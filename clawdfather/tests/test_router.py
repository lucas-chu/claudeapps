"""Routing table, loop guard, and thread ownership."""

import pytest

from app import registry, router

CF = "UCLAWDFATHER"


def route(text, channel, thread_ts=None):
    return router.route(text=text, channel=channel, clawdfather_id=CF, thread_ts=thread_ts)


# --- who owns the message -------------------------------------------------


def test_clawdfather_mention_wins(scout):
    assert route(f"<@{CF}> create Scout, a researcher", "C_RANDOM").kind == "clawdfather"


def test_direct_mention_anywhere(scout):
    d = route("<@U111> research Cursor pricing", "C_RANDOM")
    assert d.kind == "direct" and d.teammate.name == "Scout"


def test_mention_beats_ambient_in_home_channel(scout):
    d = route("<@U111> what's up", "C_STRAT")
    assert d.kind == "direct" and d.teammate.name == "Scout"


def test_home_channel_is_ambient(scout):
    d = route("how should we price against Cursor?", "C_STRAT")
    assert d.kind == "ambient" and [t.name for t in d.candidates] == ["Scout"]


def test_each_teammate_owns_its_own_home(scout, builder):
    assert [t.name for t in route("deploy is red", "C_ENG").candidates] == ["Builder"]


@pytest.mark.parametrize("text", ["lunch?", "", "   "])
def test_unrelated_channel_is_dropped(scout, text):
    assert route(text, "C_RANDOM") is None


def test_mentions_become_names_not_ids(scout, builder):
    assert route("<@U111> ask <@U222> too", "C_X").text == "Scout ask Builder too"


def test_unknown_mention_does_not_crash(scout):
    assert route("<@UNOBODY> hello", "C_STRAT").text == "@someone hello"


# --- thread ownership: the follow-up path ---------------------------------


def test_followup_in_owned_thread_needs_no_mention(scout):
    """The bug this exists for: @Scout in #random, then a bare reply in-thread."""
    registry.set_session("C_RANDOM", "111.1", "sesn_a", owner="U111")
    d = route("what about their enterprise tier?", "C_RANDOM", thread_ts="111.1")
    assert d.kind == "direct" and d.teammate.name == "Scout"


def test_followup_reaches_clawdfather_too(scout):
    registry.set_session("C_RANDOM", "222.2", "sesn_b", owner=registry.CLAWDFATHER)
    assert route("actually make it snarkier", "C_RANDOM", thread_ts="222.2").kind == ("clawdfather")


def test_thread_owner_beats_the_ambient_gate(scout, builder):
    """A claimed thread in a home channel goes straight to its owner."""
    registry.set_session("C_STRAT", "333.3", "sesn_c", owner="U222")
    d = route("and the pricing?", "C_STRAT", thread_ts="333.3")
    assert d.kind == "direct" and d.teammate.name == "Builder"


def test_explicit_mention_overrides_thread_owner(scout, builder):
    registry.set_session("C_STRAT", "444.4", "sesn_d", owner="U111")
    d = route("<@U222> your turn", "C_STRAT", thread_ts="444.4")
    assert d.teammate.name == "Builder"


def test_unclaimed_thread_falls_through(scout):
    assert route("hello?", "C_RANDOM", thread_ts="555.5") is None


def test_owner_of_departed_teammate_falls_through(scout):
    """A thread owned by a teammate that no longer exists must not 500."""
    registry.set_session("C_RANDOM", "666.6", "sesn_e", owner="UGONE")
    assert route("still there?", "C_RANDOM", thread_ts="666.6") is None


# --- loop guard and noise filter ------------------------------------------


@pytest.mark.parametrize(
    "event,ignored",
    [
        ({"bot_id": "B1", "text": "hi"}, True),
        ({"user": "U111", "text": "hi"}, True),  # one of ours
        ({"subtype": "message_changed", "text": "hi"}, True),
        ({"subtype": "channel_join", "text": "<@U111> has joined"}, True),
        ({"subtype": "channel_topic", "text": "new topic"}, True),
        ({"user": "UHUMAN", "text": ""}, True),  # empty
        ({"user": "UHUMAN", "text": "hi"}, False),
        ({"user": "UHUMAN", "subtype": "file_share", "text": "look"}, False),
        ({"user": "UHUMAN", "subtype": "thread_broadcast", "text": "fyi"}, False),
    ],
)
def test_should_ignore(event, ignored):
    assert router.should_ignore(event, {CF, "U111"}) is ignored


def test_join_message_does_not_read_as_a_mention(scout):
    """`<@USCOUT> has joined` would otherwise route as a direct mention."""
    event = {"subtype": "channel_join", "user": "UHUMAN", "text": "<@U111> has joined"}
    assert router.should_ignore(event, {CF}) is True


def test_first_mention_wins_when_two_are_named(scout, builder):
    """`mentioned` is a set; the responder must still be stable across runs."""
    d = route("<@U222> <@U111> who owns this?", "C_RANDOM")
    assert d.kind == "direct" and d.teammate.name == "Builder"
    d = route("<@U111> <@U222> who owns this?", "C_RANDOM")
    assert d.kind == "direct" and d.teammate.name == "Scout"
