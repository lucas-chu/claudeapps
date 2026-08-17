import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import Canvas from './canvas/Canvas'
import Omnibar from './Omnibar'
import ChatPanel from './chat/ChatPanel'
import { useGeneration, BOX_BUSY_MESSAGE } from './useGeneration'
import { reducer, initialState, MIN_BOX_W, MIN_BOX_H } from './state/store'
import { load, save } from './state/persist'
import { findCenterSlot, findFreeSlot, screenToWorld, type Point, type Rect } from './canvas/geometry'
import { blocksToText } from './state/types'
import { fileToDownscaledDataUrl, sortImageCandidates, isImageFile } from './lib/imagePaste'

const NEW_BOX = { w: 360, h: 260 }
const PASTED_IMAGE_MAX_W = 420
// A runaway drag-and-drop (e.g. an entire folder) shouldn't flood the
// canvas with boxes, so every image-adding path shares this cap.
const MAX_IMAGES_PER_ADD = 5

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState, (s) => load() ?? s)
  const shellRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [size, setSize] = useState({ w: 1200, h: 800 })
  const [autoEditId, setAutoEditId] = useState<string | null>(null)
  // Stable identity: passed down to the React.memo'd TextBox (via Canvas),
  // so a fresh closure every render would defeat that memoization for every
  // box, not just the one being auto-edited.
  const clearAutoEdit = useCallback(() => setAutoEditId(null), [])
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Latches once autosave starts failing (e.g. localStorage quota exceeded
  // by a canvas full of images), so the toast fires once per failure streak
  // instead of every 500ms, and clears again the moment a save succeeds.
  const autosaveFailing = useRef(false)

  const showToast = (message: string) => {
    setToast(message)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2000)
  }
  // A prompt that targets a box already mid-generation is declined rather
  // than queued or interleaved (see useGeneration's same-box guard) — this
  // is how the user finds out why nothing happened.
  const gen = useGeneration(state, dispatch, size, () => showToast(BOX_BUSY_MESSAGE))
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
  }, [])

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

  // Canvas has its own dragover/drop handlers (drop-position-follows-cursor,
  // the .is-dropping affordance), but everything else on the page - the
  // toolbar, the "Add image" button, the omnibar, the chat panel - has none.
  // Without a default-preventing catch-all, a drop anywhere out there falls
  // through to the browser's native behavior and navigates the whole tab
  // away to the dropped file. These listen on `document` in the bubble
  // phase, so a drop on .canvas itself is already handled by React's
  // synthetic handlers (attached lower, on the app root) before it gets
  // here - this is strictly a safety net for drops everywhere else.
  useEffect(() => {
    const onDocumentDragOver = (e: DragEvent) => e.preventDefault()
    const onDocumentDrop = (e: DragEvent) => e.preventDefault()
    document.addEventListener('dragover', onDocumentDragOver)
    document.addEventListener('drop', onDocumentDrop)
    return () => {
      document.removeEventListener('dragover', onDocumentDragOver)
      document.removeEventListener('drop', onDocumentDrop)
    }
  }, [])

  // Debounced autosave. A canvas with a couple dozen images can exceed
  // localStorage's ~5MB quota; when that happens, save() reports it rather
  // than silently swallowing it, so the user gets a toast instead of a
  // reload that quietly discards every unsaved change since the last
  // successful save.
  useEffect(() => {
    const t = setTimeout(() => {
      if (save(state)) {
        autosaveFailing.current = false
      } else if (!autosaveFailing.current) {
        autosaveFailing.current = true
        showToast('Canvas too large to autosave')
      }
    }, 500)
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

  // Shared by every image-adding path (paste, drag-and-drop, the "Add
  // image" button) so behavior - downscaling, sizing, free-slot placement,
  // titling, selection, feedback - can never diverge between them.
  // `at` is a world point (e.g. under a drop's cursor); when omitted, images
  // land centred in the current viewport, same as every other box-creation
  // path in this app.
  /**
   * `mode` distinguishes the two ways callers supply files:
   *  - 'separate'     : drop / file-picker. Each file is a different image, so
   *                     every one gets its own box.
   *  - 'alternatives' : paste. The clipboard hands over ONE image in several
   *                     formats, so these are fallbacks for each other — try
   *                     them in order and stop at the first that decodes.
   */
  async function addImageBoxes(
    files: File[],
    at?: Point,
    title = 'Image',
    mode: 'separate' | 'alternatives' = 'separate',
  ) {
    const candidates = sortImageCandidates(files.filter(isImageFile))
    const images = mode === 'alternatives' ? candidates : candidates.slice(0, MAX_IMAGES_PER_ADD)
    if (images.length === 0) return
    const attempted: string[] = []

    const center = at ?? screenToWorld({ x: size.w / 2, y: size.h / 2 }, state.viewport)
    let placed: Rect[] = state.boxes
    let successCount = 0
    let failureCount = 0

    for (const file of images) {
      attempted.push(file.type || 'unknown')
      try {
        const { data, mime, width, height } = await fileToDownscaledDataUrl(file)
        const aspect = height > 0 ? width / height : 1
        const w = Math.max(MIN_BOX_W, Math.min(PASTED_IMAGE_MAX_W, width))
        const h = Math.max(MIN_BOX_H, w / aspect)
        const pos = findFreeSlot(placed, center, { w, h })
        dispatch({
          type: 'addBox',
          box: {
            id: crypto.randomUUID(),
            x: pos.x, y: pos.y, w, h,
            blocks: [{ type: 'image', mime, data }],
            render: 'markdown',
            status: 'idle',
            title,
            titleEdited: true,
          },
        })
        // addBox already selects the box it creates, so the last one added
        // ends up selected - unmistakable feedback that something happened.
        placed = [...placed, { x: pos.x, y: pos.y, w, h }]
        successCount++
        // Clipboard flavours are alternatives for one image, so one success
        // is the whole job — keep going and we'd add duplicate boxes.
        if (mode === 'alternatives') break
      } catch (err) {
        failureCount++
        // Log the real reason: the toast has to stay short, but without this
        // a decode failure is undiagnosable from the outside.
        console.warn('[image] could not decode', file.type, err)
      }
    }

    if (successCount > 0) showToast('Image added')
    else if (failureCount > 0) showToast(`Couldn't read image (${attempted.join(', ')})`)
  }

  // Pasting an image anywhere in the app drops a new box on the canvas.
  // Registered on `document` in the capture phase, ahead of any other
  // handler that might otherwise swallow the event first, and wrapped in
  // try/catch so a real-world clipboard quirk can never silently kill the
  // listener.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      try {
        const cd = e.clipboardData
        if (!cd) return

        // Gather EVERY image flavour the clipboard offers, not just the first.
        // The macOS clipboard routinely lists the same image as several types
        // and often puts an undecodable one (image/tiff) first, so stopping at
        // the first match made paste fail with a usable PNG right behind it.
        const candidates: File[] = []
        const seen = new Set<string>()
        const add = (f: File | null) => {
          if (!f || !isImageFile(f)) return
          const key = `${f.type}:${f.size}`
          if (seen.has(key)) return
          seen.add(key)
          candidates.push(f)
        }

        // Browsers differ on which of these they populate; read both.
        if (cd.items) {
          for (const item of cd.items) {
            if (item.kind === 'file') add(item.getAsFile())
          }
        }
        if (cd.files) for (const f of cd.files) add(f)

        if (candidates.length === 0) {
          // Nothing usable. Log what the clipboard *did* carry so an
          // unsupported source can be identified rather than guessed at.
          console.warn('[image] paste carried no image file; types:', cd.types)
          return
        }
        e.preventDefault()
        void addImageBoxes(candidates, undefined, 'Pasted image', 'alternatives')
      } catch {
        // A clipboard quirk must never kill the listener.
      }
    }
    document.addEventListener('paste', onPaste, true)
    return () => document.removeEventListener('paste', onPaste, true)
  }, [addImageBoxes])

  const openFilePicker = () => fileInputRef.current?.click()

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // reset so selecting the same file twice still fires change
    if (files.length > 0) void addImageBoxes(files)
  }

  return (
    <div className="app">
      <div className="canvas-shell" ref={shellRef}>
        <Canvas
          state={state}
          dispatch={dispatch}
          onRetry={gen.retryBox}
          autoEditId={autoEditId}
          onAutoEditConsumed={clearAutoEdit}
          onDropImages={(files, at) => void addImageBoxes(files, at)}
        />
        <div className="canvas-toolbar">
          <button className="new-box-btn" onClick={addEmptyBox}>
            + New box
          </button>
          <button className="add-image-btn" onClick={openFilePicker}>
            Add image
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={onFileInputChange}
        />
        {toast && <div className="toast">{toast}</div>}
        <Omnibar state={state} gen={gen} />
      </div>
      <ChatPanel state={state} dispatch={dispatch} gen={gen} onPromote={promote} />
    </div>
  )
}
