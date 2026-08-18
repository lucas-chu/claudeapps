import { lazy, Suspense } from 'react'
import type { Action } from '../state/store'
import type { Box } from '../state/types'

/**
 * Excalidraw (plus its bundled fonts/CSS) is a large dependency, so it is
 * only fetched once a drawing box actually needs to render, via a dynamic
 * import - the main bundle, and every canvas that never creates a drawing,
 * stays untouched by it. See ExcalidrawScene.tsx for the component this
 * resolves to and vite's chunk output (verified via `npx vite build`) for
 * confirmation it lands in its own file.
 */
const ExcalidrawScene = lazy(() => import('./ExcalidrawScene'))

/** Renders a drawing-only box's body: the real Excalidraw canvas, lazy-loaded. */
export default function DrawingBox({
  box, dispatch,
}: {
  box: Box
  dispatch: (a: Action) => void
}) {
  return (
    <Suspense fallback={<div className="drawing-loading">Loading…</div>}>
      <ExcalidrawScene box={box} dispatch={dispatch} />
    </Suspense>
  )
}
