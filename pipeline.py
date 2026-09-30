"""Core processing steps for the vlog auto-editing pipeline.

Every function here is a pure step: it reads some files from a job directory
and writes new files into it. `app.py` orchestrates these steps in background
threads and updates status.json between steps so the web UI can show progress
and pause for the user's confirmation at the right points.
"""
from __future__ import annotations

import contextvars
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

import cv2
from PIL import Image, ImageDraw, ImageFont

import ai_helper

BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"
YUNET_MODEL = MODELS_DIR / "yunet.onnx"
JOBS_DIR = BASE_DIR / "jobs"

# Machine-specific paths come from the environment (or a local .env file, see
# .env.example) so the code carries no one's home directory.
BLOG_PROJECT_DIR = Path(os.environ.get("VLOGSMITH_BLOG_DIR", "~/blog")).expanduser()
CONTENT_BLOG_ROOT = BLOG_PROJECT_DIR / "src" / "content" / "blog"
SERIES_ROOT = CONTENT_BLOG_ROOT / "ja" / "japanese"

FONT_PATH = os.environ.get("VLOGSMITH_FONT", "/System/Library/Fonts/Hiragino Sans GB.ttc")
FONT_BOLD_INDEX = 2  # W6 bold face inside the ttc

CHANNEL_STYLE_NOTES = """频道过往视频标题范例（要模仿这种"具体细节/数字钩子 + 地点 + Vlog/记录/休日"的风格）：
- 語学学校の期末試験結果発表！想像以上に苦戦したポイントと今後の計画
- 東京・水元公園｜ただ歩く、贅沢な午後。水辺と森と猫に出会う散歩Vlog
- 初めて日本の1400円カットに行った休日の記録
- 来日して半年。一面の曼珠沙華と日和田山を歩いた秋の休日
- 来日して半年。語学学校の期末テストが終わった日の荒川散歩

缩略图风格：左上角白底黑字地点小标签、大号加粗黑边描边标题（1~2行，白色或黄色）、标题下方小字白色副标题。"""


# Where Homebrew may live: Apple Silicon, Intel, and a per-user install.
HOMEBREW_PREFIXES = [Path("/opt/homebrew"), Path("/usr/local"), Path.home() / ".homebrew"]


def resolve_ffmpeg_full() -> str:
    candidates = [
        os.environ.get("FFMPEG_PATH"),
        *(str(prefix / "opt/ffmpeg-full/bin/ffmpeg") for prefix in HOMEBREW_PREFIXES),
        shutil.which("ffmpeg-full"),
        shutil.which("ffmpeg"),
    ]
    for c in candidates:
        if c and Path(c).exists():
            return c
    raise RuntimeError("找不到 ffmpeg，请先运行 `brew install ffmpeg-full`")


def resolve_ffprobe() -> str:
    candidates = [
        os.environ.get("FFPROBE_PATH"),
        *(str(prefix / "opt/ffmpeg-full/bin/ffprobe") for prefix in HOMEBREW_PREFIXES),
        shutil.which("ffprobe"),
    ]
    for c in candidates:
        if c and Path(c).exists():
            return c
    raise RuntimeError("找不到 ffprobe")


def get_duration_seconds(video_path: Path) -> float:
    ffprobe = resolve_ffprobe()
    out = subprocess.run(
        [ffprobe, "-v", "quiet", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(video_path)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def get_shot_at(video_path: Path) -> str | None:
    """Read the camera's own recording timestamp (QuickTime creation_time), when
    the file has one — this is when it was actually filmed, not when it was
    uploaded into the tool."""
    ffprobe = resolve_ffprobe()
    out = subprocess.run(
        [ffprobe, "-v", "quiet", "-show_entries", "format_tags=creation_time",
         "-of", "csv=p=0", str(video_path)],
        capture_output=True, text=True,
    )
    value = out.stdout.strip()
    return value or None


# ---------------------------------------------------------------------------
# Step 1: audio extraction + Whisper transcription
# ---------------------------------------------------------------------------

def extract_audio(video_path: Path, out_wav: Path) -> None:
    ffmpeg = resolve_ffmpeg_full()
    subprocess.run(
        [ffmpeg, "-y", "-i", str(video_path), "-ar", "16000", "-ac", "1",
         "-c:a", "pcm_s16le", str(out_wav)],
        capture_output=True, text=True, check=True,
    )


def transcribe(wav_path: Path, out_dir: Path, model_size: str = "small") -> Path:
    whisper_bin = shutil.which("whisper") or str(BASE_DIR / ".venv" / "bin" / "whisper")
    subprocess.run(
        [whisper_bin, str(wav_path), "--model", model_size, "--language", "Japanese",
         "--output_format", "srt", "--output_dir", str(out_dir)],
        capture_output=True, text=True, check=True,
    )
    srt_path = out_dir / (wav_path.stem + ".srt")
    if not srt_path.exists():
        raise RuntimeError("Whisper 没有生成 srt 文件")
    return srt_path


# ---------------------------------------------------------------------------
# Step 1b: podcast re-recording — force-align a fresh reading against the
# already-corrected script (transcript.srt) so the video-podcast export knows
# when each line was actually spoken this time.
# ---------------------------------------------------------------------------

def normalize_audio_to_wav(src_path: Path, out_wav: Path) -> None:
    ffmpeg = resolve_ffmpeg_full()
    subprocess.run(
        [ffmpeg, "-y", "-i", str(src_path), "-ar", "16000", "-ac", "1",
         "-c:a", "pcm_s16le", str(out_wav)],
        capture_output=True, text=True, check=True,
    )


def merge_podcast_clips(clips: list[dict], out_path: Path, gap: float = 0.35) -> list[dict]:
    """Line-by-line recording: trim each clip's leading/trailing silence, join
    them in script order with a short pause, and return exact per-line timings
    (no speech alignment needed — every clip already belongs to one line).
    `clips` items: {"index", "text", "path"}."""
    import tempfile
    import wave

    ffmpeg = resolve_ffmpeg_full()
    rate = 48000
    trim = ("silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08,areverse,"
            "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08,areverse")
    results = []
    with tempfile.TemporaryDirectory() as tmp:
        merged_wav = Path(tmp) / "merged.wav"
        with wave.open(str(merged_wav), "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(rate)
            silence = b"\x00\x00" * int(rate * gap)
            t = 0.0
            for i, clip in enumerate(clips):
                wav = Path(tmp) / f"{i}.wav"
                base = [ffmpeg, "-y", "-i", str(clip["path"]), "-ar", str(rate), "-ac", "1", "-c:a", "pcm_s16le"]
                subprocess.run(base + ["-af", trim, str(wav)], capture_output=True, check=True)
                with wave.open(str(wav), "rb") as w:
                    frames = w.readframes(w.getnframes())
                if len(frames) < rate * 2 * 0.2:  # trimmed away (very quiet take) -> keep it untrimmed
                    subprocess.run(base + [str(wav)], capture_output=True, check=True)
                    with wave.open(str(wav), "rb") as w:
                        frames = w.readframes(w.getnframes())
                if i:
                    out.writeframes(silence)
                    t += gap
                dur = len(frames) / (rate * 2)
                out.writeframes(frames)
                results.append({"index": clip["index"], "text": clip["text"],
                                "start": round(t, 2), "end": round(t + dur, 2)})
                t += dur
        subprocess.run([ffmpeg, "-y", "-i", str(merged_wav), "-c:a", "aac", "-b:a", "160k", str(out_path)],
                       capture_output=True, check=True)
    return results


def _flatten_word_timestamps(whisper_json: dict) -> list[dict]:
    words = []
    for seg in whisper_json.get("segments", []):
        for w in seg.get("words", []):
            if w.get("word"):
                words.append({"text": w["word"], "start": w["start"], "end": w["end"]})
    return words


def _char_timeline(words: list[dict]) -> tuple[str, list[float]]:
    """Expand word/token chunks into a per-character string + parallel timestamps
    (each character's time interpolated across its chunk's [start, end]). Whisper's
    "words" for Japanese are really just short token chunks since Japanese has no
    spaces, so working at the character level is more robust than word matching."""
    chars, times = [], []
    for w in words:
        text = w["text"]
        span = max(w["end"] - w["start"], 0.001)
        for i, ch in enumerate(text):
            chars.append(ch)
            times.append(w["start"] + span * (i / max(len(text), 1)))
    return "".join(chars), times


def align_podcast_recording(audio_path: Path, lines: list[dict], out_json: Path,
                             model_size: str = "small") -> list[dict]:
    import difflib

    work_dir = audio_path.parent
    wav_path = work_dir / "recording_16k.wav"
    normalize_audio_to_wav(audio_path, wav_path)

    whisper_bin = shutil.which("whisper") or str(BASE_DIR / ".venv" / "bin" / "whisper")
    subprocess.run(
        [whisper_bin, str(wav_path), "--model", model_size, "--language", "Japanese",
         "--word_timestamps", "True", "--output_format", "json", "--output_dir", str(work_dir)],
        capture_output=True, text=True, check=True,
    )
    whisper_json = json.loads((work_dir / (wav_path.stem + ".json")).read_text(encoding="utf-8"))
    rec_text, rec_times = _char_timeline(_flatten_word_timestamps(whisper_json))

    clean_texts = [re.sub(r"\s+", "", e["text"]) for e in lines]
    script_text = "".join(clean_texts)

    matcher = difflib.SequenceMatcher(None, script_text, rec_text, autojunk=False)
    mapping = {}
    for block in matcher.get_matching_blocks():
        for k in range(block.size):
            mapping[block.a + k] = block.b + k

    results = []
    cursor = 0
    last_end = 0.0
    for entry, clean in zip(lines, clean_texts):
        positions = [mapping[p] for p in range(cursor, cursor + len(clean)) if p in mapping]
        if positions and rec_times:
            start = rec_times[min(positions)]
            end = rec_times[min(max(positions) + 1, len(rec_times) - 1)]
        else:
            start = end = last_end
        start = max(start, last_end)
        end = max(end, start + 0.3)
        results.append({"index": entry["index"], "text": entry["text"], "start": round(start, 2), "end": round(end, 2)})
        last_end = end
        cursor += len(clean)

    out_json.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    return results


# ---------------------------------------------------------------------------
# SRT parsing helpers (shared by claude cleanup + ASS building)
# ---------------------------------------------------------------------------

def parse_srt(path: Path):
    text = path.read_text(encoding="utf-8")
    blocks = re.split(r"\n\s*\n", text.strip())
    entries = []
    for b in blocks:
        lines = b.strip().split("\n")
        if len(lines) < 2:
            continue
        idx = int(lines[0].strip())
        start, end = [x.strip() for x in lines[1].split("-->")]
        content = " ".join(lines[2:]).strip()
        entries.append({"index": idx, "start": start, "end": end, "text": content})
    return entries


def write_srt(entries, path: Path) -> None:
    lines = []
    for e in entries:
        lines.append(str(e["index"]))
        lines.append(f"{e['start']} --> {e['end']}")
        lines.append(e["text"])
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


# ---------------------------------------------------------------------------
# Step 1b: Claude-assisted transcript cleanup (suggestions only)
# ---------------------------------------------------------------------------

def claude_suggest_corrections(srt_path: Path) -> dict:
    srt_text = srt_path.read_text(encoding="utf-8")
    prompt = f"""你是日语 vlog 字幕校对助手，风格参照 erzhiqian.cc 博客"やさしい日本語"系列
（每期视频的"この話のポイント"板块：一段背景说明 + 2~4条挑出来的重点，每条讲一个具体的听写错误
或口语表达问题、错在哪、更好的说法是什么）。

下面是 Whisper 自动识别生成的日语 SRT 字幕，可能包含数字听错（比如15/25混淆）、同音词误认、
专有名词识别错误（地名/品牌名）等 ASR 常见错误，也可能包含说话人自己的语法/表达问题。

请你：
1. 逐条检查字幕，只在你有较高把握判断是识别错误或明显语法问题、并且能从上下文合理推断真实内容时
   才提出修改；拿不准的不要瞎猜，跳过即可。不要改变说话人原本的语气和意思。
2. 从这些修改里挑出 2~4 条最值得学习者注意的"重点"（比如某类反复出现的听写错误模式、或某个语法点），
   每条要说清楚：错在哪、为什么错、更自然的说法是什么，并关联到具体的字幕编号。

请严格输出 JSON，不要输出任何其他文字：
{{
  "corrections": [{{"index": 字幕编号(数字), "original": "原文", "fixed": "建议修正后的文本", "reason": "简短原因"}}],
  "context": "一段整体背景说明，这期视频在讲什么、字幕整体质量如何",
  "points": [{{"title": "重点标题（比如"专有名词地名容易听错"）", "body": "具体说明错在哪、为什么、更好的说法", "anchor_index": 关联的字幕编号(数字)}}]
}}

字幕内容：
{srt_text}
"""
    return ai_helper.call_json(prompt, timeout=180)


def claude_edit_transcript(srt_path: Path, instruction: str,
                            selected_indices: list[int] | None = None) -> dict:
    """Free-form natural-language edit request, e.g. '把第5-8条润色得更自然一点'.

    `selected_indices` are entries the user explicitly checked in the web UI before
    typing the instruction — treat those as the primary target even if the wording
    of the instruction itself is vague (e.g. "这句话感觉不太对").

    Returns the same {"corrections": [...], "notes": "..."} shape as
    claude_suggest_corrections so the web UI can reuse one rendering path.
    """
    entries = parse_srt(srt_path)
    srt_text = srt_path.read_text(encoding="utf-8")

    selected_block = ""
    if selected_indices:
        by_index = {e["index"]: e for e in entries}
        lines = [f"[{i}] {by_index[i]['text']}" for i in selected_indices if i in by_index]
        selected_block = (
            "用户在网页上勾选了下面这几条字幕作为这次指令的重点对象，请优先处理这些行；"
            "如果指令内容明显只针对这些行，就只改这些，不要动其他行：\n" + "\n".join(lines) + "\n\n"
        )

    prompt = f"""你是日语 vlog 字幕编辑助手。下面是当前的日语 SRT 字幕，用户给了一个具体的修改指令，
请你按这个指令找出需要改的行、给出修改后的文本。只处理指令涉及到的部分，不要顺带改动指令没提到的地方。
如果指令本身不清楚指的是哪几行，用你的best judgement从上下文判断，并在 notes 里说明你是怎么理解的。

{selected_block}用户的指令：{instruction}

请严格输出 JSON，不要输出任何其他文字：
{{"corrections": [{{"index": 字幕编号(数字), "original": "原文", "fixed": "修改后的文本", "reason": "简短说明改了什么"}}], "notes": "一句话说明你是怎么理解并执行这个指令的"}}

字幕内容：
{srt_text}
"""
    return ai_helper.call_json(prompt, timeout=180)


def apply_corrections(entries, corrections: list[dict]):
    by_index = {e["index"]: e for e in entries}
    applied = []
    for c in corrections:
        idx = c.get("index")
        e = by_index.get(idx)
        if e and e["text"] == c.get("original"):
            e["text"] = c["fixed"]
            applied.append(c)
    return applied


# ---------------------------------------------------------------------------
# Step 2: thumbnail candidate frames
# ---------------------------------------------------------------------------

def extract_candidate_frames(video_path: Path, out_dir: Path, count: int = 6) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    duration = get_duration_seconds(video_path)
    ffmpeg = resolve_ffmpeg_full()
    paths = []
    for i in range(count):
        t = duration * (i + 1) / (count + 1)
        out_path = out_dir / f"candidate_{i:02d}.jpg"
        subprocess.run(
            [ffmpeg, "-y", "-ss", str(t), "-i", str(video_path),
             "-frames:v", "1", "-q:v", "2", str(out_path)],
            capture_output=True, text=True, check=True,
        )
        paths.append(out_path)
    return paths


# ---------------------------------------------------------------------------
# Step 2b: face detection + mosaic blur
# ---------------------------------------------------------------------------

def blur_faces(src_path: Path, out_path: Path, score_threshold: float = 0.3) -> int:
    img = cv2.imread(str(src_path))
    h, w = img.shape[:2]
    detector = cv2.FaceDetectorYN_create(
        str(YUNET_MODEL), "", (w, h),
        score_threshold=score_threshold, nms_threshold=0.3, top_k=5000,
    )
    detector.setInputSize((w, h))
    _, faces = detector.detect(img)

    out = img.copy()
    count = 0
    if faces is not None:
        for f in faces:
            x, y, fw, fh = [int(v) for v in f[:4]]
            pad_x, pad_y = int(fw * 0.4), int(fh * 0.5)
            x0, y0 = max(0, x - pad_x), max(0, y - pad_y)
            x1, y1 = min(w, x + fw + pad_x), min(h, y + fh + pad_y)
            roi = out[y0:y1, x0:x1]
            if roi.size == 0:
                continue
            block = max(8, fw // 8)
            rh, rw = roi.shape[:2]
            small = cv2.resize(roi, (max(1, rw // block), max(1, rh // block)))
            out[y0:y1, x0:x1] = cv2.resize(small, (rw, rh), interpolation=cv2.INTER_NEAREST)
            count += 1
    cv2.imwrite(str(out_path), out, [cv2.IMWRITE_JPEG_QUALITY, 95])
    return count


# ---------------------------------------------------------------------------
# Step 3: Claude creative brief (titles, thumbnail copy, highlight words)
# ---------------------------------------------------------------------------

def claude_creative_brief(srt_path: Path) -> dict:
    entries = parse_srt(srt_path)
    transcript_plain = "\n".join(f"[{e['index']}] {e['text']}" for e in entries)
    prompt = f"""你是 YouTube 频道 "Itsuki No Nihongo"（日语学习/生活vlog）的运营助手。

{CHANNEL_STYLE_NOTES}

下面是这期新视频（涩谷十字路口 vlog）的完整字幕文本，每行前面 [数字] 是字幕编号。请你：
1. 给出 3 个日语标题方案，模仿上面的风格
2. 给出缩略图文案：地点标签 tag（比如"東京・渋谷"）、大标题 title_line1 / title_line2（各不超过7个字，适合缩略图大字）、副标题 subtitle（一行简短说明）
3. 从字幕原文中挑选 10~20 个适合在硬字幕里高亮强调的关键词/短语，必须是字幕原文中逐字出现的片段（数字、地名、情绪词等），按字幕编号给出

严格只输出 JSON，不要输出任何其他文字：
{{"titles": ["...", "...", "..."], "thumbnail": {{"tag": "...", "title_line1": "...", "title_line2": "...", "subtitle": "..."}}, "highlights": {{"字幕编号(字符串)": ["词1", "词2"]}}}}

字幕内容：
{transcript_plain}
"""
    return ai_helper.call_json(prompt, timeout=240)


# ---------------------------------------------------------------------------
# Podcast script markup: every line split into words, each with its kana reading
# and part of speech (drives the furigana / romaji / per-type colors of the
# teleprompter and the final karaoke video), plus a Chinese translation.
# Compact array tokens keep the output small; batches run in parallel.
# ---------------------------------------------------------------------------

PODCAST_POS = ("noun", "proper", "pronoun", "verb", "adj", "adv", "particle",
               "aux", "conj", "interj", "prefix", "number", "punct")


def _podcast_markup_batch(batch: list[dict]) -> dict:
    transcript_plain = "\n".join(f"[{e['index']}] {e['text']}" for e in batch)
    prompt = f"""下面是一份日语 vlog 的字幕稿（每行一条，[编号] 原文），要改成视频播客的朗读稿。请逐条整理、分词标注并翻译成中文。

先整理：口语里重复的内容要去掉——同一句里重复说的词或短语（比如「山中口 川口 山中口 川口」「えーと えーと」、
说错后马上重说的部分）只保留一次；和上一条意思完全重复的整条，输出 {{"drop": true}}。
除了删掉重复，不要改写、润色或增加内容，保留原本的说法。

对每一条（没有 drop 的）输出：
- "t"：整理后这一条的分词结果，数组，每个元素是 [词, 读音, 词性]
  - 词：按学习者友好的粒度切分（动词/形容词连同活用词尾和紧跟的「て/た/ます/ない」等作为一个词，
    例如「散ってゆく」「知った」「触れて」「寒くなりました」可以各算一个词；助词单独切出）。
    所有词按顺序拼接起来就是整理后的这一条：除了去掉的重复部分，其余字符与原文逐字一致（标点、数字照抄）。
  - 读音：这个词的平假名读音（片假名词也写成平假名；数字按实际读法；标点写空字符串 ""）。
  - 词性：只能是以下之一：{", ".join(PODCAST_POS)}
    （proper=人名地名店名等专有名词，aux=助动词/です/ます 单独出现时，punct=标点符号）
- "zh"：这一条自然、口语化的中文翻译。

严格只输出 JSON，不要输出任何其他文字，格式：
{{"编号(字符串)": {{"t": [["今日", "きょう", "noun"], ["は", "は", "particle"], ...], "zh": "..."}}, "编号": {{"drop": true}}}}
每一条都必须输出（要么有 t 和 zh，要么是 drop）。

字幕内容：
{transcript_plain}
"""
    result = ai_helper.call_json(prompt, timeout=600)
    return result if isinstance(result, dict) else {}


def podcast_script_lines(srt_path: Path, markup: dict | None) -> list[dict]:
    """The script actually read for the podcast: the cleaned (de-duplicated) text
    from markup.json when it has token data, else the confirmed subtitles as-is."""
    lines = []
    for e in parse_srt(srt_path):
        m = (markup or {}).get(str(e["index"])) or {}
        if m.get("drop"):
            continue
        text = "".join(tok[0] for tok in m["t"]) if m.get("t") else e["text"]
        lines.append({"index": e["index"], "text": text})
    return lines


def generate_podcast_markup(srt_path: Path, batch_size: int = 40) -> dict:
    from concurrent.futures import ThreadPoolExecutor
    entries = parse_srt(srt_path)
    batches = [entries[i:i + batch_size] for i in range(0, len(entries), batch_size)]
    merged: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        # A fresh context copy per batch carries the caller's AI call recorder into
        # the worker threads (one Context can't be entered by two threads at once).
        futures = [pool.submit(contextvars.copy_context().run, _podcast_markup_batch, b) for b in batches]
        for fut in futures:
            merged.update(fut.result())
    return merged


# ---------------------------------------------------------------------------
# Step 3b: per-platform cover image, designed at export/publish time
# ---------------------------------------------------------------------------

# One entry per publish target. `cover_file` is where that platform's cover is
# written inside the job folder; YouTube keeps thumbnail.jpg since it doubles as
# the job's cover in the dashboard/sidebar.
PLATFORMS = {
    "youtube": {"label": "YouTube", "size": (1280, 720), "cover_file": "thumbnail.jpg"},
}


def render_thumbnail(blurred_frame_path: Path, cover: dict, out_path: Path,
                      size: tuple[int, int] = (1280, 720),
                      title_fontsize: int = 92, sub_fontsize: int = 42) -> None:
    """`cover` holds the overlay copy: tag / title_line1 / title_line2 / subtitle."""
    W, H = size
    img = Image.open(blurred_frame_path).convert("RGB").resize((W, H), Image.LANCZOS)
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    def font(sz):
        return ImageFont.truetype(FONT_PATH, sz, index=FONT_BOLD_INDEX)

    def stroke_text(pos, text, f, fill, stroke_width=8):
        draw.text(pos, text, font=f, fill=fill, stroke_width=stroke_width, stroke_fill=(0, 0, 0, 255))

    tag = cover.get("tag", "")
    if tag:
        tag_font = font(30)
        bbox = draw.textbbox((0, 0), tag, font=tag_font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        pad_x, pad_y = 18, 10
        tx, ty = 40, 36
        draw.rounded_rectangle([tx, ty, tx + tw + pad_x * 2, ty + th + pad_y * 2 + 10],
                                radius=8, fill=(255, 255, 255, 235))
        draw.text((tx + pad_x, ty + pad_y), tag, font=tag_font, fill=(20, 20, 20, 255))

    line1 = cover.get("title_line1", "")
    line2 = cover.get("title_line2", "")
    ty = 100
    tfont = font(title_fontsize)
    if line1:
        stroke_text((40, ty), line1, tfont, (255, 255, 255, 255))
    if line2:
        stroke_text((40, ty + int(title_fontsize * 1.1)), line2, tfont, (255, 230, 60, 255))

    subtitle = cover.get("subtitle", "")
    if subtitle:
        sy = ty + int(title_fontsize * 2.3)
        stroke_text((40, sy), subtitle, font(sub_fontsize), (255, 255, 255, 255), stroke_width=6)

    combined = Image.alpha_composite(img.convert("RGBA"), overlay)
    combined.convert("RGB").save(out_path, quality=92)


# ---------------------------------------------------------------------------
# Step 4: build the ASS caption file with keyword highlighting
# ---------------------------------------------------------------------------

def srt_time_to_ass(t: str) -> str:
    h, m, rest = t.split(":")
    s, ms = rest.split(",")
    cs = int(ms) // 10
    return f"{int(h)}:{m}:{s}.{cs:02d}"


def build_ass(srt_path: Path, highlights: dict, out_path: Path,
              fontsize: int = 130, video_w: int = 3840, video_h: int = 2160) -> None:
    entries = parse_srt(srt_path)
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {video_w}
PlayResY: {video_h}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Hiragino Sans GB,{fontsize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,9,4,2,80,80,150,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = [header]
    for e in entries:
        words = highlights.get(str(e["index"]), [])
        text = e["text"]
        for w in words:
            if w and w in text:
                text = text.replace(w, "{\\c&H00FFFF&}" + w + "{\\c&HFFFFFF&}", 1)
        a_start = srt_time_to_ass(e["start"])
        a_end = srt_time_to_ass(e["end"])
        lines.append(f"Dialogue: 0,{a_start},{a_end},Default,,0,0,0,,{text}\n")
    out_path.write_text("".join(lines), encoding="utf-8")


# ---------------------------------------------------------------------------
# Step 4b/5: render caption preview or full burned-in video
# ---------------------------------------------------------------------------

def render_captioned(video_path: Path, ass_path: Path, out_path: Path,
                      duration: float | None = None, preset: str = "veryfast",
                      progress_cb=None) -> None:
    """Burn `ass_path` into `video_path`. If `progress_cb` is given, it's called
    with an int 0-100 as ffmpeg reports encoding progress (via `-progress pipe:1`),
    so callers can surface a real progress bar instead of a bare spinner."""
    ffmpeg = resolve_ffmpeg_full()
    total_duration = duration if duration else get_duration_seconds(video_path)

    cmd = [ffmpeg, "-y", "-i", str(video_path)]
    if duration:
        cmd += ["-t", str(duration)]
    cmd += [
        "-vf", f"ass={ass_path.name}:fontsdir=/System/Library/Fonts",
        "-c:v", "libx264", "-preset", preset, "-crf", "20",
        "-c:a", "aac", "-b:a", "192k",
    ]

    if not progress_cb:
        cmd += [str(out_path.name)]
        subprocess.run(cmd, capture_output=True, text=True, check=True, cwd=str(ass_path.parent))
        return

    cmd += ["-progress", "pipe:1", "-nostats", str(out_path.name)]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             text=True, cwd=str(ass_path.parent))
    last_pct = -1
    for line in proc.stdout:
        line = line.strip()
        if line.startswith("out_time="):
            time_str = line.split("=", 1)[1]
            try:
                h, m, s = time_str.split(":")
                seconds = int(h) * 3600 + int(m) * 60 + float(s)
                pct = min(99, round(seconds / total_duration * 100)) if total_duration else 0
                if pct != last_pct:
                    last_pct = pct
                    progress_cb(pct)
            except (ValueError, ZeroDivisionError):
                pass
        elif line == "progress=end":
            progress_cb(100)
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg 编码失败（退出码 {proc.returncode}）")


# ---------------------------------------------------------------------------
# Step X: "やさしい日本語" review blog post (erzhiqian.cc series)
# ---------------------------------------------------------------------------

def get_video_creation_date(video_path: Path) -> str:
    """Best-effort YYYY-MM-DD from embedded metadata, else file mtime."""
    try:
        ffprobe = resolve_ffprobe()
        out = subprocess.run(
            [ffprobe, "-v", "quiet", "-print_format", "json", "-show_format", str(video_path)],
            capture_output=True, text=True, check=True,
        )
        tags = json.loads(out.stdout).get("format", {}).get("tags", {})
        raw = tags.get("com.apple.quicktime.creationdate") or tags.get("creation_time")
        if raw:
            return raw[:10]
    except Exception:
        pass
    return datetime.date.fromtimestamp(video_path.stat().st_mtime).isoformat()


def find_series_files() -> list[tuple[int, Path]]:
    """All yasashii-nihongo(-N).md files under the series root, sorted by episode number."""
    if not SERIES_ROOT.exists():
        return []
    pattern = re.compile(r"^yasashii-nihongo(?:-(\d+))?\.md$")
    results = []
    for p in SERIES_ROOT.rglob("yasashii-nihongo*.md"):
        m = pattern.match(p.name)
        if not m:
            continue
        n = int(m.group(1)) if m.group(1) else 1
        results.append((n, p))
    results.sort(key=lambda x: x[0])
    return results


def _frontmatter_field(text: str, field: str) -> str:
    m = re.search(rf'"{field}"\s*:\s*"([^"]*)"', text)
    return m.group(1) if m else ""


def get_series_context() -> dict:
    """Next episode number + previous episode's title/slug (for the nav link) + example file text."""
    files = find_series_files()
    if not files:
        return {"next_number": 1, "prev_title": None, "prev_slug": None, "example_text": None}
    last_n, last_path = files[-1]
    example_text = last_path.read_text(encoding="utf-8")
    prev_title = _frontmatter_field(example_text, "title")
    prev_slug = "/" + str(last_path.relative_to(CONTENT_BLOG_ROOT).with_suffix("")).replace("\\", "/")
    return {
        "next_number": last_n + 1,
        "prev_title": prev_title,
        "prev_slug": f"/blog{prev_slug}",
        "example_text": example_text,
        "example_path": str(last_path),
    }


def claude_generate_blog_post(srt_path: Path, video_date: str, video_title_hint: str = "") -> tuple[str, dict]:
    entries = parse_srt(srt_path)
    transcript_lines = "\n".join(f"[{e['index']}] {e['start'].split(',')[0]} {e['text']}" for e in entries)
    ctx = get_series_context()

    nav_block = ""
    if ctx["prev_title"] and ctx["prev_slug"]:
        nav_block = (
            f'文末需要加系列导航，格式完全参照示例文件最后一行：\n'
            f'<nav class="review-series" aria-label="日本語ふりかえりシリーズ">'
            f'<a href="{ctx["prev_slug"]}">前回 · {ctx["prev_title"]}</a></nav>\n'
        )

    example_section = ""
    if ctx["example_text"]:
        example_section = f"""下面是同系列上一篇文章的完整原文，请严格模仿它的 HTML 结构、CSS class 名称、
标签用法（ct / ct-head / ct-pair / ct-before / ct-after / ct-x / ct-o / ct-n / ct-notes /
data-note-kind / review-kind / ct-note-detail / review-intro / review-source / review-context /
review-points / review-key / review-reference / review-series 等），只是内容换成这期新视频的：

```markdown
{ctx['example_text']}
```
"""

    prompt = f"""你是 erzhiqian.cc 博客"やさしい日本語"系列的编辑助手。这个系列把 vlog 的自动语音识别字幕，
改写成"原字幕 vs 自然日语"对照的日语学习文章，帮读者发现自动字幕里的听写错误，并学习对应的语法点。

{example_section}

现在请你用同样的格式，把下面这期新视频（第 {ctx['next_number']} 期）的字幕处理成一篇新文章。

视频信息：
- 日期：{video_date}
- 参考标题/主题：{video_title_hint or "（无，自行根据内容总结）"}
- 完整字幕（[编号] 时间 原文）：
{transcript_lines}

要求：
1. frontmatter 字段和示例完全一致的写法（"lang": "ja" 等每个字段都用双引号包裹的 YAML），
   title 格式为 "#{ctx['next_number']} <简短概括本期内容的标题>"，date 用 "{video_date}"，
   category 用 "Japanese"，coverImage 用 "/assets/blog/default.webp"，featured 用 true，
   transcriptReview 用 true，tags 参考示例（["やさしい日本語", "日本語学習", ...根据内容加1个主题标签]），
   summary 一句话概括这期文章在讲什么、对照了多少处表达。
2. 正文结构完全参照示例：review-intro 开场 -> "## この話のポイント" 小结 -> 按内容分 5~8 个章节
   （## N. 章节标题（时间范围）），每个章节里若干个 <div class="ct" id="ct-N">对照块 -> 结尾
   "## 表現のまとめ" 总结表格。
3. 每个 ct 块：ct-head 显示时间和小标题；ct-pair 里左边"元の字幕"用 <mark class="ct-x"> 标出原文中的
   问题点（配 <i class="ct-n">序号</i>），右边"自然な言い方の一例"用 <mark class="ct-o"> 标出修正后的
   对应部分；ct-notes 是 <ol> 列表，每条前面加 <span class="review-kind">修正|整理|言い換え|字幕</span>
   （对应 data-note-kind="correction|structure|wording|transcript"）；只有值得展开讲解语法点的地方才加
   <details class="ct-note-detail"> 补充说明（日语+中文双语，中文部分 lang="zh-CN"）。
4. 字幕里明显是 ASR 听写错误、语义不通的地方（比如地名/专有名词读错），用 data-note-kind="transcript"
   标注并合理推测原意；不要瞎编与上下文无关的内容。
5. {nav_block if nav_block else "这是系列第一篇，不需要加 review-series 导航。"}

请直接输出完整的 Markdown 文件原始内容（从 --- frontmatter 开始到结尾），不要用代码块包裹，
不要输出任何解释性文字。"""

    text = ai_helper.call_text(prompt, timeout=900)
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n", "", text)
        text = re.sub(r"\n```$", "", text)
    return text, ctx


def write_blog_post(content: str, job_dir: Path) -> Path:
    """Saved inside the job folder and previewed in the pipeline UI itself. The blog
    repo is only written by an explicit export (`blog_export_path`)."""
    target = Path(job_dir) / "blog.md"
    target.write_text(content, encoding="utf-8")
    return target


def blog_export_path(content: str, episode_number: int) -> Path:
    """Where the series keeps episode N: <SERIES_ROOT>/YYYY/MM/yasashii-nihongo[-N].md,
    with YYYY/MM from the post's frontmatter date (episode 1 has no -N suffix)."""
    date = _frontmatter_field(content, "date")
    if not re.match(r"^\d{4}-\d{2}", date):
        raise ValueError("文章 frontmatter 里没有有效的 date 字段")
    name = "yasashii-nihongo.md" if episode_number == 1 else f"yasashii-nihongo-{episode_number}.md"
    return SERIES_ROOT / date[:4] / date[5:7] / name


def set_blog_youtube_link(blog_path: Path, video_id: str, title: str) -> None:
    """Insert/update the optional `youtube: {id, title}` frontmatter field."""
    if not blog_path or not Path(blog_path).exists():
        return
    text = Path(blog_path).read_text(encoding="utf-8")
    line = f'"youtube": {{"id": "{video_id}", "title": "{title}"}}'
    if re.search(r'^"youtube"\s*:', text, re.MULTILINE):
        text = re.sub(r'^"youtube"\s*:.*$', line, text, count=1, flags=re.MULTILINE)
    else:
        # insert just before the closing --- of the frontmatter block
        parts = text.split("---", 2)
        if len(parts) >= 3:
            parts[1] = parts[1].rstrip("\n") + "\n" + line + "\n"
            text = "---".join(parts)
    Path(blog_path).write_text(text, encoding="utf-8")


# ---------------------------------------------------------------------------
# Progress tracking
# ---------------------------------------------------------------------------

STAGE_ORDER = [
    "uploaded", "transcribing", "transcript_review",
    "blog_processing", "blog_review",
    "caption_processing", "caption_review",
    "rendering_final", "done",
]

STAGE_LABELS = {
    "uploaded": "已上传",
    "transcribing": "转录中",
    "transcript_review": "确认字幕",
    "blog_processing": "生成博客文章",
    "blog_review": "确认博客文章",
    "caption_processing": "生成字幕样式",
    "caption_review": "确认字幕样式",
    "rendering_final": "导出成片",
    "done": "已完成",
    "error": "出错",
}


def stage_progress(stage: str) -> dict:
    if stage == "error":
        return {"index": None, "total": len(STAGE_ORDER), "percent": None}
    try:
        idx = STAGE_ORDER.index(stage)
    except ValueError:
        idx = 0
    total = len(STAGE_ORDER) - 1
    return {"index": idx, "total": total, "percent": round(idx / total * 100)}
