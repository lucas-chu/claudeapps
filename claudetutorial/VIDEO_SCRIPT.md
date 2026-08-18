# Video outline

Not a script to read verbatim — beats to hit, so it stays natural. Target: 2.5–3.5 minutes.

## Hook (~15s)
- You've probably already tried Claude, GPT, and Gemini for something. This isn't "why Claude is better" in the abstract.
- It's three versions of the same incident, at three tiers, so you can see which one your product actually needs.

## What it is (~20s)
- Screen: repo listing, three numbered scripts + README.
- One sentence each: a single call, a tool-use loop, a Managed Agent.

## Demo — tier 1 (~30s)
- Run `01_hello_claude.py` live.
- Point at the streaming output, then the usage numbers at the bottom — call out `cache_read_input_tokens` going from 0 to nonzero on the second call.
- One line: "if you're re-sending context on every request, this is free money left on the table."

## Demo — tier 2 (~40s)
- Run `02_tool_use_agent.py`.
- Narrate as it runs: it checks the service, hits the runbook, decides on its own whether to resolve or escalate.
- Call out: three plain Python functions, no agent framework, the SDK owns the loop.

## Demo — tier 3 (~50s)
- Run `03_managed_agent.py`.
- While it's creating the environment/agent/session, explain what's NOT happening: no Dockerfile, no sandbox infra, no cleanup code.
- Cut to the written `fix-plan.md` / `postmortem.md` in `outputs/` — Claude produced files, not just text.
- This is the one line that should land hardest: "Anthropic is running the loop and the computer it works in."

## Why it matters for them specifically (~25s)
- You're 2–4 people. You don't have a platform team to build agent sandboxing.
- Pick the cheapest tier that solves the problem — the repo is set up so that's an easy call, not a guess.

## Close (~10s)
- Link to the repo, docs, cookbook.
- Direct CTA: clone it, run `01_hello_claude.py` today, come back for tier 3 when you need it.
