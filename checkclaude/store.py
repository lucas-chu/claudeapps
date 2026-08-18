"""Dedupe, and just enough memory to answer follow-ups.

One sqlite table. The mention id is the idempotency key: the bot restarts, the
stream reconnects, the poller overlaps - none of that should produce a second
public reply to the same request.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

SCHEMA = """
CREATE TABLE IF NOT EXISTS checks (
    mention_id   TEXT PRIMARY KEY,
    claim_post_id TEXT NOT NULL,
    reply_id     TEXT,
    verdict      TEXT,
    reply_text   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS checks_reply_id ON checks(reply_id);
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
        self._db.commit()

    def seen(self, mention_id: str) -> bool:
        row = self._db.execute(
            "SELECT 1 FROM checks WHERE mention_id = ?", (mention_id,)
        ).fetchone()
        return row is not None

    def claim(self, mention_id: str, claim_post_id: str) -> bool:
        """Reserve a mention. Returns False if another pass already took it."""
        try:
            self._db.execute(
                "INSERT INTO checks (mention_id, claim_post_id) VALUES (?, ?)",
                (mention_id, claim_post_id),
            )
            self._db.commit()
            return True
        except sqlite3.IntegrityError:
            return False

    def record(self, mention_id: str, reply_id: str | None, verdict: str, reply_text: str) -> None:
        self._db.execute(
            "UPDATE checks SET reply_id = ?, verdict = ?, reply_text = ? WHERE mention_id = ?",
            (reply_id, verdict, reply_text, mention_id),
        )
        self._db.commit()

    def release(self, mention_id: str) -> None:
        """Undo a claim so a transient failure can be retried on the next pass."""
        self._db.execute("DELETE FROM checks WHERE mention_id = ?", (mention_id,))
        self._db.commit()

    def latest_mention_id(self) -> str | None:
        row = self._db.execute(
            "SELECT mention_id FROM checks ORDER BY CAST(mention_id AS INTEGER) DESC LIMIT 1"
        ).fetchone()
        return row[0] if row else None

    def prior_check_for_reply(self, reply_id: str) -> PriorCheck | None:
        """If a mention replies to one of our own posts, this is that check."""
        row = self._db.execute(
            "SELECT mention_id, verdict, reply_text FROM checks WHERE reply_id = ?",
            (reply_id,),
        ).fetchone()
        return PriorCheck(*row) if row else None

    def close(self) -> None:
        self._db.close()
