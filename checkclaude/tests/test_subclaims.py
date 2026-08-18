"""Fan-out changes who does the research; it must not change what may be posted.

The rule these cover: a well-sourced sub-claim never vouches for an unsourced
one. Pooling every citation into one list would hide exactly that - which is the
failure mode the citation check exists to catch.
"""

from __future__ import annotations

import dataclasses
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import DELEGATION_TOOL, build_options  # noqa: E402
from config import config  # noqa: E402
from verdict import FactCheck, Source, SubClaim, guard  # noqa: E402

RETRIEVED = "https://eta.lbl.gov/publications/us-data-center-energy"
FABRICATED = "https://example.gov/report-that-was-never-opened"


def check(verdict: str = "FALSE", sub_claims: list[SubClaim] | None = None) -> FactCheck:
    return FactCheck(
        verdict=verdict,
        claim="two things at once",
        body="No - it was about 4.4% in 2023, and revenue grew 12%.",
        sources=[Source("LBNL", RETRIEVED)],
        sub_claims=sub_claims or [],
    )


def test_unsourced_sub_claim_sinks_an_assertive_verdict() -> None:
    reply = guard(
        check(sub_claims=[
            SubClaim("share of US electricity", verdict="FALSE",
                     sources=[Source("LBNL", RETRIEVED)]),
            SubClaim("revenue growth", verdict="TRUE",
                     sources=[Source("Ghost", FABRICATED)]),
        ]),
        {RETRIEVED},
        280,
    )
    assert reply.fact_check.verdict == "UNVERIFIABLE"
    assert reply.downgraded
    assert reply.unsupported_sub_claims == ["revenue growth"]
    assert reply.text.startswith("Part of this I couldn't confirm")
    # The half that was real keeps its attribution.
    assert reply.fact_check.sources == [Source("LBNL", RETRIEVED)]


def test_a_sourced_sub_claim_cannot_vouch_for_an_unsourced_one() -> None:
    """The pooled-source shortcut, stated as a test.

    Every top-level citation checks out here, so a guard that only looked at the
    pooled list would publish an assertive verdict over a sub-claim backed by a
    page nobody opened.
    """
    reply = guard(
        check(verdict="TRUE", sub_claims=[
            SubClaim("checked out", verdict="TRUE", sources=[Source("LBNL", RETRIEVED)]),
            SubClaim("never opened", verdict="TRUE", sources=[Source("Ghost", FABRICATED)]),
        ]),
        {RETRIEVED},
        280,
    )
    assert reply.fact_check.verdict == "UNVERIFIABLE"
    assert "never opened" in reply.unsupported_sub_claims


def test_every_sub_claim_sourced_publishes_normally() -> None:
    reply = guard(
        check(sub_claims=[
            SubClaim("a", verdict="FALSE", sources=[Source("LBNL", RETRIEVED)]),
            SubClaim("b", verdict="TRUE", sources=[Source("LBNL", RETRIEVED)]),
        ]),
        {RETRIEVED},
        280,
    )
    assert reply.fact_check.verdict == "FALSE"
    assert not reply.downgraded
    assert reply.unsupported_sub_claims == []


def test_an_unverifiable_sub_claim_needs_no_source() -> None:
    """"I couldn't establish this part" is an honest finding, not a failure."""
    reply = guard(
        check(sub_claims=[
            SubClaim("solid part", verdict="FALSE", sources=[Source("LBNL", RETRIEVED)]),
            SubClaim("open question", verdict="UNVERIFIABLE", sources=[]),
        ]),
        {RETRIEVED},
        280,
    )
    assert reply.fact_check.verdict == "FALSE"
    assert not reply.downgraded


def test_sub_claim_citations_are_reported_as_dropped_once() -> None:
    reply = guard(
        check(sub_claims=[
            SubClaim("a", verdict="TRUE", sources=[Source("Ghost", FABRICATED)]),
            SubClaim("b", verdict="TRUE", sources=[Source("Ghost", FABRICATED)]),
        ]),
        {RETRIEVED},
        280,
    )
    assert [s.url for s in reply.dropped_sources] == [FABRICATED]


def test_no_sub_claims_behaves_exactly_as_before() -> None:
    reply = guard(check(), {RETRIEVED}, 280)
    assert reply.fact_check.verdict == "FALSE"
    assert not reply.downgraded
    assert reply.unsupported_sub_claims == []


def test_a_whole_unsourced_check_still_uses_the_stronger_wording() -> None:
    reply = guard(
        FactCheck(verdict="FALSE", claim="c", body="No.",
                  sources=[Source("Ghost", FABRICATED)]),
        {RETRIEVED},
        280,
    )
    assert reply.text.startswith("I couldn't confirm this against a source")


# --- the tool surface, which fan-out must not widen ----------------------


def test_delegation_reaches_nothing_beyond_search_and_fetch() -> None:
    options = build_options(config, {})
    investigator = (options.agents or {})["investigator"]
    assert sorted(investigator.tools or []) == ["WebFetch", "WebSearch"]
    # No verdict tool: only the lead may submit. No delegation tool: an
    # investigator cannot spawn investigators.
    assert DELEGATION_TOOL not in (investigator.tools or [])
    assert not any("verdict" in t for t in investigator.tools or [])


def test_lead_gains_delegation_and_nothing_else() -> None:
    options = build_options(config, {})
    assert sorted(options.tools) == ["Agent", "WebFetch", "WebSearch"]
    assert "Bash" not in options.allowed_tools


@pytest.mark.parametrize("fanout", [True, False])
def test_delegation_guidance_matches_the_tools_on_offer(fanout: bool) -> None:
    """Don't tell an agent to delegate when it has no way to."""
    options = build_options(dataclasses.replace(config, fanout=fanout), {})
    assert ("## Investigating in parallel" in options.system_prompt) is fanout
    assert (DELEGATION_TOOL in options.tools) is fanout
    assert "{delegation}" not in options.system_prompt


def test_sub_claim_sources_stand_in_for_an_empty_top_level_list() -> None:
    """Filing every source under a sub-claim shouldn't cost the reply its links.

    Both lists are verified identically, so promoting them changes nothing about
    what got checked - only about what the reader sees.
    """
    reply = guard(
        FactCheck(
            verdict="FALSE",
            claim="c",
            body="No.",
            sources=[],
            sub_claims=[SubClaim("a", verdict="FALSE", sources=[Source("LBNL", RETRIEVED)])],
        ),
        {RETRIEVED},
        280,
    )
    assert reply.fact_check.verdict == "FALSE"
    assert not reply.downgraded
    assert RETRIEVED in reply.text


def test_promotion_only_moves_sources_that_survived_the_check() -> None:
    reply = guard(
        FactCheck(
            verdict="FALSE",
            claim="c",
            body="No.",
            sources=[],
            sub_claims=[SubClaim("a", verdict="FALSE", sources=[Source("Ghost", FABRICATED)])],
        ),
        {RETRIEVED},
        280,
    )
    assert reply.fact_check.verdict == "UNVERIFIABLE"
    assert reply.fact_check.sources == []
