import { describe, it, expect } from 'vitest'
import {
  historyReducer,
  initialHistoryState,
  canUndo,
  canRedo,
  COALESCE_WINDOW_MS,
  HISTORY_LIMIT,
  type HistoryState,
} from './history'
import { initialState } from './store'
import type { Box } from './types'

const box = (id: string, over: Partial<Box> = {}): Box => ({
  id, x: 0, y: 0, w: 320, h: 220,
  blocks: [{ type: 'text', text: '' }],
  render: 'markdown', status: 'idle', ...over,
})

const fresh = (): HistoryState => initialHistoryState(initialState)

describe('undoable edits push and restore', () => {
  it('addBox pushes a step; undo restores the prior state', () => {
    let h = fresh()
    h = historyReducer(h, { type: 'addBox', box: box('a'), at: 0 })
    expect(h.present.boxes).toHaveLength(1)
    expect(canUndo(h)).toBe(true)

    h = historyReducer(h, { type: 'undo' })
    expect(h.present.boxes).toHaveLength(0)
    expect(canUndo(h)).toBe(false)
  })

  it('redo re-applies the undone step', () => {
    let h = fresh()
    h = historyReducer(h, { type: 'addBox', box: box('a'), at: 0 })
    h = historyReducer(h, { type: 'undo' })
    expect(canRedo(h)).toBe(true)

    h = historyReducer(h, { type: 'redo' })
    expect(h.present.boxes).toHaveLength(1)
    expect(h.present.boxes[0].id).toBe('a')
    expect(canRedo(h)).toBe(false)
  })

  it('moveBox is undoable and restores the exact prior position', () => {
    let h = fresh()
    h = historyReducer(h, { type: 'addBox', box: box('a', { x: 5, y: 5 }), at: 0 })
    h = historyReducer(h, { type: 'moveBox', id: 'a', x: 50, y: 60, at: 2000 })
    expect(h.present.boxes[0]).toMatchObject({ x: 50, y: 60 })

    h = historyReducer(h, { type: 'undo' })
    expect(h.present.boxes[0]).toMatchObject({ x: 5, y: 5 })
  })

  it('deleteBox is undoable', () => {
    let h = fresh()
    h = historyReducer(h, { type: 'addBox', box: box('a'), at: 0 })
    h = historyReducer(h, { type: 'deleteBox', id: 'a', at: 2000 })
    expect(h.present.boxes).toHaveLength(0)

    h = historyReducer(h, { type: 'undo' })
    expect(h.present.boxes).toHaveLength(1)
  })

  it('setBoxText, setBoxTitle, renameBox, setBoxDrawing, and commitShadow are all undoable', () => {
    let h = fresh()
    h = historyReducer(h, { type: 'addBox', box: box('a', { blocks: [{ type: 'text', text: 'orig' }] }), at: 0 })
    const afterAdd = h

    h = historyReducer(h, { type: 'setBoxText', id: 'a', text: 'edited', at: 2000 })
    expect(h.present.boxes[0].blocks).toEqual([{ type: 'text', text: 'edited' }])
    h = historyReducer(h, { type: 'undo' })
    expect(h.present.boxes[0].blocks).toEqual(afterAdd.present.boxes[0].blocks)

    h = historyReducer(afterAdd, { type: 'setBoxTitle', id: 'a', title: 'Auto', at: 2000 })
    h = historyReducer(h, { type: 'undo' })
    expect(h.present.boxes[0].title).toBeUndefined()

    h = historyReducer(afterAdd, { type: 'renameBox', id: 'a', title: 'Manual', at: 2000 })
    h = historyReducer(h, { type: 'undo' })
    expect(h.present.boxes[0].title).toBeUndefined()

    h = historyReducer(afterAdd, { type: 'setBoxDrawing', id: 'a', elements: [{ id: 'e1' }], at: 2000 })
    h = historyReducer(h, { type: 'undo' })
    expect(h.present.boxes[0].blocks).toEqual(afterAdd.present.boxes[0].blocks)

    // commitShadow: undo must restore the pre-rewrite text.
    h = historyReducer(afterAdd, { type: 'beginShadow', id: 'a' })
    h = historyReducer(h, { type: 'appendShadow', id: 'a', text: 'new stuff' })
    h = historyReducer(h, { type: 'commitShadow', id: 'a', at: 2000 })
    expect(h.present.boxes[0].blocks).toEqual([{ type: 'text', text: 'new stuff' }])
    h = historyReducer(h, { type: 'undo' })
    expect(h.present.boxes[0].blocks).toEqual([{ type: 'text', text: 'orig' }])
  })
})

describe('a new edit after undo clears the redo stack', () => {
  it('drops the future entry once a new undoable action lands', () => {
    let h = fresh()
    h = historyReducer(h, { type: 'addBox', box: box('a'), at: 0 })
    h = historyReducer(h, { type: 'addBox', box: box('b'), at: 2000 })
    h = historyReducer(h, { type: 'undo' })
    expect(canRedo(h)).toBe(true)

    h = historyReducer(h, { type: 'addBox', box: box('c'), at: 4000 })
    expect(canRedo(h)).toBe(false)
    expect(h.present.boxes.map((b) => b.id).sort()).toEqual(['a', 'c'])
  })
})

describe('non-undoable actions create no history step', () => {
  const setup = () => {
    let h = fresh()
    h = historyReducer(h, { type: 'addBox', box: box('a'), at: 0 })
    return h
  }

  it('streaming churn does not push a step', () => {
    let h = setup()
    const before = h
    h = historyReducer(h, { type: 'beginShadow', id: 'a' })
    h = historyReducer(h, { type: 'appendShadow', id: 'a', text: 'partial' })
    h = historyReducer(h, { type: 'appendDelta', id: 'a', text: 'x' })
    h = historyReducer(h, { type: 'setBoxStatus', id: 'a', status: 'idle' })
    h = historyReducer(h, { type: 'setBoxSources', id: 'a', sources: [] })
    h = historyReducer(h, { type: 'setBoxPrompt', id: 'a', prompt: 'hi' })
    h = historyReducer(h, { type: 'growBox', id: 'a', h: 500 })
    h = historyReducer(h, { type: 'rollbackShadow', id: 'a', error: 'oops' })
    expect(h.past).toEqual(before.past)
    expect(h.past).toHaveLength(1) // only the initial addBox
  })

  it('growth during a rewrite costs no extra undo to get the text back', () => {
    let h = setup()
    h = historyReducer(h, {
      type: 'setBoxText', id: 'a', text: 'original', at: 1000,
    })
    h = historyReducer(h, { type: 'beginShadow', id: 'a' })
    h = historyReducer(h, { type: 'appendShadow', id: 'a', text: 'a much longer answer' })
    h = historyReducer(h, { type: 'growBox', id: 'a', h: 700 })
    h = historyReducer(h, { type: 'commitShadow', id: 'a', at: 3000 })

    // A single undo restores the pre-rewrite text: the dozens of growth
    // dispatches in between contributed no steps of their own, so undo isn't
    // spent unwinding them one at a time.
    h = historyReducer(h, { type: 'undo' })
    expect(h.present.boxes[0].blocks).toEqual([{ type: 'text', text: 'original' }])
  })

  it('viewport changes do not push a step', () => {
    let h = setup()
    const pastBefore = h.past
    h = historyReducer(h, { type: 'setViewport', viewport: { x: 10, y: 10, zoom: 2 } })
    expect(h.past).toBe(pastBefore)
    expect(h.present.viewport).toEqual({ x: 10, y: 10, zoom: 2 })
  })

  it('chat panel width changes do not push a step', () => {
    let h = setup()
    const pastBefore = h.past
    h = historyReducer(h, { type: 'setChatWidth', width: 500 })
    expect(h.past).toBe(pastBefore)
    expect(h.present.chatWidth).toBe(500)
  })

  it('selection changes do not push a step', () => {
    let h = setup()
    const pastBefore = h.past
    h = historyReducer(h, { type: 'select', ids: ['a'] })
    h = historyReducer(h, { type: 'toggleSelect', id: 'a' })
    h = historyReducer(h, { type: 'clearSelection' })
    expect(h.past).toBe(pastBefore)
  })

  it('chat thread actions do not push a step', () => {
    let h = setup()
    const pastBefore = h.past
    h = historyReducer(h, { type: 'addTurn', turn: { id: 't1', role: 'user', blocks: [{ type: 'text', text: 'hi' }] } })
    h = historyReducer(h, { type: 'updateTurn', id: 't1', patch: { label: 'x' } })
    h = historyReducer(h, { type: 'appendTurnDelta', id: 't1', text: 'y' })
    h = historyReducer(h, { type: 'clearThread' })
    expect(h.past).toBe(pastBefore)
  })
})

describe('coalescing', () => {
  it('merges same-type same-target edits inside the window into one step', () => {
    let h = fresh()
    h = historyReducer(h, { type: 'addBox', box: box('a'), at: 0 })
    const afterAdd = h.past.length // 1

    h = historyReducer(h, { type: 'moveBox', id: 'a', x: 1, y: 1, at: 1000 })
    h = historyReducer(h, { type: 'moveBox', id: 'a', x: 2, y: 2, at: 1000 + COALESCE_WINDOW_MS - 1 })
    h = historyReducer(h, { type: 'moveBox', id: 'a', x: 3, y: 3, at: 1000 + 2 * (COALESCE_WINDOW_MS - 1) })

    // Still just one extra step beyond the addBox: all three moves coalesced.
    expect(h.past).toHaveLength(afterAdd + 1)
    expect(h.present.boxes[0]).toMatchObject({ x: 3, y: 3 })

    h = historyReducer(h, { type: 'undo' })
    // One undo unwinds the whole coalesced drag back to right after addBox.
    expect(h.present.boxes[0]).toMatchObject({ x: 0, y: 0 })
  })

  it('splits into a new step once the gap exceeds the window', () => {
    let h = fresh()
    h = historyReducer(h, { type: 'addBox', box: box('a'), at: 0 })
    h = historyReducer(h, { type: 'setBoxText', id: 'a', text: 'a', at: 1000 })
    h = historyReducer(h, { type: 'setBoxText', id: 'a', text: 'ab', at: 1000 + COALESCE_WINDOW_MS + 1 })
    // The pause exceeded the window, so typing "ab" is a second step.
    expect(h.past).toHaveLength(3) // addBox, "a", then present is "ab"
  })

  it('does not coalesce across different target boxes', () => {
    let h = fresh()
    h = historyReducer(h, { type: 'addBox', box: box('a'), at: 0 })
    h = historyReducer(h, { type: 'addBox', box: box('b'), at: 100 })
    const afterAdds = h.past.length

    h = historyReducer(h, { type: 'moveBox', id: 'a', x: 1, y: 1, at: 1000 })
    h = historyReducer(h, { type: 'moveBox', id: 'b', x: 1, y: 1, at: 1050 })
    // Different target ids: two separate steps even though well within window.
    expect(h.past).toHaveLength(afterAdds + 2)
  })

  it('does not coalesce across different action types', () => {
    let h = fresh()
    h = historyReducer(h, { type: 'addBox', box: box('a'), at: 0 })
    const afterAdd = h.past.length

    h = historyReducer(h, { type: 'moveBox', id: 'a', x: 1, y: 1, at: 1000 })
    h = historyReducer(h, { type: 'resizeBox', id: 'a', x: 1, y: 1, w: 400, h: 300, at: 1050 })
    expect(h.past).toHaveLength(afterAdd + 2)
  })

  it('typing, pausing, then typing again produces two steps', () => {
    let h = fresh()
    h = historyReducer(h, { type: 'addBox', box: box('a', { blocks: [{ type: 'text', text: '' }] }), at: 0 })
    const afterAdd = h.past.length

    h = historyReducer(h, { type: 'setBoxText', id: 'a', text: 'h', at: 1000 })
    h = historyReducer(h, { type: 'setBoxText', id: 'a', text: 'he', at: 1100 })
    h = historyReducer(h, { type: 'setBoxText', id: 'a', text: 'hel', at: 1200 })
    // pause
    h = historyReducer(h, { type: 'setBoxText', id: 'a', text: 'hello', at: 1200 + COALESCE_WINDOW_MS + 50 })

    expect(h.past).toHaveLength(afterAdd + 2)
  })
})

describe('depth cap', () => {
  it('drops the oldest entry once past exceeds HISTORY_LIMIT', () => {
    let h = fresh()
    // Each addBox uses a distinct id and a timestamp far enough apart that
    // none of them coalesce (addBox never coalesces with itself anyway,
    // since ids differ, but space them out for clarity).
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) {
      h = historyReducer(h, { type: 'addBox', box: box(`b${i}`), at: i * 1000 })
    }
    expect(h.past.length).toBe(HISTORY_LIMIT)
    expect(h.present.boxes).toHaveLength(HISTORY_LIMIT + 10)

    // The oldest steps were dropped, so undoing HISTORY_LIMIT times can't
    // get back to the very first box - it never leaves history entirely
    // empty from a state that still has boxes past the cap.
    for (let i = 0; i < HISTORY_LIMIT; i++) {
      h = historyReducer(h, { type: 'undo' })
    }
    expect(canUndo(h)).toBe(false)
    expect(h.present.boxes.length).toBeGreaterThan(0)
  })
})

describe('no-ops on empty stacks', () => {
  it('undo on empty past is a no-op', () => {
    const h = fresh()
    const after = historyReducer(h, { type: 'undo' })
    expect(after).toBe(h)
  })

  it('redo on empty future is a no-op', () => {
    const h = fresh()
    const after = historyReducer(h, { type: 'redo' })
    expect(after).toBe(h)
  })
})

describe('load', () => {
  it('resets history and is itself not undoable', () => {
    let h = fresh()
    h = historyReducer(h, { type: 'addBox', box: box('a'), at: 0 })
    h = historyReducer(h, { type: 'addBox', box: box('b'), at: 2000 })
    h = historyReducer(h, { type: 'undo' })
    expect(canRedo(h)).toBe(true)
    expect(canUndo(h)).toBe(true)

    const loaded = { ...initialState, boxes: [box('loaded')] }
    h = historyReducer(h, { type: 'load', state: loaded })
    expect(h.present.boxes).toEqual([box('loaded')])
    expect(canUndo(h)).toBe(false)
    expect(canRedo(h)).toBe(false)
  })
})

describe('undo never resurrects transient state', () => {
  it('undoing a commitShadow does not restore status: streaming or leave a shadow entry', () => {
    let h = fresh()
    h = historyReducer(h, {
      type: 'addBox',
      box: box('a', { blocks: [{ type: 'text', text: 'orig' }] }),
      at: 0,
    })
    h = historyReducer(h, { type: 'beginShadow', id: 'a' })
    h = historyReducer(h, { type: 'appendShadow', id: 'a', text: 'rewritten' })
    // Right before commit, the box is genuinely 'streaming' and shadow holds
    // the in-flight text - that's the live present commitShadow is about to
    // replace, and it's exactly the snapshot undo would otherwise restore.
    expect(h.present.boxes[0].status).toBe('streaming')
    h = historyReducer(h, { type: 'commitShadow', id: 'a', at: 2000 })
    expect(h.present.boxes[0].status).toBe('idle')

    h = historyReducer(h, { type: 'undo' })
    expect(h.present.boxes[0].blocks).toEqual([{ type: 'text', text: 'orig' }])
    expect(h.present.boxes[0].status).not.toBe('streaming')
    expect(h.present.shadow).toEqual({})
    expect('a' in h.present.shadow).toBe(false)
  })

  it('redo also sanitizes the restored snapshot', () => {
    let h = fresh()
    h = historyReducer(h, { type: 'addBox', box: box('a'), at: 0 })
    h = historyReducer(h, { type: 'beginShadow', id: 'a' })
    h = historyReducer(h, { type: 'appendShadow', id: 'a', text: 'x' })
    h = historyReducer(h, { type: 'commitShadow', id: 'a', at: 2000 })
    h = historyReducer(h, { type: 'undo' })
    h = historyReducer(h, { type: 'redo' })
    expect(h.present.boxes[0].status).not.toBe('streaming')
    expect(h.present.shadow).toEqual({})
  })
})
