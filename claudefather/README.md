# A Slack Claude that hires Claudes

`@ClaudeFather` is a Claude Managed Agent whose job is hiring other Managed
Agents. Ask it for a teammate in plain English; it writes that teammate a soul,
creates its agent, gives it a Slack identity, and moves it into a channel. The
new teammate then works in Slack under its own name, listens in its home
channel, and keeps context per thread.

```
@ClaudeFather create Scout, a competitive-intelligence researcher.
              Have it live in #strategy and research competitors.

@Scout research Cursor's latest pricing and tell us how to position against it.
```

## How it works

```
Slack (one Socket Mode connection, on ClaudeFather's app)
  │   the router app holds channels:history, so it sees every message —
  │   including ones that mention a teammate. Teammate apps never listen.
  ▼
router.route()
  ├── from a bot?                → drop (loop guard)
  ├── mentions @ClaudeFather     → ClaudeFather agent + create_teammate tool
  ├── mentions @Scout            → Scout's agent, always responds
  ├── in Scout's home channel    → Haiku RESPOND/IGNORE gate, then maybe
  └── otherwise                  → drop
  ▼
Managed Agent session, one per Slack thread
  thread_ts ─────────────────────► session_id     (follow-ups keep context)
  ▼
posted back with that teammate's own bot token
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

## Setup

**1. Slack — one router app + a pool of teammate apps** (~5 minutes, once)

Follow [`slack/SETUP.md`](./slack/SETUP.md). You paste two manifests rather
than clicking scopes: [`slack/claudefather.manifest.yaml`](./slack/claudefather.manifest.yaml)
for the router app, and [`slack/teammate.manifest.yaml`](./slack/teammate.manifest.yaml)
three times for the identity pool.

Then `/invite @ClaudeFather` in every channel you'll demo in — it must be in a
channel to see its messages, and it invites the teammate bots itself.

**2. Configure and create the agents**

```bash
cd claudefather               # every command below runs from here
pip install -r requirements.txt
cp .env.example .env          # paste your Slack tokens + ANTHROPIC_API_KEY
python -m scripts.setup       # creates the environment + ClaudeFather agent
                              # paste the printed IDs back into .env
python -m app.slack           # start listening
```

`scripts/setup.py` is one-time. `app/slack.py` is the runtime — it never creates
an agent, only sessions.

## Demo

```
@ClaudeFather create Scout, a competitive-intelligence researcher.
              Have it live in #strategy and research competitors.

@ClaudeFather create Builder, a pragmatic staff engineer for #engineering.
              Terse, opinionated, always names the tradeoff.
```

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

`@ClaudeFather who works here?` lists the roster.

## Souls

Each teammate's charter is written to `souls/<name>.md` and becomes that agent's
`system` prompt. The file is the human-editable copy — check it into git, edit
it, and re-apply by re-hiring the same name, which calls `agents.update()` and
mints a new agent version rather than creating a second teammate.

## Files

```
app/
  config.py         env + the Slack identity pool
  prompts.py        every prompt: ClaudeFather, tool schemas, soul template, gate
  registry.py       JSON persistence: teammates, thread→session, slot claims
  managed_agent.py  Anthropic integration: create agents, run a session turn
  claudefather.py   the create_teammate / list_teammates tool handlers
  router.py         who owns this message (pure logic, no I/O)
  slack_client.py   Slack Web API helpers
  slack.py          Socket Mode listener — the runtime entrypoint
scripts/setup.py    ONE-TIME: environment + ClaudeFather agent
souls/              generated charters, checked in
data/registry.json  teammates + thread→session map (gitignored)
```

## Known limits

- **Bot renaming is best effort.** After hiring, the pooled app is renamed via
  `users.profile.set` so `@Scout` reads as Scout. If your workspace rejects that
  scope, messages still appear as *Scout* with Scout's emoji (via the
  `username` override) but `@`-autocomplete shows the pool app's name. Fix in
  10 seconds: api.slack.com → the app → Basic Information → Display Information.
- **Three teammates at a time** — the pool size. Re-hiring an existing name
  reuses its slot instead of consuming a new one.
- Two teammates sharing a home channel are gated in order; the first RESPOND
  answers, so they never both pile on.
- Registry is a JSON file, single process. Fine for a demo, not for production.
- No vaults are configured — there are no MCP servers or repo mounts, and Slack
  posting happens in this process, never inside the sandbox.
