"""她的眼睛和耳朵：视频抽帧、抽音轨、语音识别。

命令行（供 mcp-media.js 调用，每一步都打印一行 JSON）：
  py media-tool.py probe      --file <媒体文件>
  py media-tool.py frames     --file <视频> --out <目录> --count 4 [--max-width 720]
  py media-tool.py audio      --file <视频/语音> --out <wav>
  py media-tool.py transcribe --file <wav/视频> [--model small] [--lang zh]

设计要点
────────
1. **ffmpeg 不要求系统安装**：优先用 imageio-ffmpeg 自带的二进制，找不到再退回 PATH 里的 ffmpeg。
2. **模型走国内镜像**：HuggingFace 直连不通时用 hf-mirror.com（可用 HF_ENDPOINT 覆盖）。
3. **一切裁到"够看"**：帧数、宽度、音频长度都有上限 —— 她的每一帧都会变成下一轮的视觉输入 token。
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

# ── ffmpeg ────────────────────────────────────────────
def ffmpeg_exe():
    try:
        import imageio_ffmpeg
        p = imageio_ffmpeg.get_ffmpeg_exe()
        if p and os.path.exists(p):
            return p
    except Exception:
        pass
    for name in ("ffmpeg", "ffmpeg.exe"):
        from shutil import which
        w = which(name)
        if w:
            return w
    return None


FFMPEG = ffmpeg_exe()


def fail(msg):
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    sys.exit(1)


def run(cmd, timeout=600):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)


# ── probe ─────────────────────────────────────────────
def do_probe(args):
    if not FFMPEG:
        fail("找不到 ffmpeg（pip install imageio-ffmpeg）")
    if not os.path.exists(args.file):
        fail(f"文件不存在：{args.file}")
    r = run([FFMPEG, "-hide_banner", "-i", args.file])
    text = (r.stderr or "") + (r.stdout or "")
    duration = None
    for line in text.splitlines():
        if "Duration:" in line:
            try:
                t = line.split("Duration:")[1].split(",")[0].strip()
                h, m, s = t.split(":")
                duration = int(h) * 3600 + int(m) * 60 + float(s)
            except Exception:
                pass
    has_video = "Video:" in text
    has_audio = "Audio:" in text
    print(json.dumps({
        "ok": True,
        "file": args.file,
        "bytes": os.path.getsize(args.file),
        "duration": round(duration, 2) if duration else None,
        "hasVideo": has_video,
        "hasAudio": has_audio,
    }, ensure_ascii=False))


# ── frames ────────────────────────────────────────────
def do_frames(args):
    if not FFMPEG:
        fail("找不到 ffmpeg（pip install imageio-ffmpeg）")
    if not os.path.exists(args.file):
        fail(f"文件不存在：{args.file}")
    count = max(1, min(8, int(args.count or 4)))
    width = max(320, min(1280, int(args.max_width or 720)))
    os.makedirs(args.out, exist_ok=True)

    probe = do_probe_quiet(args.file)
    duration = probe.get("duration") or 0
    if duration <= 0:
        duration = 10.0

    # 均匀取帧，避开首尾各 8%（片头片尾常有黑场/logo）
    lo, hi = duration * 0.08, duration * 0.92
    if hi <= lo:
        lo, hi = 0.0, max(duration, 1.0)
    times = [lo + (hi - lo) * (i / max(1, count - 1)) for i in range(count)] if count > 1 else [(lo + hi) / 2]

    frames = []
    for i, t in enumerate(times):
        out = os.path.join(args.out, f"f{i}.jpg")
        r = run([
            FFMPEG, "-hide_banner", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", args.file,
            "-frames:v", "1", "-vf", f"scale='min({width},iw)':-2", "-q:v", "3", "-y", out,
        ])
        if os.path.exists(out) and os.path.getsize(out) > 0:
            frames.append({"path": out, "at": round(t, 2), "bytes": os.path.getsize(out)})
    if not frames:
        fail("一帧都没抽出来（可能不是视频文件）")

    result = {"ok": True, "frames": frames, "duration": round(duration, 2)}

    # 拼成一张"连续图"：几帧排在一个网格里，每格标序号和时间。
    # 为什么：分开给 N 张图时，模型看到的是 N 个孤立画面，看不出动作的方向和先后；
    # 拼成一张后，运动是"从左到右、从上到下"的一条线，顺序和时间都摆在脸上。
    if args.sheet:
        try:
            sheet = make_sheet([f["path"] for f in frames], [f["at"] for f in frames],
                               args.sheet, tile_w=int(args.tile_width or 420))
            result["sheet"] = {"path": sheet, "bytes": os.path.getsize(sheet)}
        except Exception as e:
            result["sheetError"] = str(e)

    print(json.dumps(result, ensure_ascii=False))


def make_sheet(paths, times, out_path, tile_w=420, cols=None, pad=10, label_h=30):
    """把若干帧拼成一张带序号/时间标注的网格图。"""
    from PIL import Image, ImageDraw, ImageFont

    imgs = [Image.open(p).convert("RGB") for p in paths]
    n = len(imgs)
    cols = int(cols or (2 if n <= 4 else 3))
    rows = (n + cols - 1) // cols

    first = imgs[0]
    tile_h = max(1, int(first.height * tile_w / first.width))

    W = cols * tile_w + (cols + 1) * pad
    H = rows * (tile_h + label_h) + (rows + 1) * pad
    sheet = Image.new("RGB", (W, H), (16, 16, 16))
    draw = ImageDraw.Draw(sheet)

    try:
        font = ImageFont.load_default(size=20)
    except TypeError:
        font = ImageFont.load_default()

    for i, (im, t) in enumerate(zip(imgs, times)):
        r, c = divmod(i, cols)
        x = pad + c * (tile_w + pad)
        y = pad + r * (tile_h + label_h + pad)
        sheet.paste(im.resize((tile_w, tile_h)), (x, y))
        # 序号 + 时间：让人一眼看出"第几张、视频第几秒"
        draw.rectangle([x, y + tile_h, x + tile_w, y + tile_h + label_h], fill=(28, 28, 28))
        draw.text((x + 8, y + tile_h + 4), f"#{i + 1}  {t:.1f}s", fill=(240, 240, 240), font=font)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    sheet.save(out_path, "JPEG", quality=88)
    return out_path


def do_probe_quiet(path):
    r = run([FFMPEG, "-hide_banner", "-i", path])
    text = (r.stderr or "") + (r.stdout or "")
    for line in text.splitlines():
        if "Duration:" in line:
            try:
                t = line.split("Duration:")[1].split(",")[0].strip()
                h, m, s = t.split(":")
                return {"duration": int(h) * 3600 + int(m) * 60 + float(s)}
            except Exception:
                pass
    return {}


# ── audio ─────────────────────────────────────────────
def do_audio(args):
    if not FFMPEG:
        fail("找不到 ffmpeg（pip install imageio-ffmpeg）")
    if not os.path.exists(args.file):
        fail(f"文件不存在：{args.file}")
    r = run([
        FFMPEG, "-hide_banner", "-loglevel", "error", "-i", args.file,
        "-vn", "-ac", "1", "-ar", "16000", "-t", "600", "-y", args.out,
    ])
    if not os.path.exists(args.out) or os.path.getsize(args.out) == 0:
        fail(f"抽音轨失败：{(r.stderr or '')[:200]}")
    print(json.dumps({"ok": True, "file": args.out, "bytes": os.path.getsize(args.out)}, ensure_ascii=False))


# ── transcribe ────────────────────────────────────────
def find_local_snapshot(root, model_name):
    """在 huggingface 缓存结构里找到已下载好的模型快照目录。"""
    import glob
    pat = os.path.join(root, f"models--*--faster-whisper-{model_name}", "snapshots", "*")
    dirs = [d for d in glob.glob(pat) if os.path.isfile(os.path.join(d, "model.bin"))]
    if not dirs:
        pat2 = os.path.join(root, f"models--*--whisper-{model_name}", "snapshots", "*")
        dirs = [d for d in glob.glob(pat2) if os.path.isfile(os.path.join(d, "model.bin"))]
    return dirs[0] if dirs else None


def do_transcribe(args):
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ["HF_HUB_DISABLE_XET"] = "1"
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    src = args.file
    if not os.path.exists(src):
        fail(f"文件不存在：{src}")

    # 统一先转成 16k 单声道 wav（ffmpeg 能吃视频/语音/任何容器），
    # 之后用 soundfile 读成 numpy 直接喂模型 —— 绕开 faster-whisper 内部的
    # av.open(metadata_errors=...) 调用（那个参数在 PyAV 19 里已经没有了，
    # 不绕开就是 TypeError: unexpected keyword argument 'metadata_errors'）。
    tmp = os.path.join(tempfile.gettempdir(), f"asr-{os.getpid()}.wav")
    r = run([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", src,
             "-vn", "-ac", "1", "-ar", "16000", "-t", "600", "-y", tmp])
    if not os.path.exists(tmp) or os.path.getsize(tmp) == 0:
        fail(f"抽音轨失败：{(r.stderr or '')[:200]}")

    try:
        import soundfile as sf
        audio, sr = sf.read(tmp, dtype="float32")
        if getattr(audio, "ndim", 1) > 1:
            audio = audio.mean(axis=1)
        if sr != 16000:
            import numpy as np
            x = np.linspace(0, 1, len(audio), endpoint=False)
            audio = np.interp(np.linspace(0, 1, int(len(audio) * 16000 / sr), endpoint=False), x, audio).astype("float32")
    except Exception as e:
        fail(f"读音频失败：{e}")
    finally:
        try:
            os.remove(tmp)
        except Exception:
            pass

    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        fail(f"没装 faster-whisper：{e}")

    model_name = args.model or "small"
    root = os.path.join(os.path.expanduser("~"), ".dsh", "models", "whisper")
    # 优先用本地快照（离线、秒开）；没有才回落到按名字加载（联网下载）。
    # 为什么要这样：hf_hub 的在线校验在这台机器上会挂住十分钟不出结果，
    # 而模型文件其实早就完整下载好了。
    snap = find_local_snapshot(root, model_name)
    try:
        if snap:
            model = WhisperModel(snap, device="cpu", compute_type="int8", local_files_only=True)
        else:
            model = WhisperModel(model_name, device="cpu", compute_type="int8", download_root=root)
        # vad_filter：先用 VAD 切掉静音/纯音段。
        # 实测纯正弦音（没有一个人说话）在不开 VAD 时会"听"出「字幕by索兰娅」这种幻觉；
        # 开了 VAD 之后返回空字符串，反而是对的。
        segs, info = model.transcribe(audio, language=(args.lang or None), beam_size=1, vad_filter=True)
        text = "".join(s.text for s in segs).strip()
    except Exception as e:
        fail(f"识别失败：{e}")

    # Whisper 在没人说话的音频上爱"编字幕"：这几个是中文语音里最常见的幻觉句，
    # 命中就直接当成没听到（宁可说没听清，也别给她编一段不存在的话）。
    HALLUCINATION = (
        "字幕by", "字幕提供", "请不吝点赞", "感谢观看", "订阅转发", "打赏支持",
        "字幕組", "中文字幕", "由.*提供", "明镜与点点栏目",
    )
    import re
    if text and any(re.search(p, text) for p in HALLUCINATION):
        text = ""

    print(json.dumps({
        "ok": True, "text": text, "model": model_name,
        "seconds": round(len(audio) / 16000, 2),
    }, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("probe"); p.add_argument("--file", required=True); p.set_defaults(func=do_probe)
    p = sub.add_parser("frames"); p.add_argument("--file", required=True); p.add_argument("--out", required=True)
    p.add_argument("--count", type=int, default=4); p.add_argument("--max-width", type=int, default=720)
    p.add_argument("--sheet", default=""); p.add_argument("--tile-width", type=int, default=420)
    p.set_defaults(func=do_frames)
    p = sub.add_parser("audio"); p.add_argument("--file", required=True); p.add_argument("--out", required=True)
    p.set_defaults(func=do_audio)
    p = sub.add_parser("transcribe"); p.add_argument("--file", required=True)
    p.add_argument("--model", default="small"); p.add_argument("--lang", default="zh")
    p.set_defaults(func=do_transcribe)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
