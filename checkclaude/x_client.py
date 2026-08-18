"""Thin X (Twitter) API v2 client: listen for mentions and DMs, read threads, reply.

Reads use the app-only bearer token. Writes use OAuth 1.0a user context. DMs are
user-context in both directions - there is no app-only view of someone's inbox.

Two ingest paths for public mentions:
  * ``poll``   - GET /2/users/:id/mentions on an interval. Works on every access
                 tier, including pay-per-use. This is the default.
  * ``stream`` - GET /2/tweets/search/stream with a `@handle` rule. Lower latency
                 (single-digit seconds) but requires Pro or Enterprise access.

DMs are polled from GET /2/dm_events. That endpoint has no ``since_id``, so the
cursor is applied client-side against the snowflake ids it returns.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Iterable

import requests
from requests_oauthlib import OAuth1

from config import Config, config

log = logging.getLogger(__name__)

API = "https://api.x.com/2"

# Everything we need to reconstruct a claim and its thread in one round trip.
TWEET_FIELDS = "created_at,author_id,conversation_id,referenced_tweets,entities,public_metrics,lang"
USER_FIELDS = "username,name,verified,description"
EXPANSIONS = "author_id,referenced_tweets.id,referenced_tweets.id.author_id"

DM_EVENT_FIELDS = "id,text,event_type,created_at,sender_id,dm_conversation_id,referenced_tweets"
DM_EXPANSIONS = "sender_id"


@dataclass
class Post:
    """A single X post, flattened into the fields the agent actually needs."""

    id: str
    text: str
    author_id: str
    author_handle: str = ""
    author_name: str = ""
    created_at: str = ""
    conversation_id: str = ""
    parent_id: str | None = None
    urls: list[str] = field(default_factory=list)

    @property
    def url(self) -> str:
        handle = self.author_handle or "i"
        return f"https://x.com/{handle}/status/{self.id}"


@dataclass
class DirectMessage:
    """One incoming DM. The private twin of ``Post``.

    ``referenced_post_ids`` are posts shared into the conversation - the usual way
    someone asks about a specific post privately rather than by pasting a link.
    """

    id: str
    text: str
    sender_id: str
    conversation_id: str
    sender_handle: str = ""
    sender_name: str = ""
    created_at: str = ""
    referenced_post_ids: list[str] = field(default_factory=list)


class RateLimited(Exception):
    def __init__(self, reset_epoch: float | None):
        self.reset_epoch = reset_epoch
        super().__init__("rate limited")


class XClient:
    def __init__(self, cfg: Config = config):
        self.cfg = cfg
        self._session = requests.Session()
        self._me_id: str | None = None

    # -- HTTP plumbing ------------------------------------------------------

    def _oauth1(self) -> OAuth1:
        self.cfg.require_write_credentials()
        return OAuth1(
            self.cfg.api_key,
            self.cfg.api_secret,
            self.cfg.access_token,
            self.cfg.access_secret,
        )

    def _get(self, path: str, params: dict[str, Any] | None = None, *, user_context: bool = False) -> dict:
        kwargs: dict[str, Any] = {"params": params or {}, "timeout": 30}
        if user_context:
            kwargs["auth"] = self._oauth1()
        else:
            self.cfg.require_read_credentials()
            kwargs["headers"] = {"Authorization": f"Bearer {self.cfg.bearer_token}"}

        response = self._session.get(f"{API}{path}", **kwargs)
        if response.status_code == 429:
            reset = response.headers.get("x-rate-limit-reset")
            raise RateLimited(float(reset) if reset else None)
        response.raise_for_status()
        return response.json()

    def _post(self, path: str, payload: dict[str, Any]) -> dict:
        response = self._session.post(
            f"{API}{path}", json=payload, auth=self._oauth1(), timeout=30
        )
        if response.status_code == 429:
            reset = response.headers.get("x-rate-limit-reset")
            raise RateLimited(float(reset) if reset else None)
        if response.status_code >= 400:
            log.error("POST %s failed: %s %s", path, response.status_code, response.text)
        response.raise_for_status()
        return response.json()

    # -- Parsing ------------------------------------------------------------

    @staticmethod
    def _index_users(includes: dict) -> dict[str, dict]:
        return {u["id"]: u for u in includes.get("users", [])}

    @staticmethod
    def _to_dm(raw: dict, users: dict[str, dict]) -> DirectMessage:
        sender_id = raw.get("sender_id", "")
        sender = users.get(sender_id, {})
        return DirectMessage(
            id=raw["id"],
            text=raw.get("text", ""),
            sender_id=sender_id,
            conversation_id=raw.get("dm_conversation_id", ""),
            sender_handle=sender.get("username", ""),
            sender_name=sender.get("name", ""),
            created_at=raw.get("created_at", ""),
            referenced_post_ids=[
                ref["id"] for ref in raw.get("referenced_tweets") or [] if ref.get("id")
            ],
        )

    @staticmethod
    def _to_post(raw: dict, users: dict[str, dict]) -> Post:
        parent = None
        for ref in raw.get("referenced_tweets") or []:
            if ref.get("type") == "replied_to":
                parent = ref["id"]
                break

        urls = [
            u.get("expanded_url") or u.get("url", "")
            for u in (raw.get("entities") or {}).get("urls", [])
        ]
        # Drop X's own self-links (quoted posts, media) - they aren't sources.
        urls = [u for u in urls if u and "//x.com/" not in u and "//twitter.com/" not in u]

        author = users.get(raw.get("author_id", ""), {})
        return Post(
            id=raw["id"],
            text=raw.get("text", ""),
            author_id=raw.get("author_id", ""),
            author_handle=author.get("username", ""),
            author_name=author.get("name", ""),
            created_at=raw.get("created_at", ""),
            conversation_id=raw.get("conversation_id", ""),
            parent_id=parent,
            urls=urls,
        )

    # -- Public API (async wrappers over the sync HTTP calls) ---------------

    async def me_id(self) -> str:
        if self._me_id is None:
            data = await asyncio.to_thread(self._get, "/users/me", None, user_context=True)
            self._me_id = data["data"]["id"]
            log.info("Authenticated as @%s (%s)", data["data"]["username"], self._me_id)
        return self._me_id

    async def get_post(self, post_id: str) -> Post | None:
        """Fetch one post with its author expanded."""
        try:
            data = await asyncio.to_thread(
                self._get,
                f"/tweets/{post_id}",
                {
                    "tweet.fields": TWEET_FIELDS,
                    "user.fields": USER_FIELDS,
                    "expansions": "author_id",
                },
            )
        except requests.HTTPError as exc:
            log.warning("Could not fetch post %s: %s", post_id, exc)
            return None
        if "data" not in data:
            return None
        return self._to_post(data["data"], self._index_users(data.get("includes", {})))

    async def get_thread(self, post: Post, depth: int | None = None) -> list[Post]:
        """Walk up the reply chain from ``post``, oldest first, excluding ``post``."""
        depth = depth if depth is not None else self.cfg.thread_depth
        ancestors: list[Post] = []
        cursor = post.parent_id
        while cursor and len(ancestors) < depth:
            parent = await self.get_post(cursor)
            if parent is None:
                break
            ancestors.append(parent)
            cursor = parent.parent_id
        return list(reversed(ancestors))

    async def reply(self, post_id: str, text: str) -> str | None:
        """Post ``text`` as a reply to ``post_id``. Returns the new post id."""
        if self.cfg.dry_run:
            log.info("[dry-run] would reply to %s:\n%s", post_id, text)
            return None
        data = await asyncio.to_thread(
            self._post,
            "/tweets",
            {"text": text, "reply": {"in_reply_to_tweet_id": post_id}},
        )
        new_id = data["data"]["id"]
        log.info("Replied to %s with %s", post_id, new_id)
        return new_id

    async def reply_thread(self, post_id: str, posts: list[str]) -> list[str]:
        """Post ``posts`` as a chain, each one replying to the previous.

        Returns the ids that were actually created. A failure partway through
        leaves a shorter thread rather than none: the lead post already carries
        the answer, so what is lost is elaboration, not the verdict.
        """
        ids: list[str] = []
        target = post_id
        for index, text in enumerate(posts):
            try:
                new_id = await self.reply(target, text)
            except requests.RequestException as exc:
                log.error("Thread stopped at post %d/%d: %s", index + 1, len(posts), exc)
                break
            if new_id is None:
                continue  # dry run: nothing to chain onto, but log every post
            ids.append(new_id)
            target = new_id
        return ids

    # -- DMs ----------------------------------------------------------------

    async def send_dm(self, conversation_id: str, text: str) -> str | None:
        """Reply inside an existing DM conversation. Returns the dm event id."""
        if self.cfg.dry_run:
            log.info("[dry-run] would DM conversation %s:\n%s", conversation_id, text)
            return None
        data = await asyncio.to_thread(
            self._post, f"/dm_conversations/{conversation_id}/messages", {"text": text}
        )
        event_id = (data.get("data") or {}).get("dm_event_id")
        log.info("Sent DM in conversation %s (%s)", conversation_id, event_id)
        return event_id

    async def dm_user(self, user_id: str, text: str) -> str | None:
        """Open (or reuse) a DM with ``user_id``. ``None`` means not delivered.

        Being unable to DM someone is the normal case, not an error: accounts that
        don't accept DMs from strangers return 403. Callers use the return value to
        decide whether they may *say* a DM was sent.
        """
        if self.cfg.dry_run:
            log.info("[dry-run] would DM user %s:\n%s", user_id, text)
            return None
        try:
            data = await asyncio.to_thread(
                self._post, f"/dm_conversations/with/{user_id}/messages", {"text": text}
            )
        except requests.RequestException as exc:
            log.info("Could not DM %s (%s); staying with the public reply only", user_id, exc)
            return None
        return (data.get("data") or {}).get("dm_event_id")

    async def listen_for_dms(self, since_id: str | None = None) -> AsyncIterator[DirectMessage]:
        """Yield incoming DMs, oldest first, forever.

        The bot's own messages are filtered out here rather than downstream: every
        reply it sends lands in the same event feed, and answering those would be
        an infinite loop with a bill attached.
        """
        me = await self.me_id()
        cursor = since_id
        while True:
            params: dict[str, Any] = {
                "max_results": 25,
                "event_types": "MessageCreate",
                "dm_event.fields": DM_EVENT_FIELDS,
                "user.fields": USER_FIELDS,
                "expansions": DM_EXPANSIONS,
            }
            try:
                data = await asyncio.to_thread(
                    self._get, "/dm_events", params, user_context=True
                )
            except RateLimited as exc:
                wait = max(5.0, (exc.reset_epoch or 0) - time.time()) if exc.reset_epoch else 60.0
                log.warning("Rate limited on DMs; sleeping %.0fs", wait)
                await asyncio.sleep(wait)
                continue
            except requests.RequestException as exc:
                log.warning("DM poll failed (%s); retrying", exc)
                await asyncio.sleep(self.cfg.dm_poll_seconds)
                continue

            users = self._index_users(data.get("includes", {}))
            # Newest-first from the API, and no since_id parameter to lean on, so
            # the cursor is enforced here against the ids themselves.
            for raw in reversed(data.get("data", []) or []):
                if cursor and int(raw["id"]) <= int(cursor):
                    continue
                cursor = raw["id"]
                if raw.get("sender_id") == me:
                    continue
                yield self._to_dm(raw, users)

            await asyncio.sleep(self.cfg.dm_poll_seconds)

    # -- Ingest: mentions ---------------------------------------------------

    async def listen_for_mentions(self, since_id: str | None = None) -> AsyncIterator[Post]:
        """Yield posts that mention the bot, oldest first, forever."""
        if self.cfg.ingest_mode == "stream":
            async for post in self._stream_mentions():
                yield post
        else:
            async for post in self._poll_mentions(since_id):
                yield post

    # -- Ingest: polling ----------------------------------------------------

    async def _poll_mentions(self, since_id: str | None) -> AsyncIterator[Post]:
        user_id = await self.me_id()
        cursor = since_id
        while True:
            params: dict[str, Any] = {
                "max_results": 25,
                "tweet.fields": TWEET_FIELDS,
                "user.fields": USER_FIELDS,
                "expansions": EXPANSIONS,
            }
            if cursor:
                params["since_id"] = cursor

            try:
                data = await asyncio.to_thread(
                    self._get, f"/users/{user_id}/mentions", params, user_context=True
                )
            except RateLimited as exc:
                wait = max(5.0, (exc.reset_epoch or 0) - time.time()) if exc.reset_epoch else 60.0
                log.warning("Rate limited on mentions; sleeping %.0fs", wait)
                await asyncio.sleep(wait)
                continue
            except requests.RequestException as exc:
                log.warning("Mentions poll failed (%s); retrying", exc)
                await asyncio.sleep(self.cfg.poll_seconds)
                continue

            users = self._index_users(data.get("includes", {}))
            # The API returns newest-first; process oldest-first so threads make sense.
            for raw in reversed(data.get("data", []) or []):
                cursor = max(cursor, raw["id"], key=int) if cursor else raw["id"]
                yield self._to_post(raw, users)

            newest = (data.get("meta") or {}).get("newest_id")
            if newest:
                cursor = max(cursor, newest, key=int) if cursor else newest

            await asyncio.sleep(self.cfg.poll_seconds)

    # -- Ingest: filtered stream (Pro / Enterprise access only) -------------

    def _sync_stream_rules(self) -> None:
        self.cfg.require_read_credentials()
        headers = {"Authorization": f"Bearer {self.cfg.bearer_token}"}
        want = f"@{self.cfg.bot_handle} -is:retweet"

        current = self._session.get(
            f"{API}/tweets/search/stream/rules", headers=headers, timeout=30
        )
        current.raise_for_status()
        existing = current.json().get("data", []) or []
        if any(rule["value"] == want for rule in existing):
            return
        if existing:
            self._session.post(
                f"{API}/tweets/search/stream/rules",
                headers=headers,
                json={"delete": {"ids": [r["id"] for r in existing]}},
                timeout=30,
            ).raise_for_status()
        self._session.post(
            f"{API}/tweets/search/stream/rules",
            headers=headers,
            json={"add": [{"value": want, "tag": "checkclaude-mention"}]},
            timeout=30,
        ).raise_for_status()
        log.info("Filtered stream rule set: %s", want)

    def _stream_lines(self) -> Iterable[str]:
        headers = {"Authorization": f"Bearer {self.cfg.bearer_token}"}
        params = {
            "tweet.fields": TWEET_FIELDS,
            "user.fields": USER_FIELDS,
            "expansions": EXPANSIONS,
        }
        with self._session.get(
            f"{API}/tweets/search/stream",
            headers=headers,
            params=params,
            stream=True,
            timeout=(30, 90),
        ) as response:
            response.raise_for_status()
            for line in response.iter_lines():
                if line:
                    yield line.decode("utf-8")

    async def _stream_mentions(self) -> AsyncIterator[Post]:
        await asyncio.to_thread(self._sync_stream_rules)
        backoff = 1.0
        while True:
            queue: asyncio.Queue[str | None] = asyncio.Queue()
            loop = asyncio.get_running_loop()

            def pump() -> None:
                try:
                    for line in self._stream_lines():
                        loop.call_soon_threadsafe(queue.put_nowait, line)
                except Exception as exc:  # noqa: BLE001 - surfaced below
                    log.warning("Stream dropped: %s", exc)
                finally:
                    loop.call_soon_threadsafe(queue.put_nowait, None)

            task = asyncio.create_task(asyncio.to_thread(pump))
            while True:
                line = await queue.get()
                if line is None:
                    break
                backoff = 1.0
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if "data" not in payload:
                    continue
                users = self._index_users(payload.get("includes", {}))
                yield self._to_post(payload["data"], users)

            await task
            log.info("Reconnecting to filtered stream in %.0fs", backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60.0)
