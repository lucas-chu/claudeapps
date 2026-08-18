"""The --once flag is the demo rehearsal path; its parsing should be boring."""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import CREDENTIAL_LEAKING_LOGGERS, configure_logging, parse_post_id  # noqa: E402


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


@pytest.mark.parametrize("verbose", [False, True])
def test_verbose_never_unmutes_the_credential_loggers(verbose: bool) -> None:
    """`-v` raises the root level to DEBUG; oauthlib must not come with it.

    oauthlib logs the signature base string, which carries the consumer key
    and the access token in cleartext. A verbose run gets pasted into issues
    and redirected to files, so this has to hold at DEBUG too.
    """
    root = logging.getLogger()
    loggers = [logging.getLogger(name) for name in CREDENTIAL_LEAKING_LOGGERS]
    saved = (root.level, [logger.level for logger in loggers])
    try:
        # basicConfig is a no-op once handlers exist, so put the root at DEBUG
        # by hand - otherwise this asserts nothing under pytest.
        root.setLevel(logging.DEBUG)
        for logger in loggers:
            logger.setLevel(logging.NOTSET)

        configure_logging(verbose)

        for logger in loggers:
            assert logger.level == logging.WARNING, f"{logger.name} is not muted"
            assert not logger.isEnabledFor(logging.DEBUG), f"{logger.name} would log credentials"
    finally:
        root.setLevel(saved[0])
        for logger, level in zip(loggers, saved[1]):
            logger.setLevel(level)
