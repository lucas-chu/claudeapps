# anthropic-interview

Take-home: three projects on one spine — **Messages API** (Claude responds) →
**Agent SDK** (Claude investigates) → **Managed Agents** (Claude persists).

All three are built. They are sibling directories and share nothing — separate
dependencies, separate entrypoints, and separate `.env` files for the two that
need one (Claude Canvas doesn't; its key is supplied by the visitor at runtime).
Run every command from inside the project directory, never from the repo root.

| Project | Where | What |
|---|---|---|
| Messages API | `claudecanvas/` | Claude Canvas — a static browser app; an infinite canvas of boxes Claude writes into |
| Agent SDK | `checkclaude/` | X bot that fact-checks any post you reply to with `@CheckClaude is this true?` |
| Managed Agents | `clawdfather/` | `@ClawdFather`, a Slack agent that hires other agents |

Each project's own README is its authoritative doc; the root `README.md` is only
an index. The sections below are per-project; anything after **Repo-wide**
applies to all three.

---

# Claude Canvas — `claudecanvas/`

## Commands

```bash
cd claudecanvas
npm install

npm run dev               # Vite on :5173. That's the whole stack.
npm test                  # 257 unit tests, no network, no API key
npm run typecheck
npm run build             # -> dist/, deployable to any static host
npm run preview           # serve the production build
```

`npm test` is the fastest signal. There is no `.env` and no server — the user
pastes their own API key into the app at runtime.

## Architecture

```
src/App.tsx           wiring: keyboard, selection, undo/redo, view reset/fit
src/Omnibar.tsx       the prompt bar — behaviour depends on what's selected
src/ApiKeyDialog.tsx  key entry: validation, verification, storage scope
src/api/              stream.ts (Anthropic calls) · sources.ts (web-search cites)
src/canvas/           geometry.ts · Canvas · TextBox · DrawingBox (Excalidraw)
src/chat/ChatPanel.tsx  the thread — the same one the canvas prompts against
src/state/            types · store (reducer) · history (undo) · context (request
                      assembly) · persist (localStorage) · apiKey (the user's key)
src/useGeneration.ts  every generation path funnels through here
```

There is no server. The browser calls the Anthropic API directly via the SDK's
`dangerouslyAllowBrowser` mode, which also makes it send the
`anthropic-dangerous-direct-browser-access` header the API requires.

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
4. **The key is the user's, and only ever goes to Anthropic.** It is entered at
   runtime, kept in `sessionStorage` (default) or `localStorage`, and read only
   by `state/apiKey.ts`. Never bundle a key, never send one anywhere but
   `api.anthropic.com`, never log or render it — `maskApiKey` exists for that.
   This *replaced* the old server-side-key invariant when the app went static;
   don't reintroduce a backend that receives other people's keys.
5. **Model is `claude-opus-5`, and the sampling params stay off.** Don't send
   `temperature`, `top_p`, `top_k`, or a `thinking` param. Disabling thinking on
   opus-5 makes tool calls leak as plain text — web search silently never runs.

## Environment notes

- Deploys as static files (`dist/`). `vercel.json` and `netlify.toml` are
  checked in; neither needs an environment variable, because there are none.
- HEIC is unsupported and says so — no browser decodes it, and the `sips`-based
  converter died with the server. Don't reach for the WASM decoder that
  preceded it; it rejected real iPhone photos.
- `MAX_TURNS = 6` — history caps at the last six turns. Full box contents come
  from selection instead, so history stays cheap.
- localStorage caps around 8–9MB (~25–30 photos). Past that `save()` returns
  false and `App.tsx` raises a toast — don't let a refactor drop that return
  value on the floor and make the failure silent again.
- The project was called **Cove Canvas** until it was renamed. `load()` still
  falls back to the `cove-canvas:v1` localStorage key, and `save()` clears it
  only once the new key is written; this has tests. The archived docs under
  `docs/superpowers/` keep the old names, and describe the original
  server-backed design rather than the current static one.
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
- Claude Canvas has no accounts and no server-side persistence. Boxes live in
  the visitor's own localStorage and nowhere else, so the deployed app is
  many independent single-user canvases, not a shared one.

## Conventions

- Comments explain *why*, not what. Don't narrate the code.
- Tests assert behaviour that must not fail open, not implementation detail.
- Keep it small. The PRD's "do not build" list is real: no dashboard, no
  accounts, no analytics, no DB beyond dedupe.
