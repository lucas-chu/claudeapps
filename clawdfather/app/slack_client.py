"""Thin Slack Web API helpers.

Kept separate from `slack.py` (the Bolt listener) so `clawdfather.py` can post and
provision without importing the listener — that would be a cycle.
"""

from __future__ import annotations

import logging

from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

from . import config
from .registry import Slot

log = logging.getLogger(__name__)

_router = WebClient(token=config.SLACK_BOT_TOKEN) if config.SLACK_BOT_TOKEN else None
_by_slot: dict[int, WebClient] = {}


def router() -> WebClient:
    if _router is None:
        raise RuntimeError("SLACK_BOT_TOKEN is not set")
    return _router


def for_slot(slot: Slot) -> WebClient:
    if slot.index not in _by_slot:
        _by_slot[slot.index] = WebClient(token=slot.bot_token)
    return _by_slot[slot.index]


def resolve_channel(name: str) -> tuple[str, str]:
    """Channel name (with or without '#') -> (channel_id, channel_name)."""
    wanted = name.strip().lstrip("#").lower()
    cursor = None
    while True:
        resp = router().conversations_list(
            types="public_channel,private_channel",
            limit=200,
            exclude_archived=True,
            cursor=cursor,
        )
        for channel in resp["channels"]:
            if channel["name"].lower() == wanted:
                return channel["id"], channel["name"]
        cursor = resp.get("response_metadata", {}).get("next_cursor")
        if not cursor:
            raise ValueError(
                f"No channel named #{wanted}. Create it in Slack first, or "
                "invite the router bot to it if it is private."
            )


def set_bot_profile(slot: Slot, display_name: str, real_name: str) -> bool:
    """Rename the pooled bot so `@Scout` reads as Scout.

    Needs the `users.profile:write` scope on the teammate app. Best effort: if
    it fails the teammate still posts under the right name via the `username`
    override, only the @mention autocomplete shows the pool app's name.
    """
    try:
        for_slot(slot).users_profile_set(
            profile={"display_name": display_name, "real_name": real_name}
        )
        return True
    except SlackApiError as exc:
        log.warning("could not rename slot %s: %s", slot.index, exc.response.get("error"))
        return False


def invite_to_channel(channel_id: str, bot_user_id: str) -> bool:
    try:
        router().conversations_invite(channel=channel_id, users=bot_user_id)
        return True
    except SlackApiError as exc:
        error = exc.response.get("error", "")
        if error in ("already_in_channel", "cant_invite_self"):
            return True
        log.warning("could not invite %s to %s: %s", bot_user_id, channel_id, error)
        return False


def post(
    client: WebClient,
    *,
    channel: str,
    text: str,
    thread_ts: str | None = None,
    username: str | None = None,
    icon_emoji: str | None = None,
) -> str | None:
    try:
        resp = client.chat_postMessage(
            channel=channel,
            text=text,
            thread_ts=thread_ts,
            username=username,
            icon_emoji=f":{icon_emoji}:" if icon_emoji else None,
            unfurl_links=False,
        )
        return resp["ts"]
    except SlackApiError as exc:
        log.error("post failed: %s", exc.response.get("error"))
        return None


def update(client: WebClient, *, channel: str, ts: str, text: str) -> None:
    try:
        client.chat_update(channel=channel, ts=ts, text=text)
    except SlackApiError as exc:
        log.debug("update failed: %s", exc.response.get("error"))
