"""Slot pool, thread→session mapping, and soul rendering."""

import pytest

from app import registry
from app.prompts import CREATE_TEAMMATE_TOOL, render_soul, system_from_soul

from .conftest import make_teammate

# --- identity pool --------------------------------------------------------


def test_new_hire_takes_a_free_slot(pool, scout):
    assert registry.claim_slot("Newbie").index == 2


def test_rehiring_a_name_reuses_its_slot(pool, scout):
    """`create Scout` twice must update Scout, not consume a second identity."""
    assert registry.claim_slot("Scout").index == 1
    assert registry.claim_slot("scout").index == 1  # case-insensitive


def test_teammates_share_slots_once_the_pool_is_exhausted(pool, monkeypatch, scout, builder):
    """More teammates than slots must not block hiring — the least-loaded slot wins."""
    monkeypatch.setattr(registry, "identity_pool", lambda: pool[:2])
    assert registry.claim_slot("Third").index == 1  # scout(1) and builder(1) tie; lowest wins
    registry.save_teammate(make_teammate("Third", "U111", 1, "C_THIRD", "third"))
    assert registry.claim_slot("Fourth").index == 2  # slot 1 now has two teammates


def test_claim_slot_with_no_pool_raises_something_actionable(monkeypatch):
    monkeypatch.setattr(registry, "identity_pool", lambda: [])
    with pytest.raises(RuntimeError, match="No Slack identities"):
        registry.claim_slot("Anyone")


def test_slot_for_returns_none_when_slot_is_gone(monkeypatch, scout):
    monkeypatch.setattr(registry, "identity_pool", lambda: [])
    assert registry.slot_for(scout) is None


# --- thread -> session ----------------------------------------------------


def test_session_round_trip():
    registry.set_session("C_A", "111.1", "sesn_a", owner="U111")
    assert registry.get_session("C_A", "111.1") == "sesn_a"
    assert registry.thread_owner("C_A", "111.1") == "U111"


def test_threads_are_scoped_per_channel():
    """thread_ts is only unique within a channel."""
    registry.set_session("C_A", "111.1", "sesn_a")
    assert registry.get_session("C_B", "111.1") is None


def test_clear_session():
    registry.set_session("C_A", "111.1", "sesn_a", owner="U111")
    registry.clear_session("C_A", "111.1")
    assert registry.get_session("C_A", "111.1") is None
    assert registry.thread_owner("C_A", "111.1") is None


def test_rewriting_a_session_keeps_the_owner():
    """Session replacement after a stale-session retry must not orphan the thread."""
    registry.set_session("C_A", "111.1", "sesn_a", owner="U111")
    registry.set_session("C_A", "111.1", "sesn_b")
    assert registry.get_session("C_A", "111.1") == "sesn_b"
    assert registry.thread_owner("C_A", "111.1") == "U111"


def test_legacy_bare_string_sessions_still_read(tmp_path):
    """Registries written before owners existed must not break on upgrade."""
    registry.REGISTRY_PATH.write_text('{"teammates": {}, "sessions": {"C_A:1.1": "sesn_x"}}')
    assert registry.get_session("C_A", "1.1") == "sesn_x"
    assert registry.thread_owner("C_A", "1.1") is None


def test_corrupt_registry_does_not_crash():
    registry.REGISTRY_PATH.write_text("{not json")
    assert registry.all_teammates() == []


# --- teammates ------------------------------------------------------------


def test_lookup_by_bot_id_and_name(scout):
    assert registry.teammate_by_bot_id("U111").name == "Scout"
    assert registry.teammate_by_name("SCOUT").name == "Scout"
    assert registry.teammate_by_bot_id("UNOBODY") is None
    assert registry.teammate_by_name("Ghost") is None


def test_saving_the_same_name_updates_in_place(scout):
    registry.save_teammate(make_teammate("Scout", "U111", 1, "C_OTHER", "social"))
    assert len(registry.all_teammates()) == 1
    assert registry.teammate_by_bot_id("U111").home_channel_name == "social"


def test_different_names_sharing_a_bot_id_do_not_collide(scout):
    """The bug a bot_user_id-keyed store had: two teammates, one Slack identity."""
    registry.save_teammate(make_teammate("Helper", "U111", 1, "C_HELP", "help"))
    assert len(registry.all_teammates()) == 2
    assert registry.teammate_by_name("Scout") is not None
    assert registry.teammate_by_name("Helper") is not None


def test_teammates_by_bot_id_lists_every_sharer(scout, builder):
    registry.save_teammate(make_teammate("Helper", "U111", 1, "C_HELP", "help"))
    assert sorted(t.name for t in registry.teammates_by_bot_id("U111")) == ["Helper", "Scout"]
    assert [t.name for t in registry.teammates_by_bot_id("U222")] == ["Builder"]


# --- prompts --------------------------------------------------------------


def test_soul_carries_identity_and_slack_rules():
    soul = render_soul("Scout", "Competitive Intelligence", "strategy", "You are Scout.")
    assert "Scout" in soul and "#strategy" in soul and "You are Scout." in soul
    assert "Operating context" in system_from_soul(soul)


def test_create_teammate_tool_shape():
    schema = CREATE_TEAMMATE_TOOL["input_schema"]
    assert CREATE_TEAMMATE_TOOL["type"] == "custom"
    # Only the home channel is structurally required: a template alone is a
    # complete hire, and so is freehand `instructions`. `_compose` enforces the
    # "one of the two" rule, with an error message the agent can act on.
    assert set(schema["required"]) == {"home_channel"}
    assert {"template", "name", "role", "instructions", "emoji"} <= set(schema["properties"])
