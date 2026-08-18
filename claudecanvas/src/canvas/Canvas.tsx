import { useCallback, useEffect, useRef, useState } from 'react'
import TextBox, { type Handle } from './TextBox'
import {
  screenToWorld, worldToScreen, zoomAt, rectsOverlap,
  type Point, type Rect,
} from './geometry'
import { isZoomWheel, panDeltaFromWheel, wheelUnitPx, findScrollableAncestor } from './wheel'
import { isImageFile } from '../lib/imagePaste'
import type { Action, State } from '../state/store'
import { MIN_BOX_W, MIN_BOX_H } from '../state/store'

type Drag =
  | { kind: 'none' }
  | { kind: 'pan'; last: Point }
  | { kind: 'move'; id: string; grab: Point; origin: Point }
  | { kind: 'resize'; id: string; handle: Handle; start: Rect; origin: Point }
  | { kind: 'marquee'; from: Point; to: Point }

export default function Canvas({
  state, dispatch, onRetry, autoEditId, onAutoEditConsumed, onDropImages,
}: {
  state: State
  dispatch: (a: Action) => void
  onRetry: (id: string) => void
  autoEditId?: string | null
  onAutoEditConsumed?: () => void
  /** Called with the dropped image files and the world point under the cursor. */
  onDropImages?: (files: File[], at: Point) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag>({ kind: 'none' })
  const [isDropping, setIsDropping] = useState(false)
  const dragDepth = useRef(0)
  const vp = state.viewport

  // The wheel listener below lives outside React's render closure (it must
  // be registered non-passively via a manual effect, see below), so it
  // can't just close over `vp` from this render - that would go stale after
  // the first pan/zoom. A ref kept in sync on every render gives it the
  // current viewport without re-subscribing the listener on every change.
  const vpRef = useRef(vp)
  useEffect(() => {
    vpRef.current = vp
  }, [vp])

  // Same idea, for the box-select/drag/resize callbacks below: they're
  // handed to TextBox (which is React.memo'd, see TextBox.tsx) and must
  // keep a stable identity across renders so memoization actually holds,
  // yet still need to read the *current* selection/boxes when a user
  // actually starts a drag - not whatever they were when the callback was
  // created. A ref mirror gives them that without depending on `state`.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const toWorld = (e: { clientX: number; clientY: number }): Point => {
    const rect = ref.current!.getBoundingClientRect()
    return screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top }, vp)
  }

  // A ref-based twin of `toWorld` with a stable identity, for the same
  // reason as `stateRef` above.
  const toWorldStable = useCallback((e: { clientX: number; clientY: number }): Point => {
    const rect = ref.current!.getBoundingClientRect()
    return screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top }, vpRef.current)
  }, [])

  const handleSelect = useCallback((e: React.PointerEvent, id: string) => {
    e.stopPropagation()
    if (e.shiftKey) dispatch({ type: 'toggleSelect', id })
    else if (!stateRef.current.selection.includes(id)) dispatch({ type: 'select', ids: [id] })
  }, [dispatch])

  const handleDragStart = useCallback((e: React.PointerEvent, id: string) => {
    e.stopPropagation()
    // Dragging by the header must also select, or the omnibar would still
    // be acting on whatever was selected before.
    if (!stateRef.current.selection.includes(id)) dispatch({ type: 'select', ids: [id] })
    const box = stateRef.current.boxes.find((x) => x.id === id)!
    setDrag({
      kind: 'move', id,
      grab: toWorldStable(e),
      origin: { x: box.x, y: box.y },
    })
  }, [dispatch, toWorldStable])

  const handleResizeStart = useCallback((e: React.PointerEvent, id: string, handle: Handle) => {
    const box = stateRef.current.boxes.find((x) => x.id === id)!
    setDrag({
      kind: 'resize', id, handle,
      start: { x: box.x, y: box.y, w: box.w, h: box.h },
      origin: toWorldStable(e),
    })
  }, [toWorldStable])

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

  // React's onWheel is registered passively, so preventDefault() there is a
  // silent no-op: a pinch would zoom the whole browser page, and a
  // horizontal two-finger swipe would trigger Chrome's back-navigation
  // gesture. A manual, non-passive listener is the only way to stop both.
  useEffect(() => {
    const el = ref.current
    if (!el) return

    function onWheelNative(e: WheelEvent) {
      try {
        // If the wheel event lands on (or bubbles from) a scrollable
        // ancestor inside a box - e.g. `.box-body` or the editing textarea
        // overflowing with a long streamed answer - and that ancestor still
        // has room to move in this direction, let the browser scroll it
        // natively instead of stealing the gesture for canvas pan/zoom. A
        // pinch/zoom gesture always wins regardless (handled inside the
        // helper), so a box can never swallow zoom.
        // TS doesn't narrow `el` across the nested-function boundary even
        // though it's a const captured after the null check above.
        const target = e.target instanceof Element ? e.target : null
        const scrollable = findScrollableAncestor(
          target, el!, (node) => node.parentElement, e.deltaX, e.deltaY, e,
        )
        if (scrollable) return

        e.preventDefault()
        const currentVp = vpRef.current
        if (isZoomWheel(e)) {
          const rect = el!.getBoundingClientRect()
          const point = { x: e.clientX - rect.left, y: e.clientY - rect.top }
          // Scale the zoom factor by the actual scroll magnitude rather than
          // a fixed step, so a trackpad's ~30-60 events per gesture produce
          // smooth zoom instead of slamming into MIN_ZOOM/MAX_ZOOM in a
          // dozen events.
          const unit = wheelUnitPx(e.deltaMode)
          const factor = Math.exp(-e.deltaY * unit * 0.002)
          dispatch({ type: 'setViewport', viewport: zoomAt(currentVp, point, factor) })
        } else {
          // Plain two-finger scroll pans instead, the standard convention
          // for canvas apps (Figma/Miro/Maps).
          const { dx, dy } = panDeltaFromWheel(e, currentVp.zoom)
          dispatch({
            type: 'setViewport',
            viewport: { ...currentVp, x: currentVp.x + dx, y: currentVp.y + dy },
          })
        }
      } catch {
        // A wheel-event quirk must never kill the listener.
      }
    }

    el.addEventListener('wheel', onWheelNative, { passive: false })
    return () => el.removeEventListener('wheel', onWheelNative)
    // dispatch is stable (useReducer); vp is read fresh via vpRef, so this
    // effect only needs to run once to attach the listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    dragDepth.current += 1
    setIsDropping(true)
  }

  const onDragOver = (e: React.DragEvent) => {
    // preventDefault() is required here or the browser just opens the file
    // instead of allowing a drop.
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
  }

  const onDragLeave = (e: React.DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setIsDropping(false)
  }

  const onDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    dragDepth.current = 0
    setIsDropping(false)
    const files = Array.from(e.dataTransfer.files).filter(isImageFile)
    if (files.length === 0 || !onDropImages) return
    onDropImages(files, toWorld(e))
  }

  return (
    <div
      ref={ref}
      className={`canvas${isDropping ? ' is-dropping' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
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
          onSelect={handleSelect}
          onDragStart={handleDragStart}
          onResizeStart={handleResizeStart}
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
