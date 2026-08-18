# anthropic-interview

Take-home: three projects on one spine — **Messages API** (Claude responds) →
**Agent SDK** (Claude investigates) → **Managed Agents** (Claude persists).

All three are built. They are sibling directories and share nothing — separate
dependencies, separate `.env`, separate entrypoints. Run every command from
inside the project directory, never from the repo root.

| Project | Where | What |
|---|---|---|
| Messages API | `claudecanvas/` | Claude Canvas — an infinite canvas of boxes Claude writes into |
| Agent SDK | `checkclaude/` | X bot that fact-checks any post you reply to with `@CheckClaude is this true?` |
| Managed Agents | `clawdfather/` | `@ClawdFather`, a Slack agent that hires other agents |

Each project's own README is its authoritative doc; the root `README.md` is only
an index. The sections below are per-project; anything after **Repo-wide**
applies to all three.

---

# Claude Canvas — `claudecanvas/`

Still named "Cove Canvas" inside its own README and `package.json` — the
directory was renamed on the way into this repo, the project wasn't.

## Commands

```bash
cd claudecanvas
npm install
cp .env.example .env      # ANTHROPIC_API_KEY=sk-ant-...

npm run dev               # Vite on :5173 + API server on :8787, one command
npm test                  # 237 unit tests, no network, no API key
npm run typecheck
npm run build
```

`npm test` is the fastest signal. The server refuses to start without a key
rather than failing on the first prompt.

## Architecture

```
src/App.tsx           wiring: keyboard, selection, undo/redo, view reset/fit
src/Omnibar.tsx       the prompt bar — behaviour depends on what's selected
src/canvas/           geometry.ts · Canvas · TextBox · DrawingBox (Excalidraw)
src/chat/ChatPanel.tsx  the thread — the same one the canvas prompts against
src/state/            types · store (reducer) · history (undo) · context (request
                      assembly) · persist (localStorage)
src/useGeneration.ts  every generation path funnels through here
server/               config preflight · generate (SSE) · sources
```

The browser never talks to the Anthropic API. It calls `/api/generate` (SSE:
`delta`, `sources`, `error`, `done`), `/api/title`, and `/api/convert-image`.

## Invariants — don't break these

Each has tests.

1. **Stored coordinates are world coordinates.** `canvas/geometry.ts` is the
   only place screen↔world math lives. Scattering `* zoom` into event handlers
   is how this class of app breaks subtly under zoom.
2. **In-place rewrites go through a shadow buffer.** Streamed text accumulates
   in `state.shadow` and only replaces a box's content on `commitShadow`, so a
   failed rewrite can't destroy text already on the canvas.
3. **History is built from completed exchanges only.** `completedTurns()` drops
   streaming and errored turns. Without it, three rapid prompts make each one
   inherit the others' unanswered questions and answer all of them — observed
   live, producing "Fish: clownfish. Bird: robin."
4. **The key lives in the server process.** Never in `src/`, never in a Vite
   bundle, never in an SSE payload. Startup logs the key's *source*, not the key.
5. **Model is `claude-opus-5`, and the sampling params stay off.** Don't send
   `temperature`, `top_p`, `top_k`, or a `thinking` param. Disabling thinking on
   opus-5 makes tool calls leak as plain text — web search silently never runs.

## Environment notes

- HEIC conversion shells out to macOS `sips`; other platforms get a clear
  "requires macOS" message rather than a silent failure.
- `MAX_TURNS = 6` — history caps at the last six turns. Full box contents come
  from selection instead, so history stays cheap.
- localStorage caps around 8–9MB (~25–30 photos); past that autosave fails
  silently.
- The lockfile is authored on macOS. `npm ci` on Linux rewrites its optional
  platform deps, so CI uses `npm install` and leaves the lockfile alone.

---

# CheckClaude — `checkclaude/`

## Commands

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
- `CHECKCLAUDE_EFFORT=high` takes ~2–4 min per check; `medium` roughly halves it.

---

# ClawdFather — `clawdfather/`

Read [`clawdfather/README.md`](./clawdfather/README.md).

---

# Repo-wide

## CI

One workflow per project, all firing on every PR:

| Workflow | Runs |
|---|---|
| `.github/workflows/canvas.yml` | `claudecanvas/`: typecheck + vitest + build |
| `.github/workflows/tests.yml` | `checkclaude/`: pytest |
| `.github/workflows/ci.yml` | `clawdfather/`: ruff + pytest + import check |

## Open threads

- Scope question: CheckClaude is a fact-checker only. The PRD lists
  "general-purpose X assistant" under *do not build*, so non-fact-check asks
  aren't routed anywhere.
- Claude Canvas is single-user and local by design — no auth, no server-side
  persistence. Boxes live in localStorage and nowhere else.

## Conventions

- Comments explain *why*, not what. Don't narrate the code.
- Tests assert behaviour that must not fail open, not implementation detail.
- Keep it small. The PRD's "do not build" list is real: no dashboard, no
  accounts, no analytics, no DB beyond dedupe.
