#!/usr/bin/env node
// qq-media-plugin 自检：装完跑一下，逐项告诉你哪里没到位。
//   node verify.mjs [--repo <qq-bridge>]
// 退出码 0 = 全绿。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

function looksLikeRepo(d) { try { return fs.existsSync(path.join(d, 'src', 'bridge.js')) && fs.existsSync(path.join(d, 'config.json')); } catch { return false; } }
function findRepo() {
  const g = opt('repo') ?? process.env.QQ_BRIDGE_DIR;
  if (g && looksLikeRepo(path.resolve(g))) return path.resolve(g);
  for (const p of [process.cwd(), path.join(process.cwd(), '..'), path.join(os.homedir(), 'qq-bridge')]) {
    const abs = path.resolve(p);
    if (looksLikeRepo(abs)) return abs;
  }
  return null;
}
function findProfile() {
  const base = path.join(os.homedir(), '.dsh', 'profiles');
  if (!fs.existsSync(base)) return null;
  for (const d of fs.readdirSync(base)) {
    const f = path.join(base, d, 'cordis.patch.yml');
    if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('mcp-media')) return path.join(base, d);
  }
  return null;
}

const REPO = findRepo();
if (!REPO) { console.log('❌ 找不到 qq-bridge，用 --repo 指定'); process.exit(1); }
console.log(`检查目标: ${REPO}\n`);
const read = (f) => fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');

for (const rel of ['src/mcp-media.js', 'scripts/media-tool.py']) ok(`文件 ${rel}`, fs.existsSync(path.join(REPO, rel)));

const guard = path.join(REPO, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');
ok('守卫白名单含 mcp__media__', fs.existsSync(guard) && read(guard).includes("'mcp__media__'"));

const preset = path.join(REPO, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml');
ok('预设含「你能听、也能看」', fs.existsSync(preset) && read(preset).includes('mcp__media__media_hear'));

const profile = findProfile();
ok('DSH profile 已挂载 mcp-media', !!profile, profile ? path.basename(profile) : '未找到');

// python 依赖
const home = os.homedir();
const pyCands = [process.env.MEDIA_PYTHON, process.env.DSH_PYTHON,
  path.join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
  'python', 'python3'].filter(Boolean);
let py = null;
let depsOk = false;
for (const c of pyCands) {
  const r = spawnSync(c, ['-c', 'import imageio_ffmpeg, faster_whisper, soundfile, numpy, huggingface_hub as h; print("ok", h.__version__)'], { encoding: 'utf8' });
  if (!r.error && String(r.stdout).includes('ok')) { depsOk = true; py = c; break; }
}
ok('python 依赖（imageio-ffmpeg / faster-whisper / soundfile / numpy / hf_hub<1.0）', depsOk, depsOk ? py : '');
if (depsOk) {
  const v = spawnSync(py, ['-c', 'import huggingface_hub as h; print(h.__version__)'], { encoding: 'utf8' });
  const ver = String(v.stdout || '').trim();
  ok('huggingface_hub 是 1.0 以下（faster-whisper 要求）', ver && Number(ver.split('.')[0]) < 1, ver);
}

// SILK addon
const cfg = JSON.parse(read(path.join(REPO, 'config.json')));
const slHome = String(cfg?.snowluma?.homeDir || 'C:/SnowLuma');
const addon = [
  path.join(slHome, 'native', 'ffmpeg', 'ffmpegAddon.win32.x64.node'),
  path.join(slHome, 'native', 'ffmpegAddon.win32.x64.node'),
].find((p) => fs.existsSync(p));
ok('SnowLuma SILK addon 存在', !!addon, addon ?? `找的是 ${slHome}/native/ffmpeg/`);

// 模型
const modelDir = path.join(home, '.dsh', 'models', 'whisper');
let hasModel = false;
if (fs.existsSync(modelDir)) {
  for (const d of fs.readdirSync(modelDir)) {
    if (!/faster-whisper-small/.test(d)) continue;
    const snaps = path.join(modelDir, d, 'snapshots');
    if (!fs.existsSync(snaps)) continue;
    for (const s of fs.readdirSync(snaps)) if (fs.existsSync(path.join(snaps, s, 'model.bin'))) hasModel = true;
  }
}
ok('whisper small 模型已下载', hasModel, hasModel ? modelDir : '可跑 install.mjs --download-model');

// MCP 冒烟
const smoke = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(REPO, 'src', 'mcp-media.js')], { stdio: ['pipe', 'pipe', 'pipe'], cwd: REPO });
  let buf = ''; let stderr = '';
  const timer = setTimeout(() => { child.kill(); resolve({ ok: false, detail: '超时（15 秒无响应）' }); }, 15000);
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.on('exit', (code) => {
    clearTimeout(timer);
    const hint = /Cannot find package|Cannot find module/.test(stderr) ? '缺少依赖：在 qq-bridge 里跑 npm install' : `退出（code ${code}）：${stderr.split('\n')[0] || '无输出'}`;
    resolve({ ok: false, detail: hint });
  });
  child.stdout.on('data', (d) => {
    buf += d.toString();
    for (const line of buf.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id === 1) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
      }
      if (m.id === 2) {
        clearTimeout(timer);
        const names = (m.result?.tools ?? []).map((t) => t.name);
        child.removeAllListeners('exit'); child.kill();
        resolve({ ok: names.length === 3, detail: names.join(', ') });
      }
    }
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '1' } } }) + '\n');
});
ok('MCP server 能起来并暴露 3 个工具', smoke.ok, smoke.detail ?? '');

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.log('没过的是：');
  for (const f of failed) console.log(`  · ${f.name}`);
  console.log('\n常见修法：白名单没过 → 完整退出并重开 DSH；依赖没过 → 跑 install 打印的 pip 命令；SILK addon → 检查 SnowLuma 安装路径');
  process.exit(1);
}
