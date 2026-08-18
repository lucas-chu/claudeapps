"""ONE-TIME SETUP — run once, paste the printed IDs into .env.

Creates the shared sandbox environment and the ClawdFather agent. Both are
persistent, versioned objects: never create them in the per-message path.
Teammate agents are NOT created here — ClawdFather creates those at hire time.

    python -m scripts.setup
"""

from __future__ import annotations

import sys

from app import config, managed_agent
from app.prompts import CLAWDFATHER_SYSTEM, CREATE_TEAMMATE_TOOL, LIST_TEAMMATES_TOOL


def main() -> int:
    if not config.ANTHROPIC_API_KEY:
        print("ANTHROPIC_API_KEY is not set. Copy .env.example to .env first.")
        return 1

    if config.ENVIRONMENT_ID:
        environment_id = config.ENVIRONMENT_ID
        print(f"Reusing environment {environment_id}")
    else:
        environment_id = managed_agent.create_environment("slack-teammates")
        print(f"Created environment {environment_id}")

    if config.CLAWDFATHER_AGENT_ID:
        print(f"ClawdFather already exists ({config.CLAWDFATHER_AGENT_ID}); updating it.")
        version = managed_agent.update_agent_system(config.CLAWDFATHER_AGENT_ID, CLAWDFATHER_SYSTEM)
        agent_id = config.CLAWDFATHER_AGENT_ID
    else:
        agent_id, version = managed_agent.create_agent(
            name="ClawdFather",
            system=CLAWDFATHER_SYSTEM,
            tools=[
                {"type": "agent_toolset_20260401"},
                CREATE_TEAMMATE_TOOL,
                LIST_TEAMMATES_TOOL,
            ],
        )
        print(f"Created ClawdFather agent {agent_id} (version {version})")

    print("\nPaste into .env:\n")
    print(f"ENVIRONMENT_ID={environment_id}")
    print(f"CLAWDFATHER_AGENT_ID={agent_id}")
    print(f"CLAWDFATHER_AGENT_VERSION={version if version is not None else ''}")
    print("\nThen: python -m app.slack")
    return 0


if __name__ == "__main__":
    sys.exit(main())
