#!/usr/bin/env node
// qq-media-plugin 安装器
//
// 给 QQ 机器人加"眼睛和耳朵"：听语音/视频里的声音、看视频画面。
//
// 六步（幂等；重复跑不会重复写）：
//   1. 放 src/mcp-media.js、scripts/media-tool.py
//   2. 守卫白名单加 mcp__media__（不加的话 QQ 会话里调用会被拒）
//   3. 往 QQ 预设插入「你能听、也能看」小节
//   4. 把 mcp-media 挂到 DSH profile
//   5. 检查 python 依赖
//   6. 检查 SnowLuma 的 SILK 解码 addon 与 whisper 模型
//
// 用法：
//   node install.mjs                     # 自动找 qq-bridge / DSH profile
//   node install.mjs --dry-run           # 只看它打算做什么
//   node install.mjs --repo "D:\qq-bridge" --profile desktop
//   node install.mjs --download-model    # 顺便把 whisper small 模型下下来（≈464MB）
//   node install.mjs --python "C:\Python312\python.exe"
//
// 装完必须：重启桥接 + **完整退出并重开 DSH**（守卫名单住在 DSH 进程里）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url));
const FILES = [
  { from: 'src/mcp-media.js', to: 'src/mcp-media.js' },
  { from: 'scripts/media-tool.py', to: 'scripts/media-tool.py' },
];
const PIP = 'python -m pip install imageio-ffmpeg faster-whisper "huggingface_hub<1.0" soundfile numpy';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (n) => args.includes(`--${n}`);
const DRY = flag('dry-run');

let changed = 0;
const log = (s) => console.log(s);
const act = (s) => { if (!DRY) changed += 1; log(s); };

function looksLikeRepo(d) {
  try { return fs.existsSync(path.join(d, 'src', 'bridge.js')) && fs.existsSync(path.join(d, 'config.json')); } catch { return false; }
}

function findRepo() {
  const given = opt('repo') ?? process.env.QQ_BRIDGE_DIR;
  if (given) { const p = path.resolve(given); return looksLikeRepo(p) ? p : null; }
  const probes = [
    process.cwd(), path.join(process.cwd(), '..'),
    path.join(process.cwd(), 'qq-bridge'), path.join(process.cwd(), 'qq-bridge-main'),
    path.join(os.homedir(), 'qq-bridge'), path.join(os.homedir(), 'Documents', 'qq-bridge'),
  ];
  for (const p of probes) { const abs = path.resolve(p); if (looksLikeRepo(abs)) return abs; }
  return null;
}

function findProfile() {
  const base = path.join(os.homedir(), '.dsh', 'profiles');
  const given = opt('profile');
  if (given) { const p = path.isAbsolute(given) ? given : path.join(base, given); return fs.existsSync(p) ? p : null; }
  if (!fs.existsSync(base)) return null;
  const dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  for (const name of dirs) {
    const pkg = path.join(base, name, 'package.json');
    try {
      const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      if (/qq-agent-presets|qq-mode|qq-bridge/i.test(JSON.stringify(j.dsh?.profile?.bundles ?? j.bundles ?? []))) return path.join(base, name);
    } catch { /* 跳过 */ }
  }
  return dirs.length === 1 ? path.join(base, dirs[0]) : null;
}

const read = (f) => fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
const write = (f, t) => { if (DRY) return; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t, 'utf8'); };
function backup(f) {
  if (!fs.existsSync(f) || DRY) return;
  const b = `${f}.mediakit.bak`;
  if (!fs.existsSync(b)) fs.copyFileSync(f, b);
}

// ── 1. 放文件 ──────────────────────────────────────────
function installFiles() {
  log('\n[1/6] 放代码');
  for (const f of FILES) {
    const src = path.join(PKG_ROOT, f.from);
    const dst = path.join(REPO, f.to);
    if (!fs.existsSync(src)) { log(`  ✘ 包里缺 ${f.from}`); continue; }
    if (fs.existsSync(dst) && read(dst) === read(src)) { log(`  · ${f.to} 已是最新`); continue; }
    backup(dst);
    write(dst, read(src));
    act(`  ✔ 写入 ${f.to}`);
  }
}

// ── 2. 守卫白名单 ──────────────────────────────────────
function patchGuard() {
  log('\n[2/6] 授权工具白名单');
  const f = path.join(REPO, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');
  if (!fs.existsSync(f)) { log('  ⚠️  找不到 qq-tool-restrict.mjs，跳过（手动加 mcp__media__）'); return; }
  let t = read(f);
  if (t.includes("'mcp__media__'")) { log('  · 已包含 mcp__media__'); return; }
  const idx = t.indexOf('const SAFE_PREFIXES = [');
  if (idx < 0) { log('  ⚠️  找不到 SAFE_PREFIXES，跳过'); return; }
  const close = t.indexOf(']', idx);
  if (close < 0) { log('  ⚠️  SAFE_PREFIXES 结构异常，跳过'); return; }
  t = t.slice(0, idx) + `${t.slice(idx, close).replace(/\s*$/, '')}\n  'mcp__media__',\n` + t.slice(close);
  backup(f);
  write(f, t);
  act('  ✔ 已加入 mcp__media__');
}

// ── 3. 预设话术 ────────────────────────────────────────
const SECTION = (() => {
  const f = path.join(PKG_ROOT, 'patches', 'media-section.txt');
  return fs.existsSync(f) ? read(f).replace(/\r\n/g, '\n') : '';
})();

function patchPreset() {
  log('\n[3/6] 写预设话术');
  for (const rel of [path.join('dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'), path.join('dsh', 'agent-presets', 'qq-chat', 'agent.cordis.yml')]) {
    const f = path.join(REPO, rel);
    if (!fs.existsSync(f)) { log(`  · ${rel} 不存在，跳过`); continue; }
    let t = read(f);
    if (t.includes('mcp__media__media_hear')) { log(`  · ${rel} 已有耳朵小节`); continue; }
    const indent = (t.match(/^\s+\S/m) ?? ['  '])[0].replace(/\S.*$/, '');
    const block = SECTION.split('\n').map((l) => (l.trim() ? indent + l : '')).join('\r\n');
    let at = -1;
    for (const a of ['【她自己的手机', '【你自己的嗓子', '【发语音', '【表情包策略']) {
      const i = t.indexOf(a);
      if (i >= 0) { at = t.lastIndexOf('\n', i) + 1; break; }
    }
    if (at < 0) { log(`  ⚠️  ${rel} 找不到锚点，没自动写入（可手动贴 patches/media-section.txt）`); continue; }
    backup(f);
    write(f, t.slice(0, at) + block + '\r\n' + t.slice(at));
    act(`  ✔ ${rel} 已插入耳朵小节`);
  }
}

// ── 4. 挂 MCP ──────────────────────────────────────────
function findNode() {
  const patch = path.join(PROFILE, 'cordis.patch.yml');
  const t = fs.existsSync(patch) ? read(patch) : '';
  const m = t.match(/command:\s*'([^']*node(?:\.exe)?)'/i);
  if (m) return m[1];
  const base = path.join(os.homedir(), '.dsh', 'dsh-runtimes');
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      for (const rel of [path.join('dependencies', 'node', 'bin', 'node.exe'), path.join('dependencies', 'node', 'node.exe')]) {
        const p = path.join(base, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

function patchProfile() {
  log('\n[4/6] 挂载到 DSH profile');
  const f = path.join(PROFILE, 'cordis.patch.yml');
  if (!fs.existsSync(f)) { log('  ⚠️  profile 里没有 cordis.patch.yml，跳过'); return; }
  let t = read(f);
  if (t.includes('mcp-media')) { log('  · 已挂载 mcp-media'); return; }
  const node = findNode();
  if (!node) { log('  ⚠️  找不到 DSH 用的 node.exe，跳过挂载'); return; }
  const esc = (s) => s.replace(/\\/g, '\\\\');
  const block = [
    '', '# === qq-media MCP BEGIN ===', '- insert:', '    - id: mcp-media',
    "      name: '@deepseek-ai/dsh-mcp-client'", '      config:', '        serverName: media',
    '        transport: stdio', `        command: '${esc(node)}'`, '        args:',
    `          - '${esc(path.join(REPO, 'src', 'mcp-media.js'))}'`, '        toolCallTimeoutMs: 420000',
    '# === qq-media MCP END ===', '',
  ].join('\r\n');
  backup(f);
  write(f, t.replace(/\s*$/, '') + '\r\n' + block);
  act('  ✔ 已追加 mcp-media 挂载');
}

// ── 5/6. 环境检查 ──────────────────────────────────────
function pythonExe(model = false) {
  const home = os.homedir();
  const cands = [
    opt('python'), process.env.MEDIA_PYTHON, process.env.DSH_PYTHON, process.env.PYTHON,
    path.join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    path.join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'bin', 'python3'),
  ].filter(Boolean);
  for (const c of cands) {
    const isPath = c.includes(path.sep) || c.includes('/');
    if (isPath && !fs.existsSync(c)) continue;
    const r = spawnSync(c, ['-c', 'import sys;print(sys.version_info[0])'], { encoding: 'utf8' });
    if (!r.error && String(r.stdout).trim().startsWith('3')) return c;
  }
  return null;
}

function checkDeps() {
  log('\n[5/6] 检查 python 依赖');
  const py = pythonExe();
  if (!py) { log(`  ⚠️  找不到 python3。装一下：\n      ${PIP}`); return false; }
  const probe = spawnSync(py, ['-c', `
import importlib, sys
miss = []
for m in ("imageio_ffmpeg", "faster_whisper", "soundfile", "numpy"):
    try: importlib.import_module(m)
    except Exception: miss.append(m)
try:
    import huggingface_hub as h
    if int(h.__version__.split(".")[0]) >= 1: miss.append("huggingface_hub<1.0")
except Exception:
    miss.append("huggingface_hub")
print("MISS:" + ",".join(miss))
`], { encoding: 'utf8' });
  const out = String(probe.stdout || '');
  const miss = (out.match(/MISS:(.*)/)?.[1] || '').trim();
  if (!miss) { log(`  ✔ ${py}（依赖齐全）`); return true; }
  log(`  ⚠️  缺：${miss}`);
  log(`     装一下：\n     ${PIP}`);
  return false;
}

function snowlumaHome() {
  try {
    const cfg = JSON.parse(read(path.join(REPO, 'config.json')));
    return String(cfg?.snowluma?.homeDir || 'C:/SnowLuma');
  } catch { return 'C:/SnowLuma'; }
}

function checkAddon() {
  log('\n[6/6] 检查 SILK 解码与模型');
  const home = snowlumaHome();
  const cands = [
    path.join(home, 'native', 'ffmpeg', 'ffmpegAddon.win32.x64.node'),
    path.join(home, 'native', 'ffmpegAddon.win32.x64.node'),
  ];
  const found = cands.find((p) => fs.existsSync(p));
  if (found) log(`  ✔ SILK addon：${found}`);
  else log('  ⚠️  没找到 SnowLuma 的 ffmpeg addon —— QQ 语音（SILK）会听不了。\n     它通常在 <SnowLuma>/native/ffmpeg/ffmpegAddon.win32.x64.node，可用环境变量 SNOWLUMA_FFMPEG_ADDON 指定。');

  const py = pythonExe();
  const modelDir = path.join(os.homedir(), '.dsh', 'models', 'whisper');
  const hasModel = (() => {
    if (!fs.existsSync(modelDir)) return false;
    for (const d of fs.readdirSync(modelDir)) {
      if (!/faster-whisper-small/.test(d)) continue;
      const snaps = path.join(modelDir, d, 'snapshots');
      if (!fs.existsSync(snaps)) continue;
      for (const s of fs.readdirSync(snaps)) {
        if (fs.existsSync(path.join(snaps, s, 'model.bin'))) return true;
      }
    }
    return false;
  })();

  if (hasModel) { log('  ✔ whisper small 模型已就绪'); return; }
  log('  ⚠️  还没有 whisper small 模型（≈464MB，本地识别用）');
  if (flag('download-model') && py && !DRY) {
    log('     开始下载（走 hf-mirror，关掉 Xet 通道）…');
    const r = spawnSync(py, ['-c',
      'import os; os.environ["HF_ENDPOINT"]="https://hf-mirror.com"; os.environ["HF_HUB_DISABLE_XET"]="1"; '
      + 'from faster_whisper import WhisperModel; WhisperModel("small", device="cpu", compute_type="int8", '
      + 'download_root=os.path.expanduser("~/.dsh/models/whisper")); print("ok")'],
      { encoding: 'utf8', timeout: 1800000, env: { ...process.env, HF_ENDPOINT: 'https://hf-mirror.com', HF_HUB_DISABLE_XET: '1' } });
    log(String(r.stdout || '').includes('ok') ? '     ✔ 模型下载完成' : `     ⚠️ 下载没成功：${(r.stderr || '').slice(-300)}`);
  } else {
    log('     稍后可加 --download-model 让它自动下，或手动跑：');
    log('     python -c "import os;os.environ[\'HF_ENDPOINT\']=\'https://hf-mirror.com\';os.environ[\'HF_HUB_DISABLE_XET\']=\'1\';from faster_whisper import WhisperModel;WhisperModel(\'small\',download_root=os.path.expanduser(\'~/.dsh/models/whisper\'))"');
  }
}

// ── 跑 ─────────────────────────────────────────────────
log('qq-media-plugin 安装器');
log('='.repeat(60));
const REPO = findRepo();
if (!REPO) {
  log('❌ 找不到 qq-bridge（需要含 src/bridge.js 和 config.json）。');
  log('   用 --repo 指定：node install.mjs --repo "C:\\Users\\你\\qq-bridge"');
  process.exit(1);
}
const PROFILE = findProfile();
if (!PROFILE) { log('❌ 找不到 DSH profile，用 --profile 指定（~/.dsh/profiles 下的目录名）'); process.exit(1); }

log(`目标安装 : ${REPO}`);
log(`DSH profile: ${PROFILE}`);
log(`模式       : ${DRY ? 'dry-run（不写盘）' : '正式安装'}`);

installFiles();
patchGuard();
patchPreset();
patchProfile();
const depsOk = checkDeps();
checkAddon();

log('\n' + '='.repeat(60));
log(DRY ? 'dry-run 结束。' : `✅ 安装完成（写入 ${changed} 处）`);
log('');
log('接下来：');
log('  1) 重启桥接（关掉 start.bat 窗口再打开）');
log('  2) **完整退出 DSH 再打开** —— 守卫名单住在 DSH 进程里，只重启桥接会一直报「不在白名单内」');
log('');
log('验证：QQ 里发一条语音，然后让她「听听我刚说的啥」；或者发个视频让她「看看」。');
if (!depsOk) log('⚠️  python 依赖没装齐，先按上面那条 pip 命令装。');
