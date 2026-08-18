"""Dedupe is the only persistence this bot has - it needs to actually hold."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from store import Store  # noqa: E402


def make(tmp_path) -> Store:
    return Store(str(tmp_path / "test.sqlite3"))


def test_a_mention_can_only_be_claimed_once(tmp_path):
    store = make(tmp_path)
    assert store.claim("1", "100") is True
    assert store.claim("1", "100") is False


def test_release_allows_a_retry_after_failure(tmp_path):
    store = make(tmp_path)
    store.claim("1", "100")
    store.release("1")
    assert store.claim("1", "100") is True


def test_latest_mention_id_is_numeric_not_lexicographic(tmp_path):
    store = make(tmp_path)
    for mid in ("9", "100", "20"):
        store.claim(mid, "x")
    assert store.latest_mention_id() == "100"


def test_prior_check_is_found_by_our_own_reply_id(tmp_path):
    store = make(tmp_path)
    store.claim("1", "100")
    store.record("1", "999", "MISLEADING", "⚠️ MISLEADING\n\nIt was 4.4%.")
    prior = store.prior_check_for_reply("999")
    assert prior is not None
    assert prior.verdict == "MISLEADING"
    assert store.prior_check_for_reply("nope") is None


def test_dedupe_survives_a_restart(tmp_path):
    store = make(tmp_path)
    store.claim("1", "100")
    store.close()
    assert make(tmp_path).claim("1", "100") is False
