import { useRef, useState } from 'react'
import TextBox, { type Handle } from './TextBox'
import {
  screenToWorld, worldToScreen, zoomAt, rectsOverlap,
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
  state, dispatch, onRetry, autoEditId, onAutoEditConsumed,
}: {
  state: State
  dispatch: (a: Action) => void
  onRetry: (id: string) => void
  autoEditId?: string | null
  onAutoEditConsumed?: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag>({ kind: 'none' })
  const vp = state.viewport

  const toWorld = (e: React.PointerEvent | PointerEvent): Point => {
    const rect = ref.current!.getBoundingClientRect()
    return screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top }, vp)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const isPan = e.button === 1 || e.altKey
    // A box swallows plain clicks (select/drag/resize), but alt-drag and
    // middle-drag must still pan even when they start on top of a box, so
    // TextBox lets those through unstopped and we accept them here.
    if (e.target !== e.currentTarget && !isPan) return // a box handled it
    ref.current!.setPointerCapture(e.pointerId)
    // Alt or middle button pans; a plain drag on empty canvas marquee-selects.
    // Alt rather than space: space-drag would fight with typing in the omnibar.
    if (isPan) {
      setDrag({ kind: 'pan', last: { x: e.clientX, y: e.clientY } })
    } else {
      const w = toWorld(e)
      if (!e.shiftKey) dispatch({ type: 'clearSelection' })
      setDrag({ kind: 'marquee', from: w, to: w })
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (drag.kind === 'none') return

    // Belt and braces: if the pointer's button was released outside the
    // canvas subtree (missing our pointerup), buttons will read 0 here.
    // Treat that as a lost release and reset instead of letting the box
    // follow the cursor on plain hover.
    if (e.buttons === 0) {
      setDrag({ kind: 'none' })
      return
    }

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
    // Scale the zoom factor by the actual scroll magnitude rather than a
    // fixed step, so a trackpad's ~30-60 events per gesture produce smooth
    // zoom instead of slamming into MIN_ZOOM/MAX_ZOOM in a dozen events.
    // deltaMode normalises line (1) and page (2) units to pixels.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
    const factor = Math.exp(-e.deltaY * unit * 0.002)
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
          onRetry={onRetry}
          autoEdit={b.id === autoEditId}
          onAutoEditConsumed={onAutoEditConsumed}
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
      {drag.kind === 'marquee' && (() => {
        const a = worldToScreen(drag.from, vp)
        const b = worldToScreen(drag.to, vp)
        return (
          <div
            className="marquee"
            style={{
              left: Math.min(a.x, b.x),
              top: Math.min(a.y, b.y),
              width: Math.abs(b.x - a.x),
              height: Math.abs(b.y - a.y),
            }}
          />
        )
      })()}
    </div>
  )
}
