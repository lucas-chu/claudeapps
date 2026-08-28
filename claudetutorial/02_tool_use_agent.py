#!/usr/bin/env python3
"""
02_tool_use_agent.py

Claude driving tools you wrote, in a loop the SDK manages for you. This is
the workflow tier: you own the tools and the infra, Claude owns the
decisions about which ones to call and when to stop calling them.

Scenario: an on-call triage assistant. It gets paged, checks the service it
was told about, looks up the relevant runbook entry, and either resolves
the page itself or escalates with a clear summary.

Run:
    python 02_tool_use_agent.py
"""
import os

import anthropic
from anthropic import beta_tool
from dotenv import load_dotenv

load_dotenv()

MODEL = "claude-opus-5"

# Fake infra so this runs with zero setup. Swap these bodies for real calls
# to your status page, your runbook wiki, and PagerDuty/Opsgenie.
_SERVICE_STATUS = {
    "checkout-api": "5xx rate at 42% over the last 5 minutes, up from a 0.1% baseline",
    "auth-api": "healthy",
    "webhook-dispatcher": "healthy",
}

_RUNBOOK = {
    "checkout-api": (
        "checkout-api 5xx spikes are almost always the Stripe client pool "
        "exhausting connections under load. Restart the pod group and set "
        "STRIPE_POOL_SIZE=50 if it recurs within an hour."
    ),
}


@beta_tool
def check_service_status(service: str) -> str:
    """Look up the current health of an internal service.

    Args:
        service: The service name, e.g. "checkout-api".
    """
    return _SERVICE_STATUS.get(service, f"No status found for '{service}'.")


@beta_tool
def search_runbook(service: str) -> str:
    """Search the on-call runbook for a known issue with a service.

    Args:
        service: The service name to search for.
    """
    return _RUNBOOK.get(service, "No runbook entry found for this service.")


@beta_tool
def page_oncall(severity: str, summary: str) -> str:
    """Escalate to the human on-call engineer.

    Args:
        severity: One of "low", "medium", "high".
        summary: A one- or two-sentence summary of the incident for the page.
    """
    return f"Paged on-call (severity={severity}): {summary}"


def main() -> None:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("Set ANTHROPIC_API_KEY first -- see .env.example.")

    client = anthropic.Anthropic()

    alert = (
        "PagerDuty alert: checkout-api error rate is elevated. Investigate "
        "and either resolve it yourself using the runbook, or page on-call "
        "with a clear summary if it's not a known issue."
    )

    runner = client.beta.messages.tool_runner(
        model=MODEL,
        max_tokens=16000,
        tools=[check_service_status, search_runbook, page_oncall],
        messages=[{"role": "user", "content": alert}],
    )

    # The tool runner handles calling each tool and feeding results back --
    # this loop just prints what's happening. It stops automatically once
    # Claude has no more tool calls to make.
    for message in runner:
        for block in message.content:
            if block.type == "text":
                print(block.text)
            elif block.type == "tool_use":
                print(f"  -> calling {block.name}({block.input})")


if __name__ == "__main__":
    main()
