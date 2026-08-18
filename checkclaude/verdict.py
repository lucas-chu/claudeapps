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
class SubClaim:
    """One decomposed part of the post, usually researched by its own subagent.

    Carrying sources per sub-claim is what lets the guard tell "the whole answer
    is unsourced" apart from "one half of the answer is unsourced" - the second
    is invisible if you only look at the pooled source list.
    """

    claim: str
    finding: str = ""
    verdict: str = "UNVERIFIABLE"
    sources: list[Source] = field(default_factory=list)


@dataclass
class FactCheck:
    verdict: str
    claim: str
    body: str
    sources: list[Source] = field(default_factory=list)
    confidence: str = "medium"
    notes: str = ""
    sub_claims: list[SubClaim] = field(default_factory=list)


@dataclass
class GuardedReply:
    text: str
    fact_check: FactCheck
    dropped_sources: list[Source] = field(default_factory=list)
    downgraded: bool = False
    truncated: bool = False
    unsupported_sub_claims: list[str] = field(default_factory=list)

    @property
    def warnings(self) -> list[str]:
        out: list[str] = []
        if self.dropped_sources:
            out.append(
                "dropped unretrieved citations: "
                + ", ".join(f"{s.name} <{s.url}>" for s in self.dropped_sources)
            )
        if self.unsupported_sub_claims:
            out.append(
                "sub-claims with no verifiable source: "
                + "; ".join(self.unsupported_sub_claims)
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


def _split_sources(
    sources: list[Source], retrieved: set[str]
) -> tuple[list[Source], list[Source]]:
    """Partition citations into ones backed by a retrieved page and ones not."""
    kept: list[Source] = []
    dropped: list[Source] = []
    for source in sources:
        (kept if normalize_url(source.url) in retrieved else dropped).append(source)
    return kept, dropped


def _dedupe(sources: list[Source]) -> list[Source]:
    seen: set[tuple[str, str]] = set()
    out: list[Source] = []
    for source in sources:
        key = (source.name, normalize_url(source.url))
        if key not in seen:
            seen.add(key)
            out.append(source)
    return out


# Prepended to the reply when evidence did not survive the citation check. There
# is no header in conversational style, so the prose has to carry the downgrade.
_UNSOURCED = (
    "I couldn't confirm this against a source I was able to open, so treat this "
    "as unverified. "
)
_PARTLY_UNSOURCED = (
    "Part of this I couldn't confirm against a source I was able to open, so "
    "treat it as unverified. "
)


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
    kept, dropped = _split_sources(check.sources, retrieved)

    # Each sub-claim is checked against reality on its own. Pooling the sources
    # would let a well-sourced half vouch for an unsourced one, which is exactly
    # the failure the citation check exists to prevent.
    unsupported: list[str] = []
    for sub in check.sub_claims:
        sub.verdict = sub.verdict.upper().replace(" ", "_")
        sub_kept, sub_dropped = _split_sources(sub.sources, retrieved)
        dropped.extend(sub_dropped)
        sub.sources = sub_kept
        if sub.verdict in ASSERTIVE and not sub_kept:
            unsupported.append(sub.claim)
            sub.verdict = "UNVERIFIABLE"

    # The schema asks for both a top-level source list and per-sub-claim ones, so
    # an agent that files everything under the sub-claims would leave the reply
    # unattributed and get downgraded for it. Promote what it did verify instead;
    # these have already passed the same citation check.
    if not kept and check.sub_claims:
        kept = _dedupe([s for sub in check.sub_claims for s in sub.sources])

    downgraded = False
    if check.verdict in ASSERTIVE and not kept:
        prefix = _UNSOURCED
        downgraded = True
    elif check.verdict in ASSERTIVE and unsupported:
        # One unverified part is enough to sink an assertive verdict about the
        # whole: you cannot assert a conjunction you only half-checked. This can
        # cost a defensible FALSE whose falsity rests on the supported half - a
        # deliberate trade, in the direction of failing safe.
        prefix = _PARTLY_UNSOURCED
        downgraded = True

    if downgraded:
        check.verdict = "UNVERIFIABLE"
        if check.body:
            check.body = prefix + check.body

    check.sources = kept
    text, truncated = compose(check, max_chars, style)
    return GuardedReply(
        text=text,
        fact_check=check,
        dropped_sources=_dedupe(dropped),
        downgraded=downgraded,
        truncated=truncated,
        unsupported_sub_claims=unsupported,
    )
