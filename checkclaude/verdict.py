"""Verdict model + response guard.

The guard is the last thing between the agent and a public post. It enforces the
three properties this product lives or dies on:

  1. Every cited URL was actually retrieved during the investigation.
  2. A verdict that asserts something has at least one surviving source, or it is
     downgraded to UNVERIFIABLE.
  3. The reply fits in one post.

Two rendering styles. ``conversational`` (the default) reads like a person
answering in the thread - the verdict is carried by the prose, not a label.
``card`` is the labelled format from the PRD, kept so the two can be compared
side by side. Either way the verdict enum is computed and enforced internally;
the style only decides whether the reader sees it as a header.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from urllib.parse import urlparse

log = logging.getLogger(__name__)

CONVERSATIONAL = "conversational"
CARD = "card"

LABELS: dict[str, str] = {
    "TRUE": "✅ TRUE",
    "MOSTLY_TRUE": "⚠️ MOSTLY TRUE",
    "MISLEADING": "⚠️ MISLEADING",
    "FALSE": "❌ FALSE",
    "UNVERIFIABLE": "❓ UNVERIFIABLE",
}

# Verdicts that assert something about the world, and therefore require evidence.
ASSERTIVE = {"TRUE", "MOSTLY_TRUE", "MISLEADING", "FALSE"}

# X wraps every link in t.co, which always costs 23 characters.
TCO_LEN = 23
_URL_RE = re.compile(r"https?://\S+")


@dataclass
class Source:
    name: str
    url: str


@dataclass
class FactCheck:
    verdict: str
    claim: str
    body: str
    sources: list[Source] = field(default_factory=list)
    confidence: str = "medium"
    notes: str = ""


@dataclass
class GuardedReply:
    text: str
    fact_check: FactCheck
    dropped_sources: list[Source] = field(default_factory=list)
    downgraded: bool = False
    truncated: bool = False

    @property
    def warnings(self) -> list[str]:
        out: list[str] = []
        if self.dropped_sources:
            out.append(
                "dropped unretrieved citations: "
                + ", ".join(f"{s.name} <{s.url}>" for s in self.dropped_sources)
            )
        if self.downgraded:
            out.append("downgraded to UNVERIFIABLE: no verifiable source survived")
        if self.truncated:
            out.append("reply truncated to fit one post")
        return out


def tweet_length(text: str) -> int:
    """Approximate X's character count: every URL costs a flat 23."""
    urls = _URL_RE.findall(text)
    return len(_URL_RE.sub("", text)) + TCO_LEN * len(urls)


def normalize_url(url: str) -> str:
    """Host + path, case- and slash-insensitive. Used to match citations against
    pages the agent actually retrieved."""
    try:
        parsed = urlparse(url.strip())
    except ValueError:
        return url.strip().lower()
    host = (parsed.netloc or "").lower().removeprefix("www.")
    path = (parsed.path or "").rstrip("/")
    return f"{host}{path}"


def _sentence_truncate(text: str, budget: int) -> tuple[str, bool]:
    """Trim to the last full sentence that fits; hard-cut only as a last resort."""
    if tweet_length(text) <= budget:
        return text, False
    pieces = re.split(r"(?<=[.!?])\s+", text)
    kept = ""
    for piece in pieces:
        candidate = f"{kept} {piece}".strip()
        if tweet_length(candidate) > budget:
            break
        kept = candidate
    if kept:
        return kept, True
    return text[: max(0, budget - 1)].rstrip() + "…", True


def _sources_line(sources: list[Source], with_urls: bool, style: str) -> str:
    if not sources:
        return ""
    if style == CARD:
        parts = [f"{s.name} {s.url}" if with_urls else s.name for s in sources]
        return "Sources: " + " · ".join(parts)
    # Conversational: a bare link reads like a normal reply. Fall back to
    # publisher names only when the links themselves won't fit.
    if with_urls:
        return " ".join(s.url for s in sources)
    return "Sources: " + ", ".join(s.name for s in sources)


def compose(check: FactCheck, max_chars: int, style: str = CONVERSATIONAL) -> tuple[str, bool]:
    """Render the reply, shrinking it until it fits. Returns (text, truncated)."""
    header = LABELS.get(check.verdict, LABELS["UNVERIFIABLE"]) if style == CARD else ""

    def assemble(body: str, sources: list[Source], with_urls: bool) -> str:
        blocks = [header, body.strip(), _sources_line(sources, with_urls, style)]
        return "\n\n".join(b for b in blocks if b)

    # Try progressively cheaper source renderings before touching the prose.
    # Note there is no "drop the sources entirely" rung: an unattributed reply is
    # worse than a slightly shorter one, so attribution outlives the last clause.
    for sources, with_urls in (
        (check.sources[:2], True),
        (check.sources[:1], True),
        (check.sources[:2], False),
    ):
        text = assemble(check.body, sources, with_urls)
        if tweet_length(text) <= max_chars:
            return text, False

    # Still too long: the prose itself has to give, and the names stay.
    sources = check.sources[:2]
    fixed = tweet_length(assemble("", sources, False))
    budget = max_chars - fixed - 2
    body, truncated = _sentence_truncate(check.body, budget)
    return assemble(body, sources, False), truncated


def guard(
    check: FactCheck,
    retrieved_urls: set[str],
    max_chars: int,
    style: str = CONVERSATIONAL,
) -> GuardedReply:
    """Validate a fact-check and render a postable reply."""
    if check.verdict not in LABELS:
        log.warning("Unknown verdict %r; treating as UNVERIFIABLE", check.verdict)
        check.verdict = "UNVERIFIABLE"

    retrieved = {normalize_url(u) for u in retrieved_urls}
    kept: list[Source] = []
    dropped: list[Source] = []
    for source in check.sources:
        if normalize_url(source.url) in retrieved:
            kept.append(source)
        else:
            dropped.append(source)

    downgraded = False
    if check.verdict in ASSERTIVE and not kept:
        check.verdict = "UNVERIFIABLE"
        downgraded = True
        # In conversational style there is no header to carry the downgrade, so
        # the uncertainty has to be stated in the prose itself.
        if check.body:
            check.body = (
                "I couldn't confirm this against a source I was able to open, so treat "
                "this as unverified. " + check.body
            )

    check.sources = kept
    text, truncated = compose(check, max_chars, style)
    return GuardedReply(
        text=text,
        fact_check=check,
        dropped_sources=dropped,
        downgraded=downgraded,
        truncated=truncated,
    )
