"""Thin X (Twitter) API v2 client: listen for mentions, read threads, post replies.

Reads use the app-only bearer token. Writes use OAuth 1.0a user context.

Two ingest paths:
  * ``poll``   - GET /2/users/:id/mentions on an interval. Works on every access
                 tier, including pay-per-use. This is the default.
  * ``stream`` - GET /2/tweets/search/stream with a `@handle` rule. Lower latency
                 (single-digit seconds) but requires Pro or Enterprise access.
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
