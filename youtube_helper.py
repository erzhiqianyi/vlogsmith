"""YouTube Data API v3 integration: OAuth connect + resumable upload.

One-time setup required (only the account owner can do this, it needs a
Google login in a real browser):

1. Go to https://console.cloud.google.com/ , create a project (or reuse one).
2. Enable "YouTube Data API v3" under APIs & Services > Library.
3. APIs & Services > Credentials > Create Credentials > OAuth client ID.
   - Application type: "Desktop app".
4. Download the JSON and save it as `youtube_client_secret.json` in this
   project's root directory (next to app.py).
5. In the app's Settings page, click "连接 YouTube 账号" — this opens your
   default browser for you to log in and grant access. The resulting token
   is cached in `youtube_token.json` so you only do this once (until it's
   revoked or the refresh token expires).

Both `youtube_client_secret.json` and `youtube_token.json` are secrets —
keep them out of version control.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Callable, Optional

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

BASE_DIR = Path(__file__).resolve().parent
CLIENT_SECRET_PATH = BASE_DIR / "youtube_client_secret.json"
TOKEN_PATH = BASE_DIR / "youtube_token.json"

SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
]


class YouTubeNotConfigured(RuntimeError):
    pass


class YouTubeNotConnected(RuntimeError):
    pass


def is_configured() -> bool:
    return CLIENT_SECRET_PATH.exists()


def is_connected() -> bool:
    return TOKEN_PATH.exists()


def disconnect() -> None:
    TOKEN_PATH.unlink(missing_ok=True)


def get_credentials() -> Credentials:
    if not TOKEN_PATH.exists():
        raise YouTubeNotConnected("尚未连接 YouTube 账号，请先在设置页完成授权")
    creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        TOKEN_PATH.write_text(creds.to_json(), encoding="utf-8")
    return creds


def start_oauth_flow() -> None:
    """Blocking call: opens a browser for login/consent. Run this in a background thread."""
    if not is_configured():
        raise YouTubeNotConfigured(
            f"找不到 {CLIENT_SECRET_PATH.name}。请先在 Google Cloud Console 创建 OAuth 客户端"
            "（Desktop app 类型），把下载的 JSON 保存为这个文件名放到项目根目录。"
        )
    flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRET_PATH), SCOPES)
    creds = flow.run_local_server(port=0, open_browser=True,
                                   authorization_prompt_message="正在打开浏览器完成 YouTube 授权...")
    TOKEN_PATH.write_text(creds.to_json(), encoding="utf-8")


def get_channel_info() -> Optional[dict]:
    creds = get_credentials()
    youtube = build("youtube", "v3", credentials=creds)
    resp = youtube.channels().list(part="snippet", mine=True).execute()
    items = resp.get("items", [])
    if not items:
        return None
    return {"title": items[0]["snippet"]["title"], "id": items[0]["id"]}


def upload_video(video_path: Path, title: str, description: str, tags: list[str],
                  privacy_status: str = "private", category_id: str = "22",
                  thumbnail_path: Path | None = None,
                  progress_cb: Optional[Callable[[int], None]] = None) -> dict:
    """Resumable upload. privacy_status must be one of private/unlisted/public.

    Defaults to 'private' — callers should require an explicit, informed choice
    before ever passing 'public'.
    """
    if privacy_status not in ("private", "unlisted", "public"):
        raise ValueError("privacy_status must be private/unlisted/public")

    creds = get_credentials()
    youtube = build("youtube", "v3", credentials=creds)

    body = {
        "snippet": {
            "title": title,
            "description": description,
            "tags": tags,
            "categoryId": category_id,
        },
        "status": {
            "privacyStatus": privacy_status,
            "selfDeclaredMadeForKids": False,
        },
    }
    media = MediaFileUpload(str(video_path), chunksize=8 * 1024 * 1024,
                             resumable=True, mimetype="video/mp4")
    request = youtube.videos().insert(part="snippet,status", body=body, media_body=media)

    response = None
    while response is None:
        status, response = request.next_chunk()
        if status and progress_cb:
            progress_cb(int(status.progress() * 100))
    if progress_cb:
        progress_cb(100)

    video_id = response["id"]

    if thumbnail_path and Path(thumbnail_path).exists():
        youtube.thumbnails().set(
            videoId=video_id,
            media_body=MediaFileUpload(str(thumbnail_path)),
        ).execute()

    return {"video_id": video_id, "url": f"https://youtu.be/{video_id}"}
