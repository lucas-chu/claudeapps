"""Turn a raw @mention into the context block the agent reasons over."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from config import config
from x_client import Post, XClient

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

    @property
    def is_followup(self) -> bool:
        return self.prior_check is not None

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
            parts.append("YOUR PREVIOUS CHECK ON THIS THREAD:\n<<<\n" + self.prior_check + "\n>>>")

        parts.append(
            f"USER QUESTION (from @{self.mention.author_handle or self.mention.author_id}):\n"
            f'<<<\n"{self.question}"\n>>>'
        )
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
