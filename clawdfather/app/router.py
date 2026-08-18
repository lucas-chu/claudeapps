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


def _resolve_mention(
    bot_id: str, by_bot_id: dict[str, list[Teammate]], channel: str
) -> Teammate | None:
    """Which teammate a bot_user_id means, here.

    Usually unambiguous. Once teammates outnumber identity-pool slots, several
    teammates can share one Slack identity — in that case, prefer whichever of
    them lives in this channel. If that still doesn't narrow it to one, the
    identity can't be disambiguated from here, so no teammate is returned
    (the mention is dropped rather than guessed).
    """
    candidates = by_bot_id.get(bot_id) or []
    if len(candidates) == 1:
        return candidates[0]
    home_matches = [t for t in candidates if t.home_channel == channel]
    return home_matches[0] if len(home_matches) == 1 else None


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
    by_bot_id: dict[str, list[Teammate]] = {}
    for t in teammates:
        by_bot_id.setdefault(t.bot_user_id, []).append(t)
    # Prefer the channel-disambiguated teammate for each bot_user_id so a
    # shared identity reads as the right name in this channel; a genuinely
    # ambiguous one falls back to whichever teammate is listed first, just
    # for display — routing itself only trusts an unambiguous resolution.
    names = {
        bot_id: (_resolve_mention(bot_id, by_bot_id, channel) or candidates[0]).name
        for bot_id, candidates in by_bot_id.items()
    }
    names[clawdfather_id] = "ClawdFather"
    clean = _clean(text, names)

    if clawdfather_id in mentioned:
        return Decision(kind="clawdfather", text=clean)

    # Mention order, not set order: two teammates in one message should always
    # resolve to the same one, and `mentioned` is a set.
    for bot_id in MENTION.findall(text):
        teammate = _resolve_mention(bot_id, by_bot_id, channel)
        if teammate is not None:
            return Decision(kind="direct", teammate=teammate, text=clean)

    # Follow-up in a thread that already has a speaker.
    if thread_ts:
        owner = registry.thread_owner(channel, thread_ts)
        if owner == CLAWDFATHER:
            return Decision(kind="clawdfather", text=clean)
        if owner:
            teammate = registry.teammate_by_name(owner)
            if teammate is not None:
                return Decision(kind="direct", teammate=teammate, text=clean)

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
