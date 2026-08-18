import { useCallback, useEffect, useRef } from 'react'
import { Excalidraw, exportToCanvas, getNonDeletedElements } from '@excalidraw/excalidraw'
// Excalidraw ships its own stylesheet; importing it here (inside the
// lazy-loaded chunk) rather than at the app's top level keeps it out of the
// initial page load for canvases that never touch a drawing box.
import '@excalidraw/excalidraw/index.css'
import type { AppState, BinaryFiles, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types'
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { downscaleToDataUrl } from '../lib/imagePaste'
import type { Action } from '../state/store'
import type { Block, Box } from '../state/types'

/** Excalidraw's onChange fires on every pointer move while drawing - this is
 * how long a pause has to last before an edit is committed to state (and a
 * new preview exported), so a stroke-in-progress never thrashes the reducer
 * or autosave. */
const DEBOUNCE_MS = 500

/** Matches the 1280px-long-edge convention used for pasted images. */
const PREVIEW_MAX_EDGE = 1280

/**
 * Allowlist of AppState fields worth round-tripping into persisted state.
 * The full AppState Excalidraw hands back on every change also carries a
 * `collaborators` Map, a `fileHandle`, and a lot of per-render UI scratch
 * (open menus, the element mid-edit, ...) - none of that is serialisable or
 * worth keeping, so only "how the drawing looks" survives a save.
 */
const PERSISTED_APP_STATE_KEYS = [
  'viewBackgroundColor',
  'currentItemStrokeColor',
  'currentItemBackgroundColor',
  'currentItemFillStyle',
  'currentItemStrokeWidth',
  'currentItemStrokeStyle',
  'currentItemRoughness',
  'currentItemOpacity',
  'currentItemFontFamily',
  'currentItemFontSize',
  'currentItemTextAlign',
  'gridSize',
  'gridModeEnabled',
  'zoom',
  'scrollX',
  'scrollY',
] as const satisfies readonly (keyof AppState)[]

type PersistedAppState = Pick<AppState, (typeof PERSISTED_APP_STATE_KEYS)[number]>

// Written as an explicit literal rather than a loop over
// PERSISTED_APP_STATE_KEYS: TS can't correlate a loop variable's read key
// with its write key well enough to type each assignment, but the return
// type above still forces this to list exactly those keys - add one there
// and TS will complain here until it's added below too, and vice versa.
function sanitizeAppState(appState: AppState): PersistedAppState {
  return {
    viewBackgroundColor: appState.viewBackgroundColor,
    currentItemStrokeColor: appState.currentItemStrokeColor,
    currentItemBackgroundColor: appState.currentItemBackgroundColor,
    currentItemFillStyle: appState.currentItemFillStyle,
    currentItemStrokeWidth: appState.currentItemStrokeWidth,
    currentItemStrokeStyle: appState.currentItemStrokeStyle,
    currentItemRoughness: appState.currentItemRoughness,
    currentItemOpacity: appState.currentItemOpacity,
    currentItemFontFamily: appState.currentItemFontFamily,
    currentItemFontSize: appState.currentItemFontSize,
    currentItemTextAlign: appState.currentItemTextAlign,
    gridSize: appState.gridSize,
    gridModeEnabled: appState.gridModeEnabled,
    zoom: appState.zoom,
    scrollX: appState.scrollX,
    scrollY: appState.scrollY,
  }
}

type DrawingBlock = Extract<Block, { type: 'drawing' }>

export default function ExcalidrawScene({
  box, dispatch,
}: {
  box: Box
  dispatch: (a: Action) => void
}) {
  const drawingBlock = box.blocks.find((b): b is DrawingBlock => b.type === 'drawing')

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const filesRef = useRef<BinaryFiles>({})
  // Tracks the last successfully-exported preview so a failed export (rare,
  // e.g. mid-navigation) commits the edit without regressing an existing
  // preview back to nothing.
  const lastPreviewRef = useRef<string | undefined>(drawingBlock?.preview)

  // Excalidraw only consumes `initialData` once, at mount - freezing it in a
  // ref (rather than recomputing from `box` on every render) guarantees that
  // our own debounced dispatch below, which writes these same elements back
  // into `box.blocks`, can never feed back in and reset the live scene the
  // user is actively drawing on.
  const initialDataRef = useRef<ExcalidrawInitialDataState>({
    elements: (drawingBlock?.elements ?? []) as unknown as ExcalidrawInitialDataState['elements'],
    appState: (drawingBlock?.appState ?? {}) as unknown as ExcalidrawInitialDataState['appState'],
    scrollToContent: true,
  })

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const commit = useCallback(
    async (elements: readonly OrderedExcalidrawElement[], appState: AppState) => {
      // Deleted elements are Excalidraw's own undo tombstones - dropping
      // them keeps persisted state (and localStorage) from growing forever
      // across a long editing session, and matches exportToCanvas's own
      // NonDeleted<...> element type below.
      const nonDeleted = getNonDeletedElements(elements)
      const sanitized = sanitizeAppState(appState)
      const elementsForState = Array.from(nonDeleted) as unknown[]

      // Nothing drawn yet: commit the (empty) elements so the box round-trips
      // cleanly, but there is nothing meaningful to preview.
      if (nonDeleted.length === 0) {
        dispatch({ type: 'setBoxDrawing', id: box.id, elements: elementsForState, appState: sanitized })
        return
      }

      try {
        const canvas = await exportToCanvas({
          elements: nonDeleted,
          appState: { ...appState, exportBackground: true },
          files: filesRef.current,
        })
        const { data } = downscaleToDataUrl(canvas, canvas.width, canvas.height, {
          maxEdge: PREVIEW_MAX_EDGE,
          mime: 'image/png',
        })
        lastPreviewRef.current = data
      } catch (err) {
        // Preview export is best-effort: a failure must never drop the
        // user's edit, it just leaves the preview stale for this round.
        console.warn('[drawing] preview export failed', err)
      }

      dispatch({
        type: 'setBoxDrawing',
        id: box.id,
        elements: elementsForState,
        appState: sanitized,
        preview: lastPreviewRef.current,
      })
    },
    [box.id, dispatch],
  )

  const onChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      filesRef.current = files
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        void commit(elements, appState)
      }, DEBOUNCE_MS)
    },
    [commit],
  )

  return (
    <div className="drawing-canvas">
      <Excalidraw initialData={initialDataRef.current} onChange={onChange} />
    </div>
  )
}
