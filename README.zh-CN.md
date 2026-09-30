# vlogsmith

[English](README.md) · **简体中文** · [日本語](README.ja.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Python 3.9+](https://img.shields.io/badge/python-3.9%2B-3776AB)
![Node 20+](https://img.shields.io/badge/node-20%2B-339933)
![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)

把一条 vlog 原片变成成片、封面、一篇日语学习博客和一期视频播客。全部在你自己的电脑上跑，AI 提建议，你来拍板。

vlogsmith 是一个本地运行的小型 Web 应用。把相机拍的视频拖进去（最初是为 DJI Osmo Pocket 写的）：它先用 Whisper 离线转录，再让 AI 命令行工具（默认 Claude Code）校对字幕、起草其余内容。每到关键节点都会停下来，等你确认后才继续。

> **先说明：** 这原本是给一个频道、一个博客用的个人工具。界面是简体中文，AI 提示词是为日语学习系列写的，也写死了一些风格上的假设。和机器相关的设置都可以改（见[配置](#配置)），但如果你做的内容类型不同，提示词得自己调整。

## 特性

- **离线转录**：[OpenAI Whisper](https://github.com/openai/whisper) 在本机运行，生成带时间轴的 SRT，不需要付费的语音 API。
- **AI 辅助校对字幕**：AI 标出可能听错的地方，以对比形式显示，你逐条采纳或忽略。也可以勾选几行，用一句话告诉它怎么改，比如「这两句听错了」「把口头禅去掉」。
- **AI 命令行工具可以自选**：只要能从标准输入或参数读 prompt、输出文本或 JSON 的 CLI 都能用。可以配置好几个、设一个默认，在 AI 助手里每次对话临时换。
- **每个任务一条对话记录**：每个任务页右侧都有可收起的 AI 助手。你发的指令、AI 的回复、你点的按钮都在同一条时间线上，可以搜索、按步骤筛选。
- **学习向博客文章**：确认后的字幕会改写成一篇「やさしい日本語」文章（原句 vs 自然说法、语法笔记、结尾汇总表），格式照你系列里最新一期来，一键导出到你的 Astro 博客。
- **封面设计**：从 6 张候选帧里选一张、改文案，生成 1280×720 封面。`pipeline.py` 里还有一个基于 [YuNet](https://github.com/ShiqiYu/libfacedetection) 的路人打码函数，不过界面上还没接入。
- **带高亮的硬字幕**：白字黑边，AI 挑出的关键词标成黄色，用 ffmpeg + libass 烧录。导出前可以先预览前 50 秒。
- **视频播客**：把整理好的稿子逐句或一口气重新录一遍，自动对齐时间轴，并生成带注音、逐词标注的播客稿。
- **发布到 YouTube**：在本机走 OAuth 直接上传，默认私享，自动设置封面。发布后会把视频链接写回博客文章。
- **视频多了也好管理**：首页有状态标签页、搜索，可以按拍摄月份、播客、YouTube、博客状态筛选，列表按月分组，还能勾选多条批量删除。
- **环境检查**：设置页一眼看出各个 AI CLI、ffmpeg（是否带 libass）、Whisper、博客目录是否就绪。

## 工作流程

```
 拖入视频
    │
    ▼
 1. 转录 ─────────── ffmpeg → Whisper (small, ja) → AI 给出修改建议
    │
    ▼
 ✋ 字幕 ─────────── 采纳 / 忽略建议、直接改、让 AI 改
    │
    ▼
 2. 博客 ─────────── AI 按系列格式写出新的一期
    │
    ▼
 ✋ 博客 ─────────── 预览、改 Markdown、重新生成或跳过
    │
    ▼
 3. 封面与字幕 ────── 候选帧 + AI 文案 + 高亮词，生成 50 秒预览
    │
    ▼
 ✋ 封面 ─────────── 选帧、改文案、调字幕字号
    │
    ▼
 4. 导出 ─────────── ffmpeg 给整段视频烧录字幕
    │
    ▼
 final.mp4 · thumbnail.jpg · transcript.srt  ──▶  （可选）发布到 YouTube
```

字幕确认之后，视频播客可以和上面的流程同时进行，在任务页有单独的标签。

## 环境要求

| 依赖 | 用途 | 备注 |
|---|---|---|
| macOS | 目前只在 macOS 上测过 | 默认字体是冬青黑体；其他系统请设置 `VLOGSMITH_FONT` |
| Python 3.9+ | Flask API 和处理脚本 | 建议用虚拟环境 |
| Node.js 20+ 和 npm | 前端（Vite + React） | |
| [`ffmpeg-full`](https://formulae.brew.sh/formula/ffmpeg-full) | 音视频处理、烧录字幕 | 普通的 `brew install ffmpeg` 不带 **libass**，烧字幕会失败 |
| AI CLI，比如 [Claude Code](https://github.com/anthropics/claude-code) | 校对、博客、封面文案、播客标注 | 可选。没有的话 AI 相关步骤会跳过 |
| Google Cloud OAuth 客户端 | 发布到 YouTube | 可选 |

## 安装

```bash
# 1. 带 libass 的 ffmpeg
brew install ffmpeg-full

# 2. （可选）Claude Code CLI，装好后运行 `claude`，在里面执行 /login 登录一次
npm install -g @anthropic-ai/claude-code

# 3. 克隆并安装依赖
git clone https://github.com/erzhiqianyi/vlogsmith.git
cd vlogsmith
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm --prefix frontend install

# 4. 本地设置
cp .env.example .env   # 按需修改里面的路径
```

## 快速开始

```bash
./dev.sh
```

`dev.sh` 会在 5001 端口启动 Flask API，在 5173 端口启动 Vite 开发服务器。打开 <http://localhost:5173>，把视频拖进首页，任务到每个 ✋ 节点会停下来等你。

不想开开发服务器的话，构建一次，让 Flask 直接提供页面：

```bash
npm --prefix frontend run build
.venv/bin/python app.py      # http://127.0.0.1:5001
```

## 配置

### 环境变量（`.env`）

| 变量 | 默认值 | 用途 |
|---|---|---|
| `VLOGSMITH_BLOG_DIR` | `~/blog` | 博客文章要导出到的 Astro 项目（写入 `src/content/blog/ja/japanese/YYYY/MM/`） |
| `VLOGSMITH_FONT` | 冬青黑体 | 封面和字幕用的字体，必须包含日文字形 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | 自动查找 | 默认在 Homebrew 的 `ffmpeg-full` 下查找 |

`app.py` 启动时会读取 `.env`，已经设置的环境变量优先。

### AI 命令行工具

在「设置 → AI 命令行工具」里配置。每一项包括：

- **命令**：按 shell 写法，比如 `claude -p --output-format stream-json --verbose --include-partial-messages`。
- **prompt 怎么传进去**：通过标准输入，或者追加为最后一个参数。
- **输出格式**：纯文本、JSON（要填结果字段路径），或 Claude Code 的流式 JSON。

内置 Claude Code、Gemini CLI、Codex CLI 三个预设。只有 Claude 预设完整跑通过，其他的添加后请先点「测试」。

默认工具用来跑自动步骤；在 AI 助手里可以为某一次对话临时换一个。配置保存在 `ai_config.json`，已被 git 忽略。

### 内容风格

`pipeline.py` 里的提示词是为某个频道和博客系列写的：`CHANNEL_STYLE_NOTES` 里是过往标题范例和封面风格；博客提示词会照抄你博客里最新一篇 `yasashii-nihongo*.md` 的结构。按你自己的内容改这两处即可。

### YouTube

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 启用 **YouTube Data API v3**。
2. 创建一个类型为 **Desktop app** 的 OAuth 客户端 ID。
3. 下载 JSON，改名为 `youtube_client_secret.json` 放到项目根目录。
4. 在「设置 → YouTube」点「连接 YouTube」，浏览器会打开一次授权页面。

发布表单的默认可见性和标签也在这一页设置。

## 项目结构

```
vlogsmith/
├── app.py               # Flask JSON API、任务状态机、后台阶段调度
├── pipeline.py          # 各处理步骤（ffmpeg、Whisper、OpenCV、PIL、提示词），无状态
├── ai_helper.py         # 通用 AI CLI 适配：配置、流式输出、调用记录、用量
├── youtube_helper.py    # OAuth 授权和断点续传上传
├── models/yunet.onnx    # YuNet 人脸检测模型（MIT，来自 OpenCV Zoo）
├── templates/theater.html  # 独立的大屏播放页面
├── frontend/            # React + Vite + Tailwind + shadcn/ui
│   └── src/
│       ├── pages/       # Dashboard、JobDetail、Settings
│       ├── components/  # ChatPanel、JobInfo、stages/*、ui/*
│       └── lib/         # API 封装、步骤定义、格式化
├── jobs/                # 每个任务的中间文件（已被 git 忽略）
├── .env.example
└── dev.sh
```

## 流水线参考

每个任务的状态存在 `jobs/<id>/status.json`，由 `stage` 字段驱动：

| 阶段 | 做什么 | 进入下一步 |
|---|---|---|
| `uploaded` → `transcribing` | 抽音频、跑 Whisper、AI 给建议 | 自动 |
| `transcript_review` | 确认字幕 | `POST /api/job/<id>/transcript` |
| `blog_processing` → `blog_review` | 生成博客文章，然后确认 | `POST /api/job/<id>/confirm_blog` 或 `discard_blog` |
| `caption_processing` → `caption_review` | 候选帧、AI 文案、字幕预览，然后确认 | `POST /api/job/<id>/confirm_captions` |
| `rendering_final` → `done` | 给整段视频烧录字幕 | 自动 |
| `error` | 某一步失败，界面上显示完整报错 | `POST /api/job/<id>/retry`（根据磁盘上已有的文件接着跑） |

每个操作都会记进任务的处理日志；AI 对话保存在 `jobs/<id>/chat.json`。

## 故障排查

<details>
<summary>烧录字幕时报错找不到 <code>ass</code> / <code>subtitles</code> 滤镜</summary>

要装 `ffmpeg-full`，不是 `ffmpeg`。设置页会显示找到的 ffmpeg 是否带 libass。
</details>

<details>
<summary>AI 步骤提示 CLI 未登录或超时</summary>

在终端里运行一次那个 CLI 并登录（Claude Code 是先运行 `claude`，再执行 `/login`），然后在设置页点「测试」。没有能用的 CLI 时，AI 步骤会跳过，由你手动填写。
</details>

<details>
<summary>转录或导出很慢</summary>

Whisper 和 ffmpeg 都跑在 CPU 上。`small` 模型转录几分钟的音频要几分钟；长的 4K 视频重新编码可能要 10～20 分钟。
</details>

## 已知限制

- **没有鉴权**：只绑定 `127.0.0.1`，不要暴露到网络上，因为你的 YouTube 授权保存在这台机器上。
- **重启会打断正在跑的步骤**：后台步骤是进程内的线程，重启服务会打断，点「重试」就能接着跑。
- **自由指令只在字幕步骤可用**：其他步骤在 AI 助手里提供快捷操作。
- **界面上还没有人脸打码**：封面不会自动打码，发布前请自己检查有没有路人。
- **YouTube 分类是固定的**：上传固定用分类 22（People & Blogs），并占用账号的每日 API 配额。

## 路线图

- [ ] 每一步都能用自由指令（封面文案、博客修改、发布）
- [ ] 按步骤指定默认 AI 工具
- [ ] 持久化任务队列，重启不打断
- [ ] 在界面上选择 Whisper 模型
- [ ] 更多封面版式
- [ ] 一键给封面帧打码
- [ ] 首页可以搜字幕内容
- [ ] 英文 / 日文界面

## 参与贡献

欢迎提 issue 和 pull request。比修 bug 大的改动，请先开 issue 讨论。

- 改后端要重启 Flask；改前端在 `npm run dev` 下会热更新。
- 提 PR 前请在 `frontend/` 下运行 `npx oxlint src` 和 `npm run build`。
- 想加一个确认节点，照现有写法来：`run_stage_xxx` 把 `stage` 设为 `xxx_review`，在 `frontend/src/components/stages/` 加一个确认组件，再加一个 `POST /api/job/<id>/confirm_xxx` 接口推进到下一步。

## 安全

`youtube_client_secret.json`、`youtube_token.json` 和 `.env` 都已被 git 忽略，不要提交，也不要出现在截图里。发现安全问题的话，请开一个不含敏感细节的 issue，并说明需要私下沟通。

## 许可证

[MIT](LICENSE) © 2026 erzhiqianyi

## 致谢

[Whisper](https://github.com/openai/whisper) · [FFmpeg](https://ffmpeg.org/) 和 [libass](https://github.com/libass/libass) · [YuNet / OpenCV Zoo](https://github.com/opencv/opencv_zoo) · [shadcn/ui](https://ui.shadcn.com/) · [Claude Code](https://github.com/anthropics/claude-code)
