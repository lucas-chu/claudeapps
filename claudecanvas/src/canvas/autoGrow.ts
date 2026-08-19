/**
 * Ceiling (world px) on how tall a box will grow itself while streaming.
 * Past this the body goes back to scrolling: an essay-length answer that grew
 * to fit would tower over the rest of the canvas and shove every neighbouring
 * box out of the viewport.
 */
export const MAX_AUTO_GROW_H = 720

/** Overflow at or below this is layout rounding, not clipped text. */
export const GROW_EPSILON_PX = 2

/**
 * Height (world px) a box should grow to so `overflowPx` of clipped content
 * becomes visible, or null when the box should be left alone.
 *
 * `overflowPx` is measured on screen (`scrollHeight - clientHeight` of the
 * scrolling body), so it is divided by zoom to land back in the world
 * coordinates boxes are stored in - the conversion belongs here rather than
 * scattered into the component, same reasoning as the rest of this directory.
 *
 * Only ever returns a height above `boxH`. Shrinking a box mid-stream (a
 * chunk that reflows into fewer lines, a zoom-in that widens the text column)
 * would make the text the user is reading jump around, so growth is one-way
 * and a shrink is simply "leave it alone".
 */
export function autoGrowHeight(
  boxH: number,
  overflowPx: number,
  zoom: number,
  maxH: number = MAX_AUTO_GROW_H,
): number | null {
  if (!Number.isFinite(boxH) || !Number.isFinite(overflowPx)) return null
  // A zero or negative zoom would divide the world height to infinity.
  if (!Number.isFinite(zoom) || zoom <= 0) return null
  if (overflowPx <= GROW_EPSILON_PX) return null
  if (boxH >= maxH) return null

  const next = Math.min(maxH, boxH + overflowPx / zoom)
  return next - boxH > GROW_EPSILON_PX ? next : null
}
