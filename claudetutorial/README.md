# claudetutorial

Three scripts, same incident, three different amounts of infrastructure you have to own. Clone this, run them in order, and by the third one you'll know which tier of the Claude Developer Platform your product actually needs — instead of guessing from a pricing page.

Nobody wants a 40-minute tutorial before their first API call. This one gets you a streaming response in about a minute, then escalates.

## Quickstart

```bash
git clone https://github.com/lucas-chu/claudeapps.git
cd claudeapps/claudetutorial
pip install -r requirements.txt
cp .env.example .env   # paste in your ANTHROPIC_API_KEY
python smoke_test.py   # confirms setup, makes no network calls
python 01_hello_claude.py
```

## The three tiers

Every Claude integration is one of these. Figuring out which one you need up front saves you from over-building.

**A single call** — you have a question, you send it, you get an answer. This is most of what "using an LLM" actually means: classification, extraction, drafting, support replies. No loop, no state.

**A tool-use loop** — the task needs Claude to check things and decide what to do next, but you already have the infrastructure (your DB, your APIs, your internal tools). You write the tools, the SDK's tool runner handles the back-and-forth of calling them and feeding results back until Claude is done.

**A Managed Agent** — the task needs a real workspace: reading and writing files, running commands, working across a whole codebase or filesystem, potentially for minutes at a time. Instead of standing up sandboxing infrastructure yourself, Anthropic runs the agent loop *and* hosts the container it works in. This is the one that doesn't really exist on other platforms in this form — you're not managing a Docker container fleet to give your agent hands.

Below, the same incident — a checkout API throwing errors — gets handled at each tier, so you can feel the difference instead of reading about it.

## 1. One call — `01_hello_claude.py`

```bash
python 01_hello_claude.py
```

A support assistant answers two questions about a product (made up: a webhook delivery API called Loopwire). Nothing fancy — `client.messages.stream(...)`, print the tokens as they come in. The interesting part is the second call: both requests share the same system prompt, marked with `cache_control`, so the second one can read that context from cache instead of paying full price for it again. The script prints the usage numbers so you can check — a cache hit shows `cache_read_input_tokens` above 0 on the second call; a miss shows 0 again.

If your product has any kind of standing context (docs, a schema, a style guide, prior turns in a conversation) and you're re-sending it on every request, this is the first thing to fix, and it's a one-line change.

## 2. Claude driving your tools — `02_tool_use_agent.py`

```bash
python 02_tool_use_agent.py
```

Now the checkout API alert needs actual investigation: check the service, look up the runbook, decide whether to fix it or page a human. Three Python functions, decorated with `@beta_tool`, handed to `client.beta.messages.tool_runner(...)`. Claude decides which to call, in what order, and when it has enough information to stop. You never write the loop.

The tools here are fake dictionaries so the script runs with nothing but an API key, but the shape is exactly what you'd point at a real status page, a real runbook, a real paging API. This is the tier most "AI features" in a real product actually live at.

## 3. Claude gets a computer — `03_managed_agent.py`

```bash
python 03_managed_agent.py
```

Same incident, but now Claude isn't limited to three functions you wrote — it gets a real container with bash, a filesystem, and web access, and it's asked to write an actual fix plan and postmortem to disk rather than just print an answer. The script creates an **Agent** (a persisted, versioned config — model, system prompt, tools), spins up an **Environment**, starts a **Session** against it, streams the events live, and downloads whatever Claude wrote to `/mnt/session/outputs/`.

Worth sitting with what didn't happen here: no Dockerfile, no container orchestration, no exec-in-sandbox service, no cleanup logic for runaway processes. That's the pitch for Managed Agents specifically — it's the one surface where Anthropic runs your agent's computer, not just its brain. If you've looked at OpenAI or Gemini for something like this, this is the piece that doesn't have a clean equivalent yet.

One thing worth knowing going in: the script creates a fresh agent *and* a fresh environment every time you run it, which is fine for a demo and wrong for production — both are meant to be created once and reused by ID. See the comments in the script.

## A couple of things I'm intentionally skipping

Vision, batch processing, the memory tool, structured outputs, MCP server integration — all real, all documented, none of them change the core decision above. The Claude Cookbook and the platform docs (linked below) cover them well; this tutorial is scoped to the one decision that actually matters first.

## On the model

Every script here uses `claude-opus-5`. One quirk worth knowing if you go spelunking in the request body: `top_p`, `top_k`, and `temperature` must stay default — this model family 400s otherwise. Thinking is on by default (`{type: "adaptive"}`); sending that explicitly is fine, but `{type: "disabled"}` can leak tool calls out as plain text instead of firing, which is a confusing way to lose an afternoon. If you're running high volume, cheaper models exist in the same family for the parts of your pipeline that don't need the strongest model — swap `MODEL` and everything else in these scripts stays the same.

## Where to go next

- [Claude Developer Platform docs](https://platform.claude.com/docs/en/home)
- [The Claude Cookbook](https://platform.claude.com/cookbook/) — recipes for the stuff this tutorial skipped
- [Anthropic Engineering Blog](https://www.anthropic.com/engineering)
