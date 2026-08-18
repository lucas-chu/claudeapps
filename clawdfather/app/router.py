"""Decide which agent — if any — owns an incoming Slack message.

    not a real human message?      -> drop (loop guard, joins, edits)
    mentions @ClawdFather?         -> ClawdFather
    mentions @<teammate>?          -> that teammate, always respond
    reply in a thread someone
      already owns?                -> that same someone, always respond
    mentions a Clawd we can't pin
      to one teammate?             -> that identity answers as itself
    in a teammate's home channel?  -> ambient candidate, gate decides
    says "clawd two" in plain text -> that identity answers as itself
    otherwise                      -> drop

The thread-owner rule is what makes follow-ups work. Once Scout has answered in
a thread, "what about their enterprise tier?" reaches Scout without being
re-mentioned — in any channel, not just its home one.

The greeting rule is what keeps the identity pool from being a dead end. A
pooled identity carries several teammates, so a mention of it is only
unambiguous inside one of their home channels; it used to be dropped everywhere
else, along with mentions of a slot nobody has been hired into yet. Now the
identity says hi as itself and points at the teammates it's carrying.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

from . import registry
from .config import Slot, identity_pool
from .registry import CLAWDFATHER, Teammate

MENTION = re.compile(r"<@([A-Z0-9]+)>")

# Slack delivers joins, topic changes, edits and deletes on the same event as
# real messages. Only these carry human text worth routing.
HUMAN_SUBTYPES = {None, "", "file_share", "thread_broadcast"}

# "Clawd 2", "clawd two", "clawd-3" — how people name a pooled identity without
# @-mentioning it. The number is required, so "ClawdFather" can never match.
_NUMBER_WORDS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
}
CLAWD_BY_NUMBER = re.compile(
    r"\bclawd[\s_-]*(\d+|" + "|".join(_NUMBER_WORDS) + r")\b", re.IGNORECASE
)

Kind = Literal["clawdfather", "direct", "ambient", "greeting"]


@dataclass
class Decision:
    kind: Kind
    text: str
    teammate: Teammate | None = None
    candidates: list[Teammate] = field(default_factory=list)
    # For `greeting`: the identity that should speak, as itself. `candidates`
    # are the teammates it is carrying — empty when nobody is hired into it.
    slot: Slot | None = None


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


def _slot_named_in_text(text: str, slots: list[Slot]) -> Slot | None:
    """Which pooled identity a bare `clawd two` in the text refers to.

    A configured name is matched first, since a renamed slot may not read as
    "Clawd N" at all; the numbered forms are the fallback. An index nobody has
    configured matches nothing — there is no identity there to answer.
    """
    lowered = text.lower()
    for slot in slots:
        name = slot.display_name.lower()
        if name and re.search(rf"\b{re.escape(name)}\b", lowered):
            return slot
    match = CLAWD_BY_NUMBER.search(text)
    if match is None:
        return None
    token = match.group(1).lower()
    index = _NUMBER_WORDS.get(token, int(token) if token.isdigit() else 0)
    return next((slot for slot in slots if slot.index == index), None)


def _greeting(
    slot: Slot, *, text: str, names: dict[str, str], by_bot_id: dict[str, list[Teammate]]
) -> Decision:
    """The identity speaks as itself, carrying whoever is hired into it.

    The text is re-cleaned with this slot reading as the identity rather than as
    one of its teammates — nobody was asking for Scout specifically, and having
    the mention read as "Scout" would make the greeting answer as the wrong
    thing.
    """
    return Decision(
        kind="greeting",
        slot=slot,
        candidates=list(by_bot_id.get(slot.bot_user_id) or []),
        text=_clean(text, {**names, slot.bot_user_id: slot.display_name}),
    )


def route(
    *,
    text: str,
    channel: str,
    clawdfather_id: str,
    thread_ts: str | None = None,
    slots: list[Slot] | None = None,
) -> Decision | None:
    text = text or ""
    mentioned = set(MENTION.findall(text))
    slots = identity_pool() if slots is None else slots
    slot_by_bot_id = {slot.bot_user_id: slot for slot in slots}

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
    # An identity nobody is hired into still has a name; without this its
    # mention would read as "@someone".
    for bot_id, slot in slot_by_bot_id.items():
        names.setdefault(bot_id, slot.display_name)
    names[clawdfather_id] = "ClawdFather"
    clean = _clean(text, names)

    if clawdfather_id in mentioned:
        return Decision(kind="clawdfather", text=clean)

    # Mention order, not set order: two teammates in one message should always
    # resolve to the same one, and `mentioned` is a set.
    unresolved: list[Slot] = []
    for bot_id in MENTION.findall(text):
        teammate = _resolve_mention(bot_id, by_bot_id, channel)
        if teammate is not None:
            return Decision(kind="direct", teammate=teammate, text=clean)
        slot = slot_by_bot_id.get(bot_id)
        if slot is not None and slot not in unresolved:
            unresolved.append(slot)

    # Follow-up in a thread that already has a speaker.
    if thread_ts:
        owner = registry.thread_owner(channel, thread_ts)
        if owner == CLAWDFATHER:
            return Decision(kind="clawdfather", text=clean)
        if owner:
            teammate = registry.teammate_by_name(owner)
            if teammate is not None:
                return Decision(kind="direct", teammate=teammate, text=clean)

    # A Clawd was mentioned outright but couldn't be pinned to one teammate:
    # several share it, or nobody is hired into it yet. An explicit mention
    # always gets an answer, so this deliberately runs ahead of the ambient
    # gate, which could otherwise IGNORE it into silence.
    if unresolved:
        return _greeting(unresolved[0], text=text, names=names, by_bot_id=by_bot_id)

    home = [t for t in teammates if t.home_channel == channel]
    if home:
        return Decision(kind="ambient", candidates=home, text=clean)

    # No @-mention, but someone named a Clawd in plain text. Last resort, after
    # the gate has had its say: a teammate answering on-charter is a better
    # outcome than the identity introducing itself.
    named = _slot_named_in_text(text, slots)
    if named is not None:
        return _greeting(named, text=text, names=names, by_bot_id=by_bot_id)

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
