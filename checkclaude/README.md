# @CheckClaude

Fact-check anything on X by mentioning an agent.

Reply to any post with `@CheckClaude is this true?` — the same way you'd ask
anyone in a thread — and CheckClaude reads the claim and its context, researches
it with Claude and web tools, weighs the evidence, and replies in plain language
with what it found and where. Or DM it the post instead, and the answer comes
back privately, in full.

```
X post
"Data centers now consume 20% of US electricity."
        ↓
User replies: @CheckClaude is this true?
        ↓
mention or DM → context builder → Claude Agent SDK → response guard → answer
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
     @CheckClaude mention   ·   DM to @CheckClaude
                   ▼
          ┌──────────────────┐
          │  Ingest          │  poll mentions (any tier)
          │  x_client.py     │  or filtered stream (Pro)
          │                  │  + poll dm_events
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
     public reply thread   ·   private DM
```

```
checkclaude/
├── main.py       # the loops: request → context → agent → guard → answer
├── x_client.py   # listen_for_mentions() · listen_for_dms() · reply_thread() · send_dm()
├── context.py    # build_context() · build_dm_context() · extract_links()
├── agent.py      # fact_check()  ← the Agent SDK lives here
├── prompts.py    # system instruction + objective + investigator brief
├── verdict.py    # verdict model + response guard + the three renderings
├── store.py      # sqlite dedupe (per channel) + follow-up memory
└── config.py     # env
```

The loop really is this small:

```python
async for mention in client.listen_for_mentions():
    ctx    = await build_context(client, mention)
    run    = await fact_check(ctx)
    reply  = guard(run.fact_check, run.retrieved_urls, config.max_post_chars,
                   config.reply_style, config.thread_posts)
    await client.reply_thread(mention.id, reply.posts)
```

And the private one is the same four steps with a different last line:

```python
async for dm in client.listen_for_dms():
    ctx    = await build_dm_context(client, dm)
    run    = await fact_check(ctx)
    reply  = guard(run.fact_check, run.retrieved_urls, config.max_dm_chars, config.reply_style)
    await client.send_dm(dm.conversation_id, reply.long_form(config.max_dm_chars))
```

### The agent gets an objective, not a script

`agent.py` hands Claude a goal and a research toolbox. It never says "search
Google three times" — how much investigation a claim deserves is the agent's
call. What we *do* constrain is the shape of the answer: the run ends when Claude
calls `submit_verdict`, an in-process MCP tool whose JSON Schema is the verdict
contract (verdict enum, claim, reply body, sources, confidence, internal notes).

### One investigator per claim

"OpenAI has 10M enterprise customers and is losing $20B a year" is two
investigations wearing one sentence. A single agent researches them one after the
other in one context, and the second one gets the attention the first left over.

So when the lead agent decomposes a post into two or more independent claims, it
dispatches an **investigator subagent per claim, in one batch, and they research
in parallel**. Each investigator is a researcher with the same web tools and none
of the lead's context - it sees only the brief it was written. It reports what the
evidence says and the URLs it opened; it does not issue a verdict and does not
write the reply. The lead weighs the findings against each other and forms the
single answer.

```
                     lead agent
                  decomposes the post
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
  investigator      investigator      investigator
  "share of US      "revenue growth   "the 2030
   electricity"      in FY24"          projection"
        │                 │                 │
        └─────────────────┼─────────────────┘
                          ▼
              lead synthesises → submit_verdict
```

Two details that matter more than the parallelism:

- **The brief is written by the lead, in its own words.** Investigators never see
  the post. Anything hostile embedded in the text stops at the agent that already
  knows it is untrusted, instead of being forwarded to three more agents.
- **Sources are attributed per sub-claim**, and each sub-claim's citations are
  verified on their own. A well-sourced half cannot vouch for an unsourced one -
  see the guard table below.

Fan-out costs a minute or two, so a single narrow claim is researched directly.
`CHECKCLAUDE_FANOUT=false` restores the single-agent path.

Two properties are enforced structurally rather than by asking nicely:

- **Claude can only search and fetch.** `tools=["WebSearch", "WebFetch"]` removes
  every other built-in — no Bash, no filesystem. The agent reads
  attacker-controlled text off the open internet all day; there is nothing for a
  prompt injection to reach for. Post text is additionally fenced in `<<< >>>`
  and labelled as untrusted data. Delegation adds exactly one tool to the lead,
  and investigators get `["WebSearch", "WebFetch"]` and nothing else — no verdict
  tool, and no delegation tool of their own, so the fan-out is one level deep by
  construction.
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
| Any assertive **sub-claim** with no surviving source | **Downgraded to `UNVERIFIABLE`**, and the prose says which part |
| Answer longer than one post | Split into a numbered thread at sentence boundaries, sources on the last post |
| Answer longer than the whole thread | DMed in full to whoever asked, and the last post says so — only if the DM was delivered |
| Still too long | Degrades in order: two links → one link → publisher names → truncate the prose at a sentence boundary |

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

### The answer is as long as it needs to be

280 characters is a property of a post, not of an answer. "US data centers use 20%
of electricity and Ireland's use more than its homes" is two claims with two
provenances and two dates, and compressing that into one post means dropping the
part that makes it checkable — which number came from where.

So an answer worth more than one post is **posted as a numbered self-reply
thread**. The agent writes one continuous answer and never numbers anything
itself; `verdict.py` packs it into posts at sentence boundaries, puts the counter
at the end of the prose and the sources on the final post.

```
No — US data centers used about 4.4% of national electricity in 2023. That is
roughly 176 TWh out of just under 4,000 TWh nationally. The 20% figure appears
to come from a projection for a single grid region. (1/2)

Berkeley Lab puts 2028 consumption between 6.7% and 12% of the national total.
Regional concentration is the part that holds up: Northern Virginia really does
run above 25% of its local load. (2/2)

eta.lbl.gov/publications/2024-united-states-data-center-energy
```

Two constraints shape this more than the splitting does:

- **The first post still has to work alone.** Most readers of a thread read one
  post of it, so the agent is told the opening sentence must carry the whole
  answer, and the guard's downgrade hedge is prepended to the body — which puts it
  in post 1, where a hedge is worth having.
- **The budget is a ceiling, not a target.** The agent is told exactly that. A
  claim that is simply false still gets two sentences.

The thread cap is four posts (`CHECKCLAUDE_MAX_THREAD_POSTS`), and past it the
old ladder still applies. `CHECKCLAUDE_THREAD_REPLIES=false` restores single-post
replies exactly as they were.

### Asking privately

DM `@CheckClaude` a post link — or just the claim in your own words — and the
check runs identically. The answer comes back **in that DM and nowhere else**:
someone who asked privately did not ask for a public post about it, so the DM
route never touches the reply API.

A DM can carry the claim three ways, tried most-specific first: a post shared into
the conversation, a permalink pasted into the text, or the text itself. The pasted
link is stripped out of the question, since it says *which post*, not *what is
being asked*. A DM with nothing checkable in it gets a one-line "send me a link or
a claim" — in public a non-answer is invisible, but in a DM silence just looks
broken.

What the private channel actually buys is attribution, not length. With 10,000
characters and no thread to ration, the reply carries the per-sub-claim breakdown
the guard already verified — each part, what the evidence said, and the sources
for *that part*:

```
No — the first half is wrong and the second is right. US data centers used about
4.4% of national electricity in 2023, not 20%. Ireland is the real case: its data
centres used 21% of metered electricity in 2023, more than all urban dwellings.

What I checked:
- share of US electricity: 176 TWh in 2023, about 4.4% of the national total
  LBNL https://eta.lbl.gov/publications/2024-united-states-data-center-energy
- Ireland vs urban homes: 21% versus 18% of metered consumption in 2023
  CSO https://www.cso.ie/en/releasesandpublications/ep/p-dcmec/

Sources:
LBNL https://eta.lbl.gov/publications/2024-united-states-data-center-energy
CSO https://www.cso.ie/en/releasesandpublications/ep/p-dcmec/
```

The guard is unchanged by the audience — same citation check, same downgrade rule.
A smaller readership is not a lower evidence bar, and the DM rendering is built
from the guarded verdict, so a citation that was never retrieved is missing here
too, and the sub-claim it was supposed to support says so.

DMs are polled from `GET /2/dm_events` (there is no `since_id` on that endpoint,
so the cursor is applied to the ids client-side), and the bot's own messages are
filtered out at the source — they land in the same feed, and answering them would
be an infinite loop with a bill attached. `CHECKCLAUDE_DM=false` turns the channel
off.

### When the thread isn't enough either

If an answer overruns even the thread cap, the unabridged version is DMed to
whoever asked, and the last public post points at it. The pointer is **only**
added once the DM has actually been delivered: plenty of accounts refuse DMs from
strangers, and promising a DM that never arrives is worse than a shorter answer.
The pointer is also budgeted rather than appended — the case that triggers it is
exactly the case where the last post is already full, so a line of prose gives way
instead of the pointer silently failing to fit.

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
repeating itself. Every post of a thread is recorded, not just the first, because
readers reply to whichever post they happen to be looking at.

DMs have no reply-to id to walk, so there the conversation *is* the thread: the
last answer given in it is the prior context for the next question in it.

---

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env       # then fill it in
```

The Agent SDK ships its own Claude Code CLI inside the pip package, so there is
nothing else to install — no Node, no `npm install -g`.

`.env` needs an `ANTHROPIC_API_KEY`, an X **bearer token** for reads, and the four
**OAuth 1.0a** values from the bot account's app for posting replies. The DM
channel uses the same OAuth 1.0a credentials — there is no app-only view of an
inbox — so the app needs **dm.read** and **dm.write** on top of the read/write
scopes. Without them, set `CHECKCLAUDE_DM=false` and the mention channel runs on
its own.

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

`CHECKCLAUDE_FANOUT=false` turns off the investigator fan-out and runs the whole
check in one agent — quicker and cheaper, weaker on multi-part claims.

Replies are capped at 280 characters per post by default, and four posts per
answer. If the bot account has Premium, set `MAX_POST_CHARS=25000` and the guard
will stop compressing — threading then almost never triggers, which is the point:
it exists to work around a limit, not because threads are good.

DMs are polled every 60s (`DM_POLL_SECONDS`) and capped at 10,000 characters
(`MAX_DM_CHARS`), which is X's own DM limit.

---

## Running

```bash
python main.py                  # the bot: mentions and DMs
python main.py --no-dm          # mentions only
python main.py --dry-run        # both loops, logs the answers, sends nothing
python main.py -v               # show every tool call

# Check one post without touching either feed — the demo rehearsal:
python main.py --once https://x.com/user/status/1234567890 --question "is this true?"
python main.py --once https://x.com/user/status/1234567890 --dm   # the private version
```

`--once` prints the reply — every post of it, numbered, plus the overflow DM if
there would have been one — followed by the agent's internal notes, confidence,
full source URLs, and any guard warnings. `--dm` prints the unabridged private
answer instead, which is the quickest way to see the sub-claim breakdown.

## Tests

```bash
pytest                          # 125 tests, no network, no API keys
python tests/smoke_agent.py     # real end-to-end agent run, no X API needed
```

The suite covers the parts that must not fail open: citation stripping, the
no-evidence downgrade, the length-degradation ladder in both reply styles,
trigger detection across all the accepted phrasings, thread walking,
prompt-injection fencing, restart-safe dedupe, the negative cases in URL
harvesting — model-authored text and `submit_verdict`'s own claimed sources must
never self-certify — and the fan-out rules: a sourced sub-claim may not vouch for
an unsourced one, and an investigator's tool surface may not exceed the lead's.

The two channels add their own must-nots. Threading may change how much room the
answer has and nothing else: single-post mode is asserted byte-identical to the
pre-thread rendering, every post fits, splits land on sentence boundaries, sources
stay on the last post, and the downgrade hedge stays in the *first* one. The DM
route must never write to the public reply API, must not be given a laxer guard by
its bigger budget, must not promise a DM that bounced, and must keep its cursor
out of the mention cursor — both are snowflake ids, and pooling them would have a
busy inbox silently rewinding the mention feed.

`smoke_agent.py` runs the real Agent SDK against a synthetic post, so you can
exercise the whole research → verdict → guard path before pointing it at X. It
prints a per-tool breakdown (`WebSearch 12, WebFetch 9 (9 failed)`) so a blocked
egress path shows up as a warning rather than as quietly weaker sourcing:

```bash
python tests/smoke_agent.py "Claude is the most-used model on OpenRouter." "is this true?"
```

## Demo

1. Find an interesting factual claim on X — ideally one making two claims at once.
2. Reply `@CheckClaude is this true?`
3. Wait.
4. CheckClaude replies publicly with the answer, its reasoning, and its sources,
   as a numbered thread if the claim earned one.
5. Open one source and show it actually supports the answer.
6. Now DM the same post to `@CheckClaude`. The same check comes back privately,
   with the per-sub-claim breakdown and every source — and nothing about it is
   posted publicly.

Run with `-v` on a second screen to show the research loop as it happens.

## Deliberately not built

No website, dashboard, accounts, analytics, feed, voting, moderation system, or
Community Notes clone. The database is dedupe and a reply-id index, and nothing
else. The artifact is about the Claude Agent SDK, not about building an X startup.
