/**
 * Pure helpers for interpreting wheel events as either a pan or a zoom,
 * matching the standard canvas-app convention (Figma/Miro/Maps):
 *
 *  - Two-finger trackpad scroll (wheel, no ctrl/meta) -> pan.
 *  - Pinch (wheel + ctrlKey, which is how macOS reports a trackpad pinch)
 *    or ctrl/cmd + scroll (mouse users) -> zoom.
 *
 * Kept separate from Canvas.tsx so the delta math is unit-testable without
 * a DOM WheelEvent.
 */

export type WheelDelta = {
  deltaX: number
  deltaY: number
  deltaMode: number
}

export type WheelModifiers = {
  ctrlKey: boolean
  metaKey: boolean
}

/**
 * Normalises a WheelEvent's deltaMode to a pixel multiplier.
 * 0 = pixel (already pixels), 1 = line (~16px per line), 2 = page (~400px per page).
 */
export function wheelUnitPx(deltaMode: number): number {
  return deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1
}

/**
 * macOS reports a trackpad pinch gesture as a wheel event with `ctrlKey:
 * true`. We also treat `metaKey` as zoom so ⌘+scroll works for mouse users,
 * mirroring the ctrl+scroll convention on Windows/Linux.
 */
export function isZoomWheel(e: WheelModifiers): boolean {
  return e.ctrlKey || e.metaKey
}

/**
 * Converts a two-finger-scroll wheel event into a world-space pan delta.
 * Divides by `zoom` so the pan feels 1:1 with the fingers regardless of
 * current zoom level.
 */
export function panDeltaFromWheel(e: WheelDelta, zoom: number): { dx: number; dy: number } {
  const unit = wheelUnitPx(e.deltaMode)
  return { dx: (e.deltaX * unit) / zoom, dy: (e.deltaY * unit) / zoom }
}

/**
 * The subset of an Element's scroll geometry needed to decide whether a
 * wheel event would actually move its content. A real DOM `Element`
 * satisfies this shape directly; tests can pass plain objects instead.
 */
export type ScrollBox = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
}

// Subpixel/rounding tolerance: layout can leave scrollTop/scrollLeft a
// fraction of a pixel short of the true edge, which must still read as
// "pinned" rather than "has room".
const EDGE_EPSILON = 1

/**
 * True if `el` overflows in the wheel's direction AND isn't already pinned
 * at the edge the wheel is pushing toward - i.e. letting the browser handle
 * this event natively would actually scroll `el`'s content, rather than
 * being a no-op that should fall through to canvas panning instead.
 */
export function canElementScroll(el: ScrollBox, deltaX: number, deltaY: number): boolean {
  if (deltaY < 0 && el.scrollHeight > el.clientHeight && el.scrollTop > EDGE_EPSILON) {
    return true
  }
  if (
    deltaY > 0 &&
    el.scrollHeight > el.clientHeight &&
    el.scrollTop + el.clientHeight < el.scrollHeight - EDGE_EPSILON
  ) {
    return true
  }
  if (deltaX < 0 && el.scrollWidth > el.clientWidth && el.scrollLeft > EDGE_EPSILON) {
    return true
  }
  if (
    deltaX > 0 &&
    el.scrollWidth > el.clientWidth &&
    el.scrollLeft + el.clientWidth < el.scrollWidth - EDGE_EPSILON
  ) {
    return true
  }
  return false
}

/**
 * Walks from `start` up to (but not including) `boundary` via `getParent`,
 * looking for the nearest ancestor whose native scrolling can actually
 * consume this wheel event (see `canElementScroll`). Returns null - meaning
 * "let the canvas pan/zoom instead" - when no such ancestor exists.
 *
 * A pinch/zoom gesture (ctrl/meta held) always zooms the canvas, even when
 * the pointer sits over a scrollable box, so it short-circuits to null
 * before walking at all.
 */
export function findScrollableAncestor<T extends ScrollBox>(
  start: T | null,
  boundary: T | null,
  getParent: (el: T) => T | null,
  deltaX: number,
  deltaY: number,
  mods: WheelModifiers,
): T | null {
  if (isZoomWheel(mods)) return null
  let el = start
  while (el && el !== boundary) {
    if (canElementScroll(el, deltaX, deltaY)) return el
    el = getParent(el)
  }
  return null
}
