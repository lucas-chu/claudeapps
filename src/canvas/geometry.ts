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
