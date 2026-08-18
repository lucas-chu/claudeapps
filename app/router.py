"""Decide which agent — if any — owns an incoming Slack message.

    not a real human message?      -> drop (loop guard, joins, edits)
    mentions @ClawdFather?         -> ClawdFather
    mentions @<teammate>?          -> that teammate, always respond
    reply in a thread someone
      already owns?                -> that same someone, always respond
    in a teammate's home channel?  -> ambient candidate, gate decides
    otherwise                      -> drop

The thread-owner rule is what makes follow-ups work. Once Scout has answered in
a thread, "what about their enterprise tier?" reaches Scout without being
re-mentioned — in any channel, not just its home one.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

from . import registry
from .registry import CLAWDFATHER, Teammate

MENTION = re.compile(r"<@([A-Z0-9]+)>")

# Slack delivers joins, topic changes, edits and deletes on the same event as
# real messages. Only these carry human text worth routing.
HUMAN_SUBTYPES = {None, "", "file_share", "thread_broadcast"}

Kind = Literal["clawdfather", "direct", "ambient"]


@dataclass
class Decision:
    kind: Kind
    text: str
    teammate: Teammate | None = None
    candidates: list[Teammate] = field(default_factory=list)


def _clean(text: str, names: dict[str, str]) -> str:
    """Swap raw <@U123> tokens for readable names so the agent isn't reading IDs."""
    return MENTION.sub(lambda m: names.get(m.group(1), "@someone"), text).strip()


def route(
    *,
    text: str,
    channel: str,
    clawdfather_id: str,
    thread_ts: str | None = None,
) -> Decision | None:
    text = text or ""
    mentioned = set(MENTION.findall(text))

    teammates = registry.all_teammates()
    by_bot_id = {t.bot_user_id: t for t in teammates}
    names = {t.bot_user_id: t.name for t in teammates}
    names[clawdfather_id] = "ClawdFather"
    clean = _clean(text, names)

    if clawdfather_id in mentioned:
        return Decision(kind="clawdfather", text=clean)

    for bot_id in mentioned:
        if bot_id in by_bot_id:
            return Decision(kind="direct", teammate=by_bot_id[bot_id], text=clean)

    # Follow-up in a thread that already has a speaker.
    if thread_ts:
        owner = registry.thread_owner(channel, thread_ts)
        if owner == CLAWDFATHER:
            return Decision(kind="clawdfather", text=clean)
        if owner and owner in by_bot_id:
            return Decision(kind="direct", teammate=by_bot_id[owner], text=clean)

    home = [t for t in teammates if t.home_channel == channel]
    if home:
        return Decision(kind="ambient", candidates=home, text=clean)

    return None


def should_ignore(event: dict, our_ids: set[str]) -> bool:
    """Loop guard plus noise filter.

    Drops our own output (which would otherwise re-enter the router forever)
    and Slack's non-message messages — channel joins, topic changes, edits.
    A join in particular reads as `<@U…> has joined the channel`, which would
    otherwise look like a mention.
    """
    if event.get("bot_id"):
        return True
    if event.get("subtype") not in HUMAN_SUBTYPES:
        return True
    if event.get("user", "") in our_ids:
        return True
    return not (event.get("text") or "").strip()
