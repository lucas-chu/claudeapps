import { useEffect, useReducer, useRef, useState } from 'react'
import Canvas from './canvas/Canvas'
import Omnibar from './Omnibar'
import ChatPanel from './chat/ChatPanel'
import { useGeneration } from './useGeneration'
import { reducer, initialState, MIN_BOX_W, MIN_BOX_H } from './state/store'
import { load, save } from './state/persist'
import { findCenterSlot } from './canvas/geometry'
import { blocksToText } from './state/types'
import { fileToDownscaledDataUrl } from './lib/imagePaste'

const NEW_BOX = { w: 360, h: 260 }
const PASTED_IMAGE_MAX_W = 420

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState, (s) => load() ?? s)
  const shellRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 1200, h: 800 })
  const [autoEditId, setAutoEditId] = useState<string | null>(null)
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
    const at = findCenterSlot(state.boxes, state.viewport, size, NEW_BOX)
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

  // "+ New box": an empty box the user can start typing into immediately,
  // so boxes aren't only creatable by prompting the model.
  const addEmptyBox = () => {
    const at = findCenterSlot(state.boxes, state.viewport, size, NEW_BOX)
    const id = crypto.randomUUID()
    dispatch({
      type: 'addBox',
      box: {
        id,
        x: at.x, y: at.y, w: NEW_BOX.w, h: NEW_BOX.h,
        blocks: [{ type: 'text', text: '' }],
        render: 'markdown',
        status: 'idle',
      },
    })
    setAutoEditId(id)
  }

  // Pasting an image anywhere in the app drops a new box on the canvas,
  // downscaled first so autosave never risks blowing the localStorage quota.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items
      if (!items) return
      let imageFile: File | null = null
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const f = item.getAsFile()
          if (f) {
            imageFile = f
            break
          }
        }
      }
      if (!imageFile) return
      e.preventDefault()

      fileToDownscaledDataUrl(imageFile)
        .then(({ data, mime, width, height }) => {
          const aspect = height > 0 ? width / height : 1
          const w = Math.max(MIN_BOX_W, Math.min(PASTED_IMAGE_MAX_W, width))
          const h = Math.max(MIN_BOX_H, w / aspect)
          const at = findCenterSlot(state.boxes, state.viewport, size, { w, h })
          dispatch({
            type: 'addBox',
            box: {
              id: crypto.randomUUID(),
              x: at.x, y: at.y, w, h,
              blocks: [{ type: 'image', mime, data }],
              render: 'markdown',
              status: 'idle',
              title: 'Pasted image',
              titleEdited: true,
            },
          })
        })
        .catch(() => {
          // Not a decodable image: ignore quietly, no crash, no error box.
        })
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [state.boxes, state.viewport, size])

  return (
    <div className="app">
      <div className="canvas-shell" ref={shellRef}>
        <Canvas
          state={state}
          dispatch={dispatch}
          onRetry={gen.retryBox}
          autoEditId={autoEditId}
          onAutoEditConsumed={() => setAutoEditId(null)}
        />
        <button className="new-box-btn" onClick={addEmptyBox}>
          + New box
        </button>
        <Omnibar state={state} gen={gen} />
      </div>
      <ChatPanel state={state} dispatch={dispatch} gen={gen} onPromote={promote} />
    </div>
  )
}
