"""Teammate-side custom tools: `message_teammate` and `add_reaction`.

`app/clawdfather.py` answers ClawdFather's own `create_teammate` /
`list_teammates` calls. This module answers the tools every *hired* teammate
gets. Unlike ClawdFather's handler, a teammate's tool calls need to know where
the current turn is happening (which channel/thread, which message triggered
it) and how deep into a delegation chain it already is — that's `Context`.

`handler_for(ctx)` returns a plain `(name, args) -> str` function, matching
`managed_agent.ToolHandler`, closed over that context. `message_teammate`
builds a fresh, deeper `Context` for the teammate it loops in, so a chain of
delegations shares one growing depth counter instead of each hop starting
back at zero.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from . import managed_agent, registry, slack_client
from .prompts import ADD_REACTION_TOOL, MESSAGE_TEAMMATE_TOOL
from .registry import Teammate

log = logging.getLogger(__name__)

# Every hired teammate's tools: general capability plus these two. Used both
# at hire time and to backfill teammates hired before these tools existed.
TEAMMATE_TOOLS = [managed_agent.AGENT_TOOLSET, MESSAGE_TEAMMATE_TOOL, ADD_REACTION_TOOL]

# How many hops a delegation chain may take (A -> B -> C -> ...) before a
# teammate is told to stop and answer with what it already has. Keeps a
# mutual "ask them instead" loop between two souls from running forever.
MAX_DELEGATION_DEPTH = 3


@dataclass(frozen=True)
class Context:
    """Where a teammate's current turn is happening, for its tool calls."""

    caller: Teammate
    channel: str
    thread_ts: str
    trigger_ts: str
    depth: int = 0


def _post_as(teammate: Teammate, *, channel: str, thread_ts: str, text: str) -> None:
    slot = registry.slot_for(teammate)
    if slot is None:
        log.error("teammate %s has no configured slot %s", teammate.name, teammate.slot_index)
        return
    slack_client.post(
        slack_client.for_slot(slot),
        channel=channel,
        thread_ts=thread_ts,
        text=text,
        username=teammate.name,
        icon_emoji=teammate.emoji,
    )


def _message_teammate(ctx: Context, args: dict) -> str:
    target_name = (args.get("target") or "").strip()
    message = (args.get("message") or "").strip()
    if not target_name or not message:
        return "Both `target` and `message` are required."
    if target_name.lower() == ctx.caller.name.lower():
        return "You can't message yourself."

    target = registry.teammate_by_name(target_name)
    if target is None:
        return f"No teammate named {target_name!r}. Check the spelling, or ask ClawdFather who works here."

    if ctx.depth + 1 >= MAX_DELEGATION_DEPTH:
        return (
            f"Delegation chain is already {ctx.depth + 1} deep — answer with what "
            "you have instead of looping in another teammate."
        )

    _post_as(
        ctx.caller,
        channel=ctx.channel,
        thread_ts=ctx.thread_ts,
        text=f"_→ looping in *{target.name}*:_ {message}",
    )

    next_ctx = Context(
        caller=target,
        channel=ctx.channel,
        thread_ts=ctx.thread_ts,
        trigger_ts=ctx.trigger_ts,
        depth=ctx.depth + 1,
    )
    try:
        reply = managed_agent.run_side_channel_turn(
            agent_id=target.agent_id,
            agent_version=target.agent_version,
            text=message,
            title=f"{ctx.caller.name} → {target.name}",
            tool_handler=handler_for(next_ctx),
        )
    except Exception as exc:  # noqa: BLE001 - surfaced to the caller agent, not raised
        log.exception("%s -> %s message failed", ctx.caller.name, target.name)
        return f"{target.name} could not be reached: {type(exc).__name__}: {exc}"

    reply = reply.strip() or "_(no response)_"
    _post_as(target, channel=ctx.channel, thread_ts=ctx.thread_ts, text=reply)
    return reply


def _add_reaction(ctx: Context, args: dict) -> str:
    emoji = (args.get("emoji") or "").strip(": ")
    if not emoji:
        return "`emoji` is required."
    slot = registry.slot_for(ctx.caller)
    if slot is None:
        return f"{ctx.caller.name} has no configured Slack identity."
    ok = slack_client.react(
        slack_client.for_slot(slot), channel=ctx.channel, ts=ctx.trigger_ts, emoji=emoji
    )
    return f"Reacted :{emoji}:." if ok else f"Could not react with :{emoji}:."


_HANDLERS = {
    "message_teammate": _message_teammate,
    "add_reaction": _add_reaction,
}


def handler_for(ctx: Context):
    """A `managed_agent.ToolHandler` closed over this turn's context."""

    def handle_tool(name: str, args: dict) -> str:
        handler = _HANDLERS.get(name)
        if handler is None:
            raise ValueError(f"Unknown tool {name!r}")
        return handler(ctx, args)

    return handle_tool
