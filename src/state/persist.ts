import type { State } from './store'

export const STORAGE_KEY = 'cove-canvas:v1'

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
  const clean: State = {
    ...state,
    selection: [],
    shadow: {},
    boxes: state.boxes.map((b) => ({
      ...b,
      status: b.status === 'streaming' ? 'idle' : b.status,
    })),
    turns: state.turns.map((t) => ({ ...t, status: undefined })),
  }
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
    return { ...parsed, selection: [], shadow: {} }
  } catch {
    return null
  }
}
