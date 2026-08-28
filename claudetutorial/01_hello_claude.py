#!/usr/bin/env python3
"""
01_hello_claude.py

The fastest path from "I have an API key" to "Claude answered me" -- plus
the one flag that makes repeat calls dramatically cheaper: prompt caching.

Run:
    python 01_hello_claude.py
"""
import os
import time

import anthropic
from dotenv import load_dotenv

load_dotenv()

MODEL = "claude-opus-5"

# Stand-in for something real: a startup's product docs, support macros,
# pricing page -- whatever context you'd otherwise re-paste into every
# prompt. Padded so it's actually long enough to be worth caching.
PRODUCT_CONTEXT = (
    """
You are the support assistant for Loopwire, a webhook-delivery API for
startups. Loopwire retries failed webhook deliveries with exponential
backoff (five attempts spread over 24 hours), signs every payload with an
HMAC-SHA256 signature in the `Loopwire-Signature` header, and only charges
for successfully delivered events after the first 10,000/month, which are
free. Customers manage endpoints and read delivery logs at
dashboard.loopwire.dev. Support tone: direct, technical, no hand-holding --
these are engineers.
"""
    * 6
)


def ask(client: anthropic.Anthropic, question: str) -> None:
    started = time.monotonic()
    first_token_at = None

    with client.messages.stream(
        model=MODEL,
        max_tokens=16000,
        system=[
            {
                "type": "text",
                "text": PRODUCT_CONTEXT,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": question}],
    ) as stream:
        for text in stream.text_stream:
            if first_token_at is None:
                first_token_at = time.monotonic()
            print(text, end="", flush=True)
        final = stream.get_final_message()

    print()
    print(f"  time to first text token: {first_token_at - started:.2f}s")
    print(f"  cache write tokens:       {final.usage.cache_creation_input_tokens}")
    print(f"  cache read tokens:        {final.usage.cache_read_input_tokens}")
    print(f"  uncached input tokens:    {final.usage.input_tokens}")
    print()


def main() -> None:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("Set ANTHROPIC_API_KEY first -- see .env.example.")

    client = anthropic.Anthropic()

    print("--- call #1: cold cache, pays full price for the context ---")
    ask(client, "A customer says webhooks stopped arriving. What do I check first?")

    print("--- call #2: same context, different question, cache hit ---")
    ask(client, "How many retries do we attempt, and over what window?")


if __name__ == "__main__":
    main()
