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
