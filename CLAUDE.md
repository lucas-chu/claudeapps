# anthropic-interview

Take-home: three projects on one spine — **Messages API** (Claude responds) →
**Agent SDK** (Claude investigates) → **Managed Agents** (Claude persists).

Two are built. They are sibling directories and share nothing — separate
dependencies, separate `.env`, separate entrypoints. Run every command from
inside the project directory, never from the repo root.

| Project | Where | What |
|---|---|---|
| Agent SDK | `checkclaude/` | X bot that fact-checks any post you reply to with `@CheckClaude is this true?` |
| Managed Agents | `claudefather/` | `@ClaudeFather`, a Slack agent that hires other agents |
| Messages API | — | unbuilt |

Each project's own README is its authoritative doc; the root `README.md` is only
an index. Everything below is about `checkclaude/` — for `claudefather/`, read
[`claudefather/README.md`](./claudefather/README.md).

## Commands (checkclaude)

```bash
cd checkclaude
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

pytest                                    # 63 tests, no network, no API keys
python tests/smoke_agent.py               # real agent run, needs ANTHROPIC_API_KEY only
python tests/smoke_agent.py "<claim>" "<question>"
python main.py --once <post-url>          # check one post, print, don't post
python main.py --dry-run                  # full loop, never posts
python main.py -v                         # live, verbose
```

`smoke_agent.py` is the fastest signal — it exercises research → verdict → guard
without any X credentials.

## Architecture

```
main.py       the loop: mention → context → agent → guard → reply
x_client.py   listen_for_mentions() · get_post() · get_thread() · reply()
context.py    build_context() · extract_links()
agent.py      fact_check()  ← the Agent SDK lives here
prompts.py    system instruction + objective + voice
verdict.py    FactCheck model + response guard
store.py      sqlite dedupe + follow-up memory
config.py     env
```

The agent is given an objective, not a script. It ends when Claude calls
`submit_verdict`, an in-process MCP tool whose JSON Schema is the verdict
contract. `prompts.py` holds most of the product thinking and is the file worth
reading first.

## Invariants — don't break these

These are the reason the thing is trustworthy. Each has tests.

1. **Citations are checked against reality.** `_harvest_urls` records URLs from
   tool *results* and WebFetch *targets* only. It deliberately ignores URLs the
   model wrote in text or passed to `submit_verdict` — that's the channel a
   fabricated citation arrives on. Never "simplify" it to trust model output.
2. **No evidence → no verdict.** An assertive verdict whose sources all failed
   the citation check is downgraded to UNVERIFIABLE, and the prose says so.
3. **No verdict → no reply.** If the agent never calls `submit_verdict`, the bot
   stays silent and releases the mention. Silence beats a confident guess.
4. **Attribution outlives the prose.** The length ladder has no "drop the
   sources" rung; when links don't fit it falls back to publisher names and
   truncates the body instead.
5. **The agent only searches and fetches.** `tools=["WebSearch", "WebFetch"]` —
   no Bash, no filesystem. It reads attacker-controlled text all day. Don't widen
   this. Post content stays fenced in `<<< >>>` and labelled untrusted.

## Environment notes

- `claude-agent-sdk` bundles its own Claude Code CLI. No Node or `npm install -g`
  needed.
- **WebSearch runs server-side; WebFetch runs client-side.** In a sandbox without
  outbound HTTPS, search works and fetch fails, so the agent falls back to search
  snippets and reports lower confidence. `run.research_summary()` prints
  `WebFetch 8 (8 failed)` when this happens, and `smoke_agent.py` warns. On a
  normal machine both work and sourcing is better.
- X API: `INGEST_MODE=poll` is the default and works on every access tier.
  `stream` (filtered stream) is implemented but needs Pro/Enterprise.
- Posting needs OAuth 1.0a with the app set to **Read and write**, and tokens
  **regenerated after** changing that permission — otherwise posts 403.

## Open threads

- Project 1 (Messages API — Claude *responds*) is unbuilt.
- Scope question: CheckClaude is a fact-checker only. The PRD lists
  "general-purpose X assistant" under *do not build*, so non-fact-check asks
  aren't routed anywhere.
- `CHECKCLAUDE_EFFORT=high` takes ~2–4 min per check; `medium` roughly halves it.
- CI (`.github/workflows/tests.yml`) runs `pytest` in `checkclaude/` only —
  ClaudeFather has no test suite.

## Conventions

- Comments explain *why*, not what. Don't narrate the code.
- Tests assert behaviour that must not fail open, not implementation detail.
- Keep it small. The PRD's "do not build" list is real: no dashboard, no
  accounts, no analytics, no DB beyond dedupe.
