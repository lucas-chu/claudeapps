# Claude Canvas Implementation Plan

> Archived as written on 2026-08-12, when the project was called Cove Canvas.
> It shipped as **Claude Canvas**; the body below is left as the record of the
> build, so its paths, package name and storage key are the pre-rename ones.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local canvas app where draggable, resizable boxes are written by Claude, driven by a chat panel and a canvas omnibar that share one conversation, with web search when the question needs it.

**Architecture:** A Vite + React + TypeScript front end talks to a small Node HTTP server that holds the Anthropic API key and exposes a single SSE streaming route. Pure logic (viewport geometry, state reducer, message assembly) lives in dependency-free modules that are unit-tested; React components are thin shells over them. All canvas math happens in world coordinates and converts to screen space at exactly one boundary.

**Tech Stack:** Node 24, TypeScript, Vite, React 18, Vitest, `@anthropic-ai/sdk`, `react-markdown`, `tsx`, `concurrently`.

## Global Constraints

- Model is `claude-opus-5`, exactly this string, everywhere.
- `max_tokens: 16000` on every API call.
- Never send `temperature`, `top_p`, `top_k`, or `budget_tokens` — `claude-opus-5` rejects all four with a 400.
- Never send a `thinking` parameter. Adaptive thinking is the default on `claude-opus-5`.
- The web search tool is `{ type: 'web_search_20260209', name: 'web_search' }`.
- The API key exists only in the server process. It must never appear in `src/`, in any Vite-bundled file, or in an SSE payload.
- The Anthropic base URL comes from an explicit config constant defaulting to `https://api.anthropic.com`, never from an implicitly inherited environment variable.
- Thread history caps at the last 6 turns.
- All canvas coordinates stored in state are world coordinates. Screen coordinates exist only inside event handlers.
- Every task ends with a commit.

---

### Task 1: Project scaffold, server preflight, and test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `.env.example`
- Create: `server/config.ts`, `server/index.ts`
- Create: `src/main.tsx`, `src/App.tsx`, `src/styles.css`
- Test: `server/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadConfig(env: Record<string,string|undefined>): Config` where `Config = { apiKey: string; baseURL: string; port: number }`; throws `Error` with a readable message when the key is missing. Server listens on port 8787 and answers `GET /api/health` with `{"ok":true}`.

- [ ] **Step 1: Initialize the package and install dependencies**

Run from `/Users/lucaschu/Downloads/cove-canvas`:

```bash
npm init -y
npm install @anthropic-ai/sdk react react-dom react-markdown
npm install -D typescript vite @vitejs/plugin-react vitest tsx concurrently @types/react @types/react-dom @types/node
```

- [ ] **Step 2: Write `package.json` scripts and settings**

Replace the `scripts` block and add `"type": "module"` so the whole file reads:

```json
{
  "name": "cove-canvas",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "concurrently -k -n server,web -c blue,green \"npm:dev:server\" \"npm:dev:web\"",
    "dev:server": "tsx watch server/index.ts",
    "dev:web": "vite",
    "test": "vitest run",
    "build": "vite build"
  }
}
```

Leave the `dependencies` and `devDependencies` blocks exactly as npm wrote them.

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "server"]
}
```

- [ ] **Step 4: Write `vite.config.ts`**

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' },
  },
  test: { globals: true, environment: 'node' },
})
```

- [ ] **Step 5: Write `index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Cove Canvas</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Write `.env.example`**

```
ANTHROPIC_API_KEY=sk-ant-...
```

- [ ] **Step 7: Write the failing test for config loading**

Create `server/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { loadConfig } from './config'

describe('loadConfig', () => {
  it('reads the api key from the environment', () => {
    const c = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-test' })
    expect(c.apiKey).toBe('sk-ant-test')
  })

  it('defaults the base url to the public api', () => {
    const c = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-test' })
    expect(c.baseURL).toBe('https://api.anthropic.com')
  })

  it('ignores an inherited ANTHROPIC_BASE_URL unless COVE_BASE_URL is set', () => {
    const c = loadConfig({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      ANTHROPIC_BASE_URL: 'https://inherited.example.com',
    })
    expect(c.baseURL).toBe('https://api.anthropic.com')
  })

  it('honors an explicit COVE_BASE_URL override', () => {
    const c = loadConfig({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      COVE_BASE_URL: 'https://explicit.example.com',
    })
    expect(c.baseURL).toBe('https://explicit.example.com')
  })

  it('throws a readable error when the key is missing', () => {
    expect(() => loadConfig({})).toThrow(/ANTHROPIC_API_KEY/)
  })

  it('defaults the port to 8787', () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: 'k' }).port).toBe(8787)
  })
})
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `npx vitest run server/config.test.ts`
Expected: FAIL — cannot resolve `./config`.

- [ ] **Step 9: Write `server/config.ts`**

```ts
export type Config = {
  apiKey: string
  baseURL: string
  port: number
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com'

export function loadConfig(env: Record<string, string | undefined>): Config {
  const apiKey = env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Create a .env file in the project root ' +
        'containing:\n\n  ANTHROPIC_API_KEY=sk-ant-...\n\n' +
        'Copy .env.example to .env to get started.',
    )
  }
  return {
    apiKey,
    // Deliberately NOT ANTHROPIC_BASE_URL: an inherited shell variable must
    // never silently redirect requests. Override explicitly with COVE_BASE_URL.
    baseURL: env.COVE_BASE_URL ?? DEFAULT_BASE_URL,
    port: Number(env.COVE_PORT ?? 8787),
  }
}
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `npx vitest run server/config.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 11: Write `server/index.ts` with preflight and a health route**

```ts
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { loadConfig } from './config.js'

// Minimal .env loader — avoids a dependency and keeps startup explicit.
function readDotEnv(): Record<string, string> {
  try {
    const raw = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    const out: Record<string, string> = {}
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
    return out
  } catch {
    return {}
  }
}

let config
try {
  config = loadConfig({ ...readDotEnv(), ...process.env })
} catch (err) {
  console.error(`\n  Cove Canvas cannot start.\n\n  ${(err as Error).message}\n`)
  process.exit(1)
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

server.listen(config.port, () => {
  console.log(`  cove-canvas server ready on http://localhost:${config.port}`)
})
```

- [ ] **Step 12: Write the React shell**

Create `src/main.tsx`:

```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
```

Create `src/App.tsx`:

```tsx
export default function App() {
  return <div className="app">Cove Canvas</div>
}
```

Create `src/styles.css`:

```css
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body {
  font: 14px/1.5 ui-sans-serif, -apple-system, system-ui, sans-serif;
  color: #1a1a1a;
  background: #f6f5f3;
}
.app { display: flex; height: 100%; }
```

- [ ] **Step 13: Verify the whole thing boots**

Run: `cp .env.example .env` and put a real key in it, then `npm run dev`.
Expected: the server logs `cove-canvas server ready on http://localhost:8787`, Vite serves on 5173, and `curl -s localhost:5173/api/health` prints `{"ok":true}`.

Then verify the preflight: run `mv .env .env.bak && npm run dev:server`.
Expected: exits immediately printing the `ANTHROPIC_API_KEY is not set` message. Restore with `mv .env.bak .env`.

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "feat: scaffold vite + node server with config preflight"
```

---

### Task 2: Viewport geometry and box placement

**Files:**
- Create: `src/canvas/geometry.ts`
- Test: `src/canvas/geometry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Point = { x: number; y: number }`
  - `type Rect = { x: number; y: number; w: number; h: number }`
  - `type Viewport = { x: number; y: number; zoom: number }` — `x`/`y` are the world coordinates at the top-left of the screen.
  - `screenToWorld(p: Point, vp: Viewport): Point`
  - `worldToScreen(p: Point, vp: Viewport): Point`
  - `rectsOverlap(a: Rect, b: Rect): boolean`
  - `findFreeSlot(boxes: Rect[], center: Point, size: {w:number;h:number}, gap?: number): Point`
  - `zoomAt(vp: Viewport, screenPoint: Point, factor: number): Viewport`
  - `MIN_ZOOM = 0.2`, `MAX_ZOOM = 3`

- [ ] **Step 1: Write the failing tests**

Create `src/canvas/geometry.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  screenToWorld, worldToScreen, rectsOverlap, findFreeSlot, zoomAt,
  MIN_ZOOM, MAX_ZOOM,
} from './geometry'

describe('coordinate transforms', () => {
  const viewports = [
    { x: 0, y: 0, zoom: 1 },
    { x: 120, y: -80, zoom: 0.5 },
    { x: -640, y: 340, zoom: 2.5 },
  ]

  it('round-trips screen -> world -> screen at every zoom level', () => {
    for (const vp of viewports) {
      for (const p of [{ x: 0, y: 0 }, { x: 300, y: 200 }, { x: -50, y: 900 }]) {
        const back = worldToScreen(screenToWorld(p, vp), vp)
        expect(back.x).toBeCloseTo(p.x, 6)
        expect(back.y).toBeCloseTo(p.y, 6)
      }
    }
  })

  it('maps the screen origin to the viewport origin', () => {
    const vp = { x: 120, y: -80, zoom: 0.5 }
    expect(screenToWorld({ x: 0, y: 0 }, vp)).toEqual({ x: 120, y: -80 })
  })

  it('halves screen distance into world distance at zoom 2', () => {
    const vp = { x: 0, y: 0, zoom: 2 }
    expect(screenToWorld({ x: 100, y: 100 }, vp)).toEqual({ x: 50, y: 50 })
  })
})

describe('rectsOverlap', () => {
  const a = { x: 0, y: 0, w: 100, h: 100 }
  it('detects overlap', () => {
    expect(rectsOverlap(a, { x: 50, y: 50, w: 100, h: 100 })).toBe(true)
  })
  it('treats edge-touching as not overlapping', () => {
    expect(rectsOverlap(a, { x: 100, y: 0, w: 100, h: 100 })).toBe(false)
  })
  it('detects separation', () => {
    expect(rectsOverlap(a, { x: 300, y: 300, w: 10, h: 10 })).toBe(false)
  })
})

describe('findFreeSlot', () => {
  const size = { w: 320, h: 220 }

  it('centers the box on an empty canvas', () => {
    const p = findFreeSlot([], { x: 1000, y: 500 }, size)
    expect(p).toEqual({ x: 1000 - 160, y: 500 - 110 })
  })

  it('never returns a position overlapping an existing box', () => {
    const boxes = [{ x: 840, y: 390, w: 320, h: 220 }]
    const p = findFreeSlot(boxes, { x: 1000, y: 500 }, size)
    expect(rectsOverlap({ ...p, ...size }, boxes[0])).toBe(false)
  })

  it('packs many boxes without any overlaps', () => {
    const placed: { x: number; y: number; w: number; h: number }[] = []
    for (let i = 0; i < 12; i++) {
      const p = findFreeSlot(placed, { x: 0, y: 0 }, size)
      placed.push({ ...p, ...size })
    }
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++)
        expect(rectsOverlap(placed[i], placed[j])).toBe(false)
  })
})

describe('zoomAt', () => {
  it('keeps the world point under the cursor fixed', () => {
    const vp = { x: 100, y: 100, zoom: 1 }
    const cursor = { x: 400, y: 300 }
    const before = screenToWorld(cursor, vp)
    const after = screenToWorld(cursor, zoomAt(vp, cursor, 1.2))
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('clamps to the zoom bounds', () => {
    const vp = { x: 0, y: 0, zoom: 1 }
    expect(zoomAt(vp, { x: 0, y: 0 }, 100).zoom).toBe(MAX_ZOOM)
    expect(zoomAt(vp, { x: 0, y: 0 }, 0.001).zoom).toBe(MIN_ZOOM)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/canvas/geometry.test.ts`
Expected: FAIL — cannot resolve `./geometry`.

- [ ] **Step 3: Write `src/canvas/geometry.ts`**

```ts
export type Point = { x: number; y: number }
export type Size = { w: number; h: number }
export type Rect = Point & Size

/** x,y are the world coordinates displayed at the screen's top-left corner. */
export type Viewport = { x: number; y: number; zoom: number }

export const MIN_ZOOM = 0.2
export const MAX_ZOOM = 3

export function screenToWorld(p: Point, vp: Viewport): Point {
  return { x: p.x / vp.zoom + vp.x, y: p.y / vp.zoom + vp.y }
}

export function worldToScreen(p: Point, vp: Viewport): Point {
  return { x: (p.x - vp.x) * vp.zoom, y: (p.y - vp.y) * vp.zoom }
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/**
 * Finds a non-overlapping position for a new box, searching outward in square
 * rings from the requested center so new boxes land near where the user is
 * looking rather than in a far corner.
 */
export function findFreeSlot(
  boxes: Rect[],
  center: Point,
  size: Size,
  gap = 24,
): Point {
  const start = { x: center.x - size.w / 2, y: center.y - size.h / 2 }
  const stepX = size.w + gap
  const stepY = size.h + gap

  for (let ring = 0; ring <= 20; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        // Only the perimeter of each ring is new.
        if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue
        const cand: Rect = {
          x: start.x + dx * stepX,
          y: start.y + dy * stepY,
          ...size,
        }
        if (!boxes.some((b) => rectsOverlap(cand, b))) {
          return { x: cand.x, y: cand.y }
        }
      }
    }
  }
  return start
}

/** Zooms by `factor` while keeping the world point under `screenPoint` fixed. */
export function zoomAt(vp: Viewport, screenPoint: Point, factor: number): Viewport {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.zoom * factor))
  const anchor = screenToWorld(screenPoint, vp)
  return {
    zoom,
    x: anchor.x - screenPoint.x / zoom,
    y: anchor.y - screenPoint.y / zoom,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/canvas/geometry.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/canvas/geometry.ts src/canvas/geometry.test.ts
git commit -m "feat: viewport geometry and free-slot box placement"
```

---

### Task 3: Shared types and the state reducer

**Files:**
- Create: `src/state/types.ts`, `src/state/store.ts`
- Test: `src/state/store.test.ts`

**Interfaces:**
- Consumes: `Viewport` from `src/canvas/geometry.ts`.
- Produces:
  - `types.ts`: `Block`, `Box`, `Turn`, `Source`, and `blocksToText(blocks: Block[]): string`.
  - `store.ts`: `initialState: State`, `reducer(state: State, action: Action): State`, and `MAX_TURNS = 6`.
  - `State = { boxes: Box[]; selection: string[]; viewport: Viewport; turns: Turn[]; shadow: Record<string, string> }`

- [ ] **Step 1: Write `src/state/types.ts`**

```ts
export type Source = { title: string; url: string }

export type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; data: string }
  | { type: 'html'; html: string }

export type BoxStatus = 'idle' | 'streaming' | 'error'

export type Box = {
  id: string
  x: number
  y: number
  w: number
  h: number
  blocks: Block[]
  render: 'markdown' | 'html'
  status: BoxStatus
  error?: string
  sources?: Source[]
  fromTurnId?: string
  /** The prompt that last generated this box, so a failure can be retried. */
  lastPrompt?: string
}

export type Turn = {
  id: string
  role: 'user' | 'assistant'
  blocks: Block[]
  /** Set on omnibar-originated turns, e.g. 'edited box "Pricing notes"'. */
  label?: string
  sources?: Source[]
  status?: 'streaming' | 'error'
  error?: string
}

/** Flattens a block list to plain text. Image and html blocks are elided. */
export function blocksToText(blocks: Block[]): string {
  return blocks
    .map((b) => (b.type === 'text' ? b.text : b.type === 'html' ? b.html : ''))
    .join('')
}
```

- [ ] **Step 2: Write the failing tests for the reducer**

Create `src/state/store.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { reducer, initialState, MAX_TURNS } from './store'
import type { Box } from './types'

const box = (id: string, over: Partial<Box> = {}): Box => ({
  id, x: 0, y: 0, w: 320, h: 220,
  blocks: [{ type: 'text', text: '' }],
  render: 'markdown', status: 'idle', ...over,
})

describe('boxes', () => {
  it('adds a box and selects it', () => {
    const s = reducer(initialState, { type: 'addBox', box: box('a') })
    expect(s.boxes).toHaveLength(1)
    expect(s.selection).toEqual(['a'])
  })

  it('moves a box without touching others', () => {
    let s = reducer(initialState, { type: 'addBox', box: box('a') })
    s = reducer(s, { type: 'addBox', box: box('b') })
    s = reducer(s, { type: 'moveBox', id: 'a', x: 50, y: 60 })
    expect(s.boxes.find((b) => b.id === 'a')).toMatchObject({ x: 50, y: 60 })
    expect(s.boxes.find((b) => b.id === 'b')).toMatchObject({ x: 0, y: 0 })
  })

  it('enforces a minimum size on resize', () => {
    let s = reducer(initialState, { type: 'addBox', box: box('a') })
    s = reducer(s, { type: 'resizeBox', id: 'a', x: 0, y: 0, w: 10, h: 10 })
    const b = s.boxes[0]
    expect(b.w).toBeGreaterThanOrEqual(160)
    expect(b.h).toBeGreaterThanOrEqual(100)
  })

  it('deletes a box and drops it from the selection', () => {
    let s = reducer(initialState, { type: 'addBox', box: box('a') })
    s = reducer(s, { type: 'deleteBox', id: 'a' })
    expect(s.boxes).toHaveLength(0)
    expect(s.selection).toEqual([])
  })
})

describe('selection', () => {
  const twoBoxes = () => {
    let s = reducer(initialState, { type: 'addBox', box: box('a') })
    return reducer(s, { type: 'addBox', box: box('b') })
  }

  it('replaces the selection on select', () => {
    const s = reducer(twoBoxes(), { type: 'select', ids: ['a'] })
    expect(s.selection).toEqual(['a'])
  })

  it('adds and removes with toggleSelect', () => {
    let s = reducer(twoBoxes(), { type: 'select', ids: ['a'] })
    s = reducer(s, { type: 'toggleSelect', id: 'b' })
    expect(s.selection.sort()).toEqual(['a', 'b'])
    s = reducer(s, { type: 'toggleSelect', id: 'a' })
    expect(s.selection).toEqual(['b'])
  })

  it('clears the selection', () => {
    const s = reducer(twoBoxes(), { type: 'clearSelection' })
    expect(s.selection).toEqual([])
  })
})

describe('streaming into a box', () => {
  it('appends deltas to the last text block', () => {
    let s = reducer(initialState, { type: 'addBox', box: box('a') })
    s = reducer(s, { type: 'appendDelta', id: 'a', text: 'Hel' })
    s = reducer(s, { type: 'appendDelta', id: 'a', text: 'lo' })
    expect(s.boxes[0].blocks).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('records an error status and message', () => {
    let s = reducer(initialState, { type: 'addBox', box: box('a') })
    s = reducer(s, { type: 'setBoxError', id: 'a', error: 'refused' })
    expect(s.boxes[0]).toMatchObject({ status: 'error', error: 'refused' })
  })

  it('remembers the prompt that generated a box so it can be retried', () => {
    let s = reducer(initialState, { type: 'addBox', box: box('a') })
    s = reducer(s, { type: 'setBoxPrompt', id: 'a', prompt: 'write a haiku' })
    expect(s.boxes[0].lastPrompt).toBe('write a haiku')
  })
})

describe('shadow buffer for in-place rewrites', () => {
  it('commits replacing the original text', () => {
    let s = reducer(initialState, {
      type: 'addBox',
      box: box('a', { blocks: [{ type: 'text', text: 'original' }] }),
    })
    s = reducer(s, { type: 'beginShadow', id: 'a' })
    s = reducer(s, { type: 'appendShadow', id: 'a', text: 'new text' })
    expect(s.boxes[0].blocks[0]).toEqual({ type: 'text', text: 'original' })
    s = reducer(s, { type: 'commitShadow', id: 'a' })
    expect(s.boxes[0].blocks[0]).toEqual({ type: 'text', text: 'new text' })
    expect(s.shadow.a).toBeUndefined()
  })

  it('rolls back leaving the original intact', () => {
    let s = reducer(initialState, {
      type: 'addBox',
      box: box('a', { blocks: [{ type: 'text', text: 'original' }] }),
    })
    s = reducer(s, { type: 'beginShadow', id: 'a' })
    s = reducer(s, { type: 'appendShadow', id: 'a', text: 'partial junk' })
    s = reducer(s, { type: 'rollbackShadow', id: 'a', error: 'network died' })
    expect(s.boxes[0].blocks[0]).toEqual({ type: 'text', text: 'original' })
    expect(s.boxes[0].status).toBe('error')
    expect(s.shadow.a).toBeUndefined()
  })
})

describe('thread', () => {
  it('appends turns', () => {
    const s = reducer(initialState, {
      type: 'addTurn',
      turn: { id: 't1', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
    })
    expect(s.turns).toHaveLength(1)
  })

  it('keeps every turn in state regardless of the context cap', () => {
    let s = initialState
    for (let i = 0; i < MAX_TURNS * 3; i++) {
      s = reducer(s, {
        type: 'addTurn',
        turn: { id: `t${i}`, role: 'user', blocks: [{ type: 'text', text: 'x' }] },
      })
    }
    expect(s.turns.length).toBe(MAX_TURNS * 3)
  })

  it('clears the thread', () => {
    let s = reducer(initialState, {
      type: 'addTurn',
      turn: { id: 't1', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
    })
    s = reducer(s, { type: 'clearThread' })
    expect(s.turns).toEqual([])
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/state/store.test.ts`
Expected: FAIL — cannot resolve `./store`.

- [ ] **Step 4: Write `src/state/store.ts`**

```ts
import type { Viewport } from '../canvas/geometry'
import type { Box, Source, Turn } from './types'

export const MAX_TURNS = 6
export const MIN_BOX_W = 160
export const MIN_BOX_H = 100

export type State = {
  boxes: Box[]
  selection: string[]
  viewport: Viewport
  turns: Turn[]
  /** In-flight rewrite text, keyed by box id. Never rendered as box content. */
  shadow: Record<string, string>
}

export const initialState: State = {
  boxes: [],
  selection: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  turns: [],
  shadow: {},
}

export type Action =
  | { type: 'addBox'; box: Box }
  | { type: 'moveBox'; id: string; x: number; y: number }
  | { type: 'resizeBox'; id: string; x: number; y: number; w: number; h: number }
  | { type: 'setBoxText'; id: string; text: string }
  | { type: 'deleteBox'; id: string }
  | { type: 'select'; ids: string[] }
  | { type: 'toggleSelect'; id: string }
  | { type: 'clearSelection' }
  | { type: 'setViewport'; viewport: Viewport }
  | { type: 'appendDelta'; id: string; text: string }
  | { type: 'setBoxStatus'; id: string; status: Box['status'] }
  | { type: 'setBoxError'; id: string; error: string }
  | { type: 'setBoxSources'; id: string; sources: Source[] }
  | { type: 'setBoxPrompt'; id: string; prompt: string }
  | { type: 'beginShadow'; id: string }
  | { type: 'appendShadow'; id: string; text: string }
  | { type: 'commitShadow'; id: string }
  | { type: 'rollbackShadow'; id: string; error: string }
  | { type: 'addTurn'; turn: Turn }
  | { type: 'updateTurn'; id: string; patch: Partial<Turn> }
  | { type: 'appendTurnDelta'; id: string; text: string }
  | { type: 'clearThread' }
  | { type: 'load'; state: State }

function mapBox(state: State, id: string, fn: (b: Box) => Box): State {
  return { ...state, boxes: state.boxes.map((b) => (b.id === id ? fn(b) : b)) }
}

/** Appends to the trailing text block, creating one if needed. */
function appendText(box: Box, text: string): Box {
  const blocks = [...box.blocks]
  const last = blocks[blocks.length - 1]
  if (last && last.type === 'text') {
    blocks[blocks.length - 1] = { type: 'text', text: last.text + text }
  } else {
    blocks.push({ type: 'text', text })
  }
  return { ...box, blocks }
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'addBox':
      return {
        ...state,
        boxes: [...state.boxes, action.box],
        selection: [action.box.id],
      }

    case 'moveBox':
      return mapBox(state, action.id, (b) => ({ ...b, x: action.x, y: action.y }))

    case 'resizeBox':
      return mapBox(state, action.id, (b) => ({
        ...b,
        x: action.x,
        y: action.y,
        w: Math.max(MIN_BOX_W, action.w),
        h: Math.max(MIN_BOX_H, action.h),
      }))

    case 'setBoxText':
      return mapBox(state, action.id, (b) => ({
        ...b,
        blocks: [{ type: 'text', text: action.text }],
      }))

    case 'deleteBox':
      return {
        ...state,
        boxes: state.boxes.filter((b) => b.id !== action.id),
        selection: state.selection.filter((id) => id !== action.id),
      }

    case 'select':
      return { ...state, selection: action.ids }

    case 'toggleSelect':
      return {
        ...state,
        selection: state.selection.includes(action.id)
          ? state.selection.filter((id) => id !== action.id)
          : [...state.selection, action.id],
      }

    case 'clearSelection':
      return { ...state, selection: [] }

    case 'setViewport':
      return { ...state, viewport: action.viewport }

    case 'appendDelta':
      return mapBox(state, action.id, (b) => appendText(b, action.text))

    case 'setBoxStatus':
      return mapBox(state, action.id, (b) => ({
        ...b,
        status: action.status,
        error: action.status === 'error' ? b.error : undefined,
      }))

    case 'setBoxError':
      return mapBox(state, action.id, (b) => ({
        ...b,
        status: 'error',
        error: action.error,
      }))

    case 'setBoxSources':
      return mapBox(state, action.id, (b) => ({ ...b, sources: action.sources }))

    case 'setBoxPrompt':
      return mapBox(state, action.id, (b) => ({ ...b, lastPrompt: action.prompt }))

    case 'beginShadow':
      return {
        ...state,
        shadow: { ...state.shadow, [action.id]: '' },
        boxes: state.boxes.map((b) =>
          b.id === action.id ? { ...b, status: 'streaming', error: undefined } : b,
        ),
      }

    case 'appendShadow':
      return {
        ...state,
        shadow: {
          ...state.shadow,
          [action.id]: (state.shadow[action.id] ?? '') + action.text,
        },
      }

    case 'commitShadow': {
      const text = state.shadow[action.id] ?? ''
      const { [action.id]: _drop, ...shadow } = state.shadow
      return {
        ...mapBox(state, action.id, (b) => ({
          ...b,
          blocks: [{ type: 'text', text }],
          status: 'idle',
          error: undefined,
        })),
        shadow,
      }
    }

    case 'rollbackShadow': {
      const { [action.id]: _drop, ...shadow } = state.shadow
      return {
        ...mapBox(state, action.id, (b) => ({
          ...b,
          status: 'error',
          error: action.error,
        })),
        shadow,
      }
    }

    case 'addTurn':
      return { ...state, turns: [...state.turns, action.turn] }

    case 'updateTurn':
      return {
        ...state,
        turns: state.turns.map((t) =>
          t.id === action.id ? { ...t, ...action.patch } : t,
        ),
      }

    case 'appendTurnDelta':
      return {
        ...state,
        turns: state.turns.map((t) => {
          if (t.id !== action.id) return t
          const blocks = [...t.blocks]
          const last = blocks[blocks.length - 1]
          if (last && last.type === 'text') {
            blocks[blocks.length - 1] = { type: 'text', text: last.text + action.text }
          } else {
            blocks.push({ type: 'text', text: action.text })
          }
          return { ...t, blocks }
        }),
      }

    case 'clearThread':
      return { ...state, turns: [] }

    case 'load':
      return action.state
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/state/store.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 6: Commit**

```bash
git add src/state
git commit -m "feat: shared types and canvas state reducer"
```

---

### Task 4: Request context assembly

**Files:**
- Create: `src/state/context.ts`
- Test: `src/state/context.test.ts`

**Interfaces:**
- Consumes: `Box`, `Turn`, `blocksToText` from `src/state/types.ts`; `MAX_TURNS` from `src/state/store.ts`.
- Produces:
  - `type ApiMessage = { role: 'user' | 'assistant'; content: string }`
  - `trimTurns(turns: Turn[], max?: number): Turn[]`
  - `buildMessages(turns: Turn[], selected: Box[], prompt: string): ApiMessage[]`
  - `EXCERPT_LIMIT = 400`

- [ ] **Step 1: Write the failing tests**

Create `src/state/context.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildMessages, trimTurns, EXCERPT_LIMIT } from './context'
import { MAX_TURNS } from './store'
import type { Box, Turn } from './types'

const turn = (id: string, role: 'user' | 'assistant', text: string): Turn => ({
  id, role, blocks: [{ type: 'text', text }],
})

const box = (id: string, text: string): Box => ({
  id, x: 0, y: 0, w: 320, h: 220,
  blocks: [{ type: 'text', text }],
  render: 'markdown', status: 'idle',
})

describe('trimTurns', () => {
  it('keeps only the most recent MAX_TURNS', () => {
    const turns = Array.from({ length: 20 }, (_, i) => turn(`t${i}`, 'user', `m${i}`))
    const kept = trimTurns(turns)
    expect(kept).toHaveLength(MAX_TURNS)
    expect(kept[kept.length - 1].id).toBe('t19')
  })

  it('leaves a short thread alone', () => {
    const turns = [turn('a', 'user', 'x')]
    expect(trimTurns(turns)).toHaveLength(1)
  })

  it('truncates long assistant turns to an excerpt', () => {
    const long = 'x'.repeat(EXCERPT_LIMIT + 500)
    const [out] = trimTurns([turn('a', 'assistant', long)])
    const text = out.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
    expect(text.length).toBeLessThanOrEqual(EXCERPT_LIMIT + 1)
  })
})

describe('buildMessages', () => {
  it('ends with the prompt as a user message', () => {
    const msgs = buildMessages([], [], 'write a haiku')
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: 'write a haiku' })
  })

  it('includes prior turns before the prompt', () => {
    const msgs = buildMessages(
      [turn('a', 'user', 'hello'), turn('b', 'assistant', 'hi there')],
      [], 'again',
    )
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(msgs[0].content).toBe('hello')
  })

  it('embeds selected box contents in the final user message', () => {
    const msgs = buildMessages([], [box('b1', 'Q3 revenue was flat')], 'summarize this')
    const last = msgs[msgs.length - 1].content
    expect(last).toContain('Q3 revenue was flat')
    expect(last).toContain('summarize this')
  })

  it('labels each selected box so multiple sources stay distinguishable', () => {
    const msgs = buildMessages([], [box('b1', 'alpha'), box('b2', 'beta')], 'merge')
    const last = msgs[msgs.length - 1].content
    expect(last).toContain('alpha')
    expect(last).toContain('beta')
    expect(last.match(/<box/g)).toHaveLength(2)
  })

  it('never leaks box contents into the history portion', () => {
    const history = [turn('a', 'assistant', 'previous answer')]
    const msgs = buildMessages(history, [box('b1', 'SECRET BOX TEXT')], 'go')
    const historyPart = msgs.slice(0, -1).map((m) => m.content).join('\n')
    expect(historyPart).not.toContain('SECRET BOX TEXT')
  })

  it('drops empty turns rather than sending blank messages', () => {
    const msgs = buildMessages([turn('a', 'user', '   ')], [], 'go')
    expect(msgs).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/state/context.test.ts`
Expected: FAIL — cannot resolve `./context`.

- [ ] **Step 3: Write `src/state/context.ts`**

```ts
import { MAX_TURNS } from './store'
import { blocksToText, type Box, type Turn } from './types'

export type ApiMessage = { role: 'user' | 'assistant'; content: string }

/** Assistant turns longer than this are excerpted before entering history. */
export const EXCERPT_LIMIT = 400

/**
 * Keeps the most recent turns and shortens long assistant replies. Full box
 * contents are supplied explicitly by selection, so history stays cheap.
 */
export function trimTurns(turns: Turn[], max = MAX_TURNS): Turn[] {
  return turns.slice(-max).map((t) => {
    const text = blocksToText(t.blocks)
    if (text.length <= EXCERPT_LIMIT) return t
    return { ...t, blocks: [{ type: 'text', text: text.slice(0, EXCERPT_LIMIT) + '…' }] }
  })
}

function boxContext(selected: Box[]): string {
  if (selected.length === 0) return ''
  const parts = selected.map((b, i) => {
    const text = blocksToText(b.blocks)
    return `<box index="${i + 1}">\n${text}\n</box>`
  })
  return parts.join('\n\n') + '\n\n'
}

export function buildMessages(
  turns: Turn[],
  selected: Box[],
  prompt: string,
): ApiMessage[] {
  const history: ApiMessage[] = trimTurns(turns)
    .map((t) => ({ role: t.role, content: blocksToText(t.blocks).trim() }))
    .filter((m) => m.content.length > 0)

  return [...history, { role: 'user', content: boxContext(selected) + prompt }]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/state/context.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/state/context.ts src/state/context.test.ts
git commit -m "feat: request context assembly with thread trimming"
```

---

### Task 5: Streaming generation endpoint

**Files:**
- Create: `server/sources.ts`, `server/generate.ts`
- Modify: `server/index.ts`
- Test: `server/sources.test.ts`

**Interfaces:**
- Consumes: `Config` from `server/config.ts`.
- Produces:
  - `extractSources(content: unknown[]): { title: string; url: string }[]`
  - `handleGenerate(req, res, config): Promise<void>` — reads a JSON body `{ messages: {role,content}[] }`, writes SSE.
  - SSE events: `delta` `{text}`, `sources` `{sources}`, `error` `{message}`, `done` `{}`.

- [ ] **Step 1: Write the failing test for source extraction**

Create `server/sources.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { extractSources } from './sources'

describe('extractSources', () => {
  it('pulls title and url out of web_search_tool_result blocks', () => {
    const content = [
      { type: 'text', text: 'Here is what I found.' },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', title: 'Anthropic', url: 'https://anthropic.com' },
          { type: 'web_search_result', title: 'Docs', url: 'https://docs.example' },
        ],
      },
    ]
    expect(extractSources(content)).toEqual([
      { title: 'Anthropic', url: 'https://anthropic.com' },
      { title: 'Docs', url: 'https://docs.example' },
    ])
  })

  it('returns nothing when no search happened', () => {
    expect(extractSources([{ type: 'text', text: 'hi' }])).toEqual([])
  })

  it('tolerates an error object instead of a result list', () => {
    const content = [
      { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    ]
    expect(extractSources(content)).toEqual([])
  })

  it('de-duplicates repeated urls', () => {
    const content = [
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', title: 'A', url: 'https://a.example' },
          { type: 'web_search_result', title: 'A again', url: 'https://a.example' },
        ],
      },
    ]
    expect(extractSources(content)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/sources.test.ts`
Expected: FAIL — cannot resolve `./sources`.

- [ ] **Step 3: Write `server/sources.ts`**

```ts
export type Source = { title: string; url: string }

/**
 * Web search results arrive as `web_search_tool_result` blocks. On failure the
 * API returns HTTP 200 with an error OBJECT in place of the result LIST, so the
 * shape must be checked rather than assumed.
 */
export function extractSources(content: unknown[]): Source[] {
  const out: Source[] = []
  const seen = new Set<string>()

  for (const block of content) {
    const b = block as { type?: string; content?: unknown }
    if (b?.type !== 'web_search_tool_result') continue
    if (!Array.isArray(b.content)) continue // error object, not results

    for (const item of b.content) {
      const r = item as { type?: string; title?: string; url?: string }
      if (r?.type !== 'web_search_result' || !r.url) continue
      if (seen.has(r.url)) continue
      seen.add(r.url)
      out.push({ title: r.title ?? r.url, url: r.url })
    }
  }
  return out
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/sources.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write `server/generate.ts`**

```ts
import type { IncomingMessage, ServerResponse } from 'node:http'
import Anthropic from '@anthropic-ai/sdk'
import type { Config } from './config.js'
import { extractSources } from './sources.js'

const MODEL = 'claude-opus-5'
const MAX_TOKENS = 16000

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function sse(res: ServerResponse, event: string, payload: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
}

export async function handleGenerate(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
): Promise<void> {
  let messages: { role: 'user' | 'assistant'; content: string }[]
  try {
    const parsed = JSON.parse(await readBody(req))
    messages = parsed.messages
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('messages must be a non-empty array')
    }
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: (err as Error).message }))
    return
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })

  const client = new Anthropic({ apiKey: config.apiKey, baseURL: config.baseURL })

  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages,
      // Search is available, not forced: the model calls it only when the
      // question needs current information.
      tools: [{ type: 'web_search_20260209', name: 'web_search' }],
    } as Parameters<typeof client.messages.stream>[0])

    stream.on('text', (text) => sse(res, 'delta', { text }))

    const final = await stream.finalMessage()

    // A refusal is a successful HTTP 200 with empty or partial content. Report
    // it as an error rather than leaving an empty box on screen.
    if (final.stop_reason === 'refusal') {
      sse(res, 'error', {
        message: 'Claude declined this request.',
      })
      res.end()
      return
    }

    const sources = extractSources(final.content as unknown[])
    if (sources.length > 0) sse(res, 'sources', { sources })

    sse(res, 'done', {})
  } catch (err) {
    console.error('[generate]', err)
    sse(res, 'error', { message: (err as Error).message || 'Generation failed' })
  } finally {
    res.end()
  }
}
```

- [ ] **Step 6: Wire the route into `server/index.ts`**

Add the import at the top of `server/index.ts`, below the existing imports:

```ts
import { handleGenerate } from './generate.js'
```

Then replace the request handler body so it reads:

```ts
const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  if (req.method === 'POST' && req.url === '/api/generate') {
    await handleGenerate(req, res, config)
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})
```

- [ ] **Step 7: Verify the endpoint end to end**

With `npm run dev:server` running:

```bash
curl -N -s localhost:8787/api/generate \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Say the single word: ready"}]}'
```

Expected: a series of `event: delta` lines whose concatenated `text` reads `ready`, then `event: done`.

Then verify search fires:

```bash
curl -N -s localhost:8787/api/generate \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"What did Anthropic announce most recently? One sentence."}]}'
```

Expected: delta events followed by an `event: sources` line containing at least one `{title,url}`.

- [ ] **Step 8: Commit**

```bash
git add server
git commit -m "feat: streaming generate endpoint with web search"
```

---

### Task 6: SSE client

**Files:**
- Create: `src/api/stream.ts`
- Test: `src/api/stream.test.ts`

**Interfaces:**
- Consumes: `ApiMessage` from `src/state/context.ts`; `Source` from `src/state/types.ts`.
- Produces:
  - `parseSSE(chunk: string): { event: string; data: any }[]` — parses whole events out of a buffer, exported for testing.
  - `generate(messages: ApiMessage[], handlers: { onDelta(text: string): void; onSources(s: Source[]): void; onError(message: string): void; onDone(): void }): Promise<void>`

- [ ] **Step 1: Write the failing test for the SSE parser**

Create `src/api/stream.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseSSE } from './stream'

describe('parseSSE', () => {
  it('parses a single complete event', () => {
    const out = parseSSE('event: delta\ndata: {"text":"hi"}\n\n')
    expect(out).toEqual([{ event: 'delta', data: { text: 'hi' } }])
  })

  it('parses several events in one chunk', () => {
    const out = parseSSE(
      'event: delta\ndata: {"text":"a"}\n\nevent: delta\ndata: {"text":"b"}\n\n',
    )
    expect(out.map((e) => e.data.text)).toEqual(['a', 'b'])
  })

  it('ignores a trailing partial event', () => {
    const out = parseSSE('event: delta\ndata: {"text":"a"}\n\nevent: delta\ndata: {"te')
    expect(out).toHaveLength(1)
  })

  it('returns nothing for an empty buffer', () => {
    expect(parseSSE('')).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/api/stream.test.ts`
Expected: FAIL — cannot resolve `./stream`.

- [ ] **Step 3: Write `src/api/stream.ts`**

```ts
import type { ApiMessage } from '../state/context'
import type { Source } from '../state/types'

export type StreamHandlers = {
  onDelta: (text: string) => void
  onSources: (sources: Source[]) => void
  onError: (message: string) => void
  onDone: () => void
}

/** Parses whole SSE events from a buffer. A trailing partial event is ignored. */
export function parseSSE(buffer: string): { event: string; data: any }[] {
  const out: { event: string; data: any }[] = []
  const chunks = buffer.split('\n\n')
  // The final chunk is either empty or an incomplete event; never parse it.
  for (const chunk of chunks.slice(0, -1)) {
    const eventLine = chunk.match(/^event: (.*)$/m)
    const dataLine = chunk.match(/^data: (.*)$/m)
    if (!eventLine || !dataLine) continue
    try {
      out.push({ event: eventLine[1], data: JSON.parse(dataLine[1]) })
    } catch {
      // Malformed payload: skip rather than break the stream.
    }
  }
  return out
}

export async function generate(
  messages: ApiMessage[],
  handlers: StreamHandlers,
): Promise<void> {
  let response: Response
  try {
    response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages }),
    })
  } catch (err) {
    handlers.onError(`Could not reach the server: ${(err as Error).message}`)
    return
  }

  if (!response.ok || !response.body) {
    handlers.onError(`Server returned ${response.status}`)
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let errored = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const events = parseSSE(buffer)
    // Retain only the trailing partial event.
    const lastBreak = buffer.lastIndexOf('\n\n')
    if (lastBreak !== -1) buffer = buffer.slice(lastBreak + 2)

    for (const { event, data } of events) {
      if (event === 'delta') handlers.onDelta(data.text)
      else if (event === 'sources') handlers.onSources(data.sources)
      else if (event === 'error') {
        errored = true
        handlers.onError(data.message)
      }
    }
  }

  if (!errored) handlers.onDone()
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/api/stream.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/api
git commit -m "feat: SSE streaming client"
```

---

### Task 7: Canvas viewport and text boxes

**Files:**
- Create: `src/canvas/TextBox.tsx`, `src/canvas/Canvas.tsx`
- Modify: `src/styles.css`, `src/App.tsx`

**Interfaces:**
- Consumes: everything from `src/canvas/geometry.ts`; `State`/`Action` from `src/state/store.ts`; `Box` from `src/state/types.ts`.
- Produces:
  - `<Canvas state={State} dispatch={(a: Action) => void} />`
  - `<TextBox box={Box} viewport={Viewport} selected={boolean} shadowText={string | undefined} dispatch={...} />`

- [ ] **Step 1: Write `src/canvas/TextBox.tsx`**

```tsx
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Viewport } from './geometry'
import { worldToScreen } from './geometry'
import type { Action } from '../state/store'
import { blocksToText, type Box } from '../state/types'

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
export type Handle = (typeof HANDLES)[number]

type Props = {
  box: Box
  viewport: Viewport
  selected: boolean
  shadowText?: string
  dispatch: (a: Action) => void
  onDragStart: (e: React.PointerEvent, id: string) => void
  onResizeStart: (e: React.PointerEvent, id: string, handle: Handle) => void
  onSelect: (e: React.PointerEvent, id: string) => void
}

export default function TextBox({
  box, viewport, selected, shadowText, dispatch,
  onDragStart, onResizeStart, onSelect,
}: Props) {
  const [editing, setEditing] = useState(false)
  const p = worldToScreen({ x: box.x, y: box.y }, viewport)
  // Shadow text is the in-flight rewrite; showing it lets the user watch the
  // stream without committing over the original until it succeeds.
  const text = shadowText !== undefined ? shadowText : blocksToText(box.blocks)

  return (
    <div
      className={`box ${selected ? 'is-selected' : ''} ${box.status === 'error' ? 'is-error' : ''}`}
      style={{
        left: p.x,
        top: p.y,
        width: box.w * viewport.zoom,
        height: box.h * viewport.zoom,
      }}
      onPointerDown={(e) => onSelect(e, box.id)}
    >
      <div className="box-header" onPointerDown={(e) => onDragStart(e, box.id)}>
        <span className="box-status">
          {box.status === 'streaming' ? '…' : box.status === 'error' ? '!' : ''}
        </span>
        <button
          className="box-delete"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => dispatch({ type: 'deleteBox', id: box.id })}
          title="Delete"
        >
          ×
        </button>
      </div>

      <div className="box-body" onDoubleClick={() => setEditing(true)}>
        {editing ? (
          <textarea
            className="box-editor"
            autoFocus
            value={text}
            onChange={(e) =>
              dispatch({ type: 'setBoxText', id: box.id, text: e.target.value })
            }
            onBlur={() => setEditing(false)}
          />
        ) : (
          <div className="box-markdown">
            <ReactMarkdown>{text}</ReactMarkdown>
          </div>
        )}
      </div>

      {box.status === 'error' && <div className="box-errmsg">{box.error}</div>}

      {box.sources && box.sources.length > 0 && (
        <div className="box-sources">
          {box.sources.map((s) => (
            <a key={s.url} href={s.url} target="_blank" rel="noreferrer" title={s.url}>
              {s.title}
            </a>
          ))}
        </div>
      )}

      {selected &&
        HANDLES.map((h) => (
          <div
            key={h}
            className={`handle handle-${h}`}
            onPointerDown={(e) => {
              e.stopPropagation()
              onResizeStart(e, box.id, h)
            }}
          />
        ))}
    </div>
  )
}
```

- [ ] **Step 2: Write `src/canvas/Canvas.tsx`**

```tsx
import { useRef, useState } from 'react'
import TextBox, { type Handle } from './TextBox'
import {
  screenToWorld, zoomAt, rectsOverlap,
  type Point, type Rect,
} from './geometry'
import type { Action, State } from '../state/store'
import { MIN_BOX_W, MIN_BOX_H } from '../state/store'

type Drag =
  | { kind: 'none' }
  | { kind: 'pan'; last: Point }
  | { kind: 'move'; id: string; grab: Point; origin: Point }
  | { kind: 'resize'; id: string; handle: Handle; start: Rect; origin: Point }
  | { kind: 'marquee'; from: Point; to: Point }

export default function Canvas({
  state, dispatch,
}: { state: State; dispatch: (a: Action) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag>({ kind: 'none' })
  const vp = state.viewport

  const toWorld = (e: React.PointerEvent | PointerEvent): Point => {
    const rect = ref.current!.getBoundingClientRect()
    return screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top }, vp)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return // a box handled it
    ref.current!.setPointerCapture(e.pointerId)
    // Alt or middle button pans; a plain drag on empty canvas marquee-selects.
    // Alt rather than space: space-drag would fight with typing in the omnibar.
    if (e.button === 1 || e.altKey) {
      setDrag({ kind: 'pan', last: { x: e.clientX, y: e.clientY } })
    } else {
      const w = toWorld(e)
      if (!e.shiftKey) dispatch({ type: 'clearSelection' })
      setDrag({ kind: 'marquee', from: w, to: w })
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (drag.kind === 'none') return

    if (drag.kind === 'pan') {
      const dx = (e.clientX - drag.last.x) / vp.zoom
      const dy = (e.clientY - drag.last.y) / vp.zoom
      dispatch({ type: 'setViewport', viewport: { ...vp, x: vp.x - dx, y: vp.y - dy } })
      setDrag({ kind: 'pan', last: { x: e.clientX, y: e.clientY } })
      return
    }

    if (drag.kind === 'move') {
      const w = toWorld(e)
      dispatch({
        type: 'moveBox',
        id: drag.id,
        x: drag.origin.x + (w.x - drag.grab.x),
        y: drag.origin.y + (w.y - drag.grab.y),
      })
      return
    }

    if (drag.kind === 'resize') {
      const w = toWorld(e)
      const dx = w.x - drag.origin.x
      const dy = w.y - drag.origin.y
      const s = drag.start
      let { x, y, w: width, h: height } = s

      if (drag.handle.includes('e')) width = s.w + dx
      if (drag.handle.includes('s')) height = s.h + dy
      if (drag.handle.includes('w')) {
        width = s.w - dx
        x = s.x + Math.min(dx, s.w - MIN_BOX_W)
      }
      if (drag.handle.includes('n')) {
        height = s.h - dy
        y = s.y + Math.min(dy, s.h - MIN_BOX_H)
      }
      dispatch({ type: 'resizeBox', id: drag.id, x, y, w: width, h: height })
      return
    }

    if (drag.kind === 'marquee') {
      setDrag({ ...drag, to: toWorld(e) })
    }
  }

  const onPointerUp = () => {
    if (drag.kind === 'marquee') {
      const r: Rect = {
        x: Math.min(drag.from.x, drag.to.x),
        y: Math.min(drag.from.y, drag.to.y),
        w: Math.abs(drag.to.x - drag.from.x),
        h: Math.abs(drag.to.y - drag.from.y),
      }
      if (r.w > 4 && r.h > 4) {
        const hit = state.boxes.filter((b) => rectsOverlap(r, b)).map((b) => b.id)
        dispatch({ type: 'select', ids: hit })
      }
    }
    setDrag({ kind: 'none' })
  }

  const onWheel = (e: React.WheelEvent) => {
    const rect = ref.current!.getBoundingClientRect()
    const point = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    dispatch({ type: 'setViewport', viewport: zoomAt(vp, point, factor) })
  }

  return (
    <div
      ref={ref}
      className="canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
    >
      {state.boxes.map((b) => (
        <TextBox
          key={b.id}
          box={b}
          viewport={vp}
          selected={state.selection.includes(b.id)}
          shadowText={state.shadow[b.id]}
          dispatch={dispatch}
          onSelect={(e, id) => {
            e.stopPropagation()
            if (e.shiftKey) dispatch({ type: 'toggleSelect', id })
            else if (!state.selection.includes(id)) dispatch({ type: 'select', ids: [id] })
          }}
          onDragStart={(e, id) => {
            e.stopPropagation()
            // Dragging by the header must also select, or the omnibar would
            // still be acting on whatever was selected before.
            if (!state.selection.includes(id)) dispatch({ type: 'select', ids: [id] })
            const box = state.boxes.find((x) => x.id === id)!
            setDrag({
              kind: 'move', id,
              grab: toWorld(e),
              origin: { x: box.x, y: box.y },
            })
          }}
          onResizeStart={(e, id, handle) => {
            const box = state.boxes.find((x) => x.id === id)!
            setDrag({
              kind: 'resize', id, handle,
              start: { x: box.x, y: box.y, w: box.w, h: box.h },
              origin: toWorld(e),
            })
          }}
        />
      ))}
    </div>
  )
}
```

- [ ] **Step 3: Append the canvas styles to `src/styles.css`**

```css
.canvas {
  position: relative;
  flex: 1;
  overflow: hidden;
  background:
    radial-gradient(circle, #d8d5cf 1px, transparent 1px) 0 0 / 24px 24px;
  touch-action: none;
  user-select: none;
}

.box {
  position: absolute;
  display: flex;
  flex-direction: column;
  background: #fff;
  border: 1px solid #d8d5cf;
  border-radius: 10px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, .06);
  overflow: hidden;
}
.box.is-selected { border-color: #c2643c; box-shadow: 0 0 0 2px rgba(194, 100, 60, .25); }
.box.is-error { border-color: #b3402f; }

.box-header {
  display: flex; align-items: center; justify-content: space-between;
  height: 22px; padding: 0 6px; cursor: grab;
  background: #faf9f7; border-bottom: 1px solid #eceae6;
  font-size: 11px; color: #8a8580;
}
.box-delete { border: 0; background: none; cursor: pointer; font-size: 15px; color: #8a8580; }
.box-body { flex: 1; overflow: auto; padding: 10px 12px; }
.box-markdown p:first-child { margin-top: 0; }
.box-markdown p:last-child { margin-bottom: 0; }
.box-editor { width: 100%; height: 100%; border: 0; resize: none; outline: none; font: inherit; }
.box-errmsg { padding: 6px 12px; background: #fdecea; color: #8c2f22; font-size: 12px; }
.box-sources {
  display: flex; flex-wrap: wrap; gap: 6px;
  padding: 6px 12px; border-top: 1px solid #eceae6; font-size: 11px;
}
.box-sources a {
  max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 2px 6px; background: #f2f0ec; border-radius: 999px; color: #5c5852; text-decoration: none;
}

.handle { position: absolute; width: 8px; height: 8px; background: #c2643c; border-radius: 2px; }
.handle-nw { left: -4px; top: -4px; cursor: nwse-resize; }
.handle-n  { left: calc(50% - 4px); top: -4px; cursor: ns-resize; }
.handle-ne { right: -4px; top: -4px; cursor: nesw-resize; }
.handle-e  { right: -4px; top: calc(50% - 4px); cursor: ew-resize; }
.handle-se { right: -4px; bottom: -4px; cursor: nwse-resize; }
.handle-s  { left: calc(50% - 4px); bottom: -4px; cursor: ns-resize; }
.handle-sw { left: -4px; bottom: -4px; cursor: nesw-resize; }
.handle-w  { left: -4px; top: calc(50% - 4px); cursor: ew-resize; }
```

- [ ] **Step 4: Wire the canvas into `src/App.tsx` with a temporary seed box**

```tsx
import { useReducer } from 'react'
import Canvas from './canvas/Canvas'
import { reducer, initialState } from './state/store'

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState)

  return (
    <div className="app">
      <Canvas state={state} dispatch={dispatch} />
      <button
        style={{ position: 'absolute', left: 12, top: 12, zIndex: 10 }}
        onClick={() =>
          dispatch({
            type: 'addBox',
            box: {
              id: crypto.randomUUID(),
              x: 80, y: 80, w: 320, h: 220,
              blocks: [{ type: 'text', text: '**Drag me.** Resize me. Double-click to edit.' }],
              render: 'markdown', status: 'idle',
            },
          })
        }
      >
        Add box
      </button>
    </div>
  )
}
```

- [ ] **Step 5: Verify canvas interaction by hand**

Run: `npm run dev`, open http://localhost:5173.
Verify each of these:
- "Add box" creates a box; it renders the markdown bold.
- Dragging its header moves it, and it stays under the cursor.
- Each of the 8 handles resizes in the expected direction; west and north handles move the opposite edge rather than jumping.
- Scroll zooms toward the cursor — the point under the cursor stays put.
- Alt-drag on empty canvas pans; plain drag draws a marquee that selects the boxes it touches.
- Zoom to 0.5 and 2, then repeat the drag and resize checks. Movement must still track the cursor exactly.

- [ ] **Step 6: Commit**

```bash
git add src/canvas src/App.tsx src/styles.css
git commit -m "feat: pannable zoomable canvas with draggable resizable boxes"
```

---

### Task 8: Generation hook and omnibar with the three selection modes

**Files:**
- Create: `src/useGeneration.ts`, `src/Omnibar.tsx`
- Test: `src/useGeneration.test.ts`
- Modify: `src/App.tsx`, `src/styles.css`

**Interfaces:**
- Consumes: `generate` from `src/api/stream.ts`; `buildMessages` from `src/state/context.ts`; `findFreeSlot`, `screenToWorld` from `src/canvas/geometry.ts`; reducer actions from `src/state/store.ts`.
- Produces:
  - `describeAction(selectionCount: number): string`
  - `useGeneration(state: State, dispatch: (a: Action) => void, viewportSize: {w:number;h:number})` returning `{ runCanvasPrompt(prompt: string, selected: Box[]): Promise<void>; runChatPrompt(prompt: string): Promise<void>; retryBox(boxId: string): Promise<void>; busy: boolean }`
  - `<Omnibar state={State} dispatch={...} gen={ReturnType<typeof useGeneration>} />`

All three surfaces — omnibar, chat panel, and box retry — stream through this one hook. Writing the streaming plumbing once is what keeps the three paths from drifting apart.

- [ ] **Step 1: Write the failing test for `describeAction`**

Create `src/useGeneration.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { describeAction } from './useGeneration'

describe('describeAction', () => {
  it('labels a creation', () => {
    expect(describeAction(0)).toBe('created a box')
  })
  it('labels an edit', () => {
    expect(describeAction(1)).toBe('edited a box')
  })
  it('names the count when several boxes are context', () => {
    expect(describeAction(3)).toBe('used 3 boxes as context')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/useGeneration.test.ts`
Expected: FAIL — cannot resolve `./useGeneration`.

- [ ] **Step 3: Write `src/useGeneration.ts`**

```ts
import { useState } from 'react'
import { generate } from './api/stream'
import { buildMessages } from './state/context'
import { findFreeSlot, screenToWorld } from './canvas/geometry'
import type { Action, State } from './state/store'
import { blocksToText, type Box } from './state/types'

const NEW_BOX = { w: 360, h: 260 }

export function describeAction(selectionCount: number): string {
  if (selectionCount === 0) return 'created a box'
  if (selectionCount === 1) return 'edited a box'
  return `used ${selectionCount} boxes as context`
}

export function useGeneration(
  state: State,
  dispatch: (a: Action) => void,
  viewportSize: { w: number; h: number },
) {
  const [busy, setBusy] = useState(false)

  function placeNewBox(prompt: string): Box {
    const center = screenToWorld(
      { x: viewportSize.w / 2, y: viewportSize.h / 2 },
      state.viewport,
    )
    const at = findFreeSlot(state.boxes, center, NEW_BOX)
    return {
      id: crypto.randomUUID(),
      x: at.x, y: at.y, w: NEW_BOX.w, h: NEW_BOX.h,
      blocks: [{ type: 'text', text: '' }],
      render: 'markdown',
      status: 'streaming',
      lastPrompt: prompt,
    }
  }

  /**
   * Streams a reply into a box. Passing `retryTargetId` regenerates an existing
   * box instead of choosing a target from the selection.
   */
  async function runCanvasPrompt(
    prompt: string,
    selected: Box[],
    retryTargetId?: string,
  ): Promise<void> {
    if (busy) return
    setBusy(true)

    const messages = buildMessages(state.turns, selected, prompt)

    // Every canvas prompt enters the same thread the chat panel shows, so the
    // history the model sees is exactly what the user can read.
    dispatch({
      type: 'addTurn',
      turn: {
        id: crypto.randomUUID(),
        role: 'user',
        blocks: [{ type: 'text', text: prompt }],
        label: `→ ${retryTargetId ? 'retried a box' : describeAction(selected.length)}`,
      },
    })

    // A box that already exists is rewritten through the shadow buffer, so a
    // failure can never destroy text that is already on the canvas.
    const inPlace = Boolean(retryTargetId) || selected.length === 1
    let targetId: string
    if (retryTargetId) {
      targetId = retryTargetId
    } else if (selected.length === 1) {
      targetId = selected[0].id
    } else {
      const box = placeNewBox(prompt)
      dispatch({ type: 'addBox', box })
      targetId = box.id
    }

    dispatch({ type: 'setBoxPrompt', id: targetId, prompt })
    if (inPlace) dispatch({ type: 'beginShadow', id: targetId })

    const turnId = crypto.randomUUID()
    dispatch({
      type: 'addTurn',
      turn: {
        id: turnId, role: 'assistant',
        blocks: [{ type: 'text', text: '' }], status: 'streaming',
      },
    })

    await generate(messages, {
      onDelta: (t) => {
        if (inPlace) dispatch({ type: 'appendShadow', id: targetId, text: t })
        else dispatch({ type: 'appendDelta', id: targetId, text: t })
        dispatch({ type: 'appendTurnDelta', id: turnId, text: t })
      },
      onSources: (sources) => {
        dispatch({ type: 'setBoxSources', id: targetId, sources })
        dispatch({ type: 'updateTurn', id: turnId, patch: { sources } })
      },
      onError: (message) => {
        if (inPlace) dispatch({ type: 'rollbackShadow', id: targetId, error: message })
        else dispatch({ type: 'setBoxError', id: targetId, error: message })
        dispatch({ type: 'updateTurn', id: turnId, patch: { status: 'error', error: message } })
      },
      onDone: () => {
        if (inPlace) dispatch({ type: 'commitShadow', id: targetId })
        else dispatch({ type: 'setBoxStatus', id: targetId, status: 'idle' })
        dispatch({ type: 'updateTurn', id: turnId, patch: { status: undefined } })
      },
    })

    setBusy(false)
  }

  async function runChatPrompt(prompt: string): Promise<void> {
    if (busy) return
    setBusy(true)

    // Chat prompts carry no box context — selection belongs to the omnibar.
    const messages = buildMessages(state.turns, [], prompt)

    dispatch({
      type: 'addTurn',
      turn: { id: crypto.randomUUID(), role: 'user', blocks: [{ type: 'text', text: prompt }] },
    })

    const turnId = crypto.randomUUID()
    dispatch({
      type: 'addTurn',
      turn: {
        id: turnId, role: 'assistant',
        blocks: [{ type: 'text', text: '' }], status: 'streaming',
      },
    })

    await generate(messages, {
      onDelta: (t) => dispatch({ type: 'appendTurnDelta', id: turnId, text: t }),
      onSources: (sources) => dispatch({ type: 'updateTurn', id: turnId, patch: { sources } }),
      onError: (message) =>
        dispatch({ type: 'updateTurn', id: turnId, patch: { status: 'error', error: message } }),
      onDone: () => dispatch({ type: 'updateTurn', id: turnId, patch: { status: undefined } }),
    })

    setBusy(false)
  }

  async function retryBox(boxId: string): Promise<void> {
    const box = state.boxes.find((b) => b.id === boxId)
    if (!box?.lastPrompt) return
    // Reproduce the original context: a rewrite that failed still has its
    // original text, whereas a failed creation is empty.
    const hadContent = blocksToText(box.blocks).trim().length > 0
    await runCanvasPrompt(box.lastPrompt, hadContent ? [box] : [], boxId)
  }

  return { runCanvasPrompt, runChatPrompt, retryBox, busy }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/useGeneration.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write `src/Omnibar.tsx`**

```tsx
import { useState } from 'react'
import type { State } from './state/store'
import { blocksToText, type Box } from './state/types'
import type { useGeneration } from './useGeneration'

export default function Omnibar({
  state, gen,
}: {
  state: State
  gen: ReturnType<typeof useGeneration>
}) {
  const [prompt, setPrompt] = useState('')

  const selected: Box[] = state.boxes.filter((b) => state.selection.includes(b.id))

  async function run() {
    const text = prompt.trim()
    if (!text || gen.busy) return
    setPrompt('')
    await gen.runCanvasPrompt(text, selected)
  }

  const hint =
    selected.length === 0
      ? 'Ask anything — the answer lands in a new box'
      : selected.length === 1
        ? `Rewrite "${blocksToText(selected[0].blocks).slice(0, 24) || 'this box'}…"`
        : `Use ${selected.length} boxes as context`

  return (
    <div className="omnibar">
      <input
        value={prompt}
        placeholder={hint}
        disabled={gen.busy}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') run()
        }}
      />
      <button onClick={run} disabled={gen.busy || !prompt.trim()}>
        {gen.busy ? '…' : '↵'}
      </button>
    </div>
  )
}
```

- [ ] **Step 6: Append the omnibar styles to `src/styles.css`**

```css
.omnibar {
  position: absolute;
  left: 50%; bottom: 24px; transform: translateX(-50%);
  display: flex; gap: 8px; align-items: center;
  width: min(640px, calc(100% - 48px));
  padding: 8px 8px 8px 14px;
  background: #fff; border: 1px solid #d8d5cf; border-radius: 999px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, .08);
  z-index: 20;
}
.omnibar input { flex: 1; border: 0; outline: none; font: inherit; background: none; }
.omnibar button {
  width: 30px; height: 30px; border: 0; border-radius: 50%;
  background: #c2643c; color: #fff; cursor: pointer;
}
.omnibar button:disabled { background: #ddd9d3; cursor: default; }
```

- [ ] **Step 7: Wire the omnibar into `src/App.tsx`, replacing the seed button**

```tsx
import { useEffect, useReducer, useRef, useState } from 'react'
import Canvas from './canvas/Canvas'
import Omnibar from './Omnibar'
import { useGeneration } from './useGeneration'
import { reducer, initialState } from './state/store'

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const shellRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 1200, h: 800 })
  const gen = useGeneration(state, dispatch, size)

  useEffect(() => {
    const measure = () => {
      const el = shellRef.current
      if (el) setSize({ w: el.clientWidth, h: el.clientHeight })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ type: 'clearSelection' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app">
      <div className="canvas-shell" ref={shellRef}>
        <Canvas state={state} dispatch={dispatch} />
        <Omnibar state={state} gen={gen} />
      </div>
    </div>
  )
}
```

Add to `src/styles.css`:

```css
.canvas-shell { position: relative; flex: 1; display: flex; min-width: 0; }
```

- [ ] **Step 8: Verify the three modes by hand**

Run: `npm run dev`. With nothing selected, type `Write two sentences about tide pools` and press Enter.
Expected: a new box appears near the center and text streams into it.

Select that box, then prompt `Make it one sentence.`
Expected: the box shows the new text streaming; when it finishes the old text is gone. During streaming the original is still what's stored — confirm by killing the server mid-stream (`Ctrl-C` in the server pane) and checking the box reverts to its original text with an error message rather than being left half-rewritten.

Restart the server. Create a second box, select both, and prompt `Combine these into one paragraph.`
Expected: a third box appears with the combined text.

Finally prompt something requiring current information, e.g. `What's the latest Claude model? One line.`
Expected: source chips appear at the bottom of the box.

- [ ] **Step 9: Commit**

```bash
git add src/useGeneration.ts src/useGeneration.test.ts src/Omnibar.tsx src/App.tsx src/styles.css
git commit -m "feat: shared generation hook and omnibar selection modes"
```

---

### Task 9: Chat panel, promotion to canvas, and persistence

**Files:**
- Create: `src/chat/ChatPanel.tsx`, `src/state/persist.ts`
- Modify: `src/App.tsx`, `src/styles.css`
- Test: `src/state/persist.test.ts`

**Interfaces:**
- Consumes: `State` from `src/state/store.ts`; `useGeneration` from `src/useGeneration.ts`; `findFreeSlot`, `screenToWorld` from `src/canvas/geometry.ts`.
- Produces:
  - `persist.ts`: `save(state: State): void`, `load(): State | null`, `STORAGE_KEY = 'cove-canvas:v1'`
  - `<ChatPanel state={State} dispatch={...} gen={...} onPromote={(turnId: string) => void} />`
  - `<Canvas>` and `<TextBox>` gain an `onRetry: (id: string) => void` prop.

- [ ] **Step 1: Write the failing test for persistence**

Create `src/state/persist.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { save, load, STORAGE_KEY } from './persist'
import { initialState } from './store'

const mem: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v },
  removeItem: (k: string) => { delete mem[k] },
})

describe('persistence', () => {
  beforeEach(() => { delete mem[STORAGE_KEY] })

  it('returns null when nothing is stored', () => {
    expect(load()).toBeNull()
  })

  it('round-trips state', () => {
    const s = {
      ...initialState,
      boxes: [{
        id: 'a', x: 1, y: 2, w: 320, h: 220,
        blocks: [{ type: 'text' as const, text: 'hi' }],
        render: 'markdown' as const, status: 'idle' as const,
      }],
      viewport: { x: 10, y: 20, zoom: 1.5 },
    }
    save(s)
    expect(load()).toEqual({ ...s, shadow: {}, selection: [] })
  })

  it('never persists in-flight shadow buffers or streaming status', () => {
    save({
      ...initialState,
      shadow: { a: 'partial' },
      boxes: [{
        id: 'a', x: 0, y: 0, w: 320, h: 220,
        blocks: [{ type: 'text' as const, text: 'x' }],
        render: 'markdown' as const, status: 'streaming' as const,
      }],
    })
    const out = load()!
    expect(out.shadow).toEqual({})
    expect(out.boxes[0].status).toBe('idle')
  })

  it('returns null on corrupt data rather than throwing', () => {
    mem[STORAGE_KEY] = '{not json'
    expect(load()).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/state/persist.test.ts`
Expected: FAIL — cannot resolve `./persist`.

- [ ] **Step 3: Write `src/state/persist.ts`**

```ts
import type { State } from './store'

export const STORAGE_KEY = 'cove-canvas:v1'

/**
 * Persists canvas content and thread. Transient fields are dropped: a reload
 * must never restore a half-written box or a selection the user can't see.
 */
export function save(state: State): void {
  const clean: State = {
    ...state,
    selection: [],
    shadow: {},
    boxes: state.boxes.map((b) => ({
      ...b,
      status: b.status === 'streaming' ? 'idle' : b.status,
    })),
    turns: state.turns.map((t) => ({ ...t, status: undefined })),
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean))
  } catch {
    // Quota or private mode: losing autosave must not break the app.
  }
}

export function load(): State | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as State
    if (!Array.isArray(parsed.boxes)) return null
    return { ...parsed, selection: [], shadow: {} }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/state/persist.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write `src/chat/ChatPanel.tsx`**

```tsx
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Action, State } from '../state/store'
import { blocksToText } from '../state/types'
import type { useGeneration } from '../useGeneration'

export default function ChatPanel({
  state, dispatch, gen, onPromote,
}: {
  state: State
  dispatch: (a: Action) => void
  gen: ReturnType<typeof useGeneration>
  onPromote: (turnId: string) => void
}) {
  const [prompt, setPrompt] = useState('')
  const [open, setOpen] = useState(true)

  async function send() {
    const text = prompt.trim()
    if (!text || gen.busy) return
    setPrompt('')
    await gen.runChatPrompt(text)
  }

  if (!open) {
    return (
      <button className="chat-reopen" onClick={() => setOpen(true)}>
        Chat
      </button>
    )
  }

  return (
    <aside className="chat">
      <header className="chat-head">
        <strong>Conversation</strong>
        <span className="chat-count">{state.turns.length} turns</span>
        <button onClick={() => dispatch({ type: 'clearThread' })} title="Clear thread">
          Clear
        </button>
        <button onClick={() => setOpen(false)} title="Collapse">
          ×
        </button>
      </header>

      <div className="chat-scroll">
        {state.turns.map((t) => (
          <div key={t.id} id={`turn-${t.id}`} className={`turn turn-${t.role}`}>
            {t.label && <div className="turn-label">{t.label}</div>}
            <div className="turn-body">
              <ReactMarkdown>{blocksToText(t.blocks)}</ReactMarkdown>
            </div>
            {t.status === 'error' && <div className="turn-error">{t.error}</div>}
            {t.sources && t.sources.length > 0 && (
              <div className="box-sources">
                {t.sources.map((s) => (
                  <a key={s.url} href={s.url} target="_blank" rel="noreferrer">
                    {s.title}
                  </a>
                ))}
              </div>
            )}
            {t.role === 'assistant' && t.status !== 'streaming' && (
              <button className="turn-promote" onClick={() => onPromote(t.id)}>
                Send to canvas
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="chat-input">
        <input
          value={prompt}
          placeholder="Message Claude…"
          disabled={gen.busy}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send()
          }}
        />
        <button onClick={send} disabled={gen.busy || !prompt.trim()}>
          {gen.busy ? '…' : '↵'}
        </button>
      </div>
    </aside>
  )
}
```

- [ ] **Step 6: Append the chat styles to `src/styles.css`**

```css
.chat {
  display: flex; flex-direction: column;
  width: 360px; flex: 0 0 360px;
  background: #fff; border-left: 1px solid #d8d5cf;
}
.chat-head {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; border-bottom: 1px solid #eceae6;
}
.chat-head strong { flex: 1; }
.chat-count { font-size: 11px; color: #8a8580; }
.chat-head button { border: 0; background: none; cursor: pointer; color: #8a8580; font-size: 12px; }
.chat-scroll { flex: 1; overflow: auto; padding: 12px; }
.turn { margin-bottom: 14px; }
.turn-user .turn-body {
  background: #f2f0ec; border-radius: 10px; padding: 8px 10px;
}
.turn-label { font-size: 11px; color: #8a8580; margin-bottom: 3px; }
.turn-body p:first-child { margin-top: 0; }
.turn-body p:last-child { margin-bottom: 0; }
.turn-error { color: #8c2f22; font-size: 12px; margin-top: 4px; }
.turn-promote {
  margin-top: 6px; padding: 3px 8px; font-size: 11px;
  border: 1px solid #d8d5cf; border-radius: 999px; background: #fff; cursor: pointer;
}
.turn.is-highlit { outline: 2px solid #c2643c; outline-offset: 4px; border-radius: 6px; }
.chat-input { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #eceae6; }
.chat-input input { flex: 1; border: 1px solid #d8d5cf; border-radius: 999px; padding: 7px 12px; font: inherit; outline: none; }
.chat-input button { width: 30px; border: 0; border-radius: 50%; background: #c2643c; color: #fff; cursor: pointer; }
.chat-input button:disabled { background: #ddd9d3; }
.chat-reopen {
  position: absolute; right: 16px; top: 16px; z-index: 30;
  padding: 6px 12px; border: 1px solid #d8d5cf; border-radius: 999px;
  background: #fff; cursor: pointer;
}
.box-provenance {
  padding: 4px 12px; border-top: 1px solid #eceae6;
  font-size: 11px; color: #8a8580; cursor: pointer; background: none; border-left: 0; border-right: 0; border-bottom: 0; text-align: left;
}
```

- [ ] **Step 7a: Add the retry button and provenance chip to `src/canvas/TextBox.tsx`**

Add `onRetry` to the `Props` type, after `onSelect`:

```tsx
  onRetry: (id: string) => void
```

Add it to the destructured parameter list so the signature reads:

```tsx
export default function TextBox({
  box, viewport, selected, shadowText, dispatch,
  onDragStart, onResizeStart, onSelect, onRetry,
}: Props) {
```

Replace the single-line error row with one that offers a retry:

```tsx
      {box.status === 'error' && (
        <div className="box-errmsg">
          <span>{box.error}</span>
          {box.lastPrompt && (
            <button
              className="box-retry"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onRetry(box.id)}
            >
              Retry
            </button>
          )}
        </div>
      )}
```

Then insert the provenance chip immediately before the closing `{selected && HANDLES.map(...)}` expression:

```tsx
      {box.fromTurnId && (
        <button
          className="box-provenance"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            const el = document.getElementById(`turn-${box.fromTurnId}`)
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            el?.classList.add('is-highlit')
            setTimeout(() => el?.classList.remove('is-highlit'), 1600)
          }}
        >
          from chat ↗
        </button>
      )}
```

- [ ] **Step 7b: Thread `onRetry` through `src/canvas/Canvas.tsx`**

Change the component signature to accept and forward the callback:

```tsx
export default function Canvas({
  state, dispatch, onRetry,
}: { state: State; dispatch: (a: Action) => void; onRetry: (id: string) => void }) {
```

Then add the prop to the `<TextBox ... />` element, alongside `dispatch`:

```tsx
          onRetry={onRetry}
```

- [ ] **Step 7c: Add the error-row styles to `src/styles.css`**

Replace the existing `.box-errmsg` rule with:

```css
.box-errmsg {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; background: #fdecea; color: #8c2f22; font-size: 12px;
}
.box-errmsg span { flex: 1; }
.box-retry {
  padding: 2px 8px; font-size: 11px; cursor: pointer;
  border: 1px solid #e0b4ac; border-radius: 999px; background: #fff; color: #8c2f22;
}
```

- [ ] **Step 8: Wire everything together in `src/App.tsx`**

```tsx
import { useEffect, useReducer, useRef, useState } from 'react'
import Canvas from './canvas/Canvas'
import Omnibar from './Omnibar'
import ChatPanel from './chat/ChatPanel'
import { useGeneration } from './useGeneration'
import { reducer, initialState } from './state/store'
import { load, save } from './state/persist'
import { findFreeSlot, screenToWorld } from './canvas/geometry'
import { blocksToText } from './state/types'

const NEW_BOX = { w: 360, h: 260 }

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState, (s) => load() ?? s)
  const shellRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 1200, h: 800 })
  const gen = useGeneration(state, dispatch, size)

  useEffect(() => {
    const measure = () => {
      const el = shellRef.current
      if (el) setSize({ w: el.clientWidth, h: el.clientHeight })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ type: 'clearSelection' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Debounced autosave.
  useEffect(() => {
    const t = setTimeout(() => save(state), 500)
    return () => clearTimeout(t)
  }, [state])

  const promote = (turnId: string) => {
    const turn = state.turns.find((t) => t.id === turnId)
    if (!turn) return
    const center = screenToWorld({ x: size.w / 2, y: size.h / 2 }, state.viewport)
    const at = findFreeSlot(state.boxes, center, NEW_BOX)
    dispatch({
      type: 'addBox',
      box: {
        id: crypto.randomUUID(),
        x: at.x, y: at.y, w: NEW_BOX.w, h: NEW_BOX.h,
        blocks: [{ type: 'text', text: blocksToText(turn.blocks) }],
        render: 'markdown',
        status: 'idle',
        sources: turn.sources,
        fromTurnId: turn.id,
      },
    })
  }

  return (
    <div className="app">
      <div className="canvas-shell" ref={shellRef}>
        <Canvas state={state} dispatch={dispatch} onRetry={gen.retryBox} />
        <Omnibar state={state} gen={gen} />
      </div>
      <ChatPanel state={state} dispatch={dispatch} gen={gen} onPromote={promote} />
    </div>
  )
}
```

- [ ] **Step 9: Run the full test suite**

Run: `npm test`
Expected: PASS — all suites green (config, geometry, store, context, sources, stream, useGeneration, persist).

- [ ] **Step 10: Verify the full demo path by hand**

Run: `npm run dev`, open http://localhost:5173, and walk the demo exactly as it will be given:

1. Ask a question in the chat panel. Text streams in.
2. Ask a follow-up that depends on the first ("now shorter"). It should work — the thread is live.
3. Press **Send to canvas** on a reply. A box appears; its **from chat ↗** chip scrolls the panel back to that turn and flashes it.
4. Prompt the omnibar with nothing selected. A new box appears, and the panel shows the turn labelled *→ created a box*.
5. Select that box and prompt a rewrite. The panel shows *→ edited a box*.
6. Select two boxes and prompt a merge. The panel shows *→ used 2 boxes as context*.
7. Ask something needing current information. Source chips appear on the box and in the panel.
8. Stop the server (`Ctrl-C` in the server pane) and prompt again. The box shows an error with a **Retry** button. Restart the server, press Retry, and the box fills in.
9. Press **Clear**, then confirm a follow-up no longer resolves — proving the visible thread is the real thread.
10. Reload the page. Boxes, viewport, and conversation all return.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: chat panel, promote-to-canvas with provenance, and autosave"
```

---

## Done

At this point the spec is fully implemented: canvas with drag and resize, three omnibar modes, a chat panel sharing one visible conversation, web search with sources, shadow-buffered edits, and autosave. Out of scope by design, with the schema already shaped for them: image paste, HTML/iframe rendering, multiple canvases, and undo history.
