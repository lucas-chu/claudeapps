#!/usr/bin/env python3
"""
03_managed_agent.py

Same incident as 02_tool_use_agent.py, but this time Claude gets a real
workspace instead of three functions you wrote. Managed Agents persists the
agent config as a versioned object and runs both the loop and the sandbox
for you -- bash, file read/write, the works -- inside a container scoped
to the session. You didn't build any of that infrastructure.

This script:
  1. creates a reusable Agent (in production you'd do this once, in a setup
     script, and just store the ID -- see the note below)
  2. creates a cloud Environment for it to run in
  3. starts a Session and streams events while Claude investigates and
     writes a fix plan + postmortem straight to the session's own files
  4. downloads whatever it wrote

Run:
    python 03_managed_agent.py

Optional: set GITHUB_TOKEN and TUTORIAL_REPO_URL to have Claude mount and
read an actual repository instead of working from a text description --
see the commented-out `resources` block below.
"""
import os
import time

import anthropic
from dotenv import load_dotenv

load_dotenv()

MODEL = "claude-opus-5"


def main() -> None:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("Set ANTHROPIC_API_KEY first -- see .env.example.")

    client = anthropic.Anthropic()

    # NOTE: same demo-only shortcut as the agent below -- production code
    # creates the environment once, stores environment.id, and reuses it.
    print("Creating environment...")
    environment = client.beta.environments.create(
        name=f"claudetutorial-{int(time.time())}",
        config={"type": "cloud", "networking": {"type": "unrestricted"}},
    )

    # NOTE: this creates a brand-new agent every run, which is fine for a
    # five-minute demo but not how you'd run this in production. Agents are
    # persisted, versioned objects -- create one, store agent.id, and reuse
    # it. Re-creating on every request just accumulates orphaned agents.
    print("Creating agent (in production: create this once, reuse the ID)...")
    agent = client.beta.agents.create(
        name="Incident Responder",
        model=MODEL,
        system=(
            "You are a senior SRE handling a production incident. Investigate "
            "using the tools available, then write two files to "
            "/mnt/session/outputs/: fix-plan.md (immediate remediation steps) "
            "and postmortem.md (root cause, impact, and one follow-up action). "
            "Be specific and terse -- this gets read at 3am."
        ),
        tools=[{"type": "agent_toolset_20260401", "default_config": {"enabled": True}}],
    )

    print(f"Starting session (agent {agent.id}, version {agent.version})...")
    session = client.beta.sessions.create(
        agent={"type": "agent", "id": agent.id, "version": agent.version},
        environment_id=environment.id,
        # Point Claude at a real repo instead of a text description by
        # uncommenting this and setting GITHUB_TOKEN / TUTORIAL_REPO_URL:
        # resources=[{
        #     "type": "github_repository",
        #     "url": os.environ["TUTORIAL_REPO_URL"],
        #     "authorization_token": os.environ["GITHUB_TOKEN"],
        # }],
    )

    incident = (
        "checkout-api is returning 5xx for 42% of requests, up from a 0.1% "
        "baseline, starting about 5 minutes ago. Known history: this service "
        "has hit connection-pool exhaustion under load before, tied to the "
        "Stripe client. No recent deploys to this service."
    )

    # Stream-first: open the stream before sending, so nothing gets missed.
    with client.beta.sessions.events.stream(session_id=session.id) as stream:
        client.beta.sessions.events.send(
            session_id=session.id,
            events=[{"type": "user.message", "content": [{"type": "text", "text": incident}]}],
        )
        for event in stream:
            if event.type == "agent.message":
                for block in event.content:
                    if block.type == "text":
                        print(block.text, end="", flush=True)
            elif event.type == "session.status_idle":
                print("\n\n--- agent is idle ---")
                break
            elif event.type == "session.status_terminated":
                print("\n\n--- session terminated ---")
                break

    print("Fetching whatever Claude wrote to /mnt/session/outputs/ ...")
    files = None
    for _ in range(3):
        result = client.beta.files.list(
            scope_id=session.id,
            betas=["managed-agents-2026-04-01"],
        )
        if result.data:
            files = result.data
            break
        time.sleep(2)  # output files can lag a couple seconds after idle

    if files:
        os.makedirs("outputs", exist_ok=True)
        for f in files:
            local_path = os.path.join("outputs", f.filename)
            client.beta.files.download(
                f.id, betas=["managed-agents-2026-04-01"]
            ).write_to_file(local_path)
            print(f"  saved {local_path}")
    else:
        print("  no output files yet -- rerun the download step in a few seconds.")


if __name__ == "__main__":
    main()
