import { describe, it, expect } from 'vitest'
import { reducer, initialState, MAX_TURNS } from './store'
import { blocksToText, appendToBlocks } from './types'
import type { Box } from './types'

const box = (id: string, over: Partial<Box> = {}): Box => ({
  id, x: 0, y: 0, w: 320, h: 220,
  blocks: [{ type: 'text', text: '' }],
  render: 'markdown', status: 'idle', ...over,
})

describe('boxes', () => {
  it('adds a box and selects it', () => {
    const s = reducer(initialState, { type: 'addBox', box: box('a') })
    expect(s.boxes).toHaveLength(1)
    expect(s.selection).toEqual(['a'])
  })

  it('moves a box without touching others', () => {
    let s = reducer(initialState, { type: 'addBox', box: box('a') })
    s = reducer(s, { type: 'addBox', box: box('b') })
    s = reducer(s, { type: 'moveBox', id: 'a', x: 50, y: 60 })
    expect(s.boxes.find((b) => b.id === 'a')).toMatchObject({ x: 50, y: 60 })
    expect(s.boxes.find((b) => b.id === 'b')).toMatchObject({ x: 0, y: 0 })
  })

  it('enforces a minimum size on resize', () => {
    let s = reducer(initialState, { type: 'addBox', box: box('a') })
    s = reducer(s, { type: 'resizeBox', id: 'a', x: 0, y: 0, w: 10, h: 10 })
    const b = s.boxes[0]
    expect(b.w).toBeGreaterThanOrEqual(160)
    expect(b.h).toBeGreaterThanOrEqual(100)
  })

  it('deletes a box and drops it from the selection', () => {
    let s = reducer(initialState, { type: 'addBox', box: box('a') })
    s = reducer(s, { type: 'deleteBox', id: 'a' })
    expect(s.boxes).toHaveLength(0)
    expect(s.selection).toEqual([])
  })

  it('deletes a box and drops its shadow entry', () => {
    let s = reducer(initialState, { type: 'addBox', box: box('a') })
    s = reducer(s, { type: 'beginShadow', id: 'a' })
    s = reducer(s, { type: 'appendShadow', id: 'a', text: 'in flight' })
    expect(s.shadow.a).toBe('in flight')
    s = reducer(s, { type: 'deleteBox', id: 'a' })
    expect(s.shadow.a).toBeUndefined()
    expect('a' in s.shadow).toBe(false)
  })
})

describe('box titles', () => {
  it('setBoxTitle sets the title without marking it edited', () => {
    let s = reducer(initialState, { type: 'addBox', box: box('a') })
    s = reducer(s, { type: 'setBoxTitle', id: 'a', title: 'Auto title' })
    expect(s.boxes[0].title).toBe('Auto title')
    expect(s.boxes[0].titleEdited).toBeFalsy()
  })

  it('renameBox sets the title and marks it edited', () => {
    let s = reducer(initialState, { type: 'addBox', box: box('a') })
    s = reducer(s, { type: 'renameBox', id: 'a', title: 'My title' })
    expect(s.boxes[0].title).toBe('My title')
    expect(s.boxes[0].titleEdited).toBe(true)
  })

  it('renameBox overrides a prior auto-title', () => {
    let s = reducer(initialState, { type: 'addBox', box: box('a') })
    s = reducer(s, { type: 'setBoxTitle', id: 'a', title: 'Auto title' })
    s = reducer(s, { type: 'renameBox', id: 'a', title: 'Manual title' })
    expect(s.boxes[0].title).toBe('Manual title')
    expect(s.boxes[0].titleEdited).toBe(true)
  })

  it('does not affect other boxes', () => {
    let s = reducer(initialState, { type: 'addBox', box: box('a') })
    s = reducer(s, { type: 'addBox', box: box('b') })
    s = reducer(s, { type: 'renameBox', id: 'a', title: 'A title' })
    expect(s.boxes.find((b) => b.id === 'b')?.title).toBeUndefined()
    expect(s.boxes.find((b) => b.id === 'b')?.titleEdited).toBeFalsy()
  })
})

describe('drawing boxes', () => {
  it('setBoxDrawing replaces blocks with a single drawing block', () => {
    let s = reducer(initialState, { type: 'addBox', box: box('a') })
    s = reducer(s, {
      type: 'setBoxDrawing',
      id: 'a',
      elements: [{ id: 'el1', type: 'rectangle' }],
      appState: { viewBackgroundColor: '#ffffff' },
      preview: 'data:image/png;base64,AAA',
    })
    expect(s.boxes[0].blocks).toEqual([{
      type: 'drawing',
      elements: [{ id: 'el1', type: 'rectangle' }],
      appState: { viewBackgroundColor: '#ffffff' },
      preview: 'data:image/png;base64,AAA',
    }])
  })

  it('setBoxDrawing works with no appState or preview yet', () => {
    let s = reducer(initialState, { type: 'addBox', box: box('a') })
    s = reducer(s, { type: 'setBoxDrawing', id: 'a', elements: [] })
    expect(s.boxes[0].blocks).toEqual([{ type: 'drawing', elements: [], appState: undefined, preview: undefined }])
  })

  it('setBoxDrawing preserves every other box field', () => {
    let s = reducer(initialState, {
      type: 'addBox',
      box: box('a', { title: 'My drawing', titleEdited: true, x: 10, y: 20, w: 480, h: 360 }),
    })
    s = reducer(s, { type: 'setBoxDrawing', id: 'a', elements: [] })
    expect(s.boxes[0]).toMatchObject({ title: 'My drawing', titleEdited: true, x: 10, y: 20, w: 480, h: 360 })
  })

  it('setBoxDrawing does not affect other boxes', () => {
    let s = reducer(initialState, { type: 'addBox', box: box('a') })
    s = reducer(s, { type: 'addBox', box: box('b') })
    s = reducer(s, { type: 'setBoxDrawing', id: 'a', elements: [{ id: 'x' }] })
    expect(s.boxes.find((b) => b.id === 'b')?.blocks).toEqual([{ type: 'text', text: '' }])
  })
})

describe('selection', () => {
  const twoBoxes = () => {
    let s = reducer(initialState, { type: 'addBox', box: box('a') })
    return reducer(s, { type: 'addBox', box: box('b') })
  }

  it('replaces the selection on select', () => {
    const s = reducer(twoBoxes(), { type: 'select', ids: ['a'] })
    expect(s.selection).toEqual(['a'])
  })

  it('adds and removes with toggleSelect', () => {
    let s = reducer(twoBoxes(), { type: 'select', ids: ['a'] })
    s = reducer(s, { type: 'toggleSelect', id: 'b' })
    expect(s.selection.sort()).toEqual(['a', 'b'])
    s = reducer(s, { type: 'toggleSelect', id: 'a' })
    expect(s.selection).toEqual(['b'])
  })

  it('clears the selection', () => {
    const s = reducer(twoBoxes(), { type: 'clearSelection' })
    expect(s.selection).toEqual([])
  })
})

describe('streaming into a box', () => {
  it('appends deltas to the last text block', () => {
    let s = reducer(initialState, { type: 'addBox', box: box('a') })
    s = reducer(s, { type: 'appendDelta', id: 'a', text: 'Hel' })
    s = reducer(s, { type: 'appendDelta', id: 'a', text: 'lo' })
    expect(s.boxes[0].blocks).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('records an error status and message', () => {
    let s = reducer(initialState, { type: 'addBox', box: box('a') })
    s = reducer(s, { type: 'setBoxError', id: 'a', error: 'refused' })
    expect(s.boxes[0]).toMatchObject({ status: 'error', error: 'refused' })
  })

  it('remembers the prompt that generated a box so it can be retried', () => {
    let s = reducer(initialState, { type: 'addBox', box: box('a') })
    s = reducer(s, { type: 'setBoxPrompt', id: 'a', prompt: 'write a haiku' })
    expect(s.boxes[0].lastPrompt).toBe('write a haiku')
  })
})

describe('shadow buffer for in-place rewrites', () => {
  it('commits replacing the original text', () => {
    let s = reducer(initialState, {
      type: 'addBox',
      box: box('a', { blocks: [{ type: 'text', text: 'original' }] }),
    })
    s = reducer(s, { type: 'beginShadow', id: 'a' })
    s = reducer(s, { type: 'appendShadow', id: 'a', text: 'new text' })
    expect(s.boxes[0].blocks[0]).toEqual({ type: 'text', text: 'original' })
    s = reducer(s, { type: 'commitShadow', id: 'a' })
    expect(s.boxes[0].blocks[0]).toEqual({ type: 'text', text: 'new text' })
    expect(s.shadow.a).toBeUndefined()
  })

  it('rolls back leaving the original intact', () => {
    let s = reducer(initialState, {
      type: 'addBox',
      box: box('a', { blocks: [{ type: 'text', text: 'original' }] }),
    })
    s = reducer(s, { type: 'beginShadow', id: 'a' })
    s = reducer(s, { type: 'appendShadow', id: 'a', text: 'partial junk' })
    s = reducer(s, { type: 'rollbackShadow', id: 'a', error: 'network died' })
    expect(s.boxes[0].blocks[0]).toEqual({ type: 'text', text: 'original' })
    expect(s.boxes[0].status).toBe('error')
    expect(s.shadow.a).toBeUndefined()
  })
})

describe('thread', () => {
  it('appends turns', () => {
    const s = reducer(initialState, {
      type: 'addTurn',
      turn: { id: 't1', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
    })
    expect(s.turns).toHaveLength(1)
  })

  it('keeps every turn in state regardless of the context cap', () => {
    let s = initialState
    for (let i = 0; i < MAX_TURNS * 3; i++) {
      s = reducer(s, {
        type: 'addTurn',
        turn: { id: `t${i}`, role: 'user', blocks: [{ type: 'text', text: 'x' }] },
      })
    }
    expect(s.turns.length).toBe(MAX_TURNS * 3)
  })

  it('clears the thread', () => {
    let s = reducer(initialState, {
      type: 'addTurn',
      turn: { id: 't1', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
    })
    s = reducer(s, { type: 'clearThread' })
    expect(s.turns).toEqual([])
  })
})

describe('blocksToText', () => {
  it('returns a single text block', () => {
    const result = blocksToText([{ type: 'text', text: 'hello' }])
    expect(result).toBe('hello')
  })

  it('concatenates multiple text blocks in order', () => {
    const result = blocksToText([
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'world' },
    ])
    expect(result).toBe('hello world')
  })

  it('elides image blocks', () => {
    const result = blocksToText([
      { type: 'text', text: 'before' },
      { type: 'image', mime: 'image/png', data: 'base64data' },
      { type: 'text', text: 'after' },
    ])
    expect(result).toBe('beforeafter')
  })

  it('elides drawing blocks', () => {
    const result = blocksToText([
      { type: 'text', text: 'before' },
      { type: 'drawing', elements: [{ id: 'el1' }], preview: 'data:image/png;base64,AAA' },
      { type: 'text', text: 'after' },
    ])
    expect(result).toBe('beforeafter')
  })

  it('includes html block markup', () => {
    const result = blocksToText([
      { type: 'text', text: 'text' },
      { type: 'html', html: '<div>markup</div>' },
      { type: 'text', text: 'more' },
    ])
    expect(result).toBe('text<div>markup</div>more')
  })

  it('returns empty string for empty list', () => {
    const result = blocksToText([])
    expect(result).toBe('')
  })
})

describe('appendToBlocks', () => {
  it('appends to a trailing text block', () => {
    const blocks = [{ type: 'text', text: 'hello' }]
    const result = appendToBlocks(blocks, ' world')
    expect(result).toEqual([{ type: 'text', text: 'hello world' }])
  })

  it('creates a text block in an empty list', () => {
    const blocks: typeof blocks = []
    const result = appendToBlocks(blocks, 'hello')
    expect(result).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('pushes a new text block when trailing block is not text', () => {
    const blocks = [{ type: 'image', mime: 'image/png', data: 'base64' }]
    const result = appendToBlocks(blocks, 'text')
    expect(result).toEqual([
      { type: 'image', mime: 'image/png', data: 'base64' },
      { type: 'text', text: 'text' },
    ])
  })

  it('does not mutate the input array', () => {
    const blocks = [{ type: 'text', text: 'hello' }]
    const blocksBefore = [...blocks]
    appendToBlocks(blocks, ' world')
    expect(blocks).toEqual(blocksBefore)
  })
})
