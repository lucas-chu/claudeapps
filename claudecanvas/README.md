# Cove Canvas

An infinite canvas of draggable, resizable boxes that Claude writes into, with a
chat panel alongside. Both surfaces share one conversation, so what the model
sees is exactly what you can read.

Local, single-user, Mac. Built to be demoed.

## Run it

```bash
npm install
cp .env.example .env      # then put a real key in it
npm run dev
```

Open http://localhost:5173.

`npm run dev` starts both halves: a Vite dev server on 5173 and a small Node API
server on 8787 (with `tsx watch`, so server edits reload themselves). Vite proxies
`/api` to it.

If the key is missing the server exits immediately with a readable message rather
than starting and failing on the first prompt. On startup it prints which source
the key came from (`.env` or the environment) — never the key itself.

## What you can do

**Prompting.** The omnibar at the bottom behaves differently depending on what is
selected:

| Selection | What happens |
|---|---|
| nothing | a new box is created and the answer streams into it |
| one text box | that box is rewritten in place |
| one image box | Claude answers *about* the image, into a new box |
| several boxes | their contents become context; the answer lands in a new box |

Every prompt also appears in the chat panel, labelled with what it did
(`→ created a box`), so the panel is a complete record of the session.

**Chat.** A normal Claude conversation on the right. Any reply can be pushed onto
the canvas with **Send to canvas**; the resulting box keeps a `from chat ↗` chip
that scrolls the panel back to the turn it came from.

**Web search** runs when a question needs current information — not on every
prompt. Answers that used it show source chips.

**Images.** Paste, drag a file in, or use **Add image**. iPhone HEIC photos are
converted automatically. Select an image box and prompt to ask about it.

**Editing.** Double-click a box to edit its markdown. Select text for a formatting
toolbar (bold, italic, code, heading, lists, quote, link), or use ⌘B / ⌘I / ⌘K.
Pasting a URL over selected text turns it into a link.

**Drawing.** **Draw** adds an Excalidraw box for freehand sketches, shapes and
arrows. Select one and prompt to ask Claude about it — it sees a rendered preview.

**Checklists.** Markdown task lists (`- [ ]`) render as real checkboxes you can
tick, including nested ones; checking a parent checks its sub-list.

**Undo/redo.** ⌘Z and ⌘⇧Z (or Ctrl+Y) cover box edits — add, delete, move,
resize, text. One drag or one typing burst is a single step. Streaming churn,
panning, zooming and selection are deliberately left out. Inside a text field or
a drawing box, the browser's and Excalidraw's own undo win instead.

**Titles** are generated automatically after each answer. Double-click one to
rename it — after that, auto-titling leaves it alone.

### Getting around

| Gesture | Action |
|---|---|
| two-finger scroll | pan |
| pinch (or ⌘/ctrl + scroll) | zoom at the cursor |
| alt-drag / middle-drag | pan |
| drag on empty canvas | marquee-select |
| shift-click | add to selection |
| Escape | clear selection |
| double-click a box | edit its text |
| ⌘0 / Ctrl+0 | reset zoom to 100% |
| ⇧1 (or ⌘⇧1) | zoom to fit every box |
| ⌘Z / ⌘⇧Z / Ctrl+Y | undo / redo |

The chat panel can be collapsed, or dragged wider and narrower by its edge.
Canvas and conversation autosave to localStorage and come back on reload.

## How it fits together

The browser never talks to the Anthropic API. It calls three local routes, and the
key stays in the server process:

- `POST /api/generate` — streams a reply back as Server-Sent Events (`delta`,
  `sources`, `error`, `done`). Declares the web-search tool; sends selected images
  as vision content blocks.
- `POST /api/title` — a short label for a box.
- `POST /api/convert-image` — HEIC to JPEG, via macOS `sips`.

```
src/
  canvas/      geometry (the ONLY place screen<->world math lives), Canvas,
               TextBox, DrawingBox (Excalidraw)
  chat/        ChatPanel
  state/       types, reducer, undo history, request assembly, persistence
  lib/         reveal pacer, markdown actions, image downscaling
  useGeneration.ts   every generation path funnels through here
server/        config + preflight, generate, sources
```

Two things are load-bearing and easy to break:

- **All stored coordinates are world coordinates.** Screen space exists only inside
  event handlers, converted once in `canvas/geometry.ts`. Scattering `* zoom` math
  elsewhere is how this class of app breaks subtly under zoom.
- **In-place rewrites go through a shadow buffer.** Streamed text accumulates
  separately and only replaces a box's content on success, so a failed rewrite
  can't destroy text that was already on the canvas.

## Checks

```bash
npm test        # 237 unit tests
npm run build
npm run typecheck
```

Tests cover the parts that are hard to eyeball: coordinate transforms, the state
reducer, request assembly, SSE parsing, the reveal pacer, and the markdown
actions (every toolbar action is exactly reversible). Canvas interaction,
streaming and vision were verified by driving a real browser against the real API.

## Known limitations

- **HEIC conversion is macOS-only** — it shells out to `sips`. Other platforms get
  a clear "requires macOS" message rather than a silent failure.
- **Undo covers box edits only.** Chat messages and cleared threads are not
  undoable, and history is capped at 50 steps.
- **localStorage caps around 8-9MB** — roughly 25-30 photos. Past that, autosave
  fails silently.
- **Chat images aren't supported** — vision works from canvas selection only.
- Adaptive thinking means several seconds can pass before the first token. The
  pulsing indicator exists so that pause doesn't read as a hang.
