import { describe, it, expect } from 'vitest'
import {
  wheelUnitPx, isZoomWheel, panDeltaFromWheel, canElementScroll, findScrollableAncestor,
  type ScrollBox,
} from './wheel'

describe('wheelUnitPx', () => {
  it('treats mode 0 as already pixels', () => {
    expect(wheelUnitPx(0)).toBe(1)
  })
  it('treats mode 1 as lines (16px)', () => {
    expect(wheelUnitPx(1)).toBe(16)
  })
  it('treats mode 2 as pages (400px)', () => {
    expect(wheelUnitPx(2)).toBe(400)
  })
})

describe('isZoomWheel', () => {
  it('is false for a plain two-finger scroll', () => {
    expect(isZoomWheel({ ctrlKey: false, metaKey: false })).toBe(false)
  })
  it('is true when ctrlKey is set (macOS trackpad pinch)', () => {
    expect(isZoomWheel({ ctrlKey: true, metaKey: false })).toBe(true)
  })
  it('is true when metaKey is set (cmd+scroll for mouse users)', () => {
    expect(isZoomWheel({ ctrlKey: false, metaKey: true })).toBe(true)
  })
})

describe('panDeltaFromWheel', () => {
  it('passes pixel deltas through unchanged at zoom 1', () => {
    const d = panDeltaFromWheel({ deltaX: 10, deltaY: -20, deltaMode: 0 }, 1)
    expect(d).toEqual({ dx: 10, dy: -20 })
  })
  it('divides by zoom so panning feels 1:1 with the fingers', () => {
    const d = panDeltaFromWheel({ deltaX: 10, deltaY: 20, deltaMode: 0 }, 2)
    expect(d).toEqual({ dx: 5, dy: 10 })
  })
  it('scales line-mode deltas by 16px before dividing by zoom', () => {
    const d = panDeltaFromWheel({ deltaX: 1, deltaY: 2, deltaMode: 1 }, 1)
    expect(d).toEqual({ dx: 16, dy: 32 })
  })
  it('handles horizontal deltaX', () => {
    const d = panDeltaFromWheel({ deltaX: 50, deltaY: 0, deltaMode: 0 }, 1)
    expect(d).toEqual({ dx: 50, dy: 0 })
  })
})

/** Builds a fake scrollable element; fields default to "no overflow". */
function box(overrides: Partial<ScrollBox> = {}): ScrollBox {
  return {
    scrollTop: 0, scrollHeight: 100, clientHeight: 100,
    scrollLeft: 0, scrollWidth: 100, clientWidth: 100,
    ...overrides,
  }
}

describe('canElementScroll', () => {
  it('is false when the element has no overflow at all', () => {
    expect(canElementScroll(box(), 0, -10)).toBe(false)
    expect(canElementScroll(box(), 0, 10)).toBe(false)
  })

  it('is true for a vertically-scrollable element with room in both directions', () => {
    const el = box({ scrollHeight: 200, clientHeight: 100, scrollTop: 50 })
    expect(canElementScroll(el, 0, -10)).toBe(true) // room to scroll up
    expect(canElementScroll(el, 0, 10)).toBe(true) // room to scroll down
  })

  it('is false when pinned at the top and the wheel scrolls up', () => {
    const el = box({ scrollHeight: 200, clientHeight: 100, scrollTop: 0 })
    expect(canElementScroll(el, 0, -10)).toBe(false)
  })

  it('is false when pinned at the bottom and the wheel scrolls down', () => {
    const el = box({ scrollHeight: 200, clientHeight: 100, scrollTop: 100 })
    expect(canElementScroll(el, 0, 10)).toBe(false)
  })

  it('is true for a horizontally-overflowing element with room', () => {
    const el = box({ scrollWidth: 300, clientWidth: 100, scrollLeft: 100 })
    expect(canElementScroll(el, -10, 0)).toBe(true)
    expect(canElementScroll(el, 10, 0)).toBe(true)
  })

  it('is false when pinned at the horizontal edges', () => {
    const el = box({ scrollWidth: 300, clientWidth: 100, scrollLeft: 0 })
    expect(canElementScroll(el, -10, 0)).toBe(false)
    const pinnedRight = box({ scrollWidth: 300, clientWidth: 100, scrollLeft: 200 })
    expect(canElementScroll(pinnedRight, 10, 0)).toBe(false)
  })
})

type Chain = ScrollBox & { parent: Chain | null }
const getParent = (el: Chain) => el.parent

describe('findScrollableAncestor', () => {
  it('returns null when no ancestor up to the boundary can scroll', () => {
    const boundary: Chain = { ...box(), parent: null }
    const middle: Chain = { ...box(), parent: boundary }
    const start: Chain = { ...box(), parent: middle }
    expect(findScrollableAncestor(start, boundary, getParent, 0, 10, { ctrlKey: false, metaKey: false }))
      .toBeNull()
  })

  it('returns the nearest scrollable ancestor with room to move', () => {
    const boundary: Chain = { ...box(), parent: null }
    const scrollable: Chain = { ...box({ scrollHeight: 200, clientHeight: 100, scrollTop: 50 }), parent: boundary }
    const start: Chain = { ...box(), parent: scrollable }
    const found = findScrollableAncestor(start, boundary, getParent, 0, 10, { ctrlKey: false, metaKey: false })
    expect(found).toBe(scrollable)
  })

  it('falls through to null when pinned at the top and the wheel scrolls up', () => {
    const boundary: Chain = { ...box(), parent: null }
    const pinnedTop: Chain = {
      ...box({ scrollHeight: 200, clientHeight: 100, scrollTop: 0 }), parent: boundary,
    }
    expect(findScrollableAncestor(pinnedTop, boundary, getParent, 0, -10, { ctrlKey: false, metaKey: false }))
      .toBeNull()
  })

  it('falls through to null when pinned at the bottom and the wheel scrolls down', () => {
    const boundary: Chain = { ...box(), parent: null }
    const pinnedBottom: Chain = {
      ...box({ scrollHeight: 200, clientHeight: 100, scrollTop: 100 }), parent: boundary,
    }
    expect(findScrollableAncestor(pinnedBottom, boundary, getParent, 0, 10, { ctrlKey: false, metaKey: false }))
      .toBeNull()
  })

  it('finds a horizontally-overflowing ancestor', () => {
    const boundary: Chain = { ...box(), parent: null }
    const scrollableX: Chain = {
      ...box({ scrollWidth: 300, clientWidth: 100, scrollLeft: 100 }), parent: boundary,
    }
    const found = findScrollableAncestor(scrollableX, boundary, getParent, -10, 0, { ctrlKey: false, metaKey: false })
    expect(found).toBe(scrollableX)
  })

  it('a pinch/zoom wheel event always returns null, even over a scrollable box', () => {
    const boundary: Chain = { ...box(), parent: null }
    const scrollable: Chain = { ...box({ scrollHeight: 200, clientHeight: 100, scrollTop: 50 }), parent: boundary }
    expect(findScrollableAncestor(scrollable, boundary, getParent, 0, 10, { ctrlKey: true, metaKey: false }))
      .toBeNull()
    expect(findScrollableAncestor(scrollable, boundary, getParent, 0, 10, { ctrlKey: false, metaKey: true }))
      .toBeNull()
  })
})
