# Cove Canvas — Design

**Date:** 2026-08-12
**Status:** Approved

## Purpose

A local canvas app: draggable, resizable text boxes that Claude writes into. Two ways to
talk to Claude — a chat panel and a canvas omnibar — sharing one conversation. Web search
happens when the question needs it.

The immediate use is a live Claude demo. That sets the bar: it must survive a cold
`npm run dev` in front of an audience. Reliability outranks feature count. Anything flaky
gets cut, not debugged on stage.

## Constraints

- Runs locally. `npm run dev` starts everything; nothing is exposed publicly.
- The Anthropic API key lives only in the server process, never in the browser bundle.
- Node 24, npm 11 (confirmed present on the target machine).
- Model is `claude-opus-5`.

## Architecture

Two processes, one command.

```
cove-canvas/
  .env                      ANTHROPIC_API_KEY=...   (gitignored)
  .env.example
  server/index.ts           node:http, one route, holds the key
  src/
    main.tsx
    App.tsx                 layout: canvas + chat panel + omnibar
    canvas/
      Canvas.tsx            viewport: pan, zoom, selection
      TextBox.tsx           drag, resize, inline edit, render modes
      geometry.ts           screen<->world transforms, free-slot placement
    chat/
      ChatPanel.tsx         transcript, input, send-to-canvas
    state/
      store.ts              boxes, selection, thread, persistence
      context.ts            builds the request messages from state
    api/
      stream.ts             SSE client
  docs/superpowers/specs/   this document
```

The browser never calls api.anthropic.com. Vite proxies `/api` to the Node server in dev;
the server is the only thing holding credentials.

### Server

One route: `POST /api/generate`.

Request body:

```ts
{
  messages: AnthropicMessage[],   // full thread, assembled client-side
  targetBoxId?: string            // echoed back so the client routes deltas
}
```

Response: `text/event-stream` with three event types.

| Event    | Payload                              | Meaning                       |
|----------|--------------------------------------|-------------------------------|
| `delta`  | `{ text: string }`                   | Append to the target          |
| `sources`| `{ sources: {title,url}[] }`         | Web search citations, if any  |
| `error`  | `{ message: string }`                | Terminal; stream ends         |

The call uses the streaming Messages API with adaptive thinking (the default on
`claude-opus-5` — the `thinking` parameter is omitted) and declares the server-side web
search tool:

```ts
tools: [{ type: 'web_search_20260209', name: 'web_search' }]
```

Search is available, not forced. The model calls it when the question needs current
information and skips it otherwise. Results arrive as `web_search_tool_result` blocks and
carry citations, which become the `sources` event.

Notes that matter for correctness:

- `max_tokens: 16000`. Streaming, so HTTP timeouts are not a concern.
- No `temperature`, `top_p`, `top_k`, or `budget_tokens` — all rejected by `claude-opus-5`.
- Check `stop_reason === 'refusal'` before reading content, and surface it as an `error`
  event rather than an empty box.
- Web-search failures return HTTP 200 with an error object inside the result block, not a
  thrown exception. Branch on the content shape.
- The base URL is read from an explicit `ANTHROPIC_BASE_URL` config value defaulting to the
  public API, so an inherited shell variable is never a silent surprise.

**Preflight.** On startup the server checks for a credential and, if absent, exits with a
single readable line naming the fix. A demo must never open to a canvas that silently
cannot generate.

## The conversation model

There is one conversation. The chat panel is its transcript.

Both surfaces post turns into the same thread:

- Chat panel input → an ordinary chat turn.
- Canvas omnibar → a turn tagged with what it did, e.g. `→ edited box "Pricing notes"`.

This is what makes the running history honest: what the model sees is exactly what is
readable in the panel. One **Clear thread** button resets it. History is capped at the last
6 turns; only prompts and short result excerpts are retained, never full box contents —
those are supplied explicitly by selection.

### Canvas omnibar semantics

Behavior is keyed off selection:

| Selection   | Behavior                                                                 |
|-------------|--------------------------------------------------------------------------|
| none        | New box, placed in the first free slot near the viewport center           |
| exactly one | Rewrites that box in place; its current text is the context               |
| two or more | Their contents become context; the reply lands in a new box beside them   |

### Chat panel

A normal Claude chat: streaming replies, markdown, source chips. Collapsible and resizable.
Every assistant turn carries a **Send to canvas** button that spawns a box from that turn's
content at the viewport center.

### Provenance

A box created from a chat turn records `fromTurnId`. Clicking its provenance chip scrolls
the panel to that turn and highlights it. This is the mitigation for the known weakness of
the two-surface design — the surfaces are separate, but the link between them is not lost.

## Data model

Boxes and chat turns share one content shape, chosen so the planned features are additive.

```ts
type Block =
  | { type: 'text';  text: string }
  | { type: 'image'; mime: string; data: string }   // future
  | { type: 'html';  html: string }                 // future

type Box = {
  id: string
  x: number; y: number; w: number; h: number        // world coordinates
  blocks: Block[]
  render: 'markdown' | 'html'
  status: 'idle' | 'streaming' | 'error'
  error?: string
  sources?: { title: string; url: string }[]
  fromTurnId?: string
}

type Turn = {
  id: string
  role: 'user' | 'assistant'
  blocks: Block[]
  label?: string                                    // e.g. 'edited box "Pricing notes"'
  sources?: { title: string; url: string }[]
}
```

Future work maps onto this without a schema change: image paste pushes an `image` block
into the request; generated HTML apps become a box with `render: 'html'` drawn into a
sandboxed iframe (`sandbox="allow-scripts"`, no `allow-same-origin`, so generated code
cannot reach the page or the key). Neither is built now.

## Canvas behavior

- Infinite pannable, zoomable viewport. Scroll to zoom, space-drag or middle-drag to pan.
- Boxes drag from their header, resize from 8 handles.
- Selection: click, shift-click to add, marquee drag on empty canvas, Escape to clear.
- Double-click a box to edit its text directly.
- All hit-testing and drag math happens in world coordinates, converted once at the
  viewport boundary. Mixing screen and world space is the likeliest source of subtle
  drag/resize bugs under zoom, so the conversion lives in exactly one module.

## Persistence

Canvas state (boxes, viewport) and the thread autosave to localStorage, debounced 500ms,
and restore on load. No server-side storage.

## Error handling

- A generation failure sets the target box to `status: 'error'` with the message visible
  and a retry button.
- An in-place rewrite streams into a shadow buffer and commits only on success. A failed
  edit leaves the original text intact. This is the one case where losing content would be
  unrecoverable, so it gets explicit protection.
- A refusal is reported as an error with its message, not as an empty result.
- Chat failures render as an inline failed turn with retry; the thread is not corrupted.

## Testing

Vitest over the logic that is easy to get wrong and tedious to verify by hand:

- `geometry.ts`: screen↔world round-trips at several zoom levels; free-slot placement
  avoids overlaps and stays near the viewport center.
- `context.ts`: message assembly for each selection mode; thread trimming at the 6-turn cap;
  box contents never leak into history.
- Store reducers: selection transitions, shadow-buffer commit and rollback.

Canvas interaction, streaming, and search are verified by running the app.

## Out of scope

Deliberately excluded, and not blocking the demo:

- Image paste (schema ready, not built)
- HTML/iframe app rendering (schema ready, not built)
- Multiple canvases or tabs
- Undo history beyond the edit-safety above
- Deployment, auth, multi-user
