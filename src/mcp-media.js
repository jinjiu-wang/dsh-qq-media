// mcp-media.js — 「她的眼睛和耳朵」MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 为什么需要它
// ────────────
// qq-bridge 本来能看图片（qq_get_message_images），但**语音和视频是黑盒**：
// 群里有人发一条 15 秒的语音、或者甩个视频，她只看到 `[语音]` / `[视频]` 两个占位符。
// 这个 server 补上两件事：
//
//   · media_hear  —— 听到内容：语音优先用 QQ 自带的转写（fetch_ptt_text，免费且准），
//                    拿不到再本地识别；视频则抽出音轨再识别。
//   · media_watch —— 看到画面：下载视频，用 ffmpeg 均匀抽几帧，作为图像交给她看。
//
// 三条约束
// ────────
// 1. **QQ 的媒体链接会过期**（实测 1 小时就 400 expired），所以每次调用都先 get_msg
//    取一份**新鲜**的 url 再下载，绝不缓存 url。
// 2. **她的每一帧都是下一轮的视觉 token**。帧数默认 4、宽度上限 720，够看懂就行。
// 3. **不给她任何本机能力**：只有「按消息 id 取媒体 → 交给固定的处理脚本」，
//    没有 shell、没有任意路径读取（路径永远是我们自己下载到 state/media-cache 的）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const CACHE_DIR = path.join(ROOT, 'state', 'media-cache');
const TOOL = path.join(ROOT, 'scripts', 'media-tool.py');

const MAX_BYTES = 50 * 1024 * 1024;   // 单个媒体文件上限
const MAX_ATTEMPTS = 3;

function readConfig() {
  try {
    let t = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return JSON.parse(t);
  } catch { return {}; }
}

function onebotBase() {
  const cfg = readConfig();
  return String(cfg?.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
}

function onebotToken() {
  const cfg = readConfig();
  return String(cfg?.snowluma?.accessToken || '');
}

/** 调 OneBot HTTP 动作。 */
async function onebot(action, body = {}, timeoutMs = 60000) {
  const token = onebotToken();
  const res = await fetch(`${onebotBase()}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${action} HTTP ${res.status}`);
  return json;
}

/** 按消息 id 取消息（每次现取，保证媒体 url 新鲜）。 */
async function getMessage(messageId) {
  const j = await onebot('get_msg', { message_id: messageId });
  if (j?.status !== 'ok' || !j?.data) throw new Error('找不到这条消息（id 可能不对，或不在这个号能看到的范围）');
  return j.data;
}

function segmentsOf(msg) {
  return Array.isArray(msg?.message) ? msg.message : [];
}

function pickMedia(msg) {
  const segs = segmentsOf(msg);
  const out = { record: null, video: null, images: [], file: null };
  for (const s of segs) {
    if (s?.type === 'record') out.record = s.data ?? {};
    else if (s?.type === 'video') out.video = s.data ?? {};
    else if (s?.type === 'image') out.images.push(s.data ?? {});
    else if (s?.type === 'file') out.file = s.data ?? {};
  }
  return out;
}

/** 找 python 解释器（装了 imageio-ffmpeg / faster-whisper 的那份）。 */
function resolvePython() {
  const home = os.homedir();
  const candidates = [
    process.env.MEDIA_PYTHON, process.env.DSH_PYTHON, process.env.PYTHON,
    path.join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    path.join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'bin', 'python3'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  for (const c of ['python', 'python3']) {
    const r = spawnSync(c, ['-c', 'import sys;print(sys.version_info[0])'], { encoding: 'utf8' });
    if (!r.error && String(r.stdout).trim().startsWith('3')) return c;
  }
  return null;
}

function runTool(args, timeoutMs = 300000) {
  const py = resolvePython();
  if (!py) return { ok: false, error: '找不到 python3（需要 imageio-ffmpeg / faster-whisper）' };
  const r = spawnSync(py, [TOOL, ...args], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com' },
  });
  const lines = String(r.stdout || '').trim().split('\n').filter(Boolean);
  const last = lines[lines.length - 1] || '';
  try {
    return JSON.parse(last);
  } catch {
    return { ok: false, error: `脚本返回异常（退出码 ${r.status}）：${(r.stderr || '').slice(0, 300)}` };
  }
}

/** 下载媒体到 cache；返回本地路径。 */
async function download(media, kind, messageId) {
  const url = String(media?.url || '').trim();
  const file = String(media?.file || '').trim();
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const ext = path.extname(file) || (kind === 'video' ? '.mp4' : '.amr');
  const out = path.join(CACHE_DIR, `${messageId}-${Date.now()}${ext}`);

  // 1) 本地路径（网关和桥接同机时 file 可能是绝对路径）
  if (file && path.isAbsolute(file) && fs.existsSync(file)) {
    fs.copyFileSync(file, out);
    return out;
  }
  // 2) file:// 协议：机器人自己发的本地媒体会以这种形式回读（fetch 不支持 file:）
  if (/^file:\/\//i.test(url)) {
    const { fileURLToPath } = await import('node:url');
    const local = fileURLToPath(url);
    if (fs.existsSync(local)) {
      fs.copyFileSync(local, out);
      return out;
    }
    throw new Error(`file:// 指向的本地文件不存在：${local}`);
  }
  // 3) 网络 url（必须刚 get_msg 取到，否则会 expired）
  if (url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}（QQ 的媒体链接会过期，重新读一次消息再试）`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('下载到 0 字节');
    if (buf.length > MAX_BYTES) throw new Error(`文件太大（${(buf.length / 1048576).toFixed(1)}MB，上限 ${MAX_BYTES / 1048576}MB）`);
    fs.writeFileSync(out, buf);
    return out;
  }
  throw new Error('这条消息里没有可下载的媒体');
}

function cleanup(file) {
  try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch { /* 留着也无妨 */ }
}

// ── SILK 解码 ─────────────────────────────────────────
// QQ 的语音消息文件叫 .amr，**内容是 SILK v3**（头 9 字节 `\x02#!SILK_V3`），
// ffmpeg 的 amr 解码器解不了，直接喂会报 "Invalid data found"。
// SnowLuma 自带一个 ffmpeg addon，里面有 decodeAudioToFmt(in, out, fmt) —— 用它解码。
// 路径从 config.json 的 snowluma.homeDir 推，可用 SNOWLUMA_FFMPEG_ADDON 覆盖。
let ffmpegAddon;
function loadFfmpegAddon() {
  if (ffmpegAddon !== undefined) return ffmpegAddon;
  const cfg = readConfig();
  const home = String(cfg?.snowluma?.homeDir || 'C:/SnowLuma');
  const candidates = [
    process.env.SNOWLUMA_FFMPEG_ADDON,
    path.join(home, 'native', 'ffmpeg', 'ffmpegAddon.win32.x64.node'),
    path.join(home, 'native', 'ffmpegAddon.win32.x64.node'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    try {
      const m = { exports: {} };
      process.dlopen(m, c);
      if (typeof m.exports?.decodeAudioToFmt === 'function') {
        ffmpegAddon = m.exports;
        return ffmpegAddon;
      }
    } catch { /* 换下一个候选 */ }
  }
  ffmpegAddon = null;
  return null;
}

function isSilk(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(12);
    const n = fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    return n > 0 && (buf.toString('latin1').includes('SILK') || buf[0] === 0x02);
  } catch { return false; }
}

/** 把 SILK 转成 wav；不是 SILK 就原样返回。 */
async function toPlayable(file) {
  if (!isSilk(file)) return file;
  const addon = loadFfmpegAddon();
  if (!addon) {
    throw new Error('这条语音是 SILK 编码，需要 SnowLuma 的 ffmpeg addon 解码（没找到 native/ffmpeg/ffmpegAddon.*.node）');
  }
  const out = file.replace(/\.[^.]+$/, '') + '.wav';
  await addon.decodeAudioToFmt(file, out, 'wav');
  if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error('SILK 解码没有产出文件');
  return out;
}

/** 语音消息 → 文字：优先 QQ 自带转写，拿不到就下载 + 解码 + 本地识别。 */
async function hearRecord(msg, rec, messageId) {
  try {
    // QQ 的转写是"尽力而为"：要等它那边的推送，很多时候根本没结果。
    // 给 15 秒就够，超时/失败立刻走本地识别，别让一句语音卡一分钟。
    const j = await onebot('fetch_ptt_text', { message_id: Number(messageId), file: rec.file }, 15000);
    const t = String(j?.data?.text ?? '').trim();
    if (t) return { text: t, via: 'qq' };
  } catch { /* 网关不支持/超时就走本地 */ }
  // 兜底：下载语音本地识别（先 SILK→wav）
  const local = await download(rec, 'audio', messageId);
  let wav = local;
  try {
    wav = await toPlayable(local);
    const r = runTool(['transcribe', '--file', wav], 300000);
    if (!r.ok) return { text: '', error: r.error };
    return { text: r.text, via: 'local' };
  } catch (e) {
    return { text: '', error: e.message };
  } finally {
    cleanup(local);
    if (wav !== local) cleanup(wav);
  }
}

const server = new McpServer({ name: 'media', version: '1.0.0' });

server.tool(
  'media_info',
  '看一条 QQ 消息里有什么媒体（语音 / 视频 / 图片 / 文件），以及时长和大小。不下载、很便宜，先看这个再决定要不要听/看。',
  { messageId: z.string().describe('消息 id（从 qq_get_recent_messages / qq_get_unread_messages 拿到）') },
  async ({ messageId }) => {
    try {
      const msg = await getMessage(messageId);
      const m = pickMedia(msg);
      const bits = [];
      if (m.record) bits.push(`语音 ${m.record.duration ? m.record.duration + 's' : ''}（${m.record.file || '未知文件'}）`);
      if (m.video) bits.push(`视频${m.video.file ? `（${m.video.file}）` : ''}`);
      if (m.images.length) bits.push(`${m.images.length} 张图片`);
      if (m.file) bits.push(`文件 ${m.file.name || ''}`);
      const who = msg?.sender?.nickname || msg?.sender?.user_id || '';
      const text = bits.length
        ? `消息 ${messageId}${who ? '（' + who + '）' : ''}：${bits.join('、')}`
        : `消息 ${messageId}：没有媒体，只有文字。`;
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `查不到：${e.message}` }] };
    }
  },
);

server.tool(
  'media_hear',
  '「听」一条语音或视频里的声音，转成文字。语音优先用 QQ 自带的转写；视频会先抽音轨再本地识别。'
  + '适合：群里有人发语音、你只看到 [语音] 想听懂内容；或者视频里有人说话你想知道说了什么。'
  + '注意：识别要几十秒到一两分钟，别对每条都调。',
  { messageId: z.string().describe('消息 id') },
  async ({ messageId }) => {
    try {
      const msg = await getMessage(messageId);
      const m = pickMedia(msg);
      if (m.record) {
        const heard = await hearRecord(msg, m.record, messageId);
        if (!heard.text) return { content: [{ type: 'text', text: `这条语音没听清（${heard.error || '转写不可用'}）。` }] };
        return { content: [{ type: 'text', text: `听到（语音${m.record.duration ? '，' + m.record.duration + ' 秒' : ''}）：「${heard.text}」` }] };
      }
      if (m.video) {
        const local = await download(m.video, 'video', messageId);
        try {
          const r = runTool(['transcribe', '--file', local], 300000);
          if (!r.ok) return { content: [{ type: 'text', text: `视频里的声音没听清：${r.error}` }] };
          if (!String(r.text || '').trim()) return { content: [{ type: 'text', text: '这个视频里基本没人说话（或者只有背景音乐）。' }] };
          return { content: [{ type: 'text', text: `听到（视频里的声音）：「${r.text}」` }] };
        } finally { cleanup(local); }
      }
      return { content: [{ type: 'text', text: '这条消息里没有语音或视频可听。' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `没听到：${e.message}` }] };
    }
  },
);

server.tool(
  'media_watch',
  '「看」一条视频的画面。默认把 6 帧拼成**一张连续图**给你看（每格标了序号和时间，所以能看出画面怎么变、动作往哪走），'
  + '比 N 张孤立的图有用得多。'
  + '适合：群里有人发视频、你只看到 [视频]；或者想把画面内容讲给群里听。'
  + '想要单张原图就把 separate 设 true（每张都占视觉上下文，别乱开）。',
  {
    messageId: z.string().describe('消息 id'),
    frames: z.number().int().min(2).max(9).optional().describe('抽几帧拼进一张图，默认 6'),
    separate: z.boolean().optional().describe('true = 返回单张原图（默认 false，返回一张拼好的连续图）'),
  },
  async ({ messageId, frames, separate }) => {
    try {
      const msg = await getMessage(messageId);
      const m = pickMedia(msg);
      if (!m.video) return { content: [{ type: 'text', text: '这条消息里没有视频。' }] };
      const local = await download(m.video, 'video', messageId);
      const outDir = path.join(CACHE_DIR, `frames-${messageId}-${Date.now()}`);
      const n = Math.max(2, Math.min(9, Number(frames) || 6));
      const sheetPath = path.join(outDir, 'sheet.jpg');
      try {
        const argv = ['frames', '--file', local, '--out', outDir, '--count', String(n)];
        if (!separate) argv.push('--sheet', sheetPath);
        const r = runTool(argv, 180000);
        if (!r.ok) return { content: [{ type: 'text', text: `看不了：${r.error}` }] };

        const times = r.frames.map((f) => `${f.at}s`).join(' / ');
        const head = `视频画面（${r.frames.length} 帧，时长 ${r.duration}s，按时间顺序）：${times}`;

        // 默认走连续图：一张图里就是一条时间线，顺序和间隔都看得见。
        if (!separate && r.sheet?.path && fs.existsSync(r.sheet.path)) {
          const b64 = fs.readFileSync(r.sheet.path).toString('base64');
          return {
            content: [
              { type: 'text', text: `${head}\n（每格左上角是帧序号和时间，从左到右、从上到下就是时间顺序）` },
              { type: 'image', mimeType: 'image/jpeg', data: b64 },
            ],
          };
        }

        // 单独看图（或者拼图失败时的兜底）
        const content = [{ type: 'text', text: r.sheetError ? `${head}\n（拼图失败：${r.sheetError}，这是单帧）` : head }];
        for (const f of r.frames) {
          content.push({ type: 'image', mimeType: 'image/jpeg', data: fs.readFileSync(f.path).toString('base64') });
        }
        return { content };
      } finally {
        cleanup(local);
      }
    } catch (e) {
      return { content: [{ type: 'text', text: `看不了：${e.message}` }] };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
