import { DEFAULT_CHAT_WIDTH, type State } from './store'

export const STORAGE_KEY = 'cove-canvas:v1'

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
    return true
  } catch {
    return false
  }
}

export function load(): State | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as State
    if (!Array.isArray(parsed.boxes)) return null
    // A save from before the chat panel became resizable has no chatWidth at
    // all - default it rather than resurrecting `undefined` into state.
    return { ...parsed, selection: [], shadow: {}, chatWidth: parsed.chatWidth ?? DEFAULT_CHAT_WIDTH }
  } catch {
    return null
  }
}
