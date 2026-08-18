"""Environment-backed configuration and the Slack identity pool."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

ROOT = Path(__file__).resolve().parent.parent
SOULS_DIR = ROOT / "souls"
DATA_DIR = ROOT / "data"
REGISTRY_PATH = DATA_DIR / "registry.json"

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

ENVIRONMENT_ID = os.environ.get("ENVIRONMENT_ID", "")
CLAUDEFATHER_AGENT_ID = os.environ.get("CLAUDEFATHER_AGENT_ID", "")
_bf_version = os.environ.get("CLAUDEFATHER_AGENT_VERSION", "").strip()
CLAUDEFATHER_AGENT_VERSION = int(_bf_version) if _bf_version else None

TEAMMATE_MODEL = os.environ.get("TEAMMATE_MODEL", "claude-opus-5")
TEAMMATE_EFFORT = os.environ.get("TEAMMATE_EFFORT", "high")
GATE_MODEL = os.environ.get("GATE_MODEL", "claude-haiku-4-5")
WORKSPACE = os.environ.get("ANTHROPIC_WORKSPACE", "default")

SLACK_BOT_TOKEN = os.environ.get("SLACK_BOT_TOKEN", "")
SLACK_APP_TOKEN = os.environ.get("SLACK_APP_TOKEN", "")

MAX_POOL_SLOTS = 8


@dataclass(frozen=True)
class Slot:
    """One pre-created Slack app that a teammate can be assigned to."""

    index: int
    bot_token: str
    bot_user_id: str


def identity_pool() -> list[Slot]:
    """Every SLACK_TEAMMATE_N_* pair present in the environment."""
    slots: list[Slot] = []
    for i in range(1, MAX_POOL_SLOTS + 1):
        token = os.environ.get(f"SLACK_TEAMMATE_{i}_BOT_TOKEN", "").strip()
        user_id = os.environ.get(f"SLACK_TEAMMATE_{i}_USER_ID", "").strip()
        if token and user_id:
            slots.append(Slot(index=i, bot_token=token, bot_user_id=user_id))
    return slots


def session_url(session_id: str) -> str:
    return f"https://platform.claude.com/workspaces/{WORKSPACE}/sessions/{session_id}"


def require_runtime_config() -> None:
    """Fail loudly at startup rather than mysteriously on the first message."""
    missing = [
        name
        for name, value in [
            ("ANTHROPIC_API_KEY", ANTHROPIC_API_KEY),
            ("ENVIRONMENT_ID", ENVIRONMENT_ID),
            ("CLAUDEFATHER_AGENT_ID", CLAUDEFATHER_AGENT_ID),
            ("SLACK_BOT_TOKEN", SLACK_BOT_TOKEN),
            ("SLACK_APP_TOKEN", SLACK_APP_TOKEN),
        ]
        if not value
    ]
    if missing:
        raise SystemExit(
            "Missing required env vars: "
            + ", ".join(missing)
            + "\nRun `python -m scripts.setup` first, then fill in .env."
        )
    if not identity_pool():
        raise SystemExit(
            "No teammate identities configured. Add at least one "
            "SLACK_TEAMMATE_1_BOT_TOKEN / SLACK_TEAMMATE_1_USER_ID pair to .env."
        )
