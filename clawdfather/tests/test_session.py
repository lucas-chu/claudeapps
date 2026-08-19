"""Thread sessions: one per thread, and one per agent within it."""

import pytest

from app import managed_agent, registry


@pytest.fixture
def opened(monkeypatch):
    """Record every session opened, so reuse vs. re-open is visible."""
    calls = []

    def fake_open(agent_id, agent_version, title):
        calls.append(agent_id)
        return f"sess_{len(calls)}"

    monkeypatch.setattr(managed_agent, "_open_session", fake_open)
    return calls


def session(teammate, thread_ts="100.1", channel="C_STRAT"):
    return managed_agent.session_for_thread(
        agent_id=teammate.agent_id,
        agent_version=teammate.agent_version,
        channel=channel,
        thread_ts=thread_ts,
        title="t",
        owner=teammate.name,
    )


def test_follow_up_reuses_the_thread_session(scout, opened):
    first = session(scout)
    assert session(scout) == first
    assert opened == ["agent_scout"]


def test_handover_opens_a_new_session(scout, builder, opened):
    """Builder must not answer out of Scout's session under Builder's name."""
    scouts = session(scout)
    builders = session(builder)
    assert builders != scouts
    assert opened == ["agent_scout", "agent_builder"]
    assert registry.thread_owner("C_STRAT", "100.1") == builder.name
    # And the thread now belongs to Builder, so its follow-ups stay put.
    assert session(builder) == builders


def test_separate_threads_get_separate_sessions(scout, opened):
    assert session(scout, thread_ts="100.1") != session(scout, thread_ts="200.2")
