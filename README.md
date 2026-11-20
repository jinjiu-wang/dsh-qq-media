# qq-media-plugin · 她的眼睛和耳朵

给跑在 [qq-bridge](https://github.com/Derpyu520/qq-bridge) 上的 QQ 机器人加两种感知：

| 工具 | 作用 | 花钱 |
|---|---|---|
| `media_info` | 看这条消息里有什么媒体（语音 / 视频 / 图片 / 文件），不下载 | 免费 |
| `media_hear` | **听**：语音或视频里的声音 → 文字 | 免费（本地） |
| `media_watch` | **看**：视频抽 6 帧**拼成一张连续图**（带序号和时间），交给视觉模型 | 免费（本地） |

以前群里有人发语音，她只看到 `[语音]` 两个字的占位符。现在她能真的听懂、也能看见视频画面。

---

## 一、前提

1. 已经跑通 qq-bridge（r3 / r4），QQ 收发正常；
2. DSH 正在运行（安装器会写它的 profile）；
3. **SnowLuma 装在默认结构下**（`<SnowLuma>/native/ffmpeg/ffmpegAddon.*.node`）——QQ 的语音是 SILK 编码，只有它能解；
4. python3 + 这些包：

```bash
python -m pip install imageio-ffmpeg faster-whisper "huggingface_hub<1.0" soundfile numpy
```

> `huggingface_hub` **必须 1.0 以下**，否则 faster-whisper 报 `open() got an unexpected keyword argument 'metadata_errors'`。

5. whisper 模型（small，≈464MB）。安装器可代下：`node install.mjs --download-model`

---

## 二、安装

```bash
node install.mjs                 # 自动找 qq-bridge 和 DSH profile
node install.mjs --dry-run       # 只看它打算做什么，不写盘
node install.mjs --repo "D:\qq-bridge" --profile desktop
node install.mjs --download-model   # 顺便下模型（走 hf-mirror，关掉 Xet）
```

安装器做六件事：

| # | 动作 |
|---|---|
| 1 | 放 `src/mcp-media.js`、`scripts/media-tool.py` |
| 2 | 守卫白名单加 `mcp__media__` |
| 3 | 往 `qq-chat-v2` / `qq-chat` 预设插入「你能听、也能看」小节 |
| 4 | 把 `mcp-media` 挂到 DSH profile |
| 5 | 检查 python 依赖（缺了会打印 pip 命令） |
| 6 | 检查 SILK addon 和 whisper 模型 |

反悔：`node uninstall.mjs`（模型和 python 依赖保留）。

---

## 三、装完必须做两件事

1. **重启桥接**（关掉 `start.bat` 窗口再打开）；
2. **完整退出 DSH 再打开**（托盘退出，不是关窗口）。

> 白名单住在 DSH 进程里，Node 按 URL 缓存模块——只重启桥接会一直报「工具不在白名单内」。

自检：

```bash
node verify.mjs
```

---

## 四、怎么用

群里发一条语音或视频，然后跟她说：

```
听听我刚说的啥
你看这个视频里是啥
这条语音谁在说什么
```

她会自己 `media_info` → `media_hear` / `media_watch`。

> 前提是她手里有那条消息的 **messageId**（`qq_get_recent_messages` 里就有），这些工具都按 messageId 工作。

---

## 五、它是怎么工作的

**听语音**

1. 先问 QQ 自带的转写（`fetch_ptt_text`，15 秒超时——这个接口经常根本没结果）；
2. 拿不到就下载原文件 → 检测文件头：QQ 的 `.amr` 其实是 **SILK v3**（`\x02#!SILK_V3`）→ 用 SnowLuma 的 addon `decodeAudioToFmt()` 解成 wav；
3. 用 faster-whisper（small，int8 CPU）本地识别。

**听视频里的声音**：下载视频 → ffmpeg 抽 16k 单声道 → 本地识别。

**看视频**：下载视频 → ffmpeg 在时长的 8%~92% 之间均匀抽 N 帧（默认 6）→ 用 PIL 拼成一张网格图，每格标「#序号 + 时间」→ 只返回这**一张**图。

> 为什么拼图：分开返回 N 张时，模型看到的是 N 个孤立画面，说不出「画面怎么变、动作往哪走」；拼成一张后，顺序和间隔都摆在脸上，而且只占一份图像上下文。想单独看某帧时传 `separate=true`。

### 三个必须知道的坑（都已在代码里绕过）

| 坑 | 现象 | 处理 |
|---|---|---|
| QQ 语音其实是 SILK | ffmpeg 报 `Invalid data found when processing input` | 用 SnowLuma addon 解码 |
| 媒体链接会过期 | 约 1 小时后下载返回 `download url has expired` | 每次调用都重新 `get_msg` 取新鲜 url |
| 纯音乐视频会"听"出字幕 | 无人说话时 whisper 幻觉出「字幕by索兰娅」 | 开 VAD + 幻觉黑名单 |

---

## 六、配置

**不需要改 `config.json`。** 相关项自动从现有配置读：

- OneBot HTTP 地址和 token：`snowluma.httpUrl` / `snowluma.accessToken`
- SILK addon 位置：`snowluma.homeDir`（环境变量 `SNOWLUMA_FFMPEG_ADDON` 可覆盖）
- python 解释器：`MEDIA_PYTHON` / `DSH_PYTHON` / `PYTHON`，或 DSH 自带运行时

代码里的上限（想改直接改 `src/mcp-media.js`）：

```js
const MAX_BYTES = 50 * 1024 * 1024;   // 单个媒体文件上限
// 抽帧：默认 4，最多 8；宽度上限 720
// 音轨：最长 600 秒（超出截断）
```

---

## 七、故障排查

| 现象 | 原因 / 修法 |
|---|---|
| 「工具 mcp__media__ 不在白名单内」 | 没重启 DSH |
| 「这条语音是 SILK 编码，需要 SnowLuma 的 ffmpeg addon」 | addon 路径不对 → 设 `SNOWLUMA_FFMPEG_ADDON` 指向 `ffmpegAddon.win32.x64.node` |
| 「下载失败 HTTP 400 …链接会过期」 | 消息太旧，让群友重发一条，或先 `media_info` 确认 |
| 「识别失败：… metadata_errors」 | `huggingface_hub` 装成 1.x 了 → `pip install "huggingface_hub<1.0"` |
| 识别要等很久 / 超时 | 模型首次加载约 1.5s；长视频本身慢，建议让对方发短视频 |
| 「这个视频里基本没人说话」 | VAD 判定没有语音（纯 BGM），不是坏了 |
| 听出来是「字幕by…」 | 已过滤；如果还能看到，说明跑的是旧文件，重启 DSH |

---

## 八、它不做什么

- **不上传任何东西**：下载、解码、识别全在本机，不调用外部 ASR 服务。
- **不给她本机能力**：只能"按消息 id 取媒体"，路径永远是我们自己下载到 `state/media-cache` 的文件，没有 shell、没有任意路径读取。
- **不自动听每一条**：预设里写了纪律，要她按需调用——语音识别是 CPU 重活，也很占上下文。

---

## 九、版本

- **v1.0.0** — 首版：`media_info` / `media_hear` / `media_watch`；SILK 解码、媒体链接现取、VAD 防幻觉；支持 `--download-model`。

有问题带着 `node verify.mjs` 的输出、以及桥接日志里带 `[media]` 的行来找我。

<!-- release-footer -->

---

## 版本与安装

- 版本：v1.0.1
- 仓库：https://github.com/jinjiu-wang/dsh-qq-media
- 发布包：dsh-qq-media-v1.0.1.zip（Release 里下载）

把解压出来的目录放好，执行 `node install.mjs` 把 MCP 工具接进 qq-bridge；依赖 python3 + faster-whisper 等，详见 README。

## 许可

MIT
