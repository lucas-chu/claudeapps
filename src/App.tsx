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
    const el = shellRef.current
    if (!el) return

    const measure = (w: number, h: number) => {
      if (w === 0 || h === 0) return
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }

    measure(el.clientWidth, el.clientHeight)

    const observer = new ResizeObserver(() => {
      measure(el.clientWidth, el.clientHeight)
    })
    observer.observe(el)
    return () => observer.disconnect()
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
