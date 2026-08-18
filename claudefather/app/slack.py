"""Slack event ingestion and responses.

One Socket Mode connection, on the router (ClaudeFather) app. Because that app is
in the channel and holds `channels:history`, it receives every message —
including ones that mention a teammate. The teammate apps never listen; their
tokens are only used to post, so each teammate speaks with its own identity.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor

from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

from . import claudefather, config, managed_agent, registry, router, slack_client
from .prompts import CREATE_TEAMMATE_TOOL, LIST_TEAMMATES_TOOL

log = logging.getLogger(__name__)

# token_verification_enabled=False keeps App() from calling auth.test at import
# time; main() verifies the token explicitly once, at startup.
app = App(token=config.SLACK_BOT_TOKEN, token_verification_enabled=False)
pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="turn")

CLAUDEFATHER_USER_ID: str = ""

# Slack re-delivers; a message is handled once.
_seen: deque[str] = deque(maxlen=2048)
_seen_set: set[str] = set()
_seen_lock = threading.Lock()

# Short rolling history per channel, for the ambient gate.
_recent: dict[str, deque[str]] = defaultdict(lambda: deque(maxlen=12))

THINKING = "_thinking…_"


def _once(key: str) -> bool:
    with _seen_lock:
        if key in _seen_set:
            return False
        if len(_seen) == _seen.maxlen:
            _seen_set.discard(_seen[0])
        _seen.append(key)
        _seen_set.add(key)
        return True


class Reply:
    """A Slack message that gets edited in place as the agent works."""

    def __init__(self, client, *, channel: str, thread_ts: str, username: str, emoji: str):
        self.client = client
        self.channel = channel
        self.thread_ts = thread_ts
        self.ts = slack_client.post(
            client,
            channel=channel,
            thread_ts=thread_ts,
            text=THINKING,
            username=username,
            icon_emoji=emoji,
        )
        self._last = 0.0

    def progress(self, text: str) -> None:
        # chat.update is rate limited to roughly one call per second.
        now = time.monotonic()
        if not self.ts or now - self._last < 1.5:
            return
        self._last = now
        slack_client.update(
            self.client, channel=self.channel, ts=self.ts, text=text[:2900]
        )

    def finish(self, text: str) -> None:
        body = text.strip() or "_(no response)_"
        if self.ts:
            slack_client.update(
                self.client, channel=self.channel, ts=self.ts, text=body[:3900]
            )
        else:
            slack_client.post(
                self.client, channel=self.channel, thread_ts=self.thread_ts, text=body[:3900]
            )


def _run_claudefather(*, channel: str, thread_ts: str, text: str) -> None:
    reply = Reply(
        app.client, channel=channel, thread_ts=thread_ts, username="ClaudeFather", emoji="baby"
    )
    try:
        answer = managed_agent.run_turn(
            agent_id=config.CLAUDEFATHER_AGENT_ID,
            agent_version=config.CLAUDEFATHER_AGENT_VERSION,
            channel=channel,
            thread_ts=thread_ts,
            text=text,
            title="ClaudeFather · hiring",
            tool_handler=claudefather.handle_tool,
            on_progress=reply.progress,
        )
    except Exception as exc:
        log.exception("claudefather turn failed")
        answer = f":warning: Hiring failed — `{type(exc).__name__}: {exc}`"
    reply.finish(answer)


def _run_teammate(teammate: registry.Teammate, *, channel: str, thread_ts: str, text: str) -> None:
    slot = registry.slot_for(teammate)
    if slot is None:
        log.error("teammate %s has no configured slot %s", teammate.name, teammate.slot_index)
        return
    client = slack_client.for_slot(slot)
    reply = Reply(
        client,
        channel=channel,
        thread_ts=thread_ts,
        username=teammate.name,
        emoji=teammate.emoji,
    )
    try:
        answer = managed_agent.run_turn(
            agent_id=teammate.agent_id,
            agent_version=teammate.agent_version,
            channel=channel,
            thread_ts=thread_ts,
            text=text,
            title=f"{teammate.name} · {channel}",
            on_progress=reply.progress,
        )
    except Exception as exc:
        log.exception("%s turn failed", teammate.name)
        answer = f":warning: `{type(exc).__name__}: {exc}`"
    reply.finish(answer)


def _run_ambient(decision: router.Decision, *, channel: str, thread_ts: str) -> None:
    """Let each home-channel teammate decide, and stop at the first RESPOND."""
    history = list(_recent[channel])[:-1]
    for teammate in decision.candidates:
        soul = (config.ROOT / teammate.soul_path).read_text()
        respond, reason = managed_agent.should_respond(
            soul=soul, recent=history, message=decision.text
        )
        log.info(
            "gate %s: %s (%s)", teammate.name, "RESPOND" if respond else "IGNORE", reason
        )
        if respond:
            _run_teammate(teammate, channel=channel, thread_ts=thread_ts, text=decision.text)
            return


@app.event("message")
def on_message(event, logger):  # noqa: ARG001 — Bolt injects `logger`
    if router.is_from_bot(event, _our_user_ids()):
        return
    channel = event.get("channel", "")
    ts = event.get("ts", "")
    if not channel or not ts or not _once(f"{channel}:{ts}"):
        return

    text = event.get("text", "") or ""
    _recent[channel].append(text)

    decision = router.route(text=text, channel=channel, claudefather_id=CLAUDEFATHER_USER_ID)
    if decision is None:
        return

    # A top-level message starts its own thread; replies stay in theirs. Either
    # way the thread is the session boundary.
    thread_ts = event.get("thread_ts") or ts

    if decision.kind == "claudefather":
        pool.submit(_run_claudefather, channel=channel, thread_ts=thread_ts, text=decision.text)
    elif decision.kind == "direct" and decision.teammate:
        pool.submit(
            _run_teammate, decision.teammate, channel=channel, thread_ts=thread_ts, text=decision.text
        )
    elif decision.kind == "ambient":
        pool.submit(_run_ambient, decision, channel=channel, thread_ts=thread_ts)


def _our_user_ids() -> set[str]:
    ids = {CLAUDEFATHER_USER_ID} if CLAUDEFATHER_USER_ID else set()
    ids |= {slot.bot_user_id for slot in config.identity_pool()}
    return ids


def ensure_claudefather_tools() -> None:
    """Make sure the stored ClaudeFather agent actually has its hiring tools."""
    managed_agent.client.beta.agents.update(
        config.CLAUDEFATHER_AGENT_ID,
        tools=[
            {"type": "agent_toolset_20260401"},
            CREATE_TEAMMATE_TOOL,
            LIST_TEAMMATES_TOOL,
        ],
    )


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s"
    )
    logging.getLogger("slack_bolt").setLevel(logging.WARNING)
    logging.getLogger("slack_sdk").setLevel(logging.WARNING)
    config.require_runtime_config()

    global CLAUDEFATHER_USER_ID
    CLAUDEFATHER_USER_ID = app.client.auth_test()["user_id"]

    teammates = registry.all_teammates()
    log.info("ClaudeFather is <@%s>", CLAUDEFATHER_USER_ID)
    log.info(
        "%d identity slot(s) configured, %d teammate(s) hired%s",
        len(config.identity_pool()),
        len(teammates),
        ": " + ", ".join(f"{t.name} (#{t.home_channel_name})" for t in teammates)
        if teammates
        else "",
    )
    log.info("listening…")
    SocketModeHandler(app, config.SLACK_APP_TOKEN).start()


if __name__ == "__main__":
    main()
