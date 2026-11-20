#!/usr/bin/env node
// qq-media-plugin 卸载器
//   node uninstall.mjs [--repo <qq-bridge>] [--profile <名字>] [--dry-run]
// 不删：whisper 模型和 python 依赖（可能还被别的东西用着）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const DRY = args.includes('--dry-run');

function looksLikeRepo(d) { return fs.existsSync(path.join(d, 'src', 'bridge.js')) && fs.existsSync(path.join(d, 'config.json')); }
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
  const g = opt('profile');
  if (g) return path.isAbsolute(g) ? g : path.join(base, g);
  if (!fs.existsSync(base)) return null;
  for (const d of fs.readdirSync(base)) {
    const f = path.join(base, d, 'cordis.patch.yml');
    if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('mcp-media')) return path.join(base, d);
  }
  return null;
}

const REPO = findRepo();
if (!REPO) { console.log('❌ 找不到 qq-bridge，用 --repo 指定'); process.exit(1); }
const PROFILE = findProfile();
const read = (f) => fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
const write = (f, t) => { if (!DRY) fs.writeFileSync(f, t, 'utf8'); };
let n = 0;

const guard = path.join(REPO, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');
if (fs.existsSync(guard)) {
  const t = read(guard);
  const next = t.replace(/^\s*'mcp__media__',\r?\n/m, '');
  if (next !== t) { write(guard, next); n += 1; console.log('✔ 已从守卫白名单移除 mcp__media__'); }
  else console.log('· 白名单里没有 mcp__media__');
}

if (PROFILE) {
  const f = path.join(PROFILE, 'cordis.patch.yml');
  if (fs.existsSync(f)) {
    const t = read(f);
    const next = t.replace(/# === qq-media MCP BEGIN ===[\s\S]*?# === qq-media MCP END ===\r?\n?/g, '');
    if (next !== t) { write(f, next); n += 1; console.log('✔ 已移除 mcp-media 挂载'); }
    else console.log('· profile 里没有 mcp-media');
  }
}

for (const rel of [path.join('dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml')]) {
  const f = path.join(REPO, rel);
  if (!fs.existsSync(f)) continue;
  const lines = read(f).split('\n');
  // 按行找标题，删到下一个【…】小节或文件尾（正则跨行删容易漏，实测会删不掉）
  const start = lines.findIndex((l) => /【你能听、也能看|「你能听、也能看/.test(l));
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !/^\s*[【「]/.test(lines[end])) end += 1;
    lines.splice(start, end - start);
    write(f, lines.join('\n'));
    n += 1;
    console.log(`✔ 已移除 ${rel} 的耳朵小节`);
  } else {
    console.log(`· ${rel} 里没有耳朵小节`);
  }
}

for (const rel of ['src/mcp-media.js', 'scripts/media-tool.py']) {
  const f = path.join(REPO, rel);
  if (fs.existsSync(f)) { if (!DRY) fs.unlinkSync(f); n += 1; console.log(`✔ 已删除 ${rel}`); }
}
for (const d of ['state/media-cache']) {
  const f = path.join(REPO, d);
  if (fs.existsSync(f)) { if (!DRY) fs.rmSync(f, { recursive: true, force: true }); n += 1; console.log(`✔ 已清理 ${d}`); }
}

console.log(`\n${DRY ? 'dry-run：' : ''}改动 ${n} 处。模型和 python 依赖保留。`);
console.log('之后同样要：重启桥接 + 完整退出并重开 DSH。');
