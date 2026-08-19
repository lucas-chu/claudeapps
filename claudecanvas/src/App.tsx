import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import Canvas from './canvas/Canvas'
import Omnibar from './Omnibar'
import ChatPanel from './chat/ChatPanel'
import { useGeneration, BOX_BUSY_MESSAGE } from './useGeneration'
import { initialState, MIN_BOX_W, MIN_BOX_H, type Action } from './state/store'
import { historyReducer, initialHistoryState, isUndoable, canUndo, canRedo } from './state/history'
import { load, save } from './state/persist'
import {
  findCenterSlot, findFreeSlot, screenToWorld, fitViewport, resetViewport,
  type Point, type Rect,
} from './canvas/geometry'
import { blocksToText } from './state/types'
import { fileToDownscaledDataUrl, sortImageCandidates, isImageFile } from './lib/imagePaste'
import ApiKeyDialog from './ApiKeyDialog'
import { loadApiKey } from './state/apiKey'
import {
  loadSettings, saveSettings, EFFORT_LABELS, type Effort, type Settings,
} from './state/settings'

const NEW_BOX = { w: 360, h: 260 }
// Drawing needs more room than a text box to be usable.
const NEW_DRAWING_BOX = { w: 480, h: 360 }
const PASTED_IMAGE_MAX_W = 420
// A runaway drag-and-drop (e.g. an entire folder) shouldn't flood the
// canvas with boxes, so every image-adding path shares this cap.
const MAX_IMAGES_PER_ADD = 5

/** Native text-undo (browser-handled) must win inside a text field, and
 * Excalidraw's own undo must win inside a drawing box - both cases are
 * detected purely from the event target, no app state involved. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

/** Excalidraw renders its whole UI (including the drawing surface itself,
 * which isn't a text field) under a `.excalidraw` root and keeps its own
 * undo stack. A ⌘Z/Ctrl+Z whose target lands anywhere in that subtree - a
 * drawn shape has focus, not a text field - must be left for Excalidraw to
 * handle, not hijacked by the canvas-level shortcut below. */
function isInsideExcalidraw(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.excalidraw') !== null
}

export default function App() {
  // History wraps the plain box/canvas reducer (see state/history.ts) rather
  // than replacing it - `state` below is always the same `State` shape every
  // other component already expects, so only this component and the
  // undo/redo plumbing need to know history exists.
  const [history, dispatchRaw] = useReducer(historyReducer, initialState, (s) =>
    initialHistoryState(load() ?? s),
  )
  const state = history.present
  // Stamps `at: Date.now()` onto undoable actions so history.ts's coalescing
  // can compare timestamps without ever calling Date.now() itself - that
  // keeps historyReducer pure and lets tests drive coalescing deterministically
  // by passing `at` directly. Every other call site (Canvas, TextBox,
  // useGeneration, ...) is untouched: they still just build a plain Action.
  const dispatch = useCallback((action: Action) => {
    dispatchRaw(isUndoable(action.type) ? { ...action, at: action.at ?? Date.now() } : action)
  }, [])
  const undo = useCallback(() => dispatchRaw({ type: 'undo' }), [])
  const redo = useCallback(() => dispatchRaw({ type: 'redo' }), [])
  const shellRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [size, setSize] = useState({ w: 1200, h: 800 })
  // Viewport changes are never undoable (see state/history.ts), so these go
  // straight through `dispatch` like every other pan/zoom - no `at` stamping
  // needed since setViewport isn't in the undoable set.
  const resetView = useCallback(() => {
    dispatch({ type: 'setViewport', viewport: resetViewport() })
  }, [dispatch])
  const fitView = useCallback(() => {
    dispatch({ type: 'setViewport', viewport: fitViewport(state.boxes, size) })
  }, [dispatch, state.boxes, size])
  const [autoEditId, setAutoEditId] = useState<string | null>(null)
  // Stable identity: passed down to the React.memo'd TextBox (via Canvas),
  // so a fresh closure every render would defeat that memoization for every
  // box, not just the one being auto-edited.
  const clearAutoEdit = useCallback(() => setAutoEditId(null), [])
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // No key means nothing can be generated, so the dialog opens as a gate on
  // first run and is not dismissible until one is saved. Afterwards it's an
  // ordinary settings dialog reachable from the toolbar.
  const [hasKey, setHasKey] = useState(() => loadApiKey() !== null)
  const [keyDialogOpen, setKeyDialogOpen] = useState(() => loadApiKey() === null)

  // Effort and speed are spending decisions on the visitor's own key, so they
  // are explicit controls rather than something the app picks for them.
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      saveSettings(next)
      return next
    })
  }, [])
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
  const gen = useGeneration(
    state, dispatch, size,
    () => showToast(BOX_BUSY_MESSAGE),
    (message) => showToast(message),
  )
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
      if (e.key === 'Escape') {
        dispatch({ type: 'clearSelection' })
        return
      }

      const mod = e.metaKey || e.ctrlKey

      // View-reset / zoom-to-fit, following the Figma/Sketch conventions:
      // Cmd/Ctrl+0 resets to 100%, Cmd/Ctrl+Shift+1 (or plain Shift+1) fits
      // every box in view. `e.code` (the physical key) rather than `e.key`
      // is required for the digit check - on a US layout Shift+1 reports
      // e.key as '!', not '1'. Same editable-target guard as undo/redo
      // below, and preventDefault() only fires once a shortcut is actually
      // handled.
      if (e.code === 'Digit0' && mod) {
        if (isEditableTarget(e.target) || isInsideExcalidraw(e.target)) return
        e.preventDefault()
        resetView()
        return
      }
      if (e.code === 'Digit1' && e.shiftKey) {
        if (isEditableTarget(e.target) || isInsideExcalidraw(e.target)) return
        e.preventDefault()
        fitView()
        return
      }

      if (!mod) return
      const key = e.key.toLowerCase()
      if (key !== 'z' && !(key === 'y' && e.ctrlKey)) return

      // Typing in a text field: let the browser's native text-undo handle
      // it. A drawing box: let Excalidraw's own undo handle it (it has
      // focus inside its own canvas, not a text field, so this needs a
      // separate check from the one above). Either way, don't touch
      // dispatch and don't preventDefault - only handle it if we actually
      // handle it.
      if (isEditableTarget(e.target) || isInsideExcalidraw(e.target)) return

      if (key === 'y') {
        e.preventDefault()
        redo()
      } else if (e.shiftKey) {
        e.preventDefault()
        redo()
      } else {
        e.preventDefault()
        undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dispatch, undo, redo, resetView, fitView])

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

  // "Draw": an empty drawing box, sized larger than a text box since drawing
  // needs room. addBox already selects it; unlike "+ New box" it never
  // enters the markdown editor (see TextBox's drawingOnly guard), so there is
  // no autoEdit to set here. titleEdited is set up front so auto-titling
  // (which only fires after a text generation completes) never touches it.
  const addDrawingBox = () => {
    const at = findCenterSlot(state.boxes, state.viewport, size, NEW_DRAWING_BOX)
    dispatch({
      type: 'addBox',
      box: {
        id: crypto.randomUUID(),
        x: at.x, y: at.y,
        w: Math.max(MIN_BOX_W, NEW_DRAWING_BOX.w),
        h: Math.max(MIN_BOX_H, NEW_DRAWING_BOX.h),
        blocks: [{ type: 'drawing', elements: [] }],
        render: 'markdown',
        status: 'idle',
        title: 'Drawing',
        titleEdited: true,
      },
    })
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
          onRun={(id) => {
            const box = state.boxes.find((b) => b.id === id)
            if (box) void gen.runBoxAsPrompt(box)
          }}
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
          <button className="draw-btn" onClick={addDrawingBox}>
            Draw
          </button>
          <button
            className="undo-btn"
            onClick={undo}
            disabled={!canUndo(history)}
            title="Undo (⌘Z / Ctrl+Z)"
          >
            Undo
          </button>
          <button
            className="redo-btn"
            onClick={redo}
            disabled={!canRedo(history)}
            title="Redo (⌘⇧Z / Ctrl+Shift+Z / Ctrl+Y)"
          >
            Redo
          </button>
          <button
            className="zoom-btn"
            onClick={resetView}
            title="Reset zoom to 100% (⌘0 / Ctrl+0)"
          >
            {Math.round(state.viewport.zoom * 100)}%
          </button>
          <button
            className="fit-btn"
            onClick={fitView}
            title="Zoom to fit (⌘⇧1 / Ctrl+Shift+1 / ⇧1)"
          >
            Fit
          </button>
          <select
            className="effort-select"
            value={settings.effort}
            onChange={(e) => updateSettings({ effort: e.target.value as Effort })}
            title="How hard Claude thinks. Higher costs more tokens; Auto leaves it to the API."
          >
            {(Object.keys(EFFORT_LABELS) as Effort[]).map((e) => (
              <option key={e} value={e}>
                {EFFORT_LABELS[e]}
              </option>
            ))}
          </select>
          <button
            className={`fast-btn${settings.speed === 'fast' ? ' is-on' : ''}`}
            onClick={() =>
              updateSettings({ speed: settings.speed === 'fast' ? 'standard' : 'fast' })
            }
            title="Fast mode: up to 2.5x faster output, billed at a premium rate"
          >
            Fast
          </button>
          <button
            className="key-btn"
            onClick={() => setKeyDialogOpen(true)}
            title="Your Anthropic API key"
          >
            Key
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
      {keyDialogOpen && (
        <ApiKeyDialog
          dismissible={hasKey}
          onClose={() => setKeyDialogOpen(false)}
          onSaved={() => {
            const key = loadApiKey()
            setHasKey(key !== null)
            // "Forget key" also lands here; without a key the gate must return.
            setKeyDialogOpen(key === null)
          }}
        />
      )}
    </div>
  )
}
