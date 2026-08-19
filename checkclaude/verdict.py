"""Verdict model + response guard.

The guard is the last thing between the agent and a public post. It enforces the
three properties this product lives or dies on:

  1. Every cited URL was actually retrieved during the investigation.
  2. A verdict that asserts something has at least one surviving source, or it is
     downgraded to UNVERIFIABLE.
  3. The reply fits the channel it is going to.

That third property has three shapes, because 280 characters is a property of one
public post and not of the answer:

  * ``compose``        one post, shrinking the answer until it fits.
  * ``compose_thread`` a numbered self-reply thread, so a longer answer can be
                       posted whole instead of cut down. Splitting happens at
                       sentence boundaries and the sources ride on the last post.
  * ``compose_full``   the unabridged answer for a DM, where the ceiling is
                       10,000 characters and every source can be listed.

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

# Room for the " (1/4)" counter on a threaded post. Reserved as a constant rather
# than measured, because the width of the counter depends on how many posts there
# turn out to be, which depends on the room left for prose.
COUNTER_RESERVE = 8

# Appended to the last public post when the unabridged answer went out as a DM -
# and only ever when that DM was actually delivered.
DM_NOTICE = "Full breakdown in your DMs."


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
    """A validated answer, rendered for the channel it is going to.

    ``posts`` is the whole public answer in order - one entry in single-post mode,
    several when the answer was threaded. ``text`` stays the lead post, since that
    is what a reader sees first and what gets recorded.
    """

    posts: list[str]
    fact_check: FactCheck
    dropped_sources: list[Source] = field(default_factory=list)
    downgraded: bool = False
    truncated: bool = False
    unsupported_sub_claims: list[str] = field(default_factory=list)
    dm_notice: bool = False
    # How this was rendered, kept so it can be rendered again - see add_dm_notice.
    max_chars: int = 280
    style: str = CONVERSATIONAL
    max_posts: int = 1

    @property
    def text(self) -> str:
        return self.posts[0] if self.posts else ""

    @property
    def thread_text(self) -> str:
        """Every post as one block - for logs, the store, and follow-up context."""
        return "\n\n".join(self.posts)

    def long_form(self, max_chars: int) -> str:
        """The unabridged answer, for a channel without a 280-character ceiling.

        Built from the *guarded* fact-check, so the citation check and the
        no-evidence downgrade have already been applied - a DM is a smaller
        audience, not a laxer one.
        """
        return compose_full(self.fact_check, max_chars)

    def add_dm_notice(self) -> None:
        """Point readers at the DM carrying the full answer.

        This re-renders rather than appending, because the case that triggers it -
        an answer too long for the thread - is exactly the case where the last post
        is already full. Appending would silently fail there, so the pointer is
        given a budget and the prose gives way by a line instead. A reader who
        cannot see the rest of the answer should at least be told where it is.

        Call this only once the DM has actually been delivered.
        """
        posts, truncated = compose_thread(
            self.fact_check, self.max_chars, self.style, self.max_posts, tail=DM_NOTICE
        )
        self.posts = posts
        self.truncated = truncated
        self.dm_notice = True

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
            limit = f"{len(self.posts)} posts" if len(self.posts) > 1 else "one post"
            out.append(f"reply truncated to fit {limit}")
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


def _attributed(
    body: str,
    header: str,
    sources: list[Source],
    style: str,
    max_chars: int,
    suffix: str = "",
    tail: str = "",
) -> tuple[str, bool]:
    """One post carrying the prose and the sources. Returns (text, truncated).

    ``suffix`` is glued to the end of the prose block - the thread counter, which
    has to survive truncation, so it is re-applied after the prose is trimmed
    rather than being part of what gets trimmed. ``tail`` is a fixed final line
    that has to be there whatever else gives way.
    """

    def assemble(prose: str, srcs: list[Source], with_urls: bool) -> str:
        prose = prose.strip()
        blocks = [
            header,
            f"{prose}{suffix}" if prose else "",
            _sources_line(srcs, with_urls, style),
            tail,
        ]
        return "\n\n".join(b for b in blocks if b)

    # Try progressively cheaper source renderings before touching the prose.
    # Note there is no "drop the sources entirely" rung: an unattributed reply is
    # worse than a slightly shorter one, so attribution outlives the last clause.
    for srcs, with_urls in (
        (sources[:2], True),
        (sources[:1], True),
        (sources[:2], False),
    ):
        text = assemble(body, srcs, with_urls)
        if tweet_length(text) <= max_chars:
            return text, False

    # Still too long: the prose itself has to give, and the names stay.
    srcs = sources[:2]
    fixed = tweet_length(assemble("", srcs, False)) + len(suffix)
    trimmed, truncated = _sentence_truncate(body, max_chars - fixed - 2)
    return assemble(trimmed, srcs, False), truncated


def compose(check: FactCheck, max_chars: int, style: str = CONVERSATIONAL) -> tuple[str, bool]:
    """Render the reply as a single post, shrinking it until it fits."""
    header = LABELS.get(check.verdict, LABELS["UNVERIFIABLE"]) if style == CARD else ""
    return _attributed(check.body, header, check.sources, style, max_chars)


def _wrap_words(text: str, budget: int) -> list[str]:
    """Last-resort split for a single sentence too long for one post."""
    out: list[str] = []
    current = ""
    for word in text.split():
        candidate = f"{current} {word}".strip()
        if current and tweet_length(candidate) > budget:
            out.append(current)
            current = word
        else:
            current = candidate
        if tweet_length(current) > budget:  # one word longer than a whole post
            out.append(current[: max(1, budget - 1)].rstrip() + "…")
            current = ""
    if current:
        out.append(current)
    return out or [""]


def _pack(text: str, budget: int) -> list[str]:
    """Group whole sentences into per-post chunks, greedily and in order.

    Sentence boundaries are the split points because a fact-check reads as a
    sequence of claims: cutting mid-clause is what makes bot threads unreadable.
    """
    chunks: list[str] = []
    current = ""
    for piece in re.split(r"(?<=[.!?])\s+", text.strip()):
        if not piece:
            continue
        candidate = f"{current} {piece}".strip()
        if current and tweet_length(candidate) > budget:
            chunks.append(current)
            candidate = piece
            current = ""
        if tweet_length(candidate) > budget:
            wrapped = _wrap_words(candidate, budget)
            chunks.extend(wrapped[:-1])
            current = wrapped[-1]
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks or [""]


def compose_thread(
    check: FactCheck,
    max_chars: int,
    style: str = CONVERSATIONAL,
    max_posts: int = 1,
    tail: str = "",
) -> tuple[list[str], bool]:
    """Render the answer as up to ``max_posts`` numbered posts.

    The single-post path is unchanged and still cuts the answer down to fit -
    ``max_posts=1`` is exactly ``compose``. Above that, the answer is split at
    sentence boundaries and only the overflow past the last allowed post is lost,
    which is what makes a long answer publishable instead of merely shorter.

    ``tail`` is a line that must appear at the end of the last post, budgeted
    ahead of the prose rather than appended to whatever came out.
    """
    if max_posts <= 1:
        header = LABELS.get(check.verdict, LABELS["UNVERIFIABLE"]) if style == CARD else ""
        text, truncated = _attributed(
            check.body, header, check.sources, style, max_chars, tail=tail
        )
        return [text], truncated

    header = LABELS.get(check.verdict, LABELS["UNVERIFIABLE"]) if style == CARD else ""
    # The header only appears on the first post, but reserving it everywhere keeps
    # the packing budget uniform - a couple of wasted characters in card style.
    reserve = COUNTER_RESERVE + (tweet_length(header) + 2 if header else 0)
    chunks = _pack(check.body, max_chars - reserve)

    truncated = False
    if len(chunks) > max_posts:
        chunks = chunks[:max_posts]
        truncated = True

    total = len(chunks)
    posts: list[str] = []
    for index, chunk in enumerate(chunks):
        counter = f" ({index + 1}/{total})" if total > 1 else ""
        head = header if index == 0 else ""
        if index == total - 1:
            # The sources ride on the final post, where the ladder still applies.
            text, cut = _attributed(
                chunk, head, check.sources, style, max_chars, counter, tail
            )
            truncated = truncated or cut
        else:
            text = "\n\n".join(b for b in (head, f"{chunk}{counter}") if b)
        posts.append(text)
    return posts, truncated


def compose_full(check: FactCheck, max_chars: int) -> str:
    """The unabridged answer, for a DM.

    Nothing is competing for space here, so nothing is dropped: the prose is
    whole, every sub-claim is shown with the finding and the sources that back it
    specifically, and every source is listed with its URL. This is the only
    rendering where the per-sub-claim attribution the guard already verified is
    actually visible to the reader.
    """
    parts = [check.body.strip()]

    if check.sub_claims:
        lines: list[str] = []
        for sub in check.sub_claims:
            lines.append(f"- {sub.claim}" + (f": {sub.finding}" if sub.finding else ""))
            lines.extend(f"  {s.name} {s.url}" for s in sub.sources)
            if sub.verdict == "UNVERIFIABLE" and not sub.sources:
                lines.append("  (no source I could open)")
        parts.append("What I checked:\n" + "\n".join(lines))

    if check.sources:
        parts.append("Sources:\n" + "\n".join(f"{s.name} {s.url}" for s in check.sources))

    text = "\n\n".join(p for p in parts if p)
    if len(text) <= max_chars:
        return text
    return text[: max(1, max_chars - 1)].rstrip() + "…"


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
    max_posts: int = 1,
) -> GuardedReply:
    """Validate a fact-check and render it for posting.

    ``max_chars`` is the ceiling for one post; ``max_posts`` is how many posts the
    answer may occupy. Every check below is independent of both - length is a
    rendering concern, and evidence is not.
    """
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
    posts, truncated = compose_thread(check, max_chars, style, max_posts)
    return GuardedReply(
        posts=posts,
        fact_check=check,
        dropped_sources=_dedupe(dropped),
        downgraded=downgraded,
        truncated=truncated,
        unsupported_sub_claims=unsupported,
        max_chars=max_chars,
        style=style,
        max_posts=max_posts,
    )
