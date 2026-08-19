# claudeapps

Apps built on Claude — the same idea handed to it three ways.

| | Claude… | Project | |
|---|---|---|---|
| **Messages API** | responds | [**Claude Canvas**](./claudecanvas) | an infinite canvas you think on, with Claude — deployable, bring your own key |
| **Agent SDK** | investigates | [**@CheckClaude**](./checkclaude) | fact-check anything on X by mentioning an agent |
| **Managed Agents** | persists | [**@ClawdFather**](./clawdfather) | a Slack Claude that hires Claudes |

### [`claudecanvas/`](./claudecanvas) — Claude responds

An infinite canvas of boxes you drag, resize and edit, where any prompt is
answered straight onto the canvas. Nothing selected writes a new box; one box
selected rewrites that box in place; several become context for the answer. A
chat panel shares the *same* thread, so what the model sees is exactly what you
can read, with one Clear button.

The interesting part is what it refuses to lose. A rewrite streams into a shadow
buffer and only replaces your text once it succeeds, so a failed generation
can't destroy what was already there. History is built only from *completed*
exchanges — otherwise firing three prompts at once makes each one inherit the
others' unanswered questions and answer all of them. Paste an iPhone photo and
it converts through macOS's own decoder, because no browser can read HEIC. Ask
about an image or a drawing and Claude sees it.

Streaming Messages API, server-side web search, and vision. It ships as a static
site with no backend at all: each visitor pastes their own Anthropic API key,
which goes from their browser straight to Anthropic and never touches a server
of ours.

### [`checkclaude/`](./checkclaude) — Claude investigates

Reply to any post on X with `@CheckClaude is this true?` and it reads the claim
and its thread, researches it with the Claude Agent SDK, and replies in plain
language with what it found and where. The interesting part is what it refuses
to do: citations are checked against pages actually retrieved, and a verdict
with no surviving source is downgraded rather than posted.

### [`clawdfather/`](./clawdfather) — Claude persists

`@ClawdFather` is a Managed Agent whose job is hiring other Managed Agents. Ask
it for a teammate in plain English; it writes that teammate a soul, creates its
agent, gives it a Slack identity, and moves it into a channel. Agents are
persistent versioned objects created once at hire time; sessions are per-thread.

---

The three are **separate codebases** — separate dependencies, separate `.env`,
separate entrypoints. Start from the README inside whichever one you want:
[`claudecanvas/README.md`](./claudecanvas/README.md) ·
[`checkclaude/README.md`](./checkclaude/README.md) ·
[`clawdfather/README.md`](./clawdfather/README.md).
