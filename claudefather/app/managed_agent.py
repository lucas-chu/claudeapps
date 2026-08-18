"""Anthropic Managed Agents integration.

One agent per teammate (persisted, versioned). One session per Slack thread, so
follow-ups in a thread keep their context without us resending history.
"""

from __future__ import annotations

import logging
from typing import Callable

import anthropic

from . import config, registry
from .prompts import GATE_SCHEMA, GATE_SYSTEM

log = logging.getLogger(__name__)

client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY or None)

AGENT_TOOLSET = {"type": "agent_toolset_20260401"}

ToolHandler = Callable[[str, dict], str]
Progress = Callable[[str], None]


# --------------------------------------------------------------------------
# Setup-time: environment + agent creation
# --------------------------------------------------------------------------


def create_environment(name: str = "slack-teammates") -> str:
    env = client.beta.environments.create(
        name=name,
        config={"type": "cloud", "networking": {"type": "unrestricted"}},
    )
    return env.id


def create_agent(
    *,
    name: str,
    system: str,
    tools: list[dict] | None = None,
    model: str | None = None,
    effort: str | None = None,
) -> tuple[str, int | None]:
    """Create a Managed Agent. Returns (agent_id, version).

    Agents are persistent — this runs once per teammate at hire time, never in
    the per-message path.
    """
    agent = client.beta.agents.create(
        name=name,
        model={
            "id": model or config.TEAMMATE_MODEL,
            "effort": effort or config.TEAMMATE_EFFORT,
        },
        system=system,
        tools=tools if tools is not None else [AGENT_TOOLSET],
    )
    return agent.id, getattr(agent, "version", None)


def update_agent_system(agent_id: str, system: str) -> int | None:
    """Re-apply an edited soul.md. Each update mints a new agent version."""
    agent = client.beta.agents.update(agent_id, system=system)
    return getattr(agent, "version", None)


# --------------------------------------------------------------------------
# Runtime: one turn against a thread's session
# --------------------------------------------------------------------------


def _open_session(agent_id: str, agent_version: int | None, title: str) -> str:
    agent_ref: dict = {"type": "agent", "id": agent_id}
    if agent_version is not None:
        agent_ref["version"] = agent_version
    session = client.beta.sessions.create(
        agent=agent_ref,
        environment_id=config.ENVIRONMENT_ID,
        title=title[:120],
    )
    log.info("session %s  %s", session.id, config.session_url(session.id))
    return session.id


def session_for_thread(
    *, agent_id: str, agent_version: int | None, channel: str, thread_ts: str, title: str
) -> str:
    existing = registry.get_session(channel, thread_ts)
    if existing:
        return existing
    session_id = _open_session(agent_id, agent_version, title)
    registry.set_session(channel, thread_ts, session_id)
    return session_id


def run_turn(
    *,
    agent_id: str,
    agent_version: int | None,
    channel: str,
    thread_ts: str,
    text: str,
    title: str = "Slack thread",
    tool_handler: ToolHandler | None = None,
    on_progress: Progress | None = None,
) -> str:
    """Send one user message to the thread's session and return the reply.

    Opens the stream *before* sending — the stream only delivers events that
    occur after it opens, so sending first can lose the early ones.
    """
    session_id = session_for_thread(
        agent_id=agent_id,
        agent_version=agent_version,
        channel=channel,
        thread_ts=thread_ts,
        title=title,
    )

    for attempt in (1, 2):
        try:
            with client.beta.sessions.events.stream(session_id) as stream:
                client.beta.sessions.events.send(
                    session_id,
                    events=[
                        {"type": "user.message", "content": [{"type": "text", "text": text}]}
                    ],
                )
                return _drain(
                    stream,
                    session_id,
                    tool_handler=tool_handler,
                    on_progress=on_progress,
                )
        except anthropic.APIStatusError as exc:
            # A thread whose session was archived/terminated between turns.
            retryable = exc.status_code in (400, 404, 409) and attempt == 1
            if not retryable:
                raise
            log.warning("session %s unusable (%s); starting a fresh one", session_id, exc.status_code)
            registry.clear_session(channel, thread_ts)
            session_id = session_for_thread(
                agent_id=agent_id,
                agent_version=agent_version,
                channel=channel,
                thread_ts=thread_ts,
                title=title,
            )
    return ""


def _drain(stream, session_id, *, tool_handler, on_progress) -> str:
    """Read an already-open event stream until the agent finishes this turn.

    Terminal gate: `session.status_idle` with any stop_reason other than
    `requires_action` (which just means the agent is waiting on us), or
    `session.status_terminated`.
    """
    chunks: list[str] = []
    for event in stream:
        kind = getattr(event, "type", "")

        if kind == "agent.message":
            text = "".join(
                block.text
                for block in (event.content or [])
                if getattr(block, "type", "") == "text"
            ).strip()
            if text:
                chunks.append(text)
                if on_progress:
                    on_progress(text)

        elif kind == "agent.tool_use" and on_progress:
            on_progress(f"_using {getattr(event, 'name', 'a tool')}…_")

        elif kind == "agent.custom_tool_use":
            name = getattr(event, "name", "")
            args = getattr(event, "input", None) or {}
            if tool_handler is None:
                result, is_error = f"No handler for tool {name!r}.", True
            else:
                try:
                    result, is_error = tool_handler(name, dict(args)), False
                except Exception as exc:
                    log.exception("custom tool %s failed", name)
                    result, is_error = f"{type(exc).__name__}: {exc}", True
            client.beta.sessions.events.send(
                session_id,
                events=[
                    {
                        "type": "user.custom_tool_result",
                        "custom_tool_use_id": event.id,
                        "content": [{"type": "text", "text": result}],
                        "is_error": is_error,
                    }
                ],
            )

        elif kind == "session.status_idle":
            stop = getattr(event, "stop_reason", None)
            if getattr(stop, "type", None) != "requires_action":
                break

        elif kind == "session.status_terminated":
            break

        elif kind == "session.error":
            err = getattr(event, "error", None)
            log.error("session error: %s", getattr(err, "message", err))

    return "\n\n".join(chunks).strip()


# --------------------------------------------------------------------------
# Ambient RESPOND / IGNORE gate
# --------------------------------------------------------------------------


def should_respond(*, soul: str, recent: list[str], message: str) -> tuple[bool, str]:
    """Cheap Haiku classifier — runs on every home-channel message.

    Deliberately not a Managed Agent session: spinning a sandbox up per channel
    message would be slow and expensive. We only open a session once this says
    RESPOND.
    """
    history = "\n".join(recent[-5:]) or "(no earlier messages)"
    try:
        response = client.messages.create(
            model=config.GATE_MODEL,
            max_tokens=256,
            system=GATE_SYSTEM,
            output_config={"format": {"type": "json_schema", "schema": GATE_SCHEMA}},
            messages=[
                {
                    "role": "user",
                    "content": (
                        f"<charter>\n{soul}\n</charter>\n\n"
                        f"<recent_messages>\n{history}\n</recent_messages>\n\n"
                        f"<new_message>\n{message}\n</new_message>"
                    ),
                }
            ],
        )
    except Exception:
        log.exception("gate failed; staying quiet")
        return False, "gate error"

    import json

    text = next((b.text for b in response.content if b.type == "text"), "{}")
    try:
        verdict = json.loads(text)
    except json.JSONDecodeError:
        return False, "unparseable gate output"
    return verdict.get("decision") == "RESPOND", verdict.get("reason", "")
