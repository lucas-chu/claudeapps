"""An answer worth more than one post should not be cut down to one post.

What these cover is the part that could quietly go wrong: threading changes how
much room the answer has, and nothing else. The citation check, the no-evidence
downgrade and the attribution ladder all have to survive being spread across
posts, and the lead post still has to work on its own for a reader who never
scrolls.
"""

from __future__ import annotations

import dataclasses
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import answer_shape  # noqa: E402
from config import config  # noqa: E402
from context import DM, PUBLIC, CheckContext  # noqa: E402
from verdict import (  # noqa: E402
    CARD,
    CONVERSATIONAL,
    DM_NOTICE,
    FactCheck,
    Source,
    SubClaim,
    compose,
    compose_thread,
    guard,
    tweet_length,
)
from x_client import Post  # noqa: E402

LBNL = "https://eta.lbl.gov/publications/2024-united-states-data-center-energy"
EIA = "https://www.eia.gov/todayinenergy/detail.php?id=61364"
RETRIEVED = {LBNL, EIA}

# Eight sentences: comfortably more than one post, less than four.
LONG_BODY = (
    "No - US data centers used about 4.4% of national electricity in 2023. "
    "That is roughly 176 TWh out of just under 4,000 TWh nationally. "
    "The 20% figure appears to come from a projection for a single grid region. "
    "Berkeley Lab's 2024 report is the source most of the coverage traces back to. "
    "It puts 2028 consumption between 6.7% and 12% of the national total. "
    "Even the top of that range is well short of 20%, and it is five years out. "
    "Regional concentration is the part of the claim that holds up. "
    "Northern Virginia really does run above 25% of its local load."
)


def check(**kwargs) -> FactCheck:
    base = dict(
        verdict="MISLEADING",
        claim="US data centers use 20% of US electricity",
        body=LONG_BODY,
        sources=[Source("LBNL", LBNL), Source("EIA", EIA)],
        confidence="high",
    )
    base.update(kwargs)
    return FactCheck(**base)


def counters(posts: list[str]) -> list[str]:
    return [m.group(0) for p in posts for m in [re.search(r"\(\d+/\d+\)", p)] if m]


# --- single-post mode is untouched -------------------------------------------


@pytest.mark.parametrize("style", [CONVERSATIONAL, CARD])
def test_one_post_mode_is_exactly_the_old_behaviour(style):
    """Threading is opt-in, and off it must be byte-identical to before."""
    single, truncated = compose(check(), 280, style)
    posts, threaded_truncated = compose_thread(check(), 280, style, max_posts=1)
    assert posts == [single]
    assert threaded_truncated is truncated
    assert guard(check(), RETRIEVED, 280, style).posts == [single]


def test_a_short_answer_does_not_become_a_thread():
    posts, truncated = compose_thread(
        check(body="No - it was about 4.4% in 2023."), 280, CONVERSATIONAL, max_posts=4
    )
    assert len(posts) == 1
    assert not truncated
    assert "(1/1)" not in posts[0]


# --- splitting ----------------------------------------------------------------


def test_a_long_answer_is_threaded_instead_of_truncated():
    posts, truncated = compose_thread(check(), 280, CONVERSATIONAL, max_posts=4)
    assert len(posts) > 1
    assert not truncated
    # Every sentence of the answer survives somewhere in the thread.
    joined = " ".join(posts)
    for sentence in LONG_BODY.split(". "):
        assert sentence.split(",")[0] in joined


@pytest.mark.parametrize("limit", [280, 240, 200])
@pytest.mark.parametrize("style", [CONVERSATIONAL, CARD])
def test_every_post_fits(limit, style):
    posts, _ = compose_thread(check(), limit, style, max_posts=4)
    for post in posts:
        assert tweet_length(post) <= limit


def test_posts_are_numbered_in_order():
    posts, _ = compose_thread(check(), 280, CONVERSATIONAL, max_posts=4)
    total = len(posts)
    assert counters(posts) == [f"({i}/{total})" for i in range(1, total + 1)]


def test_splits_land_on_sentence_boundaries():
    posts, _ = compose_thread(check(), 280, CONVERSATIONAL, max_posts=4)
    for post in posts[:-1]:
        prose = re.sub(r"\s*\(\d+/\d+\)$", "", post).strip()
        assert prose.endswith((".", "!", "?"))


def test_a_sentence_longer_than_a_post_still_fits():
    """The fallback path: no sentence boundary to split on at all."""
    posts, _ = compose_thread(
        check(body="No " + "and again " * 90 + "so it is false.", sources=[]),
        280,
        CONVERSATIONAL,
        max_posts=4,
    )
    assert len(posts) > 1
    for post in posts:
        assert tweet_length(post) <= 280


def test_sources_ride_on_the_final_post_only():
    posts, _ = compose_thread(check(), 280, CONVERSATIONAL, max_posts=4)
    assert LBNL in posts[-1]
    for post in posts[:-1]:
        assert "https://" not in post


def test_card_header_appears_once():
    posts, _ = compose_thread(check(), 280, CARD, max_posts=4)
    assert posts[0].startswith("⚠️ MISLEADING")
    assert sum(p.count("MISLEADING") for p in posts) == 1


def test_overflow_past_the_cap_is_truncated_and_flagged():
    posts, truncated = compose_thread(check(), 280, CONVERSATIONAL, max_posts=2)
    assert len(posts) == 2
    assert truncated
    # Attribution outlives the overflow: the last post still carries a source.
    assert "https://" in posts[-1] or "Sources:" in posts[-1]


# --- the guard still guards ---------------------------------------------------


def test_the_downgrade_is_visible_in_the_lead_post():
    """A reader who sees only the first post must see the hedge, not the claim."""
    reply = guard(
        check(verdict="FALSE", sources=[Source("DOE", "https://doe.gov/never-opened")]),
        set(),
        280,
        CONVERSATIONAL,
        max_posts=4,
    )
    assert reply.fact_check.verdict == "UNVERIFIABLE"
    assert "unverified" in reply.posts[0]
    assert reply.text == reply.posts[0]


def test_unretrieved_citations_are_stripped_from_every_post():
    reply = guard(
        check(sources=[Source("LBNL", LBNL), Source("DOE", "https://doe.gov/made-up")]),
        {LBNL},
        280,
        CONVERSATIONAL,
        max_posts=4,
    )
    assert "made-up" not in reply.thread_text
    assert reply.dropped_sources[0].name == "DOE"


def test_thread_text_is_the_whole_answer():
    reply = guard(check(), RETRIEVED, 280, CONVERSATIONAL, max_posts=4)
    assert len(reply.posts) > 1
    assert reply.thread_text.startswith(reply.posts[0])
    assert reply.posts[-1] in reply.thread_text


# --- the DM pointer ----------------------------------------------------------


def test_dm_notice_lands_on_the_last_post():
    reply = guard(check(body="No - about 4.4% in 2023."), RETRIEVED, 280, CONVERSATIONAL)
    reply.add_dm_notice()
    assert reply.posts[-1].endswith(DM_NOTICE)
    assert reply.dm_notice
    assert tweet_length(reply.text) <= 280


def test_the_prose_gives_way_so_the_pointer_still_lands():
    """The trigger for the pointer is a full thread, so appending could never work.

    A reader who cannot see the rest of the answer is exactly the reader who needs
    telling where it is, so the pointer is budgeted and a line of prose goes.
    """
    reply = guard(check(), RETRIEVED, 280, CONVERSATIONAL, max_posts=2)
    assert reply.truncated
    before = reply.posts[-1]
    reply.add_dm_notice()
    assert reply.posts[-1].endswith(DM_NOTICE)
    assert reply.posts[-1] != before
    assert len(reply.posts) == 2
    for post in reply.posts:
        assert tweet_length(post) <= 280
    # Attribution still outlives everything else.
    assert "https://" in reply.posts[-1] or "Sources:" in reply.posts[-1]


def test_long_form_keeps_what_the_posts_had_to_drop():
    reply = guard(
        check(
            sources=[Source("LBNL", LBNL), Source("EIA", EIA)],
            sub_claims=[
                SubClaim(
                    "share of US electricity", "4.4% in 2023", "FALSE", [Source("LBNL", LBNL)]
                ),
                SubClaim("regional load", "above 25% locally", "TRUE", [Source("EIA", EIA)]),
            ],
        ),
        RETRIEVED,
        280,
        CONVERSATIONAL,
        max_posts=2,
    )
    full = reply.long_form(10000)
    assert LONG_BODY.split(". ")[-1][:20] in full  # the sentence the thread lost
    assert "share of US electricity" in full and "regional load" in full
    assert full.count("https://") >= 3  # per-sub-claim links plus the source list
    assert len(reply.long_form(400)) <= 400


# --- what the agent is told ---------------------------------------------------


def context(channel: str) -> CheckContext:
    post = Post(id="1", text="Data centers use 20% of US electricity.", author_id="u1")
    return CheckContext(mention=post, claim_post=post, question="is this true?", channel=channel)


def test_thread_budget_is_bigger_than_one_post_and_is_explained():
    threaded = answer_shape(dataclasses.replace(config, thread_replies=True), context(PUBLIC))
    single = answer_shape(dataclasses.replace(config, thread_replies=False), context(PUBLIC))
    assert "thread of up to" in threaded
    assert "thread of up to" not in single
    assert budget_in(threaded) > budget_in(single)


def test_dm_budget_is_bigger_still_and_never_asks_for_urls():
    shape = answer_shape(config, context(DM))
    assert budget_in(shape) > budget_in(answer_shape(config, context(PUBLIC)))
    assert "sub_claims" in shape
    assert "Don't write URLs" in shape


def budget_in(text: str) -> int:
    return max(int(n) for n in re.findall(r"(\d{3,5}) characters", text))
