# @CheckClaude

Fact-check anything on X by mentioning an agent.

Reply to any post with `@CheckClaude is this true?` — the same way you'd ask
anyone in a thread — and CheckClaude reads the claim and its context, researches
it with Claude and web tools, weighs the evidence, and replies in plain language
with what it found and where.

```
X post
"Data centers now consume 20% of US electricity."
        ↓
User replies: @CheckClaude is this true?
        ↓
mention → context builder → Claude Agent SDK → response guard → X reply
                                 │
                    search · fetch primary sources ·
                    compare evidence · form verdict
        ↓
@CheckClaude
No — US data centers used about 4.4% of national
electricity in 2023, not 20%. Even the 2030
projections top out near 12%.

eta.lbl.gov/publications/united-states-data-center-energy-2025
```

This is the Agent SDK project in the three-project sequence:

| | |
|---|---|
| Messages API | Claude **responds** |
| **Agent SDK** | **Claude investigates** |
| Managed Agents | Claude **persists** |

---

## How it works

```
                   X
                   │
          @CheckClaude mention
                   ▼
          ┌──────────────────┐
          │  Ingest          │  poll mentions (any tier)
          │  x_client.py     │  or filtered stream (Pro)
          └────────┬─────────┘
                   ▼
          ┌──────────────────┐
          │ Context Builder  │  parent post · thread ancestry
          │ context.py       │  linked URLs · prior check
          └────────┬─────────┘
                   ▼
          ┌──────────────────┐
          │ Claude Agent SDK │  identify claims · plan research
          │ agent.py         │  WebSearch · WebFetch · reconcile
          │ prompts.py       │  → submit_verdict (custom tool)
          └────────┬─────────┘
                   ▼
          ┌──────────────────┐
          │ Response Guard   │  citations · length · confidence
          │ verdict.py       │
          └────────┬─────────┘
                   ▼
              X Reply API
```

```
checkclaude/
├── main.py       # the loop: mention → context → agent → guard → reply
├── x_client.py   # listen_for_mentions() · get_post() · get_thread() · reply()
├── context.py    # build_context() · extract_links()
├── agent.py      # fact_check()  ← the Agent SDK lives here
├── prompts.py    # system instruction + objective
├── verdict.py    # verdict model + response guard
├── store.py      # sqlite dedupe + follow-up memory
└── config.py     # env
```

The loop really is this small:

```python
async for mention in client.listen_for_mentions():
    ctx    = await build_context(client, mention)
    run    = await fact_check(ctx)
    reply  = guard(run.fact_check, run.retrieved_urls, config.max_post_chars, config.reply_style)
    await client.reply(mention.id, reply.text)
```

### The agent gets an objective, not a script

`agent.py` hands Claude a goal and a research toolbox. It never says "search
Google three times" — how much investigation a claim deserves is the agent's
call. What we *do* constrain is the shape of the answer: the run ends when Claude
calls `submit_verdict`, an in-process MCP tool whose JSON Schema is the verdict
contract (verdict enum, claim, reply body, sources, confidence, internal notes).

Two properties are enforced structurally rather than by asking nicely:

- **Claude can only search and fetch.** `tools=["WebSearch", "WebFetch"]` removes
  every other built-in — no Bash, no filesystem. The agent reads
  attacker-controlled text off the open internet all day; there is nothing for a
  prompt injection to reach for. Post text is additionally fenced in `<<< >>>`
  and labelled as untrusted data.
- **Citations are checked against reality.** Every URL that comes back from a
  tool is recorded during the run. The guard drops any cited URL that never
  appeared in tool output — deliberately ignoring URLs the model merely *wrote*,
  since that is precisely the channel a hallucinated citation arrives on.

### The response guard

This product lives or dies on false confidence, so the last step before posting
is mechanical, not model-mediated:

| Check | Behaviour |
|---|---|
| Unknown verdict | Falls back to `UNVERIFIABLE` |
| Cited URL never retrieved | Stripped, and logged loudly |
| Assertive verdict with no surviving source | **Downgraded to `UNVERIFIABLE`** |
| Reply too long | Degrades in order: two links → one link → publisher names → truncate the prose at a sentence boundary |

There is deliberately no "drop the sources" rung — an unattributed reply is worse
than a slightly shorter one, so attribution outlives the last clause.

"No evidence → no verdict" is the downgrade rule. If the agent never submits a
verdict at all (timeout, crash, refusal to conclude), the bot **stays silent** and
releases the mention so the next pass can retry. Silence beats a confident guess.

X counts every link as 23 characters regardless of length, so the length check
emulates that rather than using `len()`.

### It answers like a person, not a form

The reply is plain prose that opens with the answer — no verdict banner, no
labels, no emoji. `prompts.py` has a **Voice** section that says so explicitly:
lead with the answer, don't restate the claim the reader can already see, don't
narrate your process, give the number rather than an adjective.

The verdict enum still exists — it just isn't printed. It is what drives the
guard's downgrade rule and what gets recorded in the store, and the agent is told
its prose must make the verdict obvious within the first few words:

```
No — US data centers used about 4.4% of national electricity in 2023, per
Berkeley Lab. Even the 2030 projections top out near 12%.

eta.lbl.gov/publications/united-states-data-center-energy-2025
```

Set `REPLY_STYLE=card` to get the labelled format from the PRD instead, which is
handy for showing both side by side:

```
⚠️ MISLEADING

US data centers used about 4.4% of national electricity in 2023, not 20%.

Sources: LBNL · EIA
```

### What the agent is told to weigh

`prompts.py` is where most of the intellectual value sits — it is the part worth
reading. In short:

- **Claim decomposition.** "OpenAI has 10M enterprise customers and is losing
  $20B/year" is two claims; research them separately, then form one verdict.
- **Primary-source preference.** An explicit evidence hierarchy, plus: trace a
  number back to where it actually came from and cite *that*, and read the URLs a
  post links — claims frequently misrepresent what they link to.
- **Temporal awareness.** Rankings, prices, "most-used", office-holders are
  time-sensitive; old evidence is not dispositive, and "true in 2024, not now" is
  usually the most useful answer.
- **Evidence disagreement.** Credible sources that genuinely disagree produce
  `UNVERIFIABLE` with the range and the reason, not a forced true/false.
- **Not-false categories.** Opinions are identified as opinions; predictions
  aren't false for not having happened yet; breaking events get explicit
  uncertainty; approximations that are roughly right are `MOSTLY TRUE`, not
  `FALSE`.

### Any phrasing triggers it

`is this true?`, `check this`, `fact check`, `source?`, `true?`, or a bare
`@CheckClaude` all work — the trigger is the mention, not a magic phrase. Leading
handles are stripped and whatever remains becomes the question the agent is asked
to answer, so `@CheckClaude where did this number come from?` gets researched as
that question rather than as a generic true/false.

### Follow-ups

If someone replies to one of CheckClaude's own verdicts (`@CheckClaude what about
Europe?`), the store resolves that reply id back to the previous check and passes
it in as prior context, so the agent answers the new question instead of
repeating itself.

---

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env       # then fill it in
```

The Agent SDK ships its own Claude Code CLI inside the pip package, so there is
nothing else to install — no Node, no `npm install -g`.

`.env` needs an `ANTHROPIC_API_KEY`, an X **bearer token** for reads, and the four
**OAuth 1.0a** values from the bot account's app for posting replies.

### A note on X API access

The PRD specifies the filtered stream, and `INGEST_MODE=stream` implements it —
persistent `@CheckClaude` rule, auto-reconnect with backoff, single-digit-second
delivery. **But filtered stream is Pro/Enterprise-only** and is not available on
the free, Basic, or current pay-per-use plans
([pricing](https://postproxy.dev/blog/x-api-pricing-2026/),
[X devcommunity](https://devcommunity.x.com/t/using-the-filtered-stream-endpoint-with-a-pro-subscription/234627)).

So the **default is `INGEST_MODE=poll`**: `GET /2/users/:id/mentions` on a 30s
interval with `since_id`, which works on every tier and costs a handful of reads
per minute. It trades a few seconds of latency for being demoable without a
$5,000/month subscription. Flip one env var if you have Pro.

Replies are capped at 280 characters by default. If the bot account has Premium,
set `MAX_POST_CHARS=25000` and the guard will stop compressing.

---

## Running

```bash
python main.py                  # the bot
python main.py --dry-run        # full loop, logs the reply, posts nothing
python main.py -v               # show every tool call

# Check one post without touching the mention stream — the demo rehearsal:
python main.py --once https://x.com/user/status/1234567890 --question "is this true?"
```

`--once` prints the reply plus the agent's internal notes, confidence, full
source URLs, and any guard warnings.

## Tests

```bash
pytest                          # 63 tests, no network, no API keys
python tests/smoke_agent.py     # real end-to-end agent run, no X API needed
```

The suite covers the parts that must not fail open: citation stripping, the
no-evidence downgrade, the length-degradation ladder in both reply styles,
trigger detection across all the accepted phrasings, thread walking,
prompt-injection fencing, restart-safe dedupe, and the negative cases in URL
harvesting — model-authored text and `submit_verdict`'s own claimed sources must
never self-certify.

`smoke_agent.py` runs the real Agent SDK against a synthetic post, so you can
exercise the whole research → verdict → guard path before pointing it at X. It
prints a per-tool breakdown (`WebSearch 12, WebFetch 9 (9 failed)`) so a blocked
egress path shows up as a warning rather than as quietly weaker sourcing:

```bash
python tests/smoke_agent.py "Claude is the most-used model on OpenRouter." "is this true?"
```

## Demo

1. Find an interesting factual claim on X.
2. Reply `@CheckClaude is this true?`
3. Wait.
4. CheckClaude replies publicly with verdict + explanation + sources.
5. Open one source and show it actually supports the answer.

Run with `-v` on a second screen to show the research loop as it happens.

## Deliberately not built

No website, dashboard, accounts, analytics, feed, voting, moderation system, or
Community Notes clone. The database is one sqlite table doing dedupe. The
artifact is about the Claude Agent SDK, not about building an X startup.
