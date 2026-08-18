# Claude Canvas

An infinite canvas of draggable, resizable boxes that Claude writes into, with a
chat panel alongside. Both surfaces share one conversation, so what the model
sees is exactly what you can read.

A static web app. It has no backend: the page calls the Anthropic API directly
with **your own API key**, which you paste in on first run.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5173 and paste an Anthropic API key when asked
([get one here](https://console.anthropic.com/settings/keys)).

There is no `.env`, no server, and no build-time secret. `npm run dev` is just
Vite.

## Deploy it

`npm run build` emits a `dist/` of static files. Any static host serves it.
There are no environment variables, no functions and no secrets to configure —
each visitor supplies their own key at runtime.

```bash
npm run build && npm run preview   # check the production build locally
```

**This project is one directory inside a larger repo, so the deploy has to point
at `claudecanvas/`, not the repo root.** There is deliberately no config at the
root; a root-directory deploy finds no app and silently serves nothing useful.

From the CLI, run inside this directory — that makes it the project root, and
`vercel.json` / `netlify.toml` here are then picked up automatically:

```bash
cd claudecanvas
vercel deploy --prod
# or
netlify deploy --prod
```

Connecting the Git repo instead? Set the project's **root directory** to
`claudecanvas` (Vercel: Settings → Build → Root Directory; Netlify: Site
configuration → Build & deploy → Base directory). Build command `npm run build`,
publish directory `dist`.

### Is the right build live?

The page asks for an API key on first visit. If a freshly-opened private window
does *not* show that dialog, the deployment predates bring-your-own-key — the
old build talked to a local server that no longer exists — and needs
redeploying from the current commit.

## About your API key

Every visitor supplies their own key and is billed for their own usage.

- **The key goes to Anthropic and nowhere else.** This app has no server to send
  it to; requests go from your browser straight to `api.anthropic.com`.
- **You choose how long it is kept** — until you close the tab (the default), or
  remembered on the device. "Forget key" clears both.
- **It is checked before it is saved**, so a bad paste is caught immediately
  instead of failing on your first prompt.
- The trade-off of any bring-your-own-key app is that the key sits in browser
  storage, readable by any script on the page. This page loads no third-party
  scripts and no analytics.

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
prompt. Answers that used it show source chips (four, then "+N more"). Long
research runs are resumed automatically when the API pauses them, so an answer
doesn't stop half-finished.

**Speed and depth.** The toolbar carries an effort selector and a **Fast**
toggle. Effort defaults to **Auto**, which sends no effort setting at all and
lets the API decide; raising it buys better answers for more tokens. Fast mode
runs up to 2.5x faster output but is billed at a premium rate, so it is off by
default — and if its separate rate limit is hit, the answer completes at
standard speed rather than failing.

While Claude thinks, the box shows a running summary of its reasoning instead
of a blank pulse.

**Images.** Paste, drag a file in, or use **Add image**. Select an image box and
prompt to ask about it. iPhone HEIC photos are not supported — no browser can
decode them — so export as JPEG or PNG first; dropping one tells you so.

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

The browser is the whole app. It talks to the Anthropic API itself, using the
SDK's `dangerouslyAllowBrowser` mode — which is also what makes the SDK send the
`anthropic-dangerous-direct-browser-access` header the API requires for a
cross-origin call from a page.

- `generate()` — streams a reply, declaring the web-search tool and sending
  selected images as vision content blocks.
- `requestTitle()` — a short label for a box.
- `verifyApiKey()` — one near-empty request, so a bad key is caught at entry.

```
src/
  api/         Anthropic calls (stream.ts), web-search source extraction
  canvas/      geometry (the ONLY place screen<->world math lives), Canvas,
               TextBox, DrawingBox (Excalidraw)
  chat/        ChatPanel
  state/       types, reducer, undo history, request assembly, persistence,
               apiKey (where the user's key is kept)
  lib/         reveal pacer, markdown actions, image downscaling
  ApiKeyDialog.tsx   key entry, validation and scope
  useGeneration.ts   every generation path funnels through here
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
npm test        # 268 unit tests
npm run build
npm run typecheck
```

Tests cover the parts that are hard to eyeball: coordinate transforms, the state
reducer, request assembly, SSE parsing, the reveal pacer, and the markdown
actions (every toolbar action is exactly reversible). Canvas interaction,
streaming and vision were verified by driving a real browser against the real API.

## Known limitations

- **HEIC photos aren't supported.** No browser decodes HEIC, and there is no
  server to convert it. Dropping one says so and names the fix.
- **The API key is in browser storage**, which is inherent to bring-your-own-key.
  Prefer the tab-only option on a shared machine.
- **Undo covers box edits only.** Chat messages and cleared threads are not
  undoable, and history is capped at 50 steps.
- **localStorage caps around 8-9MB** — roughly 25-30 photos. Past that autosave
  stops working; you get a toast rather than silent loss, but the canvas is
  then only as durable as the tab.
- **Chat images aren't supported** — vision works from canvas selection only.
- Adaptive thinking means several seconds can pass before the first token. The
  streamed reasoning summary exists so that pause doesn't read as a hang.
