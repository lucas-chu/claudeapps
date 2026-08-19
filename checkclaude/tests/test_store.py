"""Dedupe is the only persistence this bot has - it needs to actually hold."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from store import DM, MENTION, Store  # noqa: E402


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


# --- two channels, two cursors -----------------------------------------------


def test_the_dm_cursor_and_the_mention_cursor_do_not_move_each_other(tmp_path):
    """Both are snowflake ids read back numerically, so pooling them would have a
    busy DM inbox silently rewinding the mention cursor - and vice versa."""
    store = make(tmp_path)
    store.claim("100", "c1", MENTION)
    store.claim("900", "conv-1", DM)
    store.claim("50", "c2", MENTION)

    assert store.latest_mention_id() == "100"
    assert store.latest_dm_event_id() == "900"


def test_the_last_answer_in_a_dm_conversation_is_the_prior_context(tmp_path):
    store = make(tmp_path)
    store.claim("900", "conv-1", DM)
    store.record("900", "e1", "FALSE", "No - it was 4.4% in 2023.")
    store.claim("901", "conv-2", DM)
    store.record("901", "e2", "TRUE", "Yes, that one checks out.")

    assert store.prior_check_in_conversation("conv-1").reply_text.startswith("No -")
    assert store.prior_check_in_conversation("conv-2").verdict == "TRUE"
    assert store.prior_check_in_conversation("conv-3") is None


def test_a_follow_up_on_any_post_of_a_thread_resolves_to_the_check(tmp_path):
    store = make(tmp_path)
    store.claim("1", "100")
    store.record("1", ["999", "1000", "1001"], "MISLEADING", "post one\n\npost two\n\npost three")

    for reply_id in ("999", "1000", "1001"):
        prior = store.prior_check_for_reply(reply_id)
        assert prior is not None and prior.mention_id == "1"
    assert store.prior_check_for_reply("1002") is None


def test_release_forgets_the_thread_posts_too(tmp_path):
    store = make(tmp_path)
    store.claim("1", "100")
    store.record("1", ["999", "1000"], "FALSE", "text")
    store.release("1")
    assert store.prior_check_for_reply("1000") is None
    assert store.claim("1", "100") is True


def test_a_database_from_before_the_dm_channel_still_opens(tmp_path):
    """The channel column is added in place rather than by rebuilding the table."""
    path = str(tmp_path / "old.sqlite3")
    old = sqlite3.connect(path)
    old.executescript(
        """
        CREATE TABLE checks (
            mention_id   TEXT PRIMARY KEY,
            claim_post_id TEXT NOT NULL,
            reply_id     TEXT,
            verdict      TEXT,
            reply_text   TEXT,
            created_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO checks (mention_id, claim_post_id, reply_id, verdict, reply_text)
        VALUES ('7', '100', '999', 'FALSE', 'It was 4.4%.');
        """
    )
    old.commit()
    old.close()

    store = Store(path)
    assert store.claim("7", "100") is False  # the old check is still deduped
    assert store.latest_mention_id() == "7"  # and counts as a mention
    assert store.prior_check_for_reply("999").verdict == "FALSE"
