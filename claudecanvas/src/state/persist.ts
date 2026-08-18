import { DEFAULT_CHAT_WIDTH, type State } from './store'

export const STORAGE_KEY = 'claude-canvas:v1'

/**
 * The key this app wrote to when it was called Cove Canvas. `load` still falls
 * back to it so the rename doesn't greet existing users with an empty canvas,
 * and `save` clears it once the new key holds the same state.
 */
export const LEGACY_STORAGE_KEY = 'cove-canvas:v1'

/**
 * Strips every transient field a reload (or an undo/redo restoring an older
 * snapshot) must never resurrect: a half-written box parked mid-stream, an
 * in-flight rewrite buffer, a selection the user can no longer see. Shared by
 * `save` below and by state/history.ts, which runs undo/redo results through
 * it so restoring an older snapshot can never leave a box stuck showing
 * `status: 'streaming'` for a generation that has long since finished.
 */
export function sanitize(state: State): State {
  return {
    ...state,
    selection: [],
    shadow: {},
    thinking: {},
    boxes: state.boxes.map((b) => ({
      ...b,
      status: b.status === 'streaming' ? 'idle' : b.status,
    })),
    turns: state.turns.map((t) => ({ ...t, status: undefined })),
  }
}

/**
 * Persists canvas content and thread. Transient fields are dropped: a reload
 * must never restore a half-written box or a selection the user can't see.
 *
 * Returns whether the save actually landed. Quota-exceeded (a canvas full of
 * images can run well past localStorage's ~5MB budget) and private-mode
 * failures are caught rather than thrown - this module has no DOM/toast
 * access, so it reports the outcome and leaves surfacing it to the caller.
 */
export function save(state: State): boolean {
  const clean = sanitize(state)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean))
  } catch {
    return false
  }
  // Only after the new key is durably written. Dropping the legacy copy any
  // earlier would lose the canvas whenever that write failed, and keeping it
  // forever would permanently spend half of localStorage's ~5MB budget on a
  // stale duplicate. Its own failure must not turn a successful save into a
  // reported one, hence the separate try.
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    // Best-effort cleanup; the state itself is already saved.
  }
  return true
}

export function load(): State | null {
  try {
    // `??`, not `||`: a present-but-corrupt value under the current key should
    // fail closed rather than silently resurrect a stale pre-rename canvas.
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as State
    if (!Array.isArray(parsed.boxes)) return null
    // A save from before the chat panel became resizable has no chatWidth at
    // all - default it rather than resurrecting `undefined` into state.
    return { ...parsed, selection: [], shadow: {}, thinking: {}, chatWidth: parsed.chatWidth ?? DEFAULT_CHAT_WIDTH }
  } catch {
    return null
  }
}
