# Three Claudes — video script

**Runtime:** 3:20 target. A 90-second cut is marked at the end.
**Format:** screen recording, voiceover, no face cam needed.
**Tone:** show first, explain underneath. Never narrate what the viewer can already see.

**Before you record**

- Three windows staged and pre-warmed: Claude Canvas at `localhost:5173`, a terminal for CheckClaude, Slack with `#strategy` and `#engineering` open.
- Run `python -m scripts.doctor` in `clawdfather/` until it is all green. Do not record until it is.
- Clear the canvas and the Slack channels of previous runs.
- Opus takes several seconds before the first token. **Do not cut those pauses out of the Slack demo** — they are the honest latency. Do cut them from the Canvas demo, where you have four prompts to get through.
- Record everything at 1440p or better; Slack text is small.

---

## 0:00 — 0:18 · Cold open

**SCREEN:** Claude Canvas, one empty box in the middle of a blank canvas. Type into the omnibar and let the answer stream in. No talking over the first three seconds — let the text arrive.

**VO:**
> Same model, three products, three completely different ways of reaching it.
>
> This one is the plain Messages API. One request, one streamed answer. The human is the agent — I decide what happens next by moving boxes around.

**ON SCREEN TEXT:** `Claude Canvas · Messages API`

---

## 0:18 — 1:00 · Claude Canvas

**SCREEN — run these four in order, they are the whole product:**

1. Nothing selected → prompt → *a new box appears and streams.*
2. Select that box → prompt "tighten this to three sentences" → *it rewrites in place.*
3. Drag in a photo, select it → prompt "what's in this?" → *answer lands in a new box.*
4. Marquee-select three boxes → prompt "what do these have in common?" → *their contents become context.*
5. **Draw** → sketch a rough box-and-arrow diagram → select it → prompt "what's wrong with this architecture?" → *Claude answers about the drawing.*

**VO:**
> The omnibar does something different depending on what's selected. Nothing selected, you get a new box. One box selected, that box gets rewritten in place. An image, and Claude answers about the image. Several, and their contents become the context.
>
> That's four behaviours from one text field, and none of it needs an agent loop.
>
> Sketches count too — a drawing box goes to Claude as a rendered preview, so you can point at a diagram and ask what's wrong with it.

**SCREEN:** hover an answer that used search so the source chips show.

**VO:**
> Search runs when a question needs current information — not on every prompt. Answers that used it show where they came from.

**VO — over the in-place rewrite, replayed or slowed:**
> The rewrite is the risky one. The streamed text accumulates in a shadow buffer and only replaces what's in the box if the whole thing succeeds. A failed rewrite can't destroy text that was already on the canvas.

**ON SCREEN TEXT:** `in-place rewrite → shadow buffer → commit on success only`

---

## 1:00 — 1:50 · CheckClaude

**SCREEN:** the X post you're checking, then cut to the terminal running
`python main.py --once <post-url>`. Let the tool lines scroll — WebSearch, WebFetch, the counts.

**VO:**
> Second project, second surface. This is the Agent SDK, and it's a fact-checker on X. Reply to any post with "@CheckClaude is this true?"
>
> Fact-checking is genuinely open-ended — you can't know up front how many searches a claim needs. So the agent gets an objective, not a script. It searches, it reads, it decides when it's done.

**SCREEN:** the verdict printing, with its label and sources.

**VO:**
> The run ends when Claude calls `submit_verdict` — an in-process tool whose schema *is* the contract. One of five labels, the claim as understood, the reasoning, the sources.

**SCREEN:** open `agent.py`, highlight the `tools=["WebSearch", "WebFetch"]` line, then `_harvest_urls`.

**VO:**
> Two things here are enforced by code, not by asking nicely in a prompt.
>
> One: it can only search and fetch. No shell, no filesystem. This thing reads attacker-controlled text off the open internet all day — there's deliberately nothing for a prompt injection to reach for.
>
> Two: citations get checked against reality. URLs are harvested from tool *results* only. URLs the model typed into its answer are ignored on purpose — that's exactly the channel a made-up citation arrives on. If every source fails that check, the verdict is downgraded to UNVERIFIABLE and it says so.

**VO — beat, then:**
> And if the agent never submits a verdict at all, the bot just doesn't post. Silence beats a confident guess.

**ON SCREEN TEXT:** `no evidence → no verdict · no verdict → no reply`

---

## 1:50 — 2:55 · ClawdFather

**SCREEN:** Slack, `#strategy`. Type the hire live.

```
@ClawdFather create Scout, a competitive-intelligence researcher.
             Have it live in #strategy and research competitors.
```

**VO — while it thinks, don't fill the silence too fast:**
> Third surface: Managed Agents. This is a Slack agent whose job is hiring other agents.
>
> Nothing in my code parses that sentence. ClawdFather reads it, decides who Scout should be, and calls a `create_teammate` tool. My handler does the boring half — claims a Slack identity, writes Scout a soul file, creates Scout's agent, invites the bot to the channel.

**SCREEN:** Scout appears in the member list, confirmation posts.

**SCREEN:** hire a second one, from a template this time.

```
@ClawdFather we need a fractional CFO in #strategy. Call him Ledger.
```

**VO:**
> Eight roles come pre-written, so common ones don't get reinvented differently every time. ClawdFather only ever sees a one-line summary of each — it passes a slug, and the full personality is loaded when the tool runs.

**SCREEN:** ask Scout something real, in a thread.

```
@Scout research Cursor's current pricing tiers and how we should position against them.
```

**SCREEN:** then, **in the same thread and without mentioning anyone:**

```
what about their enterprise tier?
```

**VO:**
> One session per thread, so the follow-up keeps its context — and the thread remembers who's speaking in it, so I don't have to mention Scout again.

**SCREEN:** post in `#strategy` with no mention at all — something on-charter, like `are we losing deals on price?` → Scout answers. Then `anyone up for lunch?` → **hold on the silence for a full two seconds.**

**VO:**
> Teammates hear everything in their home channel and mostly stay quiet. That gate isn't an agent — it's a single cheap Haiku call with a strict schema, because opening a full session for every message in a channel would be slow and expensive for a question that's almost always "no."
>
> The most important Claude in this project is the one that decides not to answer.

**SCREEN:** ask Ledger the same pricing question so the two personalities visibly diverge.

**VO:**
> Two teammates, two persisted agents, two genuinely different answers — because the difference is two different system prompts on two different agent objects, not two prefixes on one.

---

## 2:55 — 3:20 · Close

**SCREEN:** the repo tree — `claudecanvas/`, `checkclaude/`, `clawdfather/`.

**VO:**
> Three surfaces, one axis: how long Claude's context is allowed to live. One turn, one run, or one identity that outlives every run.
>
> And all three ended up defined by the same thing — not what they generate, but what they refuse to do. Don't destroy the text. Don't cite a page you didn't read. Don't speak unless you should.
>
> The prompt is where you ask for that. The architecture is where you guarantee it.

**ON SCREEN TEXT:** `claudecanvas · checkclaude · clawdfather`

---

## The 90-second cut

Drop the Canvas image and multi-select prompts, the CheckClaude code walkthrough, and the second ClawdFather hire. Keep:

| | Beat | Time |
|---|---|---|
| 1 | Canvas: new box, then rewrite in place | 0:20 |
| 2 | CheckClaude: one verdict landing, with sources | 0:20 |
| 3 | ClawdFather: hire Scout, ask Scout, unmentioned follow-up | 0:35 |
| 4 | The silence beat — off-topic message, nobody answers | 0:05 |
| 5 | Close on the refusals line | 0:10 |

The one beat never to cut is #4. It is the only moment in the whole video that shows restraint, and it is the hardest thing in the build.

---

## Lines worth keeping verbatim

Use these as-is; they carry the argument.

- "The human is the agent."
- "The agent gets an objective, not a script."
- "Silence beats a confident guess."
- "The most important Claude in this project is the one that decides not to answer."
- "The prompt is where you ask. The architecture is where you guarantee."

## Things not to claim on camera

- Don't call any of it production-ready. Canvas is single-user, local, Mac-only for HEIC; the registry is a JSON file; the identity pool holds three.
- Don't claim undo covers everything. It covers box edits, capped at 50 steps; chat messages and cleared threads are outside it.
- Don't imply the Slack teammates provision their own apps. They're claimed from a pool of three pre-created ones.
- Don't show a hire failing and narrate around it. If `doctor` isn't green, stop and fix it before recording.
