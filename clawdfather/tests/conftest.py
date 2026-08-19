import os

# Importing app.config reads the environment at import time; give it enough to
# construct cleanly without touching a real .env or the network.
os.environ.setdefault("ANTHROPIC_API_KEY", "sk-test")
os.environ.setdefault("SLACK_BOT_TOKEN", "xoxb-test")
os.environ.setdefault("SLACK_APP_TOKEN", "xapp-test")

import pytest  # noqa: E402

from app import registry, router  # noqa: E402


@pytest.fixture(autouse=True)
def isolated_registry(tmp_path, monkeypatch):
    """Point the registry at a temp file so tests never touch data/registry.json."""
    monkeypatch.setattr(registry, "DATA_DIR", tmp_path)
    monkeypatch.setattr(registry, "REGISTRY_PATH", tmp_path / "registry.json")
    yield


@pytest.fixture(autouse=True)
def no_ambient_pool(monkeypatch):
    """Default the router's identity pool to empty.

    `router.route` falls back to `identity_pool()`, which reads the environment
    — and a developer's real `.env` would otherwise leak real slots into tests.
    Tests that care about the pool pass `slots=` explicitly.
    """
    monkeypatch.setattr(router, "identity_pool", list)
    yield


@pytest.fixture
def pool(monkeypatch):
    """A three-slot identity pool, as registry.claim_slot sees it."""
    slots = [
        registry.Slot(index=1, bot_token="t1", bot_user_id="U111"),
        registry.Slot(index=2, bot_token="t2", bot_user_id="U222"),
        registry.Slot(index=3, bot_token="t3", bot_user_id="U333"),
    ]
    monkeypatch.setattr(registry, "identity_pool", lambda: slots)
    return slots


@pytest.fixture
def clawds():
    """The identity pool as the router sees it: three named Clawds.

    Slots 1 and 2 are the ones `scout` and `builder` are hired into; slot 3 is
    configured but unassigned.
    """
    return [
        registry.Slot(index=1, bot_token="t1", bot_user_id="U111", name="Clawd One"),
        registry.Slot(index=2, bot_token="t2", bot_user_id="U222", name="Clawd Two"),
        registry.Slot(index=3, bot_token="t3", bot_user_id="U333", name="Clawd Three"),
    ]


def make_teammate(name, bot_user_id, slot_index, home_channel, home_name="strategy"):
    return registry.Teammate(
        name=name,
        role=f"{name} role",
        home_channel=home_channel,
        home_channel_name=home_name,
        agent_id=f"agent_{name.lower()}",
        agent_version=1,
        slot_index=slot_index,
        bot_user_id=bot_user_id,
        soul_path=f"souls/{name.lower()}.md",
    )


@pytest.fixture
def scout():
    t = make_teammate("Scout", "U111", 1, "C_STRAT", "strategy")
    registry.save_teammate(t)
    return t


@pytest.fixture
def builder():
    t = make_teammate("Builder", "U222", 2, "C_ENG", "engineering")
    registry.save_teammate(t)
    return t
