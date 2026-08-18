"""The --once flag is the demo rehearsal path; its parsing should be boring."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import parse_post_id  # noqa: E402


@pytest.mark.parametrize(
    "target,expected",
    [
        ("https://x.com/user/status/1234567890123456789", "1234567890123456789"),
        ("https://twitter.com/user/status/1234567890?s=20", "1234567890"),
        # A username with digits must not shadow the real id.
        ("https://x.com/user12345678/status/9876543210", "9876543210"),
        ("1234567890", "1234567890"),
        ("  1234567890  ", "1234567890"),
        ("not-a-post", None),
        ("https://x.com/someuser", None),
    ],
)
def test_parse_post_id(target, expected):
    assert parse_post_id(target) == expected
