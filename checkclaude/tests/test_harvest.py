"""URL harvesting is what makes citation-checking meaningful.

If it ever starts trusting model-authored text, the guard silently stops catching
fabricated citations - so the negative cases matter more than the positive ones.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from claude_agent_sdk import TextBlock, ToolUseBlock  # noqa: E402

from agent import _harvest_urls  # noqa: E402


@dataclass
class Message:
    content: Any


@dataclass
class ResultBlock:
    """Stand-in for a tool-result block; the real shape varies by tool."""

    content: Any


def harvest(*blocks) -> set[str]:
    sink: set[str] = set()
    _harvest_urls(Message(content=list(blocks)), sink)
    return sink


def test_webfetch_target_is_recorded():
    block = ToolUseBlock(id="1", name="WebFetch", input={"url": "https://eia.gov/report"})
    assert harvest(block) == {"https://eia.gov/report"}


def test_urls_in_tool_results_are_recorded():
    payload = "1. Berkeley Lab report (https://eta.lbl.gov/publications/x) - 176 TWh in 2023."
    assert harvest(ResultBlock(content=payload)) == {"https://eta.lbl.gov/publications/x"}


def test_model_authored_text_is_not_trusted():
    """A URL the model merely wrote must never count as retrieved."""
    assert harvest(TextBlock(text="According to https://eia.gov/invented-page, ...")) == set()


def test_submitted_citations_are_not_self_certifying():
    """submit_verdict carries the model's claimed sources - harvesting them would
    make the guard validate the model against itself."""
    block = ToolUseBlock(
        id="2",
        name="mcp__verdict__submit_verdict",
        input={"verdict": "FALSE", "sources": [{"name": "EIA", "url": "https://eia.gov/fake"}]},
    )
    assert harvest(block) == set()


def test_websearch_query_is_not_a_url():
    block = ToolUseBlock(id="3", name="WebSearch", input={"query": "us data center electricity share"})
    assert harvest(block) == set()


def test_trailing_punctuation_is_stripped():
    assert harvest(ResultBlock(content="see https://eia.gov/report).")) == {"https://eia.gov/report"}


def test_string_content_is_ignored():
    """A plain-string message is our own prompt echoed back, not tool output."""
    sink: set[str] = set()
    _harvest_urls(Message(content="check https://eia.gov/from-the-prompt"), sink)
    assert sink == set()
