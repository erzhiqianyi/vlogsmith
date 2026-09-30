"""Local web UI for the DJI vlog auto-editing pipeline.

The UI itself is a React app in frontend/ (Vite + Tailwind + shadcn/ui). This
Flask process is a pure JSON API (plus raw file serving for videos/images and
the standalone "theater" playback page) — it doesn't render any of the app's
own pages.

For development, run the two servers side by side:
    .venv/bin/python app.py                  # API on :5001
    npm --prefix frontend run dev            # React dev server on :5173 (proxies /api and /job to :5001)
and open http://localhost:5173.

For everyday local use without two terminals, build once and let Flask serve
the compiled app:
    npm --prefix frontend run build
    .venv/bin/python app.py                  # now also serves frontend/dist at :5001
and open http://127.0.0.1:5001.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
import traceback
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_from_directory


def _load_dotenv(path: Path) -> None:
    """Minimal .env support (KEY=VALUE lines) so `python app.py` picks up the same
    local settings as dev.sh; real environment variables win."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv(Path(__file__).resolve().parent / ".env")

import ai_helper
import pipeline
import youtube_helper

BASE_DIR = Path(__file__).resolve().parent
JOBS_DIR = BASE_DIR / "jobs"
JOBS_DIR.mkdir(exist_ok=True)
FRONTEND_DIST = BASE_DIR / "frontend" / "dist"

app = Flask(__name__, static_folder=str(FRONTEND_DIST), static_url_path="")
app.config["TEMPLATES_AUTO_RELOAD"] = True  # pick up template edits (theater.html) without a full restart
_locks: dict[str, threading.Lock] = {}
_youtube_oauth_state = {"in_progress": False, "error": None}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def job_dir(job_id: str) -> Path:
    return JOBS_DIR / job_id


def _lock_for(job_id: str) -> threading.Lock:
    return _locks.setdefault(job_id, threading.Lock())


def read_status(job_id: str) -> dict:
    p = job_dir(job_id) / "status.json"
    with _lock_for(job_id):
        return json.loads(p.read_text(encoding="utf-8"))


def write_status(job_id: str, **updates) -> dict:
    p = job_dir(job_id) / "status.json"
    with _lock_for(job_id):
        data = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
        data.update(updates)
        data["updated_at"] = now_iso()
        p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return data


def log_event(job_id: str, message: str) -> None:
    p = job_dir(job_id) / "status.json"
    with _lock_for(job_id):
        data = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
        events = data.setdefault("events", [])
        events.append({"ts": now_iso(), "message": message})
        data["events"] = events[-200:]
        data["updated_at"] = now_iso()
        p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def set_progress(job_id: str, stage: str, message: str) -> None:
    write_status(job_id, stage=stage, progress_text=message)
    log_event(job_id, message)


def set_error(job_id: str, message: str) -> None:
    write_status(job_id, stage="error", error=message)
    log_event(job_id, f"出错: {message.splitlines()[-1] if message else ''}")


def ai_calls_path(job_id: str) -> Path:
    return job_dir(job_id) / "ai_calls.jsonl"


def record_ai(job_id: str, purpose: str, tag: str | None = None):
    """Record every AI CLI call made inside this block into the job's ai_calls.jsonl."""
    return ai_helper.record_calls(ai_calls_path(job_id), purpose, tag)


def enrich_status(status: dict) -> dict:
    status = dict(status)
    stage = status.get("stage", "uploaded")
    status["stage_label"] = pipeline.STAGE_LABELS.get(stage, stage)
    status["progress"] = pipeline.stage_progress(stage)
    return status


# ---------------------------------------------------------------------------
# Background stage runners
# ---------------------------------------------------------------------------

def run_stage_transcribe(job_id: str):
    jd = job_dir(job_id)
    try:
        video_path = jd / "source.mp4"
        wav_path = jd / "audio.wav"
        if not wav_path.exists():
            set_progress(job_id, "transcribing", "正在提取音频...")
            pipeline.extract_audio(video_path, wav_path)

        set_progress(job_id, "transcribing", "正在用 Whisper 转录（可能需要几分钟）...")
        model_size = read_status(job_id).get("whisper_model", "small")
        srt_path = pipeline.transcribe(wav_path, jd, model_size=model_size)
        shutil.copy(srt_path, jd / "raw.srt")
        shutil.copy(srt_path, jd / "transcript.srt")

        corrections = []
        review_context = None
        review_points = []
        try:
            set_progress(job_id, "transcribing", "正在调用 claude 检查可能的听写错误...")
            with record_ai(job_id, "字幕校对建议"):
                suggestion = pipeline.claude_suggest_corrections(jd / "transcript.srt")
            corrections = suggestion.get("corrections", [])
            review_context = suggestion.get("context") or suggestion.get("notes")
            review_points = suggestion.get("points", [])
        except Exception as e:
            corrections = []
            write_status(job_id, claude_note=f"claude 校对步骤跳过: {e}")

        write_status(job_id, stage="transcript_review", suggested_corrections=corrections,
                     review_context=review_context, review_points=review_points, progress_text="")
        log_event(job_id, f"转录完成，共 {len(pipeline.parse_srt(jd / 'transcript.srt'))} 条字幕")
    except Exception:
        set_error(job_id, traceback.format_exc())


def run_stage_blog(job_id: str):
    """Also used to regenerate the blog post long after the pipeline has moved on
    (e.g. the user asks for it again once the AI CLI is finally logged in) — in
    that case `confirmed_blog` is already true, and we must NOT rewrite `stage`
    back to "blog_review", or we'd clobber tracking of whatever stage (thumbnail,
    caption, rendering, done...) the job has actually reached since."""
    jd = job_dir(job_id)
    already_past = read_status(job_id).get("confirmed_blog", False)
    try:
        if not already_past:
            set_progress(job_id, "blog_processing", "正在生成やさしい日本語博客文章...")
        else:
            log_event(job_id, "正在重新生成やさしい日本語博客文章...")
        video_date = pipeline.get_video_creation_date(jd / "source.mp4")
        title_hint = read_status(job_id).get("selected_title", "")

        try:
            with record_ai(job_id, "生成博客文章"):
                content, ctx = pipeline.claude_generate_blog_post(
                    jd / "transcript.srt", video_date, video_title_hint=title_hint)
        except Exception as e:
            updates = {"blog_error": str(e), "blog_path": None, "blog_url": None, "blog_number": None}
            if not already_past:
                updates.update(stage="blog_review", progress_text="")
            write_status(job_id, **updates)
            log_event(job_id, f"博客文章生成失败: {e}")
            return

        episode_number = ctx["next_number"]
        target_path = pipeline.write_blog_post(content, jd)

        updates = {"blog_path": str(target_path), "blog_url": None,
                   "blog_number": episode_number, "blog_error": None}
        if not already_past:
            updates.update(stage="blog_review", progress_text="")
        write_status(job_id, **updates)
        log_event(job_id, f"生成博客文章 #{episode_number}: {target_path}")
    except Exception:
        if not already_past:
            set_error(job_id, traceback.format_exc())
        else:
            write_status(job_id, blog_error=traceback.format_exc())
            log_event(job_id, "重新生成博客文章失败")


def ensure_creative(job_id: str) -> None:
    """Cover candidate frames + the AI creative brief (title ideas, cover copy, caption
    highlight words). Captions need the highlights, so this runs before the caption
    preview; the titles/cover copy wait there until the export/publish step."""
    jd = job_dir(job_id)
    if (jd / "creative.json").exists():
        return
    set_progress(job_id, "caption_processing", "正在抽取封面候选帧...")
    candidates = pipeline.extract_candidate_frames(jd / "source.mp4", jd / "frames", count=6)
    # 默认不打码：作者本人出镜是常态，需要打码时再单独找 claude/CLI 处理某张候选帧。
    candidate_names = [c.name for c in candidates]

    try:
        set_progress(job_id, "caption_processing", "正在调用 claude 生成标题/封面文案/高亮词...")
        with record_ai(job_id, "标题/封面文案/高亮词"):
            creative = pipeline.claude_creative_brief(jd / "transcript.srt")
    except Exception as e:
        creative = {
            "titles": [],
            "thumbnail": {"tag": "", "title_line1": "", "title_line2": "", "subtitle": ""},
            "highlights": {},
        }
        write_status(job_id, claude_note=f"claude 生成文案失败，需手动填写: {e}")

    (jd / "creative.json").write_text(json.dumps(creative, ensure_ascii=False, indent=2),
                                       encoding="utf-8")
    write_status(job_id, candidate_frames=candidate_names, creative=creative)
    log_event(job_id, "标题/封面文案和高亮词已生成")


def run_stage_caption_prep(job_id: str, fontsize: int = 130):
    jd = job_dir(job_id)
    try:
        ensure_creative(job_id)
        set_progress(job_id, "caption_processing", "正在生成字幕样式预览...")
        status = read_status(job_id)
        creative = status.get("creative", {})
        highlights = creative.get("highlights", {})
        ass_path = jd / "captions.ass"
        pipeline.build_ass(jd / "transcript.srt", highlights, ass_path, fontsize=fontsize)

        preview_path = jd / "preview.mp4"
        pipeline.render_captioned(jd / "source.mp4", ass_path, preview_path, duration=50)

        write_status(job_id, stage="caption_review", fontsize=fontsize, progress_text="")
        log_event(job_id, f"字幕预览已生成（字号 {fontsize}）")
    except Exception:
        set_error(job_id, traceback.format_exc())


def run_stage_final_render(job_id: str):
    jd = job_dir(job_id)
    try:
        write_status(job_id, stage="rendering_final", render_progress=0,
                     progress_text="正在渲染完整视频（较久）... 0%")
        log_event(job_id, "开始渲染完整视频")
        ass_path = jd / "captions.ass"
        final_path = jd / "final.mp4"

        def on_progress(pct: int):
            write_status(job_id, render_progress=pct,
                         progress_text=f"正在渲染完整视频（较久）... {pct}%")

        pipeline.render_captioned(jd / "source.mp4", ass_path, final_path,
                                   duration=None, preset="medium", progress_cb=on_progress)
        write_status(job_id, stage="done", progress_text="", render_progress=100)
        log_event(job_id, "完整视频导出完成")
    except Exception:
        set_error(job_id, traceback.format_exc())


def run_publish_youtube(job_id: str, title: str, description: str, tags: list[str],
                         privacy_status: str):
    jd = job_dir(job_id)
    try:
        write_status(job_id, publish_state="uploading", publish_progress=0, publish_error=None)
        log_event(job_id, f"开始上传到 YouTube（{privacy_status}）...")

        def on_progress(pct: int):
            write_status(job_id, publish_progress=pct)

        thumb_path = jd / pipeline.PLATFORMS["youtube"]["cover_file"]
        result = youtube_helper.upload_video(
            jd / "final.mp4", title=title, description=description, tags=tags,
            privacy_status=privacy_status,
            thumbnail_path=thumb_path if thumb_path.exists() else None,
            progress_cb=on_progress,
        )
        write_status(job_id, publish_state="success", publish_progress=100,
                     youtube_video_id=result["video_id"], youtube_url=result["url"])
        log_event(job_id, f"已发布到 YouTube: {result['url']}")

        status = read_status(job_id)
        if status.get("blog_path"):
            try:
                pipeline.set_blog_youtube_link(Path(status["blog_path"]), result["video_id"], title)
                log_event(job_id, "已把 YouTube 链接写回博客文章 frontmatter")
            except Exception as e:
                log_event(job_id, f"回写博客 frontmatter 失败: {e}")
    except Exception as e:
        write_status(job_id, publish_state="error", publish_error=str(e))
        log_event(job_id, f"发布失败: {e}")


# ---------------------------------------------------------------------------
# Dashboard / job listing
# ---------------------------------------------------------------------------

def list_jobs() -> list[dict]:
    jobs = []
    for jd in JOBS_DIR.iterdir():
        status_path = jd / "status.json"
        if not jd.is_dir() or not status_path.exists():
            continue
        try:
            status = json.loads(status_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        stage = status.get("stage", "uploaded")
        jobs.append({
            "job_id": jd.name,
            "video_name": status.get("video_name", jd.name),
            "stage": stage,
            "stage_label": pipeline.STAGE_LABELS.get(stage, stage),
            "progress": pipeline.stage_progress(stage),
            "created_at": status.get("created_at"),
            "updated_at": status.get("updated_at"),
            "has_thumbnail": (jd / "thumbnail.jpg").exists(),
            "selected_title": status.get("selected_title", ""),
            "youtube_url": status.get("youtube_url"),
            "shot_at": status.get("shot_at"),
            "podcast_state": status.get("podcast_state"),
            "has_blog": bool(status.get("blog_path")),
            "publish_state": status.get("publish_state"),
        })
    jobs.sort(key=lambda j: j.get("created_at") or "", reverse=True)
    return jobs


@app.route("/api/jobs")
def api_list_jobs():
    return jsonify(list_jobs())


@app.route("/api/job/<job_id>", methods=["DELETE"])
def api_delete_job(job_id):
    jd = job_dir(job_id)
    if jd.exists():
        shutil.rmtree(jd)
    _locks.pop(job_id, None)
    return jsonify({"ok": True})




# ---------------------------------------------------------------------------
# YouTube connection routes
# ---------------------------------------------------------------------------

@app.route("/api/youtube/status")
def api_youtube_status():
    configured = youtube_helper.is_configured()
    connected = youtube_helper.is_connected()
    channel = None
    if connected:
        try:
            channel = youtube_helper.get_channel_info()
        except Exception:
            connected = False
    return jsonify({
        "configured": configured, "connected": connected, "channel": channel,
        "oauth_in_progress": _youtube_oauth_state["in_progress"],
        "oauth_error": _youtube_oauth_state["error"],
        "client_secret_path": str(youtube_helper.CLIENT_SECRET_PATH),
    })


@app.route("/api/youtube/connect", methods=["POST"])
def api_youtube_connect():
    if _youtube_oauth_state["in_progress"]:
        return jsonify({"ok": True})

    def run():
        _youtube_oauth_state["in_progress"] = True
        _youtube_oauth_state["error"] = None
        try:
            youtube_helper.start_oauth_flow()
        except Exception as e:
            _youtube_oauth_state["error"] = str(e)
        finally:
            _youtube_oauth_state["in_progress"] = False

    threading.Thread(target=run, daemon=True).start()
    return jsonify({"ok": True})


@app.route("/api/youtube/disconnect", methods=["POST"])
def api_youtube_disconnect():
    youtube_helper.disconnect()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Upload + job detail routes
# ---------------------------------------------------------------------------

@app.route("/upload", methods=["POST"])
def upload():
    f = request.files.get("video")
    if not f or not f.filename:
        return jsonify({"error": "没有选择文件"}), 400

    job_id = uuid.uuid4().hex[:12]
    jd = job_dir(job_id)
    jd.mkdir(parents=True, exist_ok=True)
    f.save(jd / "source.mp4")
    try:
        shot_at = pipeline.get_shot_at(jd / "source.mp4")
    except Exception:
        shot_at = None

    write_status(job_id, stage="uploaded", video_name=f.filename,
                 whisper_model="small", progress_text="", created_at=now_iso(), shot_at=shot_at,
                 events=[{"ts": now_iso(), "message": f"上传 {f.filename}"}])

    thread = threading.Thread(target=run_stage_transcribe, args=(job_id,), daemon=True)
    thread.start()

    return jsonify({"job_id": job_id})


@app.route("/job/<job_id>/theater")
def job_theater_page(job_id):
    if not (job_dir(job_id) / "status.json").exists():
        return "job not found", 404
    return render_template("theater.html", job_id=job_id)


@app.route("/api/job/<job_id>")
def api_job_status(job_id):
    if not (job_dir(job_id) / "status.json").exists():
        return jsonify({"error": "not found"}), 404
    status = enrich_status(read_status(job_id))
    cover = job_dir(job_id) / pipeline.PLATFORMS["youtube"]["cover_file"]
    status["has_cover"] = cover.exists()
    status["cover_version"] = int(cover.stat().st_mtime) if cover.exists() else None
    calls_file = ai_calls_path(job_id)
    status["ai_call_count"] = sum(1 for _ in calls_file.open(encoding="utf-8")) if calls_file.exists() else 0
    status["ai_live_count"] = len(ai_helper.live_calls(calls_file))
    chat = read_chat(job_id)
    status["chat_count"] = sum(1 for m in chat if m["role"] == "user")
    status["chat_pending"] = any(m.get("status") == "pending" for m in chat)
    srt_path = job_dir(job_id) / "transcript.srt"
    if srt_path.exists() and status.get("stage") == "transcript_review":
        status["entries"] = pipeline.parse_srt(srt_path)
    return jsonify(status)


@app.route("/api/ai/config")
def api_ai_config():
    return jsonify(ai_helper.load_config())


@app.route("/api/ai/config", methods=["POST"])
def api_ai_config_save():
    data = request.get_json(force=True) or {}
    config = ai_helper.load_config()
    if "active" in data:
        config["active"] = data["active"]
    for name in data.get("delete") or []:
        if name != config.get("active"):
            config["providers"].pop(name, None)
    providers = data.get("providers")
    if isinstance(providers, dict):
        for name, p in providers.items():
            existing = config["providers"].get(name, {})
            command = p.get("command")
            if isinstance(command, str):
                command = ai_helper.parse_command_string(command)
            existing.update({
                "label": p.get("label", existing.get("label", name)),
                "command": command if command is not None else existing.get("command", []),
                "input_mode": p.get("input_mode", existing.get("input_mode", "stdin")),
                "response_format": p.get("response_format", existing.get("response_format", "text")),
                "json_result_key": p.get("json_result_key", existing.get("json_result_key", "")),
            })
            config["providers"][name] = existing
    ai_helper.save_config(config)
    return jsonify(config)


@app.route("/api/env")
def api_env():
    """What the Settings page's environment check shows: each configured AI CLI, plus
    the local tools the pipeline shells out to."""
    config = ai_helper.load_config()
    providers = [{
        "name": name, "label": p.get("label", name),
        "command": p.get("command") or [],
        "installed": ai_helper.check_provider_installed(p),
    } for name, p in config.get("providers", {}).items()]
    try:
        ffmpeg = pipeline.resolve_ffmpeg_full()
        ffmpeg_ok = True
        ffmpeg_libass = "ffmpeg-full" in ffmpeg or "libass" in subprocess.run(
            [ffmpeg, "-hide_banner", "-buildconf"], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        ffmpeg, ffmpeg_ok, ffmpeg_libass = None, False, False
    try:
        import importlib.util
        whisper_ok = importlib.util.find_spec("whisper") is not None
    except Exception:
        whisper_ok = False
    return jsonify({
        "providers": providers,
        "ffmpeg": {"ok": ffmpeg_ok, "path": ffmpeg, "libass": ffmpeg_libass},
        "whisper": {"ok": whisper_ok},
        "blog_dir": {"ok": pipeline.SERIES_ROOT.exists(), "path": str(pipeline.SERIES_ROOT)},
    })


@app.route("/api/ai/test", methods=["POST"])
def api_ai_test():
    data = request.get_json(force=True) or {}
    name = data.get("provider") or ai_helper.get_active_provider_name()
    return jsonify(ai_helper.test_provider(name))


@app.route("/job/<job_id>/file/<path:name>")
def job_file(job_id, name):
    return send_from_directory(job_dir(job_id), name)


@app.route("/api/job/<job_id>/transcript", methods=["POST"])
def api_confirm_transcript(job_id):
    data = request.get_json(force=True)
    entries = data.get("entries", [])
    pipeline.write_srt(entries, job_dir(job_id) / "transcript.srt")
    write_status(job_id, confirmed_transcript=True)
    log_event(job_id, "字幕已确认")
    thread = threading.Thread(target=run_stage_blog, args=(job_id,), daemon=True)
    thread.start()
    return jsonify({"ok": True})


@app.route("/api/job/<job_id>/update_transcript", methods=["POST"])
def api_update_transcript(job_id):
    """Save-only edit for an already-confirmed transcript: rewrites transcript.srt
    but does NOT re-trigger the pipeline (unlike /transcript, which advances to the
    blog step). Used when revisiting the 字幕 step after moving past it."""
    data = request.get_json(force=True)
    entries = data.get("entries", [])
    pipeline.write_srt(entries, job_dir(job_id) / "transcript.srt")
    log_event(job_id, "已确认的字幕被手动修改（未重新触发后续步骤）")
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Chat with the AI about a job. Every exchange is kept in chat.json (the user's
# message is stored before the CLI runs, so a pending turn survives a page reload),
# and each AI reply links to the raw CLI call recorded in ai_calls.jsonl.
# ---------------------------------------------------------------------------

def chat_path(job_id: str) -> Path:
    return job_dir(job_id) / "chat.json"


def read_chat(job_id: str) -> list[dict]:
    p = chat_path(job_id)
    with _lock_for(job_id):
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else []


def update_chat(job_id: str, fn) -> None:
    p = chat_path(job_id)
    with _lock_for(job_id):
        messages = json.loads(p.read_text(encoding="utf-8")) if p.exists() else []
        fn(messages)
        p.write_text(json.dumps(messages, ensure_ascii=False, indent=2), encoding="utf-8")


@app.route("/api/job/<job_id>/chat")
def api_chat(job_id):
    # The CLI call times out at 180s, so a turn still pending well past that was cut
    # off by a server restart; close it out instead of spinning forever.
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
    if any(m.get("status") == "pending" and m["ts"] < cutoff for m in read_chat(job_id)):
        def expire(messages):
            for m in messages:
                if m.get("status") == "pending" and m["ts"] < cutoff:
                    m.update(status="error", text="这次请求被中断了（服务重启），请重新发送")
        update_chat(job_id, expire)
    return jsonify({"messages": read_chat(job_id)})


@app.route("/api/job/<job_id>/chat/event", methods=["POST"])
def api_chat_event(job_id):
    """A button action the user took in the UI, recorded in the AI chat so the
    conversation and the clicks share one history."""
    data = request.get_json(force=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "empty"}), 400
    update_chat(job_id, lambda m: m.append({
        "id": uuid.uuid4().hex[:12], "role": "event", "ts": now_iso(),
        "text": text, "step": data.get("step"),
    }))
    return jsonify({"ok": True})


@app.route("/api/job/<job_id>/ai_instruct", methods=["POST"])
def api_ai_instruct(job_id):
    data = request.get_json(force=True) or {}
    instruction = (data.get("instruction") or "").strip()
    selected_indices = data.get("selected_indices") or []
    provider = data.get("provider") or None
    if not instruction:
        return jsonify({"error": "请输入指令"}), 400
    jd = job_dir(job_id)
    srt_path = jd / "transcript.srt"
    if not srt_path.exists():
        return jsonify({"error": "字幕还没准备好"}), 400

    reply_id = uuid.uuid4().hex[:12]
    update_chat(job_id, lambda m: m.extend([
        {"id": uuid.uuid4().hex[:12], "role": "user", "ts": now_iso(), "step": "transcript",
         "text": instruction, "selected_indices": selected_indices},
        {"id": reply_id, "role": "assistant", "ts": now_iso(), "status": "pending", "step": "transcript",
         "provider": provider or ai_helper.get_active_provider_name()},
    ]))

    def finish(**fields):
        def apply(messages):
            for msg in messages:
                if msg["id"] == reply_id:
                    msg.update(ts=now_iso(), **fields)
        update_chat(job_id, apply)

    def calls_usage(call_ids):
        return sum_usage([c for c in ai_helper.read_calls(ai_calls_path(job_id)) if c["id"] in call_ids])

    with record_ai(job_id, "对话", tag=reply_id) as rec:
        try:
            with ai_helper.use_provider(provider):
                result = pipeline.claude_edit_transcript(srt_path, instruction, selected_indices=selected_indices)
        except Exception as e:
            finish(status="error", text=str(e), call_ids=rec.call_ids, usage=calls_usage(rec.call_ids))
            return jsonify({"error": str(e)}), 500
    finish(status="done", text=result.get("notes", ""), corrections=result.get("corrections", []),
           call_ids=rec.call_ids, usage=calls_usage(rec.call_ids))

    status = read_status(job_id)
    existing = {c["index"]: c for c in status.get("suggested_corrections", [])}
    for c in result.get("corrections", []):
        existing[c["index"]] = c
    write_status(job_id, suggested_corrections=list(existing.values()))
    note = f"AI 指令: {instruction}"
    if selected_indices:
        note += f"（选中了第 {', '.join(map(str, selected_indices))} 条）"
    log_event(job_id, note)
    return jsonify(result)


def sum_usage(calls: list[dict]) -> dict:
    total = {"calls": len(calls), "input_tokens": 0, "output_tokens": 0,
             "cache_read_tokens": 0, "cache_creation_tokens": 0, "cost_usd": 0.0}
    for c in calls:
        u = c.get("usage") or {}
        for k in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"):
            total[k] += u.get(k) or 0
        total["cost_usd"] += u.get("cost_usd") or 0
    total["cost_usd"] = round(total["cost_usd"], 4)
    return total


@app.route("/api/job/<job_id>/ai_calls")
def api_ai_calls(job_id):
    """Summaries only (the full prompts can be hundreds of KB); fetch one by id for detail."""
    calls = ai_helper.read_calls(ai_calls_path(job_id))
    return jsonify({"total": sum_usage(calls), "calls": [{
        "id": c["id"], "ts": c.get("ts"), "purpose": c.get("purpose"), "provider": c.get("provider"),
        "duration_ms": c.get("duration_ms"), "error": c.get("error"), "usage": c.get("usage"),
        "prompt_chars": len(c.get("prompt") or ""), "output_chars": len(c.get("output") or c.get("stdout") or ""),
    } for c in reversed(calls)]})


@app.route("/api/job/<job_id>/ai_live")
def api_ai_live(job_id):
    """Calls still running for this job, with the output streamed so far."""
    return jsonify({"calls": ai_helper.live_calls(ai_calls_path(job_id))})


@app.route("/api/ai/usage")
def api_ai_usage():
    """Account rate-limit windows (as last reported by the CLI) + this app's own
    recorded usage across all jobs."""
    calls = []
    for jd in JOBS_DIR.iterdir():
        for c in ai_helper.read_calls(jd / "ai_calls.jsonl"):
            c["job_id"] = jd.name
            calls.append(c)
    now = datetime.now()
    day_ago = (now - timedelta(days=1)).isoformat(timespec="seconds")
    week_ago = (now - timedelta(days=7)).isoformat(timespec="seconds")
    by_purpose: dict[str, list] = {}
    for c in calls:
        by_purpose.setdefault(c.get("purpose") or "其它", []).append(c)
    return jsonify({
        **ai_helper.load_usage(),
        "last_24h": sum_usage([c for c in calls if c.get("ts", "") >= day_ago]),
        "last_7d": sum_usage([c for c in calls if c.get("ts", "") >= week_ago]),
        "all_time": sum_usage(calls),
        "by_purpose": {k: sum_usage(v) for k, v in sorted(by_purpose.items())},
    })


@app.route("/api/job/<job_id>/ai_calls/<call_id>")
def api_ai_call(job_id, call_id):
    for c in ai_helper.read_calls(ai_calls_path(job_id)):
        if c["id"] == call_id:
            return jsonify(c)
    return jsonify({"error": "not found"}), 404


@app.route("/api/job/<job_id>/transcript_text")
def api_transcript_text(job_id):
    """Read-only confirmed subtitle text, for the "已完成的工作" summary to show on
    click regardless of which stage the job is on now."""
    srt_path = job_dir(job_id) / "transcript.srt"
    if not srt_path.exists():
        return jsonify({"entries": []})
    return jsonify({"entries": pipeline.parse_srt(srt_path)})


# ---------------------------------------------------------------------------
# Video podcast: re-record the confirmed script as audio, force-align it, and
# (later) export a karaoke-style video from just the audio + timed script.
# ---------------------------------------------------------------------------

def run_podcast_align(job_id: str):
    jd = job_dir(job_id)
    try:
        write_status(job_id, podcast_state="aligning", podcast_error=None)
        audio_name = read_status(job_id).get("podcast_audio")
        markup = _podcast_markup(jd)
        lines = pipeline.align_podcast_recording(
            jd / "podcast" / audio_name,
            pipeline.podcast_script_lines(jd / "transcript.srt", markup),
            jd / "podcast" / "lines.json",
        )
        write_status(job_id, podcast_state="aligned", podcast_lines=lines)
        log_event(job_id, "播客录音已完成时间轴对齐")
    except Exception:
        write_status(job_id, podcast_state="error", podcast_error=traceback.format_exc())
        log_event(job_id, "播客录音对齐失败")


@app.route("/api/job/<job_id>/podcast/upload", methods=["POST"])
def api_podcast_upload(job_id):
    if not read_status(job_id).get("confirmed_transcript"):
        return jsonify({"error": "还没有确认字幕，播客需要一份定稿的稿件"}), 400
    f = request.files.get("audio")
    if not f:
        return jsonify({"error": "没有收到音频"}), 400
    jd = job_dir(job_id)
    podcast_dir = jd / "podcast"
    podcast_dir.mkdir(exist_ok=True)
    for old in podcast_dir.glob("recording.*"):
        old.unlink()
    ext = Path(f.filename or "recording.webm").suffix or ".webm"
    dest = podcast_dir / f"recording{ext}"
    f.save(dest)
    write_status(job_id, podcast_state="recorded", podcast_audio=dest.name,
                 podcast_lines=None, podcast_error=None)
    log_event(job_id, f"播客录音已保存: {dest.name}")
    return jsonify({"ok": True})


def _podcast_markup(jd: Path):
    p = jd / "podcast" / "markup.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


@app.route("/api/job/<job_id>/podcast/clip/<int:index>", methods=["POST", "DELETE"])
def api_podcast_clip(job_id, index):
    """One recorded take for one script line (line-by-line recording mode)."""
    clips_dir = job_dir(job_id) / "podcast" / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)
    for old in clips_dir.glob(f"{index}_*"):
        old.unlink()
    clips = dict(read_status(job_id).get("podcast_clips") or {})
    if request.method == "DELETE":
        clips.pop(str(index), None)
    else:
        f = request.files.get("audio")
        if not f:
            return jsonify({"error": "没有收到音频"}), 400
        ext = Path(f.filename or "clip.webm").suffix or ".webm"
        name = f"{index}_{int(time.time() * 1000)}{ext}"
        f.save(clips_dir / name)
        clips[str(index)] = name
    write_status(job_id, podcast_clips=clips)
    return jsonify({"ok": True, "clips": clips})


def run_podcast_merge(job_id: str):
    jd = job_dir(job_id)
    try:
        write_status(job_id, podcast_state="merging", podcast_error=None)
        clips = read_status(job_id).get("podcast_clips") or {}
        script = pipeline.podcast_script_lines(jd / "transcript.srt", _podcast_markup(jd))
        ordered = [{"index": l["index"], "text": l["text"], "path": jd / "podcast" / "clips" / clips[str(l["index"])]}
                   for l in script if str(l["index"]) in clips]
        if not ordered:
            raise RuntimeError("还没有录任何一句")
        podcast_dir = jd / "podcast"
        for old in podcast_dir.glob("recording.*"):
            old.unlink()
        out = podcast_dir / "recording.m4a"
        lines = pipeline.merge_podcast_clips(ordered, out)
        (podcast_dir / "lines.json").write_text(json.dumps(lines, ensure_ascii=False, indent=2), encoding="utf-8")
        write_status(job_id, podcast_state="aligned", podcast_audio=out.name, podcast_lines=lines)
        log_event(job_id, f"已合并逐句录音（{len(lines)} 句）")
    except Exception:
        write_status(job_id, podcast_state="error", podcast_error=traceback.format_exc())
        log_event(job_id, "合并逐句录音失败")


@app.route("/api/job/<job_id>/podcast/merge", methods=["POST"])
def api_podcast_merge(job_id):
    threading.Thread(target=run_podcast_merge, args=(job_id,), daemon=True).start()
    return jsonify({"ok": True})


@app.route("/api/job/<job_id>/podcast/align", methods=["POST"])
def api_podcast_align(job_id):
    threading.Thread(target=run_podcast_align, args=(job_id,), daemon=True).start()
    return jsonify({"ok": True})


def run_podcast_markup(job_id: str):
    jd = job_dir(job_id)
    try:
        write_status(job_id, podcast_markup_state="generating")
        with record_ai(job_id, "播客稿件标注"):
            markup = pipeline.generate_podcast_markup(jd / "transcript.srt")
        (jd / "podcast").mkdir(exist_ok=True)
        (jd / "podcast" / "markup.json").write_text(
            json.dumps(markup, ensure_ascii=False, indent=2), encoding="utf-8")
        write_status(job_id, podcast_markup_state="ready")
        log_event(job_id, "播客稿件的假名注音/重点标注已生成")
    except Exception:
        write_status(job_id, podcast_markup_state="error", podcast_markup_error=traceback.format_exc())
        log_event(job_id, "播客稿件标注生成失败")


@app.route("/api/job/<job_id>/podcast/markup", methods=["POST"])
def api_podcast_markup(job_id):
    threading.Thread(target=run_podcast_markup, args=(job_id,), daemon=True).start()
    return jsonify({"ok": True})


@app.route("/api/job/<job_id>/rename", methods=["POST"])
def api_rename_job(job_id):
    if not (job_dir(job_id) / "status.json").exists():
        return jsonify({"error": "not found"}), 404
    name = (request.get_json(force=True).get("video_name") or "").strip()
    if not name:
        return jsonify({"error": "文件名不能为空"}), 400
    old = read_status(job_id).get("video_name", "")
    if name != old:
        write_status(job_id, video_name=name)
        log_event(job_id, f"文件名 {old} → {name}")
    return jsonify({"ok": True, "video_name": name})


@app.route("/api/job/<job_id>/blog_content")
def api_get_blog_content(job_id):
    status = read_status(job_id)
    path = status.get("blog_path")
    if not path or not Path(path).exists():
        return jsonify({"content": ""})
    return jsonify({"content": Path(path).read_text(encoding="utf-8")})


@app.route("/api/job/<job_id>/blog_content", methods=["POST"])
def api_save_blog_content(job_id):
    data = request.get_json(force=True)
    status = read_status(job_id)
    path = status.get("blog_path")
    if not path:
        return jsonify({"error": "no blog file for this job yet"}), 400
    Path(path).write_text(data.get("content", ""), encoding="utf-8")
    log_event(job_id, "手动编辑了博客文章原文")
    return jsonify({"ok": True})


@app.route("/api/job/<job_id>/export_blog", methods=["POST"])
def api_export_blog(job_id):
    """Copy the job's blog.md into the blog repo as this episode's post. An existing,
    different file there is only replaced when the request says overwrite."""
    data = request.get_json(force=True) or {}
    status = read_status(job_id)
    path = status.get("blog_path")
    if not path or not Path(path).exists():
        return jsonify({"error": "这个任务还没有博客文章"}), 400
    content = Path(path).read_text(encoding="utf-8")
    try:
        target = pipeline.blog_export_path(content, status.get("blog_number") or 1)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    if (target.exists() and target.read_text(encoding="utf-8") != content
            and not data.get("overwrite")):
        return jsonify({"error": "exists", "path": str(target)}), 409

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    write_status(job_id, blog_exported_path=str(target), blog_exported_at=now_iso())
    log_event(job_id, f"博客文章已导出到 {target}")
    return jsonify({"ok": True, "path": str(target)})


@app.route("/api/job/<job_id>/regenerate_blog", methods=["POST"])
def api_regenerate_blog(job_id):
    status = read_status(job_id)
    old_path = status.get("blog_path")
    if old_path and Path(old_path).exists():
        Path(old_path).unlink()
    thread = threading.Thread(target=run_stage_blog, args=(job_id,), daemon=True)
    thread.start()
    return jsonify({"ok": True})


@app.route("/api/job/<job_id>/confirm_blog", methods=["POST"])
def api_confirm_blog(job_id):
    write_status(job_id, confirmed_blog=True)
    log_event(job_id, "博客文章已确认")
    thread = threading.Thread(target=run_stage_caption_prep, args=(job_id,), daemon=True)
    thread.start()
    return jsonify({"ok": True})


@app.route("/api/job/<job_id>/discard_blog", methods=["POST"])
def api_discard_blog(job_id):
    status = read_status(job_id)
    path = status.get("blog_path")
    if path and Path(path).exists():
        Path(path).unlink()
        log_event(job_id, f"已丢弃博客文章文件 {path}")
    write_status(job_id, blog_path=None, blog_url=None, confirmed_blog=True)
    thread = threading.Thread(target=run_stage_caption_prep, args=(job_id,), daemon=True)
    thread.start()
    return jsonify({"ok": True})


@app.route("/api/job/<job_id>/platform/<platform>/cover", methods=["POST"])
def api_render_platform_cover(job_id, platform):
    """Render (and keep) one platform's cover from a candidate frame + overlay copy.
    Per-platform choices live under status["platforms"][platform]."""
    spec = pipeline.PLATFORMS.get(platform)
    if not spec:
        return jsonify({"error": f"unknown platform {platform}"}), 404
    data = request.get_json(force=True) or {}
    jd = job_dir(job_id)
    status = read_status(job_id)
    platforms = status.get("platforms", {})
    saved = platforms.get(platform, {})

    frame_name = (data.get("frame") or saved.get("frame") or status.get("selected_frame")
                  or (status.get("candidate_frames") or [None])[0])
    if not frame_name or not (jd / "frames" / frame_name).exists():
        return jsonify({"error": "没有可用的封面候选帧"}), 400
    cover = dict(saved.get("cover") or status.get("creative", {}).get("thumbnail", {}))
    for key in ("tag", "title_line1", "title_line2", "subtitle"):
        if key in data:
            cover[key] = data[key]

    out_path = jd / spec["cover_file"]
    pipeline.render_thumbnail(jd / "frames" / frame_name, cover, out_path, size=spec["size"])

    platforms[platform] = {**saved, "frame": frame_name, "cover": cover}
    write_status(job_id, platforms=platforms)
    return jsonify({"ok": True, "cover_url": f"/job/{job_id}/file/{spec['cover_file']}?_={uuid.uuid4().hex[:6]}"})


@app.route("/api/job/<job_id>/recaption", methods=["POST"])
def api_recaption(job_id):
    data = request.get_json(force=True) or {}
    fontsize = int(data.get("fontsize", 130))
    thread = threading.Thread(target=run_stage_caption_prep, args=(job_id, fontsize), daemon=True)
    thread.start()
    return jsonify({"ok": True})


@app.route("/api/job/<job_id>/confirm_captions", methods=["POST"])
def api_confirm_captions(job_id):
    write_status(job_id, confirmed_captions=True)
    log_event(job_id, "字幕样式已确认，开始导出完整视频")
    thread = threading.Thread(target=run_stage_final_render, args=(job_id,), daemon=True)
    thread.start()
    return jsonify({"ok": True})


@app.route("/api/job/<job_id>/retry", methods=["POST"])
def api_retry_job(job_id):
    """Re-run whichever stage a job was stuck/errored in (e.g. after a server restart)."""
    jd = job_dir(job_id)
    if not (jd / "status.json").exists():
        return jsonify({"error": "not found"}), 404
    status = read_status(job_id)
    stage = status.get("stage")

    # For an errored job, infer the right stage to resume from by what's on disk.
    if stage == "error":
        if not (jd / "transcript.srt").exists():
            stage = "transcribing"
        elif not status.get("confirmed_blog"):
            stage = "blog_processing"
        elif not (jd / "captions.ass").exists():
            stage = "caption_processing"
        elif not (jd / "final.mp4").exists():
            stage = "caption_processing"
        else:
            stage = "rendering_final"

    runners = {
        "uploaded": run_stage_transcribe,
        "transcribing": run_stage_transcribe,
        "blog_processing": run_stage_blog,
        "caption_processing": lambda jid: run_stage_caption_prep(jid, status.get("fontsize", 130)),
        "rendering_final": run_stage_final_render,
    }
    runner = runners.get(stage)
    if not runner:
        return jsonify({"error": f"stage '{stage}' 不支持重试（可能需要在网页上手动继续）"}), 400

    log_event(job_id, f"手动重试阶段: {stage}")
    write_status(job_id, stage=stage, error=None)
    threading.Thread(target=runner, args=(job_id,), daemon=True).start()
    return jsonify({"ok": True, "retrying_stage": stage})


@app.route("/api/job/<job_id>/publish_youtube", methods=["POST"])
def api_publish_youtube(job_id):
    data = request.get_json(force=True) or {}
    title = data.get("title", "").strip()
    description = data.get("description", "").strip()
    tags = [t.strip() for t in data.get("tags", "").split(",") if t.strip()]
    privacy_status = data.get("privacy_status", "private")
    if privacy_status not in ("private", "unlisted", "public"):
        return jsonify({"error": "invalid privacy_status"}), 400
    if not title:
        return jsonify({"error": "title is required"}), 400

    jd = job_dir(job_id)
    if not (jd / "final.mp4").exists():
        return jsonify({"error": "final.mp4 不存在，请先完成导出"}), 400

    write_status(job_id, selected_title=title)
    thread = threading.Thread(target=run_publish_youtube,
                               args=(job_id, title, description, tags, privacy_status), daemon=True)
    thread.start()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Serve the built React app (frontend/dist) for every other GET route, so
# client-side routes like /jobs/<id> and /settings work on a hard refresh.
# Registered last: Flask/Werkzeug still matches the more specific routes above
# (/api/*, /job/<id>/file/*, /job/<id>/theater) ahead of this catch-all.
# ---------------------------------------------------------------------------

@app.route("/", defaults={"_path": ""})
@app.route("/<path:_path>")
def spa_catch_all(_path):
    index_path = FRONTEND_DIST / "index.html"
    if not index_path.exists():
        return (
            "前端还没构建。开发时运行：\n"
            "  npm --prefix frontend run dev\n"
            "然后打开 http://localhost:5173\n\n"
            "或者构建一次让这个 Flask 进程直接提供页面：\n"
            "  npm --prefix frontend run build\n"
            "然后刷新这个地址。",
            200,
            {"Content-Type": "text/plain; charset=utf-8"},
        )
    return send_from_directory(FRONTEND_DIST, "index.html")


@app.errorhandler(404)
def spa_fallback(e):
    # The dist static route (static_url_path="") claims every path before the
    # catch-all above can, and 404s client-side routes like /settings or /jobs/<id>
    # on a hard refresh. Hand those to the React app; real API/file misses stay 404.
    if request.method == "GET" and not request.path.startswith(("/api/", "/job/", "/assets/")):
        return spa_catch_all(request.path.lstrip("/"))
    return e


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001, debug=False, threaded=True)
