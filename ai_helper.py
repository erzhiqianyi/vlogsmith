"""Generic adapter for shelling out to a local AI CLI (Claude Code CLI by default,
but any CLI that reads a prompt and prints text or JSON works via the "custom"
provider). Configured in `ai_config.json` at the project root; editable from the
Settings page in the UI.

Config shape:
{
  "active": "claude",
  "providers": {
    "claude": {
      "label": "Claude Code CLI",
      "command": ["claude", "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"],
      "input_mode": "stdin",           # "stdin" or "arg"
      "response_format": "stream_json",  # "text" | "json_envelope" | "raw_json" | "stream_json"
      "json_result_key": "result"       # dot path into the envelope, for json_envelope
    },
    "custom": {
      "label": "自定义命令",
      "command": ["your-cli", "--some-flag"],
      "input_mode": "stdin",
      "response_format": "text",
      "json_result_key": ""
    }
  }
}

Any CLI that (a) accepts the prompt via stdin or as a trailing argument, and
(b) prints either plain text or JSON to stdout, can be wired in through the
"custom" provider from the Settings page — no code changes needed.

Output is read as it streams: "stream_json" (Claude Code's event stream) shows the
reply token by token and also yields token usage, cost and the account's rate-limit
windows; the other formats show raw stdout as it arrives.
"""
from __future__ import annotations

import contextvars
import datetime
import json
import os
import re
import signal
import shlex
import shutil
import subprocess
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "ai_config.json"
USAGE_PATH = BASE_DIR / "ai_usage.json"

CLAUDE_STREAM_COMMAND = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
_OLD_CLAUDE_COMMAND = ["claude", "-p", "--output-format", "json"]

DEFAULT_CONFIG = {
    "active": "claude",
    "providers": {
        "claude": {
            "label": "Claude Code CLI",
            "command": CLAUDE_STREAM_COMMAND,
            "input_mode": "stdin",
            "response_format": "stream_json",
            "json_result_key": "result",
        },
        "custom": {
            "label": "自定义命令",
            "command": [],
            "input_mode": "stdin",
            "response_format": "text",
            "json_result_key": "",
        },
    },
}


class AIProviderError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Call recording: inside `record_calls(path, purpose)`, every CLI call made by this
# thread (and by pool workers started via contextvars.copy_context()) is appended to
# `path` as one JSON line — the full prompt, raw stdout/stderr, exit code, timing,
# token usage — whether it succeeded or not. While a call runs, its partial output
# is visible through `live_calls(path)`.
# ---------------------------------------------------------------------------

class CallRecorder:
    def __init__(self, path: Path, purpose: str, tag: str | None = None):
        self.path = Path(path)
        self.purpose = purpose
        self.tag = tag
        self.call_ids: list[str] = []


_recorder: contextvars.ContextVar[CallRecorder | None] = contextvars.ContextVar("ai_call_recorder", default=None)
# Provider picked for calls made inside a `use_provider(...)` block (e.g. the AI chat's
# per-message CLI choice); None means the configured active provider.
_provider_override: contextvars.ContextVar[str | None] = contextvars.ContextVar("ai_provider_override", default=None)


@contextmanager
def use_provider(name: str | None):
    token = _provider_override.set(name or None)
    try:
        yield
    finally:
        _provider_override.reset(token)
_record_lock = threading.Lock()
_live: dict[str, dict] = {}
_live_lock = threading.Lock()


@contextmanager
def record_calls(path: Path, purpose: str, tag: str | None = None):
    """`tag` lets a caller find its own in-flight call among live_calls (e.g. the chat
    reply waiting on it)."""
    rec = CallRecorder(path, purpose, tag)
    token = _recorder.set(rec)
    try:
        yield rec
    finally:
        _recorder.reset(token)


def _now() -> str:
    return datetime.datetime.now().isoformat(timespec="seconds")


def _record(call_id: str, entry: dict) -> None:
    rec = _recorder.get()
    if rec is None:
        return
    entry = {"id": call_id, "ts": _now(), "purpose": rec.purpose, **entry}
    with _record_lock:
        rec.path.parent.mkdir(parents=True, exist_ok=True)
        with rec.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        rec.call_ids.append(call_id)


def read_calls(path: Path) -> list[dict]:
    path = Path(path)
    if not path.exists():
        return []
    calls = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            calls.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return calls


def live_calls(path: Path) -> list[dict]:
    """In-flight calls recorded into `path`, with the output streamed so far."""
    key = str(Path(path))
    with _live_lock:
        return [{k: v for k, v in c.items() if k != "path"} for c in _live.values() if c["path"] == key]


# ---------------------------------------------------------------------------
# Account usage (Claude Code only): the latest rate-limit windows seen in a stream.
# ---------------------------------------------------------------------------

def _save_rate_limit(info: dict) -> None:
    try:
        USAGE_PATH.write_text(json.dumps({"rate_limit": info, "updated_at": _now()},
                                         ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass


def load_usage() -> dict:
    try:
        return json.loads(USAGE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def usage_summary(result_event: dict) -> dict:
    """Token counts / cost / model from Claude Code's final `result` event."""
    u = result_event.get("usage") or {}
    return {
        "input_tokens": u.get("input_tokens", 0),
        "output_tokens": u.get("output_tokens", 0),
        "cache_read_tokens": u.get("cache_read_input_tokens", 0),
        "cache_creation_tokens": u.get("cache_creation_input_tokens", 0),
        "cost_usd": result_event.get("total_cost_usd"),
        "models": list((result_event.get("modelUsage") or {}).keys()),
        "duration_api_ms": result_event.get("duration_api_ms"),
    }


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def load_config() -> dict:
    if not CONFIG_PATH.exists():
        save_config(DEFAULT_CONFIG)
        return json.loads(json.dumps(DEFAULT_CONFIG))
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return json.loads(json.dumps(DEFAULT_CONFIG))
    # Configs saved before streaming support still carry the old one-shot JSON command.
    claude = config.get("providers", {}).get("claude")
    if claude and claude.get("command") == _OLD_CLAUDE_COMMAND:
        claude.update(command=CLAUDE_STREAM_COMMAND, response_format="stream_json")
        save_config(config)
    return config


def save_config(config: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")


def get_active_provider_name(config: dict | None = None) -> str:
    config = config or load_config()
    return config.get("active", "claude")


def get_provider(name: str | None = None, config: dict | None = None) -> dict:
    config = config or load_config()
    name = name or get_active_provider_name(config)
    providers = config.get("providers", {})
    if name not in providers:
        raise AIProviderError(f"未找到 AI 提供方配置: {name}")
    return providers[name]


def _dig(payload: Any, dotted_key: str) -> Any:
    if not dotted_key:
        return payload
    val = payload
    for k in dotted_key.split("."):
        if isinstance(val, dict) and k in val:
            val = val[k]
        else:
            raise AIProviderError(f"返回的 JSON 里找不到字段路径 '{dotted_key}'")
    return val


# ---------------------------------------------------------------------------
# Calling the CLI
# ---------------------------------------------------------------------------

def call_text(prompt: str, timeout: int = 300, provider_name: str | None = None) -> str:
    rec = _recorder.get()
    call_id = uuid.uuid4().hex[:12]
    trace: dict = {}
    live = {"id": call_id, "purpose": rec.purpose if rec else "", "tag": rec.tag if rec else None,
            "path": str(rec.path) if rec else "", "started": _now(), "text": ""}
    with _live_lock:
        _live[call_id] = live
    started = time.monotonic()
    try:
        text = _call_text(prompt, timeout, provider_name, trace, live)
        error = None
        return text
    except Exception as e:
        text, error = None, str(e)
        raise
    finally:
        with _live_lock:
            _live.pop(call_id, None)
        _record(call_id, {**trace, "prompt": prompt, "output": text, "error": error,
                          "duration_ms": round((time.monotonic() - started) * 1000)})


def _call_text(prompt: str, timeout: int, provider_name: str | None, trace: dict, live: dict) -> str:
    """`trace` is filled with what actually ran (provider, argv, raw stdout/stderr, exit
    code, usage) so call_text can record it even when this raises; `live["text"]`
    grows as output streams in."""
    config = load_config()
    name = provider_name or _provider_override.get() or get_active_provider_name(config)
    cfg = get_provider(name, config)
    label = cfg.get("label", name)
    command = list(cfg.get("command") or [])
    trace.update(provider=label, command=command)
    if not command:
        raise AIProviderError(f"「{label}」还没配置命令，请到设置页填写")
    if shutil.which(command[0]) is None and not Path(command[0]).exists():
        raise AIProviderError(f"找不到命令 `{command[0]}`，请确认已安装并在 PATH 里")

    response_format = cfg.get("response_format", "text")
    argv = list(command) + ([prompt] if cfg.get("input_mode") == "arg" else [])
    stdin_data = None if cfg.get("input_mode") == "arg" else prompt

    stdout_lines, stderr_chunks = [], []
    result_event: dict | None = None
    final_message_text = ""
    timed_out = threading.Event()

    try:
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE if stdin_data is not None else subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, encoding="utf-8", errors="replace", bufsize=1,
                                start_new_session=True)
    except FileNotFoundError:
        raise AIProviderError(f"找不到命令 `{command[0]}`，请确认已安装并在 PATH 里")

    def feed_stdin():
        try:
            proc.stdin.write(stdin_data)
            proc.stdin.close()
        except (BrokenPipeError, OSError):
            pass

    def kill_on_timeout():
        # the whole process group: a child left alive would keep stdout open
        timed_out.set()
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            proc.kill()

    threads = [threading.Thread(target=lambda: stderr_chunks.append(proc.stderr.read()), daemon=True)]
    if stdin_data is not None:
        threads.append(threading.Thread(target=feed_stdin, daemon=True))
    for t in threads:
        t.start()
    timer = threading.Timer(timeout, kill_on_timeout)
    timer.start()
    try:
        for line in proc.stdout:
            if response_format != "stream_json":
                stdout_lines.append(line)
                live["text"] += line
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                stdout_lines.append(line)
                continue
            kind = event.get("type")
            if kind == "stream_event":
                # token-level deltas: shown live, but too bulky to keep in the record
                delta = (event.get("event") or {}).get("delta") or {}
                if delta.get("type") == "text_delta":
                    live["text"] += delta.get("text", "")
                continue
            stdout_lines.append(line)
            if kind == "assistant":
                parts = (event.get("message") or {}).get("content") or []
                final_message_text = "".join(p.get("text", "") for p in parts if p.get("type") == "text")
                if not live["text"]:  # CLI run without --include-partial-messages
                    live["text"] = final_message_text
            elif kind == "rate_limit_event" and event.get("rate_limit_info"):
                _save_rate_limit(event["rate_limit_info"])
            elif kind == "result":
                result_event = event
        proc.wait()
    finally:
        timer.cancel()
        for t in threads:
            t.join(timeout=5)

    stdout = "".join(stdout_lines)
    stderr = "".join(stderr_chunks)
    trace.update(stdout=stdout, stderr=stderr, returncode=proc.returncode)
    if result_event:
        trace["usage"] = usage_summary(result_event)
    if timed_out.is_set():
        raise AIProviderError(f"「{label}」调用超时（{timeout}s）")

    if response_format == "stream_json":
        if result_event is None:
            raise AIProviderError(f"「{label}」没有返回结果，stderr: {stderr.strip()[:500] or '(无)'}")
        text = result_event.get("result")
        if not isinstance(text, str):
            text = final_message_text
        if result_event.get("is_error"):
            if "Not logged in" in text or "/login" in text:
                raise AIProviderError(f"「{label}」尚未登录，请先在终端完成登录/认证")
            raise AIProviderError(f"「{label}」报错: {text}")
        return text

    stdout = stdout.strip()
    if response_format == "text":
        if proc.returncode != 0 and not stdout:
            raise AIProviderError(f"「{label}」调用失败: {stderr.strip()[:500] or '(无输出)'}")
        return stdout

    if not stdout:
        raise AIProviderError(f"「{label}」无输出，stderr: {stderr.strip()[:500]}")
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        raise AIProviderError(f"「{label}」返回内容不是合法 JSON: {stdout[:500]}")

    if response_format == "raw_json":
        return json.dumps(payload, ensure_ascii=False)

    # json_envelope
    val = _dig(payload, cfg.get("json_result_key", "result"))
    if isinstance(payload, dict) and payload.get("is_error"):
        text = str(val)
        if "Not logged in" in text or "/login" in text:
            raise AIProviderError(f"「{label}」尚未登录，请先在终端完成登录/认证")
        raise AIProviderError(f"「{label}」报错: {text}")
    return val if isinstance(val, str) else json.dumps(val, ensure_ascii=False)


def extract_json_block(text: str) -> dict:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError(f"未能在返回内容中找到 JSON: {text[:500]}")
    return json.loads(match.group(0))


def call_json(prompt: str, timeout: int = 300, provider_name: str | None = None) -> dict:
    text = call_text(prompt, timeout=timeout, provider_name=provider_name)
    return extract_json_block(text)


def parse_command_string(command_str: str) -> list[str]:
    """Split a shell-style command string (as typed in the Settings UI) into argv."""
    return shlex.split(command_str)


def check_provider_installed(cfg: dict) -> bool:
    command = cfg.get("command") or []
    return bool(command) and (shutil.which(command[0]) is not None or Path(command[0]).exists())


def test_provider(name: str) -> dict:
    """Send a trivial prompt and report back what came out, for the Settings UI's
    "测试连接" button."""
    try:
        text = call_text('请只回复这三个字："测试成功"', timeout=60, provider_name=name)
        return {"ok": True, "output": text[:300]}
    except AIProviderError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": f"未预期的错误: {e}"}
