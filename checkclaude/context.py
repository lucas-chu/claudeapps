"""Turn a raw request - an @mention or a DM - into the block the agent reasons over.

Both channels produce the same ``CheckContext``, because the investigation does
not change with the audience. What changes is the answer: ``channel`` is what the
prompt and the response guard key off to decide how much room the answer has and
whether it is going to be seen in public.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from config import config
from x_client import DirectMessage, Post, XClient

PUBLIC = "public"
DM = "dm"

# Any mention of the bot counts. We do NOT require an exact phrase - "is this
# true?", "check this", "source?", and bare "@CheckClaude" all work. The stripped
# remainder becomes the user's question, which shapes what the agent investigates.
_GREETINGS = {"", "?", "!", ".", "hi", "hey", "hello", "yo", "pls", "please", "thanks"}


def is_trigger(mention: Post, bot_handle: str = "") -> bool:
    handle = (bot_handle or config.bot_handle).lower()
    return f"@{handle}" in mention.text.lower()


def strip_handles(text: str) -> str:
    """Remove leading @mentions so the remainder is the user's actual question."""
    return re.sub(r"^(?:\s*@\w+)+\s*", "", text).strip()


def user_question(mention: Post) -> str:
    question = re.sub(rf"@{re.escape(config.bot_handle)}\b", "", strip_handles(mention.text), flags=re.I)
    question = re.sub(r"\s+", " ", question).strip()
    if question.lower() in _GREETINGS:
        return "Is this true?"
    return question


def parse_post_id(target: str) -> str | None:
    """Pull a post id out of a URL or accept a bare id.

    Usernames can contain digits, so the /status/ segment wins over anything
    earlier in the URL.
    """
    in_url = re.search(r"/status(?:es)?/(\d{5,25})", target)
    if in_url:
        return in_url.group(1)
    bare = re.fullmatch(r"\s*(\d{5,25})\s*", target)
    return bare.group(1) if bare else None


_URL_RE = re.compile(r"https?://[^\s<>\"')]+")


def extract_links(post: Post) -> list[str]:
    """URLs the post points at - candidate primary sources for the agent."""
    seen: list[str] = []
    for url in [*post.urls, *_URL_RE.findall(post.text)]:
        cleaned = url.rstrip(".,);")
        if cleaned and cleaned not in seen and "//t.co/" not in cleaned:
            seen.append(cleaned)
    return seen


@dataclass
class CheckContext:
    """Everything the agent gets about one fact-check request."""

    mention: Post
    claim_post: Post
    question: str
    thread: list[Post] = field(default_factory=list)
    links: list[str] = field(default_factory=list)
    prior_check: str | None = None  # set for follow-ups on an earlier verdict
    # "public" for an @mention answered in the thread, "dm" for a private request
    # answered only in that DM conversation.
    channel: str = PUBLIC

    @property
    def is_followup(self) -> bool:
        return self.prior_check is not None

    @property
    def is_private(self) -> bool:
        return self.channel == DM

    @property
    def claim_is_the_request(self) -> bool:
        """True when the requester wrote the claim themselves rather than pointing
        at a post - common in DMs, where there may be no post at all."""
        return self.claim_post.id == self.mention.id

    def render(self) -> str:
        """Render as a labelled block. Untrusted text is fenced so the agent can
        tell post content apart from its own instructions."""
        parts: list[str] = []

        if self.thread:
            lines = [
                f"@{p.author_handle or p.author_id} ({p.created_at or 'unknown date'}): {p.text}"
                for p in self.thread
            ]
            parts.append("THREAD CONTEXT (oldest first):\n<<<\n" + "\n\n".join(lines) + "\n>>>")

        if self.is_private and self.claim_is_the_request:
            # No post to point at, so no author and no permalink to report - and
            # inventing either would be a fabricated source.
            parts.append(
                "CLAIM, AS WRITTEN BY THE REQUESTER IN THE DM:\n<<<\n"
                + self.claim_post.text
                + "\n>>>"
            )
        else:
            parts.append(
                "CLAIM POST:\n<<<\n" + self.claim_post.text + "\n>>>\n"
                f"AUTHOR: @{self.claim_post.author_handle or self.claim_post.author_id}"
                + (f" ({self.claim_post.author_name})" if self.claim_post.author_name else "")
                + f"\nPOSTED: {self.claim_post.created_at or 'unknown'}"
                f"\nPERMALINK: {self.claim_post.url}"
            )

        if self.links:
            parts.append("LINKED URLS IN THE CLAIM POST:\n" + "\n".join(f"- {u}" for u in self.links))

        if self.prior_check:
            label = (
                "YOUR PREVIOUS CHECK IN THIS DM CONVERSATION"
                if self.is_private
                else "YOUR PREVIOUS CHECK ON THIS THREAD"
            )
            parts.append(f"{label}:\n<<<\n" + self.prior_check + "\n>>>")

        asker = self.mention.author_handle or self.mention.author_id
        origin = "private DM from" if self.is_private else "from"
        parts.append(f'USER QUESTION ({origin} @{asker}):\n<<<\n"{self.question}"\n>>>')
        return "\n\n".join(parts)


async def build_context(
    client: XClient, mention: Post, prior_check: str | None = None
) -> CheckContext | None:
    """Resolve a mention into a claim + surrounding thread.

    Returns ``None`` when there is nothing checkable - a top-level mention with
    no parent post and no claim of its own.
    """
    claim_post = mention
    if mention.parent_id:
        parent = await client.get_post(mention.parent_id)
        if parent is not None:
            claim_post = parent

    if claim_post.id == mention.id and len(strip_handles(mention.text)) < 25:
        # Someone said "@CheckClaude" into the void with no claim attached.
        return None

    thread = await client.get_thread(claim_post)
    links = extract_links(claim_post)
    for ancestor in thread:
        links.extend(u for u in extract_links(ancestor) if u not in links)

    return CheckContext(
        mention=mention,
        claim_post=claim_post,
        question=user_question(mention),
        thread=thread,
        links=links[:5],
        prior_check=prior_check,
    )


def post_ids_in(text: str) -> list[str]:
    """Post ids for any x.com/twitter.com status links in ``text``."""
    ids: list[str] = []
    for url in _URL_RE.findall(text):
        if "x.com/" not in url and "twitter.com/" not in url:
            continue
        post_id = parse_post_id(url)
        if post_id and post_id not in ids:
            ids.append(post_id)
    return ids


def dm_question(dm: DirectMessage) -> str:
    """What the DM is asking, with the links stripped out.

    A pasted permalink is how the claim arrived, not part of the question, so it
    would only make the question read strangely to the agent.
    """
    text = re.sub(r"\s+", " ", _URL_RE.sub("", strip_handles(dm.text))).strip()
    if text.lower() in _GREETINGS:
        return "Is this true?"
    return text


async def build_dm_context(
    client: XClient, dm: DirectMessage, prior_check: str | None = None
) -> CheckContext | None:
    """Resolve a DM into a claim to investigate.

    A DM can carry the claim three ways, and they are tried in this order because
    that is the order of how specific they are:

      1. a post shared into the conversation,
      2. a permalink pasted into the text,
      3. the text itself ("is it true that ...").

    Returns ``None`` when none of those produced something checkable, which the
    caller answers with a one-line "send me a link or a claim" instead of silence -
    in a private channel, no reply just looks broken.
    """
    request = Post(
        id=dm.id,
        text=dm.text,
        author_id=dm.sender_id,
        author_handle=dm.sender_handle,
        author_name=dm.sender_name,
        created_at=dm.created_at,
    )

    claim_post: Post | None = None
    for post_id in [*dm.referenced_post_ids, *post_ids_in(dm.text)]:
        claim_post = await client.get_post(post_id)
        if claim_post is not None:
            break

    if claim_post is None:
        if len(strip_handles(_URL_RE.sub("", dm.text)).strip()) < 25:
            return None  # "hi", or a link we could not resolve, and nothing else
        claim_post = request

    thread = await client.get_thread(claim_post) if claim_post is not request else []
    links = extract_links(claim_post)
    for ancestor in thread:
        links.extend(u for u in extract_links(ancestor) if u not in links)
    # Sources the requester pasted themselves are candidates too, minus the
    # permalink that only told us which post they meant.
    for url in extract_links(request):
        if url not in links and "x.com/" not in url and "twitter.com/" not in url:
            links.append(url)

    return CheckContext(
        mention=request,
        claim_post=claim_post,
        question=dm_question(dm),
        thread=thread,
        links=links[:5],
        prior_check=prior_check,
        channel=DM,
    )
