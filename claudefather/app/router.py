"""Decide which agent — if any — owns an incoming Slack message.

    from a bot?                    -> drop (loop guard)
    mentions @ClaudeFather?           -> ClaudeFather
    mentions @<teammate>?          -> that teammate, always respond
    in a teammate's home channel?  -> ambient candidate, gate decides
    otherwise                      -> drop
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

from . import registry
from .registry import Teammate

MENTION = re.compile(r"<@([A-Z0-9]+)>")

Kind = Literal["claudefather", "direct", "ambient"]


@dataclass
class Decision:
    kind: Kind
    text: str
    teammate: Teammate | None = None
    candidates: list[Teammate] = field(default_factory=list)


def _clean(text: str, names: dict[str, str]) -> str:
    """Swap raw <@U123> tokens for readable names so the agent isn't reading IDs."""
    return MENTION.sub(lambda m: names.get(m.group(1), "@someone"), text).strip()


def route(*, text: str, channel: str, claudefather_id: str) -> Decision | None:
    text = text or ""
    mentioned = set(MENTION.findall(text))

    teammates = registry.all_teammates()
    names = {t.bot_user_id: t.name for t in teammates}
    names[claudefather_id] = "ClaudeFather"

    if claudefather_id in mentioned:
        return Decision(kind="claudefather", text=_clean(text, names))

    for teammate in teammates:
        if teammate.bot_user_id in mentioned:
            return Decision(
                kind="direct", teammate=teammate, text=_clean(text, names)
            )

    home = [t for t in teammates if t.home_channel == channel]
    if home:
        return Decision(kind="ambient", candidates=home, text=_clean(text, names))

    return None


def is_from_bot(event: dict, our_ids: set[str]) -> bool:
    """Loop guard: never let our own output re-enter the router."""
    if event.get("bot_id"):
        return True
    if event.get("subtype") in {"bot_message", "message_changed", "message_deleted"}:
        return True
    return event.get("user", "") in our_ids
