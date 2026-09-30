# vlogsmith

**English** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Python 3.9+](https://img.shields.io/badge/python-3.9%2B-3776AB)
![Node 20+](https://img.shields.io/badge/node-20%2B-339933)
![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)

Turn raw vlog footage into a finished video, a thumbnail, a Japanese-learning blog post and a video podcast — on your own machine, with an AI assistant that proposes and you confirm.

vlogsmith is a small local web app. Drop in a clip from your camera (it was built around a DJI Osmo Pocket). It transcribes the speech offline with Whisper, lets an AI command-line tool (Claude Code by default) proof the subtitles and draft the rest, and stops at each key point so you can review before anything moves on.

> **Heads-up:** this started as a personal tool for one channel and one blog. The UI is in Simplified Chinese, the AI prompts are written for a Japanese-learning series, and a few style assumptions are baked in. Everything machine-specific is configurable (see [Configuration](#configuration)), but expect to adapt the prompts if your content is different.

## Features

- **Offline transcription.** [OpenAI Whisper](https://github.com/openai/whisper) runs locally and produces a timed SRT. No paid speech API is needed.
- **AI-assisted subtitle proofreading.** The AI flags likely mishearings and shows each fix as a diff you accept or ignore. You can tick lines and give it an instruction in plain language ("these two lines are wrong", "drop the filler words").
- **Bring your own AI CLI.** Any command-line tool that reads a prompt from stdin (or as an argument) and prints text or JSON works. Configure several, pick a default, and switch per conversation in the assistant.
- **One history per job.** A docked, collapsible AI assistant sits on every job page. Instructions, replies and the buttons you click all land in one timeline, and you can search and filter it.
- **Learning-oriented blog post.** The confirmed subtitles become a "やさしい日本語" post (original vs. natural phrasing, grammar notes, summary table). The post follows the format of your latest episode, and one click exports it into your Astro blog.
- **Thumbnail designer.** Pick one of six candidate frames and edit the overlay copy. It renders a 1280×720 cover. `pipeline.py` also includes a [YuNet](https://github.com/ShiqiYu/libfacedetection) face-blur helper for bystanders, though the UI doesn't use it yet.
- **Burned-in captions with highlights.** Captions are white with a black outline, and AI-picked keywords are highlighted in yellow. They are rendered with ffmpeg + libass, and you preview the first 50 seconds before exporting.
- **Video podcast.** Re-record the cleaned script line by line or in one take. It is then force-aligned, and a furigana script is generated with word-level highlighting.
- **Publish to YouTube.** OAuth upload runs from your machine, private by default, and sets the thumbnail. Once published, the video link is written back into the blog post.
- **Built for many jobs.** The dashboard has status tabs, search, and filters for shooting month, podcast, YouTube and blog status. Jobs are grouped by month, and you can select several to delete at once.
- **Environment check.** The settings page shows at a glance whether each AI CLI, ffmpeg (with libass), Whisper and the blog directory are ready.

## How it works

```
 drop a video
      │
      ▼
 1. Transcribe ─────── ffmpeg → Whisper (small, ja) → AI suggests fixes
      │
      ▼
 ✋ Subtitles ──────── accept / ignore fixes, edit, ask the AI
      │
      ▼
 2. Blog post ──────── AI writes the next episode in your series' format
      │
      ▼
 ✋ Blog ────────────── preview, edit the Markdown, regenerate, or skip
      │
      ▼
 3. Cover & captions ─ candidate frames + AI copy + highlight words, 50 s preview
      │
      ▼
 ✋ Cover ───────────── pick a frame, edit copy, set caption size
      │
      ▼
 4. Export ─────────── ffmpeg burns captions into the full video
      │
      ▼
 final.mp4 · thumbnail.jpg · transcript.srt  ──▶  (optional) publish to YouTube
```

The video podcast runs alongside this flow once the subtitles are confirmed. It has its own tab on the job page.

## Requirements

| Dependency | Why | Notes |
|---|---|---|
| macOS | Only platform tested so far | The default font is Hiragino. Set `VLOGSMITH_FONT` elsewhere |
| Python 3.9+ | Flask API and processing | Use a virtualenv |
| Node.js 20+ and npm | Frontend (Vite + React) | |
| [`ffmpeg-full`](https://formulae.brew.sh/formula/ffmpeg-full) | Audio/video processing and caption burning | Plain `brew install ffmpeg` lacks **libass**, so burning captions fails |
| An AI CLI, e.g. [Claude Code](https://github.com/anthropics/claude-code) | Proofreading, blog, cover copy, podcast markup | Optional. The AI steps are skipped if none is set up |
| Google Cloud OAuth client | Publishing to YouTube | Optional |

## Installation

```bash
# 1. ffmpeg with libass
brew install ffmpeg-full

# 2. (optional) Claude Code CLI; log in once with /login inside `claude`
npm install -g @anthropic-ai/claude-code

# 3. Clone and install
git clone https://github.com/erzhiqianyi/vlogsmith.git
cd vlogsmith
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm --prefix frontend install

# 4. Local settings
cp .env.example .env   # then edit paths as needed
```

## Quick start

```bash
./dev.sh
```

`dev.sh` starts the Flask API on port 5001 and the Vite dev server on port 5173. Open <http://localhost:5173> and drag a video onto the dashboard. The job stops at each ✋ step and waits for you.

To run without the dev server, build once and let Flask serve the app:

```bash
npm --prefix frontend run build
.venv/bin/python app.py      # http://127.0.0.1:5001
```

## Configuration

### Environment (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `VLOGSMITH_BLOG_DIR` | `~/blog` | Astro blog project that posts are exported into (`src/content/blog/ja/japanese/YYYY/MM/`) |
| `VLOGSMITH_FONT` | Hiragino Sans GB | Font for covers and captions (must include Japanese glyphs) |
| `FFMPEG_PATH` / `FFPROBE_PATH` | auto | Found automatically under Homebrew's `ffmpeg-full` |

`app.py` reads `.env` on startup. Real environment variables take precedence.

### AI command-line tools

Configure these on **Settings → AI 命令行工具**. Each entry has:

- **Command:** written in shell syntax, e.g. `claude -p --output-format stream-json --verbose --include-partial-messages`.
- **Prompt input:** `stdin`, or appended as the last argument.
- **Output format:** plain text, JSON (with a result key path), or Claude Code's stream JSON.

Presets are included for Claude Code, Gemini CLI and Codex CLI. Only the Claude preset has been tested end to end, so use **Test** after adding any other.

The default tool runs the automatic steps. In the assistant you can pick a different tool for a single conversation. The configuration is stored in `ai_config.json`, which is git-ignored.

### Content style

The prompts in `pipeline.py` target one channel and one blog series. `CHANNEL_STYLE_NOTES` holds example titles and the thumbnail style, and the blog prompt copies the structure of the newest `yasashii-nihongo*.md` in your blog. Adjust both for your own content.

### YouTube

1. In the [Google Cloud Console](https://console.cloud.google.com/), enable **YouTube Data API v3**.
2. Create an OAuth client ID of type **Desktop app**.
3. Save the JSON as `youtube_client_secret.json` in the project root.
4. On **Settings → YouTube**, click **连接 YouTube** ("connect YouTube"). A browser window opens once for consent.

Default visibility and tags for the publish form are set on the same page.

## Project structure

```
vlogsmith/
├── app.py               # Flask JSON API, job state machine, background stage runners
├── pipeline.py          # Processing steps (ffmpeg, Whisper, OpenCV, PIL, prompts); stateless
├── ai_helper.py         # Generic AI CLI adapter: config, streaming, call records, usage
├── youtube_helper.py    # OAuth and resumable upload
├── models/yunet.onnx    # YuNet face detector (MIT, OpenCV Zoo)
├── templates/theater.html  # Standalone large-screen player
├── frontend/            # React + Vite + Tailwind + shadcn/ui
│   └── src/
│       ├── pages/       # Dashboard, JobDetail, Settings
│       ├── components/  # ChatPanel, JobInfo, stages/*, ui/*
│       └── lib/         # API client, step definitions, formatting
├── jobs/                # Per-job working files (git-ignored)
├── .env.example
└── dev.sh
```

## Pipeline reference

Each job keeps its state in `jobs/<id>/status.json`, and the `stage` field drives the flow:

| Stage | What happens | Moves on via |
|---|---|---|
| `uploaded` → `transcribing` | Extract audio, run Whisper, get AI suggestions | automatic |
| `transcript_review` | Review subtitles | `POST /api/job/<id>/transcript` |
| `blog_processing` → `blog_review` | Generate the blog post, then review it | `POST /api/job/<id>/confirm_blog` or `discard_blog` |
| `caption_processing` → `caption_review` | Build candidate frames, AI copy and the caption preview, then review | `POST /api/job/<id>/confirm_captions` |
| `rendering_final` → `done` | Burn captions into the full video | automatic |
| `error` | Any step failed; the traceback is shown in the UI | `POST /api/job/<id>/retry` (resumes from what's on disk) |

Every action is appended to the job's event log, and the AI conversation is kept in `jobs/<id>/chat.json`.

## Troubleshooting

<details>
<summary>Caption burning fails with a missing <code>ass</code>/<code>subtitles</code> filter</summary>

Install `ffmpeg-full`, not `ffmpeg`. The settings page reports whether the ffmpeg it found has libass.
</details>

<details>
<summary>AI steps say the CLI isn't logged in or time out</summary>

Run the CLI once in a terminal and log in (for Claude Code: `claude`, then `/login`). Then use **Test** on the settings page. Without a working CLI, the AI steps are skipped and you fill in the text yourself.
</details>

<details>
<summary>Transcription or export is slow</summary>

Whisper and ffmpeg run on the CPU. The `small` model takes a few minutes for a few minutes of audio, and re-encoding a long 4K clip can take 10–20 minutes.
</details>

## Known limitations

- **No authentication.** Bind to `127.0.0.1` only. Never expose the app to a network, because your YouTube token lives on this machine.
- **Restarts interrupt running steps.** Background steps are in-process threads. Restarting the server stops a running step, and **Retry** resumes it.
- **Free-form AI instructions only on the subtitle step.** Other steps offer quick actions in the assistant instead.
- **No face blurring in the UI yet.** Covers aren't blurred automatically, so check them for bystanders before publishing.
- **Fixed YouTube category.** Uploads use category 22 (People & Blogs) and count against your account's daily API quota.

## Roadmap

- [ ] Free-form AI instructions on every step (cover copy, blog edits, publishing)
- [ ] Per-step default AI tool
- [ ] Persistent job queue so restarts don't interrupt work
- [ ] Choose the Whisper model in the UI
- [ ] More thumbnail layouts
- [ ] One-click face blurring on cover frames
- [ ] Search inside subtitles from the dashboard
- [ ] English / Japanese UI

## Contributing

Issues and pull requests are welcome. For anything bigger than a fix, please open an issue first to discuss it.

- Backend changes need a Flask restart. Frontend changes hot-reload under `npm run dev`.
- Run `npx oxlint src` and `npm run build` in `frontend/` before sending a PR.
- To add a review step, follow the existing pattern: a `run_stage_xxx` runner sets `stage = "xxx_review"`, a component in `frontend/src/components/stages/` handles the review, and a `POST /api/job/<id>/confirm_xxx` endpoint moves the job on.

## Security

`youtube_client_secret.json`, `youtube_token.json` and `.env` are git-ignored. Keep them out of commits and screenshots. If you find a security issue, please open an issue without sensitive details and ask for a private channel.

## License

[MIT](LICENSE) © 2026 erzhiqianyi

## Acknowledgements

[Whisper](https://github.com/openai/whisper) · [FFmpeg](https://ffmpeg.org/) and [libass](https://github.com/libass/libass) · [YuNet / OpenCV Zoo](https://github.com/opencv/opencv_zoo) · [shadcn/ui](https://ui.shadcn.com/) · [Claude Code](https://github.com/anthropics/claude-code)
