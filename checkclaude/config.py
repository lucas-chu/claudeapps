"""Environment-backed configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


def _int(name: str, default: int) -> int:
    raw = os.getenv(name)
    return int(raw) if raw else default


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    return raw.strip().lower() in {"1", "true", "yes"} if raw else default


@dataclass(frozen=True)
class Config:
    # --- X credentials -----------------------------------------------------
    bearer_token: str = os.getenv("X_BEARER_TOKEN", "")
    api_key: str = os.getenv("X_API_KEY", "")
    api_secret: str = os.getenv("X_API_SECRET", "")
    access_token: str = os.getenv("X_ACCESS_TOKEN", "")
    access_secret: str = os.getenv("X_ACCESS_TOKEN_SECRET", "")
    bot_handle: str = os.getenv("BOT_HANDLE", "CheckClaude").lstrip("@")

    # --- Ingest ------------------------------------------------------------
    # "poll" works on every X access tier. "stream" (filtered stream) needs Pro.
    ingest_mode: str = os.getenv("INGEST_MODE", "poll")
    poll_seconds: int = _int("POLL_SECONDS", 30)

    # --- Agent -------------------------------------------------------------
    model: str = os.getenv("CHECKCLAUDE_MODEL", "claude-opus-5")
    effort: str = os.getenv("CHECKCLAUDE_EFFORT", "high")
    max_turns: int = _int("CHECKCLAUDE_MAX_TURNS", 40)
    timeout_seconds: int = _int("CHECKCLAUDE_TIMEOUT_SECONDS", 480)

    # --- Response ----------------------------------------------------------
    # "conversational" replies in plain prose, like a person answering in the
    # thread. "card" uses the labelled ✅/⚠️/❌ verdict format.
    reply_style: str = os.getenv("REPLY_STYLE", "conversational")
    # 280 for a standard account; set to 25000 if the bot account has Premium.
    max_post_chars: int = _int("MAX_POST_CHARS", 280)
    thread_depth: int = _int("THREAD_DEPTH", 3)

    # --- Ops ---------------------------------------------------------------
    db_path: str = os.getenv("CHECKCLAUDE_DB", "checkclaude.sqlite3")
    dry_run: bool = _bool("DRY_RUN", False)

    def require_read_credentials(self) -> None:
        if not self.bearer_token:
            raise RuntimeError("X_BEARER_TOKEN is not set (needed to read posts).")

    def require_write_credentials(self) -> None:
        missing = [
            name
            for name, value in (
                ("X_API_KEY", self.api_key),
                ("X_API_SECRET", self.api_secret),
                ("X_ACCESS_TOKEN", self.access_token),
                ("X_ACCESS_TOKEN_SECRET", self.access_secret),
            )
            if not value
        ]
        if missing:
            raise RuntimeError(
                "Missing OAuth 1.0a credentials needed to post replies: "
                + ", ".join(missing)
            )


config = Config()
