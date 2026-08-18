"""message_teammate and add_reaction: the tools every hired teammate gets."""

import pytest

from app import managed_agent, slack_client, teammate


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Nothing here should touch Slack or Anthropic for real."""
    monkeypatch.setattr(slack_client, "post", lambda *a, **k: "ts123")
    monkeypatch.setattr(slack_client, "react", lambda *a, **k: True)


def ctx(caller, *, channel="C_STRAT", thread_ts="1.1", trigger_ts="1.1", depth=0):
    return teammate.Context(
        caller=caller, channel=channel, thread_ts=thread_ts, trigger_ts=trigger_ts, depth=depth
    )


# --- message_teammate -------------------------------------------------


def test_rejects_messaging_yourself(pool, scout):
    handler = teammate.handler_for(ctx(scout))
    result = handler("message_teammate", {"target": "Scout", "message": "hi"})
    assert "yourself" in result


def test_rejects_missing_fields(pool, scout):
    handler = teammate.handler_for(ctx(scout))
    assert "required" in handler("message_teammate", {"target": "", "message": "hi"})
    assert "required" in handler("message_teammate", {"target": "Builder", "message": ""})


def test_rejects_unknown_target(pool, scout):
    handler = teammate.handler_for(ctx(scout))
    result = handler("message_teammate", {"target": "Ghost", "message": "hi"})
    assert "No teammate named" in result


def test_enforces_delegation_depth(pool, scout, builder):
    handler = teammate.handler_for(ctx(scout, depth=teammate.MAX_DELEGATION_DEPTH - 1))
    result = handler("message_teammate", {"target": "Builder", "message": "hi"})
    assert "deep" in result


def test_relays_and_returns_the_reply(pool, scout, builder, monkeypatch):
    monkeypatch.setattr(managed_agent, "run_side_channel_turn", lambda **kw: "42 is the answer")
    handler = teammate.handler_for(ctx(scout))
    result = handler("message_teammate", {"target": "Builder", "message": "what's the number?"})
    assert result == "42 is the answer"


def test_failure_is_reported_not_raised(pool, scout, builder, monkeypatch):
    def boom(**kw):
        raise RuntimeError("session exploded")

    monkeypatch.setattr(managed_agent, "run_side_channel_turn", boom)
    handler = teammate.handler_for(ctx(scout))
    result = handler("message_teammate", {"target": "Builder", "message": "hi"})
    assert "RuntimeError" in result


def test_relay_hands_the_target_a_deeper_context(pool, scout, builder, monkeypatch):
    """The target's own tool_handler should carry depth + 1, not start back at 0."""
    captured = {}

    def fake_run(**kw):
        captured["tool_handler"] = kw["tool_handler"]
        return "ok"

    monkeypatch.setattr(managed_agent, "run_side_channel_turn", fake_run)
    handler = teammate.handler_for(ctx(scout, depth=teammate.MAX_DELEGATION_DEPTH - 2))
    handler("message_teammate", {"target": "Builder", "message": "hi"})

    # One hop deeper already; Builder relaying further should now hit the cap.
    nested = captured["tool_handler"]
    result = nested("message_teammate", {"target": "Scout", "message": "back to you"})
    assert "deep" in result


# --- add_reaction -------------------------------------------------------


def test_add_reaction_reports_success(pool, scout):
    handler = teammate.handler_for(ctx(scout))
    assert "Reacted" in handler("add_reaction", {"emoji": ":eyes:"})


def test_add_reaction_requires_emoji(pool, scout):
    handler = teammate.handler_for(ctx(scout))
    assert "required" in handler("add_reaction", {"emoji": ""})


def test_add_reaction_reports_failure(pool, scout, monkeypatch):
    monkeypatch.setattr(slack_client, "react", lambda *a, **k: False)
    handler = teammate.handler_for(ctx(scout))
    assert "Could not react" in handler("add_reaction", {"emoji": "tada"})


# --- dispatch ---------------------------------------------------------------


def test_unknown_tool_raises(pool, scout):
    handler = teammate.handler_for(ctx(scout))
    with pytest.raises(ValueError):
        handler("mystery_tool", {})
