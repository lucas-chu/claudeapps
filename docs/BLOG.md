# Three Claudes

*One idea, built three times — an infinite canvas, a fact-checker, and a Slack
agent that hires other agents. What separates them is not the model. It is which
API surface the model was reached through, and that turns out to be a product
decision rather than a technical one.*

Published version: an Artifact with the full layout. This file is the source.

```
RESPONDS              INVESTIGATES               PERSISTS
Messages API          Agent SDK                  Managed Agents
one turn              many turns, one run        many runs, one identity
▬▬▬▬▬                 ▰▰▰▰▰                      ██████
```

The axis is how long Claude's context is allowed to live. Everything else —
cost, latency, failure modes, what the product can promise — follows from where
you sit on it.

## The surface is the product decision

Every one of these three could technically have been built on any of the
surfaces. You can hand-roll an agent loop over the Messages API. You can drive a
canvas from a Managed Agent. The reason not to is that each surface makes one
thing cheap and another thing expensive, and the thing it makes cheap shows up
in the product as a behaviour a user can feel.

What follows is what each surface actually bought, and — more usefully — what
each one made me build by hand because it wasn't included.

---

## Claude responds — Claude Canvas

*An infinite canvas of draggable boxes that Claude writes into, with a chat panel
sharing the same conversation.*

| | |
|---|---|
| Surface | Messages API — `client.messages.stream()` |
| Model | claude-opus-5 |
| Tools | web_search (server-side), vision content blocks |
| Transport | SSE — delta · sources · error · done |
| Shape | Vite front end, small Node API server, single user, local |

The omnibar at the bottom does something different depending on what you have
selected, and that table is the whole product:

| Selection | What the prompt does |
|---|---|
| nothing | a new box is created and the answer streams into it |
| one text box | that box is rewritten in place |
| one image box | Claude answers *about* the image, into a new box |
| several boxes | their contents become context; the answer lands in a new box |

Boxes are not only prose. A **Draw** box is an Excalidraw surface, and selecting
one and prompting sends Claude a rendered preview of the sketch; markdown task
lists render as real checkboxes, nested ones included. Undo and redo cover box
edits — add, delete, move, resize, text — with one drag or one typing burst
counting as a single step, while streaming churn, panning and selection are
deliberately left out of the history.

No agent loop, no tool-calling harness, no session objects. One request, one
streamed reply, and the human decides what happens next by moving boxes around.
That is the Messages API's actual sweet spot: **the surface to reach for when the
human is the agent** and the model is doing one well-scoped piece of work per
turn.

> The interesting engineering wasn't in the API call. It was in everything
> around the API call that has to not lose your work.

### Two invariants hold the thing together

**All stored coordinates are world coordinates.** Screen space exists only inside
event handlers and is converted exactly once, in `canvas/geometry.ts`. Scattering
`* zoom` arithmetic through the codebase is precisely how this class of app
breaks subtly under zoom — you don't notice until a box lands somewhere
impossible at 40%.

**In-place rewrites go through a shadow buffer.** When you rewrite a box, the
streamed text accumulates separately and only replaces the box's contents on
success. A failed rewrite therefore cannot destroy text that was already on the
canvas. This is the single most important line of code in the project and it is
defensive, not generative.

### Two things I measured instead of assumed

The generation call carries a deliberately short parameter list, and both
omissions are load-bearing:

```ts
const stream = client.messages.stream({
  model: MODEL,
  max_tokens: MAX_TOKENS,
  messages,
  // No `effort` override: an A/B against the live API showed low effort
  // gave no measurable time-to-first-token win (9.1s vs 9.4-10.8s), so it
  // was only trading answer quality for nothing. Do not add a `thinking`
  // param either - disabling thinking on opus-5 makes tool calls leak as
  // plain text (web search would silently never run).
  tools: [webSearchTool],
})
```

The first is a negative result worth having: the obvious latency lever did
nothing, so it was left alone. The same file makes the opposite call one function
up — box titles *are* generated at `effort: 'low'`, because a 32-token label is
not a reasoning task. Same parameter, opposite decision, and both were argued
rather than defaulted. The second is a real failure mode — turning
thinking off doesn't just reduce reasoning, it changes how tool calls are
emitted, and web search quietly stops running. Search is *available*, never
forced; the model calls it only when the question needs current information, and
answers that used it come back with source chips.

### Failures the happy path won't show you

- **A refusal is a successful HTTP 200** with `stop_reason: 'refusal'` and empty
  or partial content. Treated naively you get a blank box and no explanation, so
  it is surfaced as an error.
- **The client can leave mid-stream.** A reload or closed tab aborts the stream
  rather than burning tokens against a dead socket.
- **The browser never holds the key.** It talks to three local routes; the key
  stays in the server process, and startup prints which source it came from —
  never the value.

237 unit tests cover the parts that are hard to eyeball: coordinate transforms,
the state reducer, request assembly, SSE parsing, and the markdown toolbar
actions, where every action is exactly reversible.

---

## Claude investigates — CheckClaude

*Reply to any post on X with "@CheckClaude is this true?" and it reads the claim
and its thread, researches it, and answers in plain prose with what it found and
where.*

| | |
|---|---|
| Surface | Claude Agent SDK — `query()` |
| Model | claude-opus-5, effort high |
| Tools | WebSearch, WebFetch — and nothing else |
| Contract | `submit_verdict`, an in-process MCP tool |
| Ends when | Claude calls that tool |

This is where the Agent SDK earns its keep. Fact-checking is genuinely
open-ended: how many searches a claim needs isn't knowable in advance, and a
fixed pipeline either wastes turns on easy claims or gives up on hard ones. So
the agent gets an *objective*, not a script. The only thing constrained is the
shape of the answer — the run ends when Claude calls `submit_verdict`, whose JSON
Schema is the verdict contract: one of five labels, plus the claim as understood,
the reasoning, and the sources.

> The prompt can ask Claude not to make up a citation. Only the code can
> guarantee it.

### Two guarantees that are structural, not prompted

**It can only search and fetch.** `tools=["WebSearch", "WebFetch"]` — no Bash, no
filesystem, and `setting_sources=[]` so no stray config on the host leaks into
the run. This agent reads attacker-controlled text off the open internet all day.
There is deliberately nothing for a prompt injection to reach for; post content
stays fenced and explicitly labelled untrusted.

**Citations are checked against reality.** URLs are harvested from tool *results*
and WebFetch *targets* only. URLs the model wrote in prose, or handed to
`submit_verdict`, are ignored on purpose — that is exactly the channel a
fabricated citation arrives on. An assertive verdict whose sources all fail that
check is downgraded to UNVERIFIABLE, and the prose says so rather than quietly
softening.

### And one that is just a refusal to post

If the agent never calls `submit_verdict` at all, the bot stays silent and
releases the mention. No fallback message, no hedged guess. Silence beats a
confident wrong answer, and building the silent path took more care than the
answering path did.

Attribution outlives the prose, too: the length ladder that fits a verdict into a
post has no rung that drops the sources. When links don't fit, it falls back to
publisher names and truncates the body instead.

---

## Claude persists — ClawdFather

*A Slack agent whose job is hiring other agents. Ask it for a teammate in plain
English; it writes that teammate a soul, creates its agent, gives it a Slack
identity, and moves it into a channel.*

| | |
|---|---|
| Surface | Managed Agents — agents, sessions, environments |
| Model | claude-opus-5, effort high |
| Tools | agent toolset + `create_teammate`, `list_teammates` |
| Gate | claude-haiku-4-5, structured output |
| Session | one per Slack thread |

Nothing in the codebase parses *"create Scout, a competitive-intelligence
researcher for #strategy"*. ClawdFather reads it, decides what Scout should be,
and calls `create_teammate` with the fields it chose. The handler does the
unglamorous half — claim a Slack identity, write `souls/scout.md`, create Scout's
agent, invite the bot to the channel — and hands a result string back.
ClawdFather reads that and writes the confirmation itself.

The reason this needs Managed Agents rather than a loop of your own: **Scout has
to still exist tomorrow.** Agents here are persisted, versioned objects created
once at hire time and referenced by ID forever. Editing `souls/scout.md` and
re-hiring the same name calls `agents.update()` and mints a new version rather
than a second teammate. Sessions are the per-run thing, one per Slack thread,
which is how a follow-up keeps context without you resending history.

### Three problems the surface didn't solve for me

**Threads need an owner, not just a session.** Keying sessions by thread alone
drops follow-ups outside a home channel — which is the exact conversation any
demo depends on. Threads now record who is speaking in them, so a bare *"what
about their enterprise tier?"* reaches Scout with no re-mention. And because a
session belongs to one agent, pulling a second teammate into Scout's thread opens
a fresh session instead of having Scout's brain answer under Builder's name and
avatar.

**Slack identities don't provision themselves.** Three pre-created Slack apps sit
in a pool; hiring claims one and renames it. One app holds the Socket Mode
connection and sees every message, including mentions of teammates; the teammate
apps never listen at all. Their tokens exist only so each teammate posts as
itself. That collapses "N apps each with a listener" into "one listener and N
tokens".

**Ambient listening needs a cheaper Claude.** A teammate hears every message in
its home channel. Opening a Managed Agent session — a real sandbox — per channel
message would be slow and expensive for a question that is almost always *no*.

> The most important Claude in this project is the one that isn't an agent.

So every home-channel message gets a single `claude-haiku-4-5` call with a strict
JSON schema instead: the teammate's charter, the last five messages, the new
message, out comes `{decision, reason}`. Only on RESPOND does the expensive path
open. Its prompt is tuned hard toward silence — respond when addressed by name,
or squarely inside the charter, or when something in its expertise is wrong in a
way worth correcting; ignore otherwise, and *otherwise is the common case*. Close
calls ignore. It fails closed, so an API error means silence. The stated reason in
the prompt is the honest one: a teammate that chimes in on everything gets muted.

### Personalities as files

Eight roles ship pre-written — chief of staff, competitive intel, data analyst,
fractional CFO, PM, recruiter, staff engineer, support triage — each a markdown
file with a little frontmatter and a soul body. ClawdFather's prompt carries only
the one-line summaries; it passes a slug and the full soul is loaded when the tool
runs. A ninth template costs one line of its context rather than a page. Anything
specific to a hire is appended rather than substituted, so *"a CFO, but we're
pre-revenue"* keeps the CFO.

---

## What the three have in common

Each project is defined less by what it generates than by what it refuses to do,
and in all three cases the refusal is enforced by code rather than requested in a
prompt.

| Project | The refusal | Enforced by |
|---|---|---|
| Claude Canvas | never destroy text already on the canvas | shadow buffer; commit only on success |
| CheckClaude | never cite a page it did not retrieve | URLs harvested from tool results only |
| ClawdFather | never speak up unless it should | a cheap gate that fails closed |

That pattern is not a coincidence of these three products. Once the generation
itself is good — and on opus-5 it mostly is — the remaining work is almost
entirely about bounding what happens when it isn't. The prompt is where you ask;
the architecture is where you guarantee.

### Choosing a surface

| Reach for | When | You will still build |
|---|---|---|
| Messages API | the human drives; one well-scoped turn at a time | streaming, state, undo, every failure path |
| Agent SDK | open-ended work whose length isn't knowable up front | the output contract, and the tool allowlist |
| Managed Agents | the thing must outlive the request and have a name | identity, routing, and a cheap gate in front |

The mistake I'd warn against is the one that looks like ambition: reaching for the
agentic surface because the product is impressive, when the model only needs one
turn. Claude Canvas would be slower, costlier and harder to reason about as a
Managed Agent, and it would not do a single thing more.

## What I'd fix next

- **Undo covers box edits only** — add, delete, move, resize, text, capped at
  50 steps. Chat messages and cleared threads are outside it, which is the one
  place the app can still lose something you meant to keep.
- **localStorage caps out around 8–9MB** — roughly 25–30 photos. Past that
  autosave stops and you get a toast, so the failure is visible; the canvas is
  then only as durable as the tab.
- **ClawdFather holds three teammates at a time**, because the identity pool is
  three pre-created Slack apps. Re-hiring a name reuses its slot; a fourth
  teammate needs a fourth app.
- **Bot renaming is best effort.** If a workspace rejects the profile scope,
  messages still show the teammate's name and emoji, but @-autocomplete shows the
  pool app's name.

---

Three projects, one repository: `claudecanvas/`, `checkclaude/`, `clawdfather/` —
separate dependencies, separate entrypoints, sharing nothing but an idea.
