"""Manual end-to-end smoke test: real Agent SDK run, no X API involved.

    python tests/smoke_agent.py
    python tests/smoke_agent.py "Some claim to check" "is this true?"

Requires the Claude Code CLI and credentials. Not part of the pytest suite -
it makes real model calls and real web requests.
"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import fact_check  # noqa: E402
from config import config  # noqa: E402
from context import CheckContext  # noqa: E402
from verdict import guard, tweet_length  # noqa: E402
from x_client import Post  # noqa: E402

DEFAULT_CLAIM = "Data centers now consume 20% of US electricity."


async def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(name)s: %(message)s")

    claim_text = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CLAIM
    question = sys.argv[2] if len(sys.argv) > 2 else "is this true?"

    claim_post = Post(
        id="1",
        text=claim_text,
        author_id="u1",
        author_handle="someone",
        created_at="2026-08-10T12:00:00.000Z",
    )
    ctx = CheckContext(
        mention=Post(id="2", text=f"@{config.bot_handle} {question}", author_id="u2", author_handle="asker"),
        claim_post=claim_post,
        question=question,
    )

    run = await fact_check(ctx)
    if run.fact_check is None:
        print(f"FAILED: {run.error}")
        return 1

    reply = guard(run.fact_check, run.retrieved_urls, config.max_post_chars, config.reply_style)

    print("\n" + "=" * 60)
    print(reply.text)
    print("=" * 60)
    print(f"\nlength:     {tweet_length(reply.text)}/{config.max_post_chars}")
    print(f"claim:      {reply.fact_check.claim}")
    print(f"confidence: {reply.fact_check.confidence}")
    print(f"research:   {run.research_summary()}")
    print(f"urls seen:  {len(run.retrieved_urls)}")
    if run.tool_errors.get("WebFetch"):
        print(
            "\nNOTE: WebFetch failed here, so the agent worked from search-result\n"
            "      summaries instead of opening primary sources. If you see this on\n"
            "      your own machine, something is blocking outbound HTTP."
        )
    if reply.fact_check.notes:
        print(f"notes:      {reply.fact_check.notes}")
    for source in reply.fact_check.sources:
        print(f"source:     {source.name} {source.url}")
    for warning in reply.warnings:
        print(f"WARNING:    {warning}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
