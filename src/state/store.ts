import type { Viewport } from '../canvas/geometry'
import type { Box, Source, Turn } from './types'
import { appendToBlocks } from './types'

export const MAX_TURNS = 6
export const MIN_BOX_W = 160
export const MIN_BOX_H = 100

export type State = {
  boxes: Box[]
  selection: string[]
  viewport: Viewport
  turns: Turn[]
  /** In-flight rewrite text, keyed by box id. Never rendered as box content. */
  shadow: Record<string, string>
}

export const initialState: State = {
  boxes: [],
  selection: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  turns: [],
  shadow: {},
}

export type Action =
  | { type: 'addBox'; box: Box }
  | { type: 'moveBox'; id: string; x: number; y: number }
  | { type: 'resizeBox'; id: string; x: number; y: number; w: number; h: number }
  | { type: 'setBoxText'; id: string; text: string }
  | { type: 'deleteBox'; id: string }
  | { type: 'select'; ids: string[] }
  | { type: 'toggleSelect'; id: string }
  | { type: 'clearSelection' }
  | { type: 'setViewport'; viewport: Viewport }
  | { type: 'appendDelta'; id: string; text: string }
  | { type: 'setBoxStatus'; id: string; status: Box['status'] }
  | { type: 'setBoxError'; id: string; error: string }
  | { type: 'setBoxSources'; id: string; sources: Source[] }
  | { type: 'setBoxPrompt'; id: string; prompt: string }
  | { type: 'setBoxTitle'; id: string; title: string }
  | { type: 'renameBox'; id: string; title: string }
  | { type: 'beginShadow'; id: string }
  | { type: 'appendShadow'; id: string; text: string }
  | { type: 'commitShadow'; id: string }
  | { type: 'rollbackShadow'; id: string; error: string }
  | { type: 'addTurn'; turn: Turn }
  | { type: 'updateTurn'; id: string; patch: Partial<Turn> }
  | { type: 'appendTurnDelta'; id: string; text: string }
  | { type: 'clearThread' }
  | { type: 'load'; state: State }

function mapBox(state: State, id: string, fn: (b: Box) => Box): State {
  return { ...state, boxes: state.boxes.map((b) => (b.id === id ? fn(b) : b)) }
}

/** Appends to the trailing text block, creating one if needed. */
function appendText(box: Box, text: string): Box {
  return { ...box, blocks: appendToBlocks(box.blocks, text) }
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'addBox':
      return {
        ...state,
        boxes: [...state.boxes, action.box],
        selection: [action.box.id],
      }

    case 'moveBox':
      return mapBox(state, action.id, (b) => ({ ...b, x: action.x, y: action.y }))

    case 'resizeBox':
      return mapBox(state, action.id, (b) => ({
        ...b,
        x: action.x,
        y: action.y,
        w: Math.max(MIN_BOX_W, action.w),
        h: Math.max(MIN_BOX_H, action.h),
      }))

    case 'setBoxText':
      return mapBox(state, action.id, (b) => ({
        ...b,
        blocks: [{ type: 'text', text: action.text }],
      }))

    case 'deleteBox': {
      const { [action.id]: _dropShadow, ...shadow } = state.shadow
      return {
        ...state,
        boxes: state.boxes.filter((b) => b.id !== action.id),
        selection: state.selection.filter((id) => id !== action.id),
        shadow,
      }
    }

    case 'select':
      return { ...state, selection: action.ids }

    case 'toggleSelect':
      return {
        ...state,
        selection: state.selection.includes(action.id)
          ? state.selection.filter((id) => id !== action.id)
          : [...state.selection, action.id],
      }

    case 'clearSelection':
      return { ...state, selection: [] }

    case 'setViewport':
      return { ...state, viewport: action.viewport }

    case 'appendDelta':
      return mapBox(state, action.id, (b) => appendText(b, action.text))

    case 'setBoxStatus':
      return mapBox(state, action.id, (b) => ({
        ...b,
        status: action.status,
        error: action.status === 'error' ? b.error : undefined,
      }))

    case 'setBoxError':
      return mapBox(state, action.id, (b) => ({
        ...b,
        status: 'error',
        error: action.error,
      }))

    case 'setBoxSources':
      return mapBox(state, action.id, (b) => ({ ...b, sources: action.sources }))

    case 'setBoxPrompt':
      return mapBox(state, action.id, (b) => ({ ...b, lastPrompt: action.prompt }))

    // Automatic path: never touches titleEdited, so a later auto-title never
    // clobbers a title the user has already renamed by hand.
    case 'setBoxTitle':
      return mapBox(state, action.id, (b) => ({ ...b, title: action.title }))

    // Manual path: marks the box so auto-titling stops overwriting it.
    case 'renameBox':
      return mapBox(state, action.id, (b) => ({
        ...b,
        title: action.title,
        titleEdited: true,
      }))

    case 'beginShadow':
      return {
        ...state,
        shadow: { ...state.shadow, [action.id]: '' },
        boxes: state.boxes.map((b) =>
          b.id === action.id ? { ...b, status: 'streaming', error: undefined } : b,
        ),
      }

    case 'appendShadow':
      return {
        ...state,
        shadow: {
          ...state.shadow,
          [action.id]: (state.shadow[action.id] ?? '') + action.text,
        },
      }

    case 'commitShadow': {
      const text = state.shadow[action.id] ?? ''
      const { [action.id]: _drop, ...shadow } = state.shadow
      return {
        ...mapBox(state, action.id, (b) => ({
          ...b,
          blocks: [{ type: 'text', text }],
          status: 'idle',
          error: undefined,
        })),
        shadow,
      }
    }

    case 'rollbackShadow': {
      const { [action.id]: _drop, ...shadow } = state.shadow
      return {
        ...mapBox(state, action.id, (b) => ({
          ...b,
          status: 'error',
          error: action.error,
        })),
        shadow,
      }
    }

    case 'addTurn':
      return { ...state, turns: [...state.turns, action.turn] }

    case 'updateTurn':
      return {
        ...state,
        turns: state.turns.map((t) =>
          t.id === action.id ? { ...t, ...action.patch } : t,
        ),
      }

    case 'appendTurnDelta':
      return {
        ...state,
        turns: state.turns.map((t) => {
          if (t.id !== action.id) return t
          return { ...t, blocks: appendToBlocks(t.blocks, action.text) }
        }),
      }

    case 'clearThread':
      return { ...state, turns: [] }

    case 'load':
      return action.state
  }
}
