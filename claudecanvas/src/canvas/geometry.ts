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

/**
 * Finds a free slot for a new box centred in the current viewport. Shared by
 * every box-creation path (omnibar generation, chat "send to canvas", the
 * "+ New box" button, pasted images) so the centring math lives in one place.
 */
export function findCenterSlot(
  boxes: Rect[],
  viewport: Viewport,
  viewportSize: Size,
  size: Size,
  gap = 24,
): Point {
  const center = screenToWorld({ x: viewportSize.w / 2, y: viewportSize.h / 2 }, viewport)
  return findFreeSlot(boxes, center, size, gap)
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

/** 100% zoom, world origin at the screen's top-left corner. Used both as the
 * explicit "reset view" target and as fitViewport's fallback when there's
 * nothing to fit - a fresh object every call, since callers may hold onto it
 * as part of a Viewport they later mutate-by-replacement. */
export function resetViewport(): Viewport {
  return { x: 0, y: 0, zoom: 1 }
}

/** Comfortable default margin (screen px) around a fitted bounding box. */
export const FIT_MARGIN = 40

export type FitViewportOpts = { margin?: number }

/**
 * Computes the viewport that frames every box's combined bounding rect,
 * centred in a viewport of `viewportSize` with a comfortable margin around
 * the edges. Clamped to MIN_ZOOM/MAX_ZOOM, and additionally never zooms in
 * past 1 (100%) - filling the screen with one tiny box is disorienting, so a
 * small canvas is simply centred at 100% rather than magnified. With no
 * boxes, behaves exactly like `resetViewport()`.
 */
export function fitViewport(
  boxes: Rect[],
  viewportSize: Size,
  opts: FitViewportOpts = {},
): Viewport {
  if (boxes.length === 0) return resetViewport()

  const margin = opts.margin ?? FIT_MARGIN

  const minX = Math.min(...boxes.map((b) => b.x))
  const minY = Math.min(...boxes.map((b) => b.y))
  const maxX = Math.max(...boxes.map((b) => b.x + b.w))
  const maxY = Math.max(...boxes.map((b) => b.y + b.h))
  // Guard against a degenerate (zero-area) bounding box turning into an
  // infinite zoom below.
  const width = Math.max(maxX - minX, 1)
  const height = Math.max(maxY - minY, 1)

  const availW = Math.max(viewportSize.w - margin * 2, 1)
  const availH = Math.max(viewportSize.h - margin * 2, 1)

  const rawZoom = Math.min(availW / width, availH / height)
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(rawZoom, 1)))

  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2

  return {
    zoom,
    x: centerX - viewportSize.w / 2 / zoom,
    y: centerY - viewportSize.h / 2 / zoom,
  }
}
