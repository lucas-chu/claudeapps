"""Routing table, loop guard, and thread ownership."""

import pytest

from app import registry, router

from .conftest import make_teammate

CF = "UCLAWDFATHER"


def route(text, channel, thread_ts=None, slots=None):
    return router.route(
        text=text, channel=channel, clawdfather_id=CF, thread_ts=thread_ts, slots=slots
    )


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


def test_unknown_id_renders_as_someone(scout):
    """An ID we can't name still has to read as prose, not as a raw token."""
    assert route("<@U111> ask <@UNOBODY> too", "C_X").text == "Scout ask @someone too"


# --- thread ownership: the follow-up path ---------------------------------


def test_followup_in_owned_thread_needs_no_mention(scout):
    """The bug this exists for: @Scout in #random, then a bare reply in-thread."""
    registry.set_session("C_RANDOM", "111.1", "sesn_a", owner="Scout")
    d = route("what about their enterprise tier?", "C_RANDOM", thread_ts="111.1")
    assert d.kind == "direct" and d.teammate.name == "Scout"


def test_followup_reaches_clawdfather_too(scout):
    registry.set_session("C_RANDOM", "222.2", "sesn_b", owner=registry.CLAWDFATHER)
    assert route("actually make it snarkier", "C_RANDOM", thread_ts="222.2").kind == ("clawdfather")


def test_thread_owner_beats_the_ambient_gate(scout, builder):
    """A claimed thread in a home channel goes straight to its owner."""
    registry.set_session("C_STRAT", "333.3", "sesn_c", owner="Builder")
    d = route("and the pricing?", "C_STRAT", thread_ts="333.3")
    assert d.kind == "direct" and d.teammate.name == "Builder"


def test_explicit_mention_overrides_thread_owner(scout, builder):
    registry.set_session("C_STRAT", "444.4", "sesn_d", owner="Scout")
    d = route("<@U222> your turn", "C_STRAT", thread_ts="444.4")
    assert d.teammate.name == "Builder"


def test_unclaimed_thread_falls_through(scout):
    assert route("hello?", "C_RANDOM", thread_ts="555.5") is None


def test_owner_of_departed_teammate_falls_through(scout):
    """A thread owned by a teammate that no longer exists must not 500."""
    registry.set_session("C_RANDOM", "666.6", "sesn_e", owner="Departed")
    assert route("still there?", "C_RANDOM", thread_ts="666.6") is None


# --- shared identity: more teammates than Slack apps -----------------------


def test_shared_identity_mention_resolves_by_home_channel(scout, builder):
    """Helper shares Scout's bot_user_id; mentioning it is unambiguous in either home."""
    registry.save_teammate(make_teammate("Helper", "U111", 1, "C_HELP", "help"))
    assert route("<@U111> hi", "C_STRAT").teammate.name == "Scout"
    assert route("<@U111> hi", "C_HELP").teammate.name == "Helper"


def test_shared_identity_mention_outside_either_home_is_dropped(scout, builder):
    """Can't tell Scout and Helper apart, and the identity isn't in the pool."""
    registry.save_teammate(make_teammate("Helper", "U111", 1, "C_HELP", "help"))
    assert route("<@U111> hi", "C_RANDOM") is None


# --- the Clawds: a pooled identity answering as itself ----------------------


def test_ambiguous_clawd_mention_greets_instead_of_dropping(scout, builder, clawds):
    """The silence this exists for: Scout and Helper share Clawd One."""
    registry.save_teammate(make_teammate("Helper", "U111", 1, "C_HELP", "help"))
    d = route("<@U111> hi", "C_RANDOM", slots=clawds)
    assert d.kind == "greeting"
    assert d.slot.index == 1
    assert sorted(t.name for t in d.candidates) == ["Helper", "Scout"]


def test_unhired_clawd_mention_greets_with_no_candidates(scout, clawds):
    """Clawd Three exists in the pool but nobody has been hired into it."""
    d = route("<@U333> anyone home?", "C_RANDOM", slots=clawds)
    assert d.kind == "greeting" and d.slot.index == 3 and d.candidates == []


def test_greeting_text_reads_as_the_identity_not_a_teammate(scout, builder, clawds):
    """Nobody asked for Scout, so the mention must not read as "Scout"."""
    registry.save_teammate(make_teammate("Helper", "U111", 1, "C_HELP", "help"))
    assert route("<@U111> hi", "C_RANDOM", slots=clawds).text == "Clawd One hi"


def test_unhired_clawd_mention_is_not_someone(scout, clawds):
    assert route("<@U333> hi", "C_RANDOM", slots=clawds).text == "Clawd Three hi"


def test_resolvable_clawd_mention_still_reaches_its_teammate(scout, builder, clawds):
    """Being in the pool must not stop an unambiguous mention resolving."""
    d = route("<@U111> research Cursor pricing", "C_RANDOM", slots=clawds)
    assert d.kind == "direct" and d.teammate.name == "Scout"


def test_ambiguous_clawd_mention_beats_the_ambient_gate(scout, clawds):
    """Two teammates on one identity, both living here: an explicit mention
    must still get an answer rather than being gated into silence."""
    registry.save_teammate(make_teammate("Probe", "U111", 1, "C_STRAT", "strategy"))
    d = route("<@U111> who's around?", "C_STRAT", slots=clawds)
    assert d.kind == "greeting" and d.slot.index == 1


def test_thread_owner_beats_an_ambiguous_clawd_mention(scout, builder, clawds):
    """A claimed thread keeps its speaker; the greeting is the fallback."""
    registry.save_teammate(make_teammate("Helper", "U111", 1, "C_HELP", "help"))
    registry.set_session("C_RANDOM", "888.8", "sesn_g", owner="Builder")
    d = route("<@U111> hi", "C_RANDOM", thread_ts="888.8", slots=clawds)
    assert d.kind == "direct" and d.teammate.name == "Builder"


def test_clawdfather_mention_beats_a_clawd_mention(scout, clawds):
    d = route(f"<@{CF}> <@U333> who works here?", "C_RANDOM", slots=clawds)
    assert d.kind == "clawdfather"


@pytest.mark.parametrize(
    "text,index",
    [
        ("clawd one, you around?", 1),
        ("Clawd Two can you help", 2),
        ("is clawd 3 alive?", 3),
        ("clawd3?", 3),
        ("CLAWD-2 hello", 2),
    ],
)
def test_plain_text_clawd_name_greets(scout, clawds, text, index):
    d = route(text, "C_RANDOM", slots=clawds)
    assert d.kind == "greeting" and d.slot.index == index


def test_clawdfather_is_not_a_clawd(scout, clawds):
    """A bare `clawd` with no number must never resolve to a pooled identity."""
    assert route("ClawdFather hired someone", "C_RANDOM", slots=clawds) is None
    assert route("clawdfather", "C_RANDOM", slots=clawds) is None


def test_unconfigured_clawd_index_is_dropped(scout, clawds):
    """There is no Clawd Seven to answer."""
    assert route("clawd seven?", "C_RANDOM", slots=clawds) is None


def test_ambient_beats_a_plain_text_clawd_name(scout, clawds):
    """On-charter work in a home channel is worth more than an introduction."""
    d = route("clawd two, how do we price against Cursor?", "C_STRAT", slots=clawds)
    assert d.kind == "ambient" and [t.name for t in d.candidates] == ["Scout"]


def test_shared_identity_thread_owner_is_unambiguous(scout, builder):
    """Ownership is stored by name, so a shared identity never confuses a follow-up."""
    registry.save_teammate(make_teammate("Helper", "U111", 1, "C_HELP", "help"))
    registry.set_session("C_HELP", "777.7", "sesn_f", owner="Helper")
    d = route("still there?", "C_HELP", thread_ts="777.7")
    assert d.kind == "direct" and d.teammate.name == "Helper"


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


# --- sharing the workspace with other bots ---------------------------------


def test_a_message_addressed_to_someone_else_is_left_alone(scout):
    """@Claude (or any other app, or a human) in Scout's home channel."""
    assert route("<@UCLAUDE> fix the failing test in checkclaude", "C_STRAT") is None


def test_someone_else_mentioned_beats_thread_ownership(scout):
    """Handing a Scout thread to another app must not route back to Scout."""
    registry.set_session("C_RANDOM", "900.1", "sesn_x", owner="Scout")
    assert route("<@UCLAUDE> open a PR for this", "C_RANDOM", thread_ts="900.1") is None


def test_our_own_mention_still_wins_alongside_another(scout):
    assert route("<@UCLAUDE> and <@U111> — thoughts?", "C_STRAT").teammate.name == "Scout"


def test_a_shared_identity_is_never_treated_as_someone_else(pool):
    """Two teammates on one Slack identity: still ours, so resolution stands."""
    for name, home in (("Scout", "C_STRAT"), ("Probe", "C_OTHER")):
        registry.save_teammate(make_teammate(name, "U111", 1, home, home.lower()))
    # Disambiguated by home channel — the new drop rule must not pre-empt this.
    assert route("<@U111> pricing?", "C_STRAT").teammate.name == "Scout"
    # Ambiguous from a third channel: dropped by _resolve_mention as before.
    assert route("<@U111> pricing?", "C_THIRD") is None


def test_an_unhired_clawd_named_alongside_another_app_still_greets(scout, clawds):
    """Explicit mention of ours wins, even when someone else is named too."""
    d = route("<@UCLAUDE> and <@U333> — either of you?", "C_RANDOM", slots=clawds)
    assert d is not None and d.kind == "greeting" and d.slot.index == 3
