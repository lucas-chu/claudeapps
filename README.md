# anthropic-interview

Three projects on one spine — the same idea handed to Claude three ways.

| | Claude… | Project | |
|---|---|---|---|
| **Messages API** | responds | — | *unbuilt* |
| **Agent SDK** | investigates | [**@CheckClaude**](./checkclaude) | fact-check anything on X by mentioning an agent |
| **Managed Agents** | persists | [**@ClaudeFather**](./claudefather) | a Slack Claude that hires Claudes |

### [`checkclaude/`](./checkclaude) — Claude investigates

Reply to any post on X with `@CheckClaude is this true?` and it reads the claim
and its thread, researches it with the Claude Agent SDK, and replies in plain
language with what it found and where. The interesting part is what it refuses
to do: citations are checked against pages actually retrieved, and a verdict
with no surviving source is downgraded rather than posted.

### [`claudefather/`](./claudefather) — Claude persists

`@ClaudeFather` is a Managed Agent whose job is hiring other Managed Agents. Ask
it for a teammate in plain English; it writes that teammate a soul, creates its
agent, gives it a Slack identity, and moves it into a channel. Agents are
persistent versioned objects created once at hire time; sessions are per-thread.

---

The two are **separate codebases** — separate dependencies, separate `.env`,
separate entrypoints. Start from the README inside whichever one you want:
[`checkclaude/README.md`](./checkclaude/README.md) ·
[`claudefather/README.md`](./claudefather/README.md).
