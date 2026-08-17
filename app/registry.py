"""JSON-backed persistence for teammates, thread sessions, and slot claims.

Two maps, per the PRD:
    slack_bot_user_id -> teammate record
    "<channel>:<thread_ts>" -> managed agent session id

The thread key includes the channel because thread_ts is only unique within a
channel.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from dataclasses import asdict, dataclass
from typing import Iterator

from .config import DATA_DIR, REGISTRY_PATH, Slot, identity_pool

_lock = threading.RLock()


@dataclass
class Teammate:
    name: str
    role: str
    home_channel: str  # channel ID, e.g. C0123
    home_channel_name: str  # channel name without '#'
    agent_id: str
    agent_version: int | None
    slot_index: int
    bot_user_id: str
    soul_path: str
    emoji: str = "robot_face"

    @property
    def mention(self) -> str:
        return f"<@{self.bot_user_id}>"


def _empty() -> dict:
    return {"teammates": {}, "sessions": {}}


def _load() -> dict:
    if not REGISTRY_PATH.exists():
        return _empty()
    try:
        with REGISTRY_PATH.open() as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, OSError):
        return _empty()
    data.setdefault("teammates", {})
    data.setdefault("sessions", {})
    return data


def _save(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=DATA_DIR, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(data, fh, indent=2)
        os.replace(tmp, REGISTRY_PATH)
    except BaseException:
        os.path.exists(tmp) and os.unlink(tmp)
        raise


# --------------------------------------------------------------------------
# Teammates
# --------------------------------------------------------------------------


def all_teammates() -> list[Teammate]:
    with _lock:
        return [Teammate(**rec) for rec in _load()["teammates"].values()]


def teammate_by_bot_id(bot_user_id: str) -> Teammate | None:
    with _lock:
        rec = _load()["teammates"].get(bot_user_id)
        return Teammate(**rec) if rec else None


def teammates_in_channel(channel_id: str) -> Iterator[Teammate]:
    for teammate in all_teammates():
        if teammate.home_channel == channel_id:
            yield teammate


def teammate_by_name(name: str) -> Teammate | None:
    lowered = name.strip().lower()
    for teammate in all_teammates():
        if teammate.name.lower() == lowered:
            return teammate
    return None


def save_teammate(teammate: Teammate) -> None:
    with _lock:
        data = _load()
        data["teammates"][teammate.bot_user_id] = asdict(teammate)
        _save(data)


def claim_slot(preferred_name: str) -> Slot:
    """Take a free identity from the pool.

    Re-hiring a name that already exists reuses that teammate's slot, so
    `@ClaudeFather create Scout ...` twice updates Scout instead of burning a slot.
    """
    with _lock:
        existing = teammate_by_name(preferred_name)
        pool = identity_pool()
        if existing:
            for slot in pool:
                if slot.index == existing.slot_index:
                    return slot
        taken = {t.slot_index for t in all_teammates()}
        for slot in pool:
            if slot.index not in taken:
                return slot
        raise RuntimeError(
            f"All {len(pool)} Slack identities are in use "
            f"({', '.join(t.name for t in all_teammates())}). "
            "Add another SLACK_TEAMMATE_N_* pair to .env, or re-hire an "
            "existing name to reuse its slot."
        )


def slot_for(teammate: Teammate) -> Slot | None:
    for slot in identity_pool():
        if slot.index == teammate.slot_index:
            return slot
    return None


# --------------------------------------------------------------------------
# Thread -> session
# --------------------------------------------------------------------------


def thread_key(channel: str, thread_ts: str) -> str:
    return f"{channel}:{thread_ts}"


def get_session(channel: str, thread_ts: str) -> str | None:
    with _lock:
        return _load()["sessions"].get(thread_key(channel, thread_ts))


def set_session(channel: str, thread_ts: str, session_id: str) -> None:
    with _lock:
        data = _load()
        data["sessions"][thread_key(channel, thread_ts)] = session_id
        _save(data)


def clear_session(channel: str, thread_ts: str) -> None:
    with _lock:
        data = _load()
        data["sessions"].pop(thread_key(channel, thread_ts), None)
        _save(data)
