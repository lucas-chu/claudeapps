"""JSON-backed persistence for teammates, thread sessions, and slot claims.

Two maps:
    lowercased teammate name -> teammate record
    "<channel>:<thread_ts>" -> managed agent session id + owner

Teammates are keyed by name, not `bot_user_id`: once there are more teammates
than identity-pool slots, several teammates legitimately share one Slack
identity, so `bot_user_id` is no longer unique.

The thread key includes the channel because thread_ts is only unique within a
channel.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from collections.abc import Iterator
from dataclasses import asdict, dataclass

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
    template: str | None = None  # base personality it was hired from

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


def teammates_by_bot_id(bot_user_id: str) -> list[Teammate]:
    """Every teammate currently posting from this Slack identity.

    More than one is expected once teammates outnumber identity-pool slots —
    several named teammates can share one underlying Slack app.
    """
    return [t for t in all_teammates() if t.bot_user_id == bot_user_id]


def teammate_by_bot_id(bot_user_id: str) -> Teammate | None:
    """First teammate on this identity. Fine for call sites that don't need
    to disambiguate a shared slot (e.g. the doctor); routing uses
    `teammates_by_bot_id` instead.
    """
    matches = teammates_by_bot_id(bot_user_id)
    return matches[0] if matches else None


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
        # Keyed by name, not bot_user_id: once teammates outnumber identity
        # slots, several teammates legitimately share one bot_user_id.
        data["teammates"][teammate.name.lower()] = asdict(teammate)
        _save(data)


def claim_slot(preferred_name: str) -> Slot:
    """Take the least-loaded identity from the pool.

    Re-hiring a name that already exists reuses that teammate's slot, so
    `@ClawdFather create Scout ...` twice updates Scout instead of burning a
    slot. Otherwise, teammates are handed the slot with the fewest current
    teammates (ties go to the lowest index) — so hiring is never blocked by
    running out of identities, only spread as evenly as possible across the
    ones that exist.
    """
    with _lock:
        existing = teammate_by_name(preferred_name)
        pool = identity_pool()
        if not pool:
            raise RuntimeError(
                "No Slack identities configured. Add at least one "
                "SLACK_TEAMMATE_N_BOT_TOKEN / SLACK_TEAMMATE_N_USER_ID pair to .env."
            )
        if existing:
            for slot in pool:
                if slot.index == existing.slot_index:
                    return slot
        load: dict[int, int] = {slot.index: 0 for slot in pool}
        for teammate in all_teammates():
            if teammate.slot_index in load:
                load[teammate.slot_index] += 1
        return min(pool, key=lambda slot: (load[slot.index], slot.index))


def slot_for(teammate: Teammate) -> Slot | None:
    for slot in identity_pool():
        if slot.index == teammate.slot_index:
            return slot
    return None


# --------------------------------------------------------------------------
# Thread -> session + owner
# --------------------------------------------------------------------------
#
# A thread records both its Managed Agent session and who is speaking in it.
# The owner is what makes follow-ups work: once Scout has answered in a thread,
# "what about their enterprise tier?" goes to Scout without re-mentioning it,
# in any channel.

CLAWDFATHER = "clawdfather"  # owner sentinel; teammates use their (unique) name


def thread_key(channel: str, thread_ts: str) -> str:
    return f"{channel}:{thread_ts}"


def _thread_record(data: dict, channel: str, thread_ts: str) -> dict | None:
    rec = data["sessions"].get(thread_key(channel, thread_ts))
    if rec is None:
        return None
    # Tolerate the older bare-string form.
    return {"session_id": rec, "owner": None} if isinstance(rec, str) else rec


def get_session(channel: str, thread_ts: str) -> str | None:
    with _lock:
        rec = _thread_record(_load(), channel, thread_ts)
        return rec["session_id"] if rec else None


def thread_owner(channel: str, thread_ts: str) -> str | None:
    """A teammate's name, the CLAWDFATHER sentinel, or None if unclaimed."""
    with _lock:
        rec = _thread_record(_load(), channel, thread_ts)
        return rec.get("owner") if rec else None


def set_session(channel: str, thread_ts: str, session_id: str, owner: str | None = None) -> None:
    with _lock:
        data = _load()
        key = thread_key(channel, thread_ts)
        existing = _thread_record(data, channel, thread_ts) or {}
        data["sessions"][key] = {
            "session_id": session_id,
            # Never let a later write silently orphan a thread's owner.
            "owner": owner if owner is not None else existing.get("owner"),
        }
        _save(data)


def clear_session(channel: str, thread_ts: str) -> None:
    with _lock:
        data = _load()
        data["sessions"].pop(thread_key(channel, thread_ts), None)
        _save(data)
