import { describe, it, expect } from 'vitest'
import { resolveTargetWithBusy, describeAction, isBoxActive, resolveCanvasTarget, type ActiveGenerations } from './useGeneration'
import type { Block, Box } from './state/types'

describe('describeAction', () => {
  it('labels a creation', () => {
    expect(describeAction(0)).toBe('created a box')
  })
  it('labels an edit', () => {
    expect(describeAction(1)).toBe('edited a box')
  })
  it('names the count when several boxes are context', () => {
    expect(describeAction(3)).toBe('used 3 boxes as context')
  })
})

function makeBox(id: string, blocks: Block[] = [{ type: 'text', text: '' }]): Box {
  return { id, x: 0, y: 0, w: 100, h: 100, blocks, render: 'markdown', status: 'idle' }
}

describe('isBoxActive', () => {
  it('is false for an empty registry', () => {
    const active: ActiveGenerations = new Map()
    expect(isBoxActive(active, 'box-1')).toBe(false)
  })

  it('is true when some generation targets the box', () => {
    const active: ActiveGenerations = new Map([['gen-1', 'box-1']])
    expect(isBoxActive(active, 'box-1')).toBe(true)
  })

  it('is false for a different box id', () => {
    const active: ActiveGenerations = new Map([['gen-1', 'box-1']])
    expect(isBoxActive(active, 'box-2')).toBe(false)
  })

  it('ignores generations with no target (chat prompts, or a new box not yet placed)', () => {
    const active: ActiveGenerations = new Map([['gen-1', undefined]])
    expect(isBoxActive(active, 'box-1')).toBe(false)
  })

  it('is true when any of several concurrent generations targets the box', () => {
    const active: ActiveGenerations = new Map([
      ['gen-1', undefined],
      ['gen-2', 'box-2'],
      ['gen-3', 'box-1'],
    ])
    expect(isBoxActive(active, 'box-1')).toBe(true)
  })
})

describe('resolveCanvasTarget', () => {
  it('targets a retry box regardless of selection', () => {
    expect(resolveCanvasTarget([], 'box-9')).toEqual({ kind: 'inPlace', targetId: 'box-9' })
    expect(resolveCanvasTarget([makeBox('box-1')], 'box-9')).toEqual({
      kind: 'inPlace',
      targetId: 'box-9',
    })
  })

  it('creates a new box when nothing is selected', () => {
    expect(resolveCanvasTarget([])).toEqual({ kind: 'new' })
  })

  it('rewrites in place when a single non-image box is selected', () => {
    const box = makeBox('box-1')
    expect(resolveCanvasTarget([box])).toEqual({ kind: 'inPlace', targetId: 'box-1' })
  })

  it('creates a new box when the single selected box is image-only', () => {
    const box = makeBox('box-1', [{ type: 'image', mime: 'image/png', data: 'x' }])
    expect(resolveCanvasTarget([box])).toEqual({ kind: 'new' })
  })

  it('creates a new box when 2+ boxes are selected', () => {
    const boxes = [makeBox('box-1'), makeBox('box-2')]
    expect(resolveCanvasTarget(boxes)).toEqual({ kind: 'new' })
  })
})

describe('resolveTargetWithBusy', () => {
  const box = (id: string, blocks: Block[] = [{ type: 'text', text: 'hi' }]): Box => ({
    id, x: 0, y: 0, w: 360, h: 260, blocks, render: 'markdown', status: 'idle',
  })
  const idle = () => false
  const allBusy = () => true

  it('rewrites in place when the single selected box is free', () => {
    expect(resolveTargetWithBusy([box('a')], undefined, idle)).toEqual({ kind: 'inPlace', targetId: 'a' })
  })

  it('falls back to a new box when the selected box is mid-stream', () => {
    // This is rapid-fire prompting: the previous answer auto-selected its box
    // and is still streaming. Declining here would silently drop the prompt.
    expect(resolveTargetWithBusy([box('a')], undefined, allBusy)).toEqual({ kind: 'new' })
  })

  it('declines a retry aimed at a box that is mid-stream', () => {
    expect(resolveTargetWithBusy([], 'a', allBusy)).toEqual({ kind: 'declined', targetId: 'a' })
  })

  it('allows a retry once that box is free', () => {
    expect(resolveTargetWithBusy([], 'a', idle)).toEqual({ kind: 'inPlace', targetId: 'a' })
  })

  it('always makes a new box for a multi-box selection, busy or not', () => {
    expect(resolveTargetWithBusy([box('a'), box('b')], undefined, allBusy)).toEqual({ kind: 'new' })
  })

  it('always makes a new box for an image-only selection', () => {
    const img = box('a', [{ type: 'image', mime: 'image/png', data: 'x' }])
    expect(resolveTargetWithBusy([img], undefined, idle)).toEqual({ kind: 'new' })
  })
})
