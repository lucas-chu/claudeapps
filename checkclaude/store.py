"""Dedupe, and just enough memory to answer follow-ups.

One table of checks. The request id - a mention id or a DM event id - is the
idempotency key: the bot restarts, the stream reconnects, the poller overlaps,
the DM feed redelivers - none of that should produce a second answer to the same
request.

Two columns exist only because there are now two channels:

  * ``channel`` keeps the mention cursor and the DM cursor from being compared
    against each other. Both are snowflake ids and both are read back with a
    numeric sort, so pooling them would have the DM feed silently rewinding the
    mention cursor.
  * ``claim_post_id`` holds the DM conversation id on DM rows, which is what makes
    a DM thread continuous: the last check in a conversation is the prior context
    for the next question in it.

``reply_posts`` is the other addition: a public answer can now be several posts,
and a follow-up may reply to any of them.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Sequence

MENTION = "mention"
DM = "dm"

SCHEMA = """
CREATE TABLE IF NOT EXISTS checks (
    mention_id   TEXT PRIMARY KEY,
    claim_post_id TEXT NOT NULL,
    reply_id     TEXT,
    verdict      TEXT,
    reply_text   TEXT,
    channel      TEXT NOT NULL DEFAULT 'mention',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS checks_reply_id ON checks(reply_id);

-- Every post of a threaded answer, so a follow-up on any of them resolves back
-- to the check that produced it.
CREATE TABLE IF NOT EXISTS reply_posts (
    reply_id   TEXT PRIMARY KEY,
    mention_id TEXT NOT NULL
);
"""

# Indexes on columns that a pre-DM database does not have yet, so they can only be
# created after the migration has added them.
POST_MIGRATION_SCHEMA = """
CREATE INDEX IF NOT EXISTS checks_channel ON checks(channel);
"""


@dataclass
class PriorCheck:
    mention_id: str
    verdict: str
    reply_text: str


class Store:
    def __init__(self, path: str):
        self._db = sqlite3.connect(path)
        self._db.executescript(SCHEMA)
        self._migrate()
        self._db.executescript(POST_MIGRATION_SCHEMA)
        self._db.commit()

    def _migrate(self) -> None:
        """Add columns a database created by an earlier version is missing."""
        columns = {row[1] for row in self._db.execute("PRAGMA table_info(checks)")}
        if "channel" not in columns:
            self._db.execute(
                f"ALTER TABLE checks ADD COLUMN channel TEXT NOT NULL DEFAULT '{MENTION}'"
            )

    def seen(self, mention_id: str) -> bool:
        row = self._db.execute(
            "SELECT 1 FROM checks WHERE mention_id = ?", (mention_id,)
        ).fetchone()
        return row is not None

    def claim(self, mention_id: str, claim_post_id: str, channel: str = MENTION) -> bool:
        """Reserve a request. Returns False if another pass already took it."""
        try:
            self._db.execute(
                "INSERT INTO checks (mention_id, claim_post_id, channel) VALUES (?, ?, ?)",
                (mention_id, claim_post_id, channel),
            )
            self._db.commit()
            return True
        except sqlite3.IntegrityError:
            return False

    def record(
        self,
        mention_id: str,
        reply_ids: str | Sequence[str] | None,
        verdict: str,
        reply_text: str,
    ) -> None:
        """Record what was published. ``reply_ids`` is one id or a thread of them."""
        ids = [reply_ids] if isinstance(reply_ids, str) else [i for i in (reply_ids or []) if i]
        self._db.execute(
            "UPDATE checks SET reply_id = ?, verdict = ?, reply_text = ? WHERE mention_id = ?",
            (ids[0] if ids else None, verdict, reply_text, mention_id),
        )
        self._db.executemany(
            "INSERT OR IGNORE INTO reply_posts (reply_id, mention_id) VALUES (?, ?)",
            [(reply_id, mention_id) for reply_id in ids],
        )
        self._db.commit()

    def release(self, mention_id: str) -> None:
        """Undo a claim so a transient failure can be retried on the next pass."""
        self._db.execute("DELETE FROM checks WHERE mention_id = ?", (mention_id,))
        self._db.execute("DELETE FROM reply_posts WHERE mention_id = ?", (mention_id,))
        self._db.commit()

    def _latest_id(self, channel: str) -> str | None:
        row = self._db.execute(
            "SELECT mention_id FROM checks WHERE channel = ? "
            "ORDER BY CAST(mention_id AS INTEGER) DESC LIMIT 1",
            (channel,),
        ).fetchone()
        return row[0] if row else None

    def latest_mention_id(self) -> str | None:
        return self._latest_id(MENTION)

    def latest_dm_event_id(self) -> str | None:
        return self._latest_id(DM)

    def prior_check_for_reply(self, reply_id: str) -> PriorCheck | None:
        """If a mention replies to any post of one of our answers, that check."""
        row = self._db.execute(
            "SELECT c.mention_id, c.verdict, c.reply_text FROM checks c "
            "LEFT JOIN reply_posts p ON p.mention_id = c.mention_id "
            "WHERE c.reply_id = ? OR p.reply_id = ? LIMIT 1",
            (reply_id, reply_id),
        ).fetchone()
        return PriorCheck(*row) if row else None

    def prior_check_in_conversation(self, conversation_id: str) -> PriorCheck | None:
        """The most recent answer in a DM conversation.

        A DM carries no reply-to id to walk, so the conversation itself is the
        thread: whatever we last said in it is what the next question follows on
        from.
        """
        row = self._db.execute(
            "SELECT mention_id, verdict, reply_text FROM checks "
            "WHERE channel = ? AND claim_post_id = ? AND reply_text IS NOT NULL "
            "ORDER BY CAST(mention_id AS INTEGER) DESC LIMIT 1",
            (DM, conversation_id),
        ).fetchone()
        return PriorCheck(*row) if row else None

    def close(self) -> None:
        self._db.close()
