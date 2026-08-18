import { reducer, type State, type Action } from './store'
import { sanitize } from './persist'

/**
 * Window within which a same-type, same-target undoable action coalesces
 * into the previous history entry instead of pushing a new one. Every
 * `pointermove` of a drag or every keystroke of a text edit lands well
 * inside this window, so one drag or one typing burst becomes a single undo
 * step; a pause longer than this starts a fresh step.
 */
export const COALESCE_WINDOW_MS = 700

/** Oldest entries are dropped once `past` would exceed this many steps, so a
 * long session's history can't grow without bound. */
export const HISTORY_LIMIT = 50

/**
 * The structural edits that create an undo step. Deliberately narrow:
 * streaming churn (appendDelta/appendShadow/beginShadow/rollbackShadow/
 * setBoxStatus/setBoxSources/setBoxPrompt/growBox) fires tens of times a
 * second and would obliterate history - a box auto-growing to fit the answer
 * being written into it is part of that generation, not a step the user should
 * have to undo one dispatch at a time; viewport, chat panel width, selection, and the
 * chat thread are left out because undoing a pan/zoom, a panel resize, a
 * selection, or a chat message is surprising in a canvas app. `load` is
 * handled separately below (it resets history rather than pushing a step).
 */
const UNDOABLE_TYPES: ReadonlySet<Action['type']> = new Set<Action['type']>([
  'addBox',
  'deleteBox',
  'moveBox',
  'resizeBox',
  'setBoxText',
  'setBoxTitle',
  'renameBox',
  'setBoxDrawing',
  'commitShadow',
])

export function isUndoable(type: Action['type']): boolean {
  return UNDOABLE_TYPES.has(type)
}

/** The box an undoable action targets, for coalescing (see COALESCE_WINDOW_MS
 * above). Every undoable action carries exactly one, so this is total over
 * the undoable subset of Action; it returns undefined for anything else. */
function targetId(action: Action): string | undefined {
  switch (action.type) {
    case 'addBox':
      return action.box.id
    case 'deleteBox':
    case 'moveBox':
    case 'resizeBox':
    case 'setBoxText':
    case 'setBoxTitle':
    case 'renameBox':
    case 'setBoxDrawing':
    case 'commitShadow':
      return action.id
    default:
      return undefined
  }
}

/** Bookkeeping used only to decide whether the *next* undoable action
 * coalesces; it is not itself undo/redo data and is reset on undo, redo, and
 * load so an edit made right after one of those never coalesces with
 * whatever came before it. */
type LastEdit = { type: Action['type']; id: string; at: number } | null

export type HistoryState = {
  past: State[]
  present: State
  future: State[]
  lastEdit: LastEdit
}

export function initialHistoryState(present: State): HistoryState {
  return { past: [], present, future: [], lastEdit: null }
}

export type HistoryAction = Action | { type: 'undo' } | { type: 'redo' }

export const canUndo = (h: HistoryState): boolean => h.past.length > 0
export const canRedo = (h: HistoryState): boolean => h.future.length > 0

/**
 * Wraps the box/canvas reducer with undo/redo. Stays pure and clock-free the
 * same way `reducer` does: it never calls Date.now() itself. Coalescing is
 * driven entirely by the `at` timestamp callers stamp onto each action
 * (App.tsx's dispatch wrapper uses `Date.now()`; tests drive `at` directly
 * for deterministic coalescing without touching a real clock).
 */
export function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  if (action.type === 'undo') {
    if (state.past.length === 0) return state
    const restored = sanitize(state.past[state.past.length - 1])
    return {
      past: state.past.slice(0, -1),
      present: restored,
      future: [state.present, ...state.future].slice(0, HISTORY_LIMIT),
      lastEdit: null,
    }
  }

  if (action.type === 'redo') {
    if (state.future.length === 0) return state
    const restored = sanitize(state.future[0])
    return {
      past: [...state.past, state.present].slice(-HISTORY_LIMIT),
      present: restored,
      future: state.future.slice(1),
      lastEdit: null,
    }
  }

  if (action.type === 'load') {
    // Restoring from localStorage is never itself undoable, and it must
    // wipe whatever history the previous session/canvas had - undoing past
    // a `load` back into a different canvas's edits would be nonsensical.
    return initialHistoryState(reducer(state.present, action))
  }

  const present = reducer(state.present, action)

  if (!isUndoable(action.type)) {
    // Streaming/selection/viewport/thread actions: apply to `present`, but
    // never touch past/future/lastEdit - an in-flight generation ticking
    // away must not break a drag's coalescing window, or push its own step.
    return { ...state, present }
  }

  const id = targetId(action)
  const at = action.at ?? 0
  const coalesce =
    id !== undefined &&
    state.lastEdit !== null &&
    state.lastEdit.type === action.type &&
    state.lastEdit.id === id &&
    Math.abs(at - state.lastEdit.at) <= COALESCE_WINDOW_MS

  if (coalesce) {
    return { ...state, present, lastEdit: { type: action.type, id: id as string, at } }
  }

  return {
    past: [...state.past, state.present].slice(-HISTORY_LIMIT),
    present,
    future: [],
    lastEdit: id !== undefined ? { type: action.type, id, at } : null,
  }
}
