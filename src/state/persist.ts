import type { State } from './store'

export const STORAGE_KEY = 'cove-canvas:v1'

/**
 * Persists canvas content and thread. Transient fields are dropped: a reload
 * must never restore a half-written box or a selection the user can't see.
 */
export function save(state: State): void {
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
  } catch {
    // Quota or private mode: losing autosave must not break the app.
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
