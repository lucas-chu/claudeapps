"""Tests for the response guard - the part that must never fail open."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from verdict import (  # noqa: E402
    CARD,
    CONVERSATIONAL,
    FactCheck,
    Source,
    compose,
    guard,
    normalize_url,
    tweet_length,
)

EIA = "https://www.eia.gov/todayinenergy/detail.php?id=61364"
LBNL = "https://eta.lbl.gov/publications/2024-united-states-data-center-energy"

BOTH_STYLES = pytest.mark.parametrize("style", [CONVERSATIONAL, CARD])


def check(**kwargs) -> FactCheck:
    base = dict(
        verdict="MISLEADING",
        claim="US data centers use 20% of US electricity",
        body="No - US data centers used roughly 4.4% of national electricity in 2023.",
        sources=[Source("EIA", EIA)],
        confidence="high",
    )
    base.update(kwargs)
    return FactCheck(**base)


def test_urls_cost_23_characters():
    assert tweet_length("hi " + "https://example.com/" + "a" * 200) == 3 + 23


def test_normalize_url_ignores_scheme_www_and_trailing_slash():
    assert normalize_url("http://WWW.Eia.gov/data/") == normalize_url("https://eia.gov/data")


# --- citation integrity ------------------------------------------------------


@BOTH_STYLES
def test_unretrieved_citation_is_stripped(style):
    reply = guard(
        check(sources=[Source("EIA", EIA), Source("DOE", "https://doe.gov/made-up")]),
        {EIA},
        280,
        style,
    )
    assert [s.name for s in reply.fact_check.sources] == ["EIA"]
    assert reply.dropped_sources[0].name == "DOE"
    assert "made-up" not in reply.text


@BOTH_STYLES
def test_assertive_verdict_without_evidence_is_downgraded(style):
    reply = guard(check(verdict="FALSE", sources=[Source("DOE", "https://doe.gov/nope")]), set(), 280, style)
    assert reply.fact_check.verdict == "UNVERIFIABLE"
    assert reply.downgraded
    # The reader must be able to see the downgrade whichever style is in use.
    assert "unverified" in reply.text or "UNVERIFIABLE" in reply.text


@BOTH_STYLES
def test_unverifiable_without_sources_is_left_alone(style):
    reply = guard(check(verdict="UNVERIFIABLE", sources=[]), set(), 280, style)
    assert not reply.downgraded


@BOTH_STYLES
def test_unknown_verdict_falls_back_to_unverifiable(style):
    reply = guard(check(verdict="PROBABLY_FINE", sources=[Source("EIA", EIA)]), {EIA}, 280, style)
    assert reply.fact_check.verdict == "UNVERIFIABLE"


# --- conversational rendering ------------------------------------------------


def test_conversational_reply_carries_no_verdict_label():
    """The whole point of this style: it reads like a person, not a form."""
    reply = guard(check(), {EIA}, 280)
    assert reply.text.startswith("No - US data centers")
    for marker in ("✅", "⚠️", "❌", "❓", "MISLEADING", "Sources:"):
        assert marker not in reply.text
    assert reply.text.endswith(EIA)


def test_card_reply_keeps_the_prd_format():
    reply = guard(check(), {EIA}, 280, CARD)
    assert reply.text.startswith("⚠️ MISLEADING")
    assert "Sources: EIA " in reply.text


def test_conversational_falls_back_to_named_sources_when_links_dont_fit():
    reply = guard(check(body="A" * 258, sources=[Source("LBNL", LBNL), Source("EIA", EIA)]), {LBNL, EIA}, 280)
    assert "https://" not in reply.text
    assert "Sources: LBNL, EIA" in reply.text


# --- length --------------------------------------------------------------------


@BOTH_STYLES
@pytest.mark.parametrize("limit", [280, 240, 200, 160])
def test_reply_always_fits(style, limit):
    long = check(
        body=(
            "No - US data centers consumed about 176 TWh in 2023, roughly 4.4% of national "
            "electricity, per Lawrence Berkeley National Laboratory. Projections put that "
            "between 6.7% and 12% by 2028, but no credible estimate reaches 20% today."
        ),
        sources=[Source("LBNL", LBNL), Source("EIA", EIA)],
    )
    reply = guard(long, {LBNL, EIA}, limit, style)
    assert tweet_length(reply.text) <= limit


@pytest.mark.parametrize(
    "body_len,expected_urls,expected_truncated",
    [
        (150, 2, False),  # both links fit
        (240, 1, False),  # drop to one link before touching prose
        (258, 0, False),  # drop to bare publisher names
        (320, 0, True),   # only now is the prose cut
    ],
)
def test_reply_degrades_in_the_right_order(body_len, expected_urls, expected_truncated):
    """Links are the first thing to go and the prose is the last."""
    long = check(body="A" * body_len, sources=[Source("LBNL", LBNL), Source("EIA", EIA)])
    reply = guard(long, {LBNL, EIA}, 280)
    assert reply.text.count("https://") == expected_urls
    assert reply.truncated is expected_truncated
    assert tweet_length(reply.text) <= 280
    # Attribution never gets dropped, even when the prose has to be cut - the
    # reply always carries either a link or a publisher name.
    assert "https://" in reply.text or "Sources:" in reply.text


def test_truncation_stops_on_a_sentence_boundary():
    text, truncated = compose(
        check(body="First sentence here. Second sentence is much longer and will not fit at all."),
        70,
    )
    assert truncated
    assert "First sentence here." in text
    assert "Second sentence" not in text
