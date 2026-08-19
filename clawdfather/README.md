# A Slack Claude that hires Claudes

`@ClawdFather` is a Claude Managed Agent whose job is hiring other Managed
Agents. Ask it for a teammate in plain English; it writes that teammate a soul,
creates its agent, gives it a Slack identity, and moves it into a channel. The
new teammate then works in Slack under its own name, listens in its home
channel, and keeps context per thread.

There's no cap on how many teammates you hire — typically one per channel.
A small pool of Slack identities is shared across all of them, and teammates
can pull each other into a conversation with `message_teammate` when a
question is really someone else's lane.

```
@ClawdFather create Scout, a competitive-intelligence researcher.
             Have it live in #strategy and research competitors.

@Scout research Cursor's latest pricing and tell us how to position against it.
```

## How it works

```
Slack (one Socket Mode connection, on ClawdFather's app)
  │   the router app holds channels:history, so it sees every message —
  │   including ones that mention a teammate. Teammate apps never listen.
  ▼
router.route()
  ├── bot / join / edit?         → drop (loop guard + noise filter)
  ├── mentions @ClawdFather      → ClawdFather agent + create_teammate tool
  ├── mentions @Scout            → Scout's agent, always responds
  ├── mentions someone we don't
  │     own                      → drop (a human, or another app such as
  │                                @Claude — it is addressed to them)
  ├── reply in a thread Scout
  │     already owns             → Scout — no mention needed
  ├── in Scout's home channel    → Haiku RESPOND/IGNORE gate, then maybe
  └── otherwise                  → drop
  ▼
Managed Agent session, one per Slack thread
  thread_ts ───────────────────► session_id + owner   (follow-ups keep context)
  ▼
Scout can call message_teammate → Builder answers inline, visibly, under its own name
  ▼
posted back with that teammate's own bot token, split into multiple messages if long
```

**Three Anthropic objects, and only one is per-teammate.**

| | What | Count |
|---|---|---|
| Environment | shared `cloud` sandbox, unrestricted egress | 1, reused |
| Agent | `name` + `system` (the soul) + `agent_toolset_20260401` | 1 per teammate |
| Session | one per Slack thread | ephemeral |

Agents are persistent, versioned objects — created once at hire time, never in
the message path. Sessions are where the per-thread work happens.

**Why the ambient gate is not an agent.** Every message in a home channel gets a
`claude-haiku-4-5` classification call with the teammate's soul and the last few
messages. Spinning up a Managed Agent session per channel message would be slow
and expensive; we only open a session once the gate says RESPOND.

**Why one listener, not three.** Teammate Slack apps exist only to be
`@mentionable` and to post as themselves. They have no Socket Mode connection
and no event subscriptions. That collapses "N apps each with a listener" into
"1 listener + N tokens".

**A thread records its owner, not just its session.** Once Scout has answered in
a thread, a bare `what about their enterprise tier?` reaches Scout — no
re-mention, in any channel. Without this, follow-ups outside a home channel are
silently dropped, which is exactly the conversation the demo depends on.

## Setup

**1. Slack — one router app + a pool of teammate apps** (~5 minutes, once)

Follow [`slack/SETUP.md`](./slack/SETUP.md). You paste two manifests rather
than clicking scopes: [`slack/clawdfather.manifest.yaml`](./slack/clawdfather.manifest.yaml)
for the router app, and [`slack/teammate.manifest.yaml`](./slack/teammate.manifest.yaml)
three times for the identity pool.

Then `/invite @ClawdFather` in every channel you'll demo in — it must be in a
channel to see its messages, and it invites the teammate bots itself.

**2. Configure and create the agents**

```bash
cd clawdfather
pip install -r requirements.txt
cp .env.example .env          # paste your Slack tokens + ANTHROPIC_API_KEY
python -m scripts.setup       # creates the environment + ClawdFather agent
                              # paste the printed IDs back into .env
python -m app.slack           # start listening
```

`scripts/setup.py` is one-time. `app/slack.py` is the runtime — it never creates
an agent, only sessions.

**Before you demo, run the preflight:**

```bash
python -m scripts.doctor
```

It checks the things that only fail at runtime and prints the fix for each:
every token actually authenticates, each teammate's token and user ID come from
the *same* app (an easy copy-paste mixup), the granted scopes include the ones
routing depends on, ClawdFather is actually in your demo channels, and the
agent and environment IDs in `.env` still resolve.

## Demo

```
@ClawdFather create Scout, a competitive-intelligence researcher.
             Have it live in #strategy and research competitors.

@ClawdFather create Builder, a pragmatic staff engineer for #engineering.
             Terse, opinionated, always names the tradeoff.
```

Or hire from a base personality — `@ClawdFather we need a fractional CFO in
#strategy` — which skips writing a soul and starts from `templates/fractional-cfo.md`.


Then in `#strategy`:

```
@Scout research Cursor's current pricing tiers and tell us how we should
       position against them.
```

…and a follow-up **in the same thread** — `what about their enterprise tier?` —
which continues the same session, so Scout still has its research.

Then post in `#strategy` without mentioning anyone. Something on-charter
(`are we losing deals on price?`) gets a reply; `anyone up for lunch?` does not.
Ask Builder the same question to show two different souls answering differently.

`@ClawdFather who works here?` lists the roster.

## Teammates as coworkers

Every hired teammate gets two more tools besides general browsing:

- **`message_teammate`** — loop another teammate into the thread by name.
  Both sides post visibly, under their own names, so it reads like two
  coworkers talking; the caller also gets the reply back to use in its own
  answer. Delegation chains are capped at a few hops so two teammates can't
  loop each other forever.
- **`add_reaction`** — react to the message it's answering with one emoji,
  the way a coworker would (sparingly, not on every message).

Teammates are also told to write like a coworker rather than a form: emoji in
the text where they fit, a GIF link pasted on its own line (found via their
own browsing — Slack unfurls it into a preview automatically), and no need to
compress a long answer to fit one message — replies longer than a comfortable
Slack message are posted as several in a row instead of being cut off.

## Souls

Each teammate's charter is written to `souls/<name>.md` and becomes that agent's
`system` prompt. The file is the human-editable copy — check it into git, edit
it, and re-apply by re-hiring the same name, which calls `agents.update()` and
mints a new agent version rather than creating a second teammate.

## Base personalities

The common roles are pre-written, in [`templates/`](./templates). Each is a
markdown file: a little frontmatter (default name, role, emoji, one-line
summary) and a soul body.

```
chief-of-staff    Atlas     decisions, owners and dates out of sprawling threads
competitive-intel Scout     primary sources, dated claims, and what to do about them
data-analyst      Delta     metric answers with the caveats attached
fractional-cfo    Ledger    runway, burn, pricing, unit economics
pm                Compass   the user problem before the solution
recruiter         Sourcer   scorecards and outreach people answer
staff-engineer    Builder   terse technical judgement, always names the tradeoff
support-triage    Frontline reproduce, scope, route
```

ClawdFather only ever sees the one-line summaries — it passes a slug and the
full soul is loaded handler-side, so adding a ninth template costs one line of
its context, not a page. Anything specific to a hire goes in `instructions` and
is appended under `## For this hire`:

```
@ClawdFather hire a fractional CFO for #strategy. We're pre-revenue with
             18 months of runway — call him Ledger.
```

Explicit `name`, `role` and `emoji` override the template's defaults, and a hire
with no template at all still works: ClawdFather writes the soul from scratch.
Add a template by dropping a file in `templates/` — nothing else to register.

## Files

```
app/
  config.py         env + the Slack identity pool
  prompts.py        every prompt: ClawdFather, tool schemas, soul template, gate
  registry.py       JSON persistence: teammates (by name), thread→session+owner, slots
  managed_agent.py  Anthropic integration: create agents, run a session turn
  clawdfather.py    the create_teammate / list_teammates tool handlers
  teammate.py       the message_teammate / add_reaction tool handlers
  templates.py      loads templates/*.md, builds ClawdFather's catalog
  router.py         who owns this message (pure logic, no I/O)
  slack_client.py   Slack Web API helpers
  slack.py          Socket Mode listener — the runtime entrypoint
scripts/setup.py    ONE-TIME: environment + ClawdFather agent
scripts/doctor.py   preflight: tokens, scopes, channels, agent IDs
tests/              pytest suite (no network, no credentials)
templates/          base personalities: frontmatter + soul body
souls/              generated charters, checked in
data/registry.json  teammates + thread→session map (gitignored)
```

## Tests

```bash
pip install pytest ruff && pytest tests -q
```

82 tests, no network and no credentials: the routing table, the loop guard and
noise filter, thread ownership and follow-up routing (now by teammate name, so
a shared Slack identity never confuses a follow-up), session reuse and
handover, least-loaded slot assignment once teammates outnumber identity
apps, `message_teammate`/`add_reaction` dispatch and delegation-depth limits,
registry persistence including legacy-format and corrupt-file recovery, and
template loading plus how a hire request resolves against one. CI runs these
plus `ruff` and an import check on every PR.

## Known limits

- **Bot renaming is best effort, and only reflects the latest hire on a
  shared identity.** After hiring, the pooled app is renamed via
  `users.profile.set` so `@Scout` reads as Scout. Every teammate still posts
  under its own name and emoji via the `username` override regardless — only
  `@`-autocomplete shows whichever teammate most recently renamed that slot.
  Fix in 10 seconds: api.slack.com → the app → Basic Information → Display
  Information.
- **A shared identity can't be `@`-mentioned from outside all of its
  teammates' home channels.** Once teammates outnumber identity apps, several
  share one Slack user ID; a mention of it is only unambiguous inside one of
  their home channels (or in a thread that already has an owner), so it's
  dropped elsewhere rather than guessed.
- **`message_teammate` exchanges are ephemeral.** Each one opens its own
  throwaway session rather than reusing either teammate's thread session, so
  it doesn't carry memory from one delegation to the next.
- Two teammates sharing a home channel are gated in order; the first RESPOND
  answers, so they never both pile on.
- Registry is a JSON file, single process. Fine for a demo, not for production.
- No vaults are configured — there are no MCP servers or repo mounts, and Slack
  posting happens in this process, never inside the sandbox.
