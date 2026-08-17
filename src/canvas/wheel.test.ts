import { describe, it, expect } from 'vitest'
import { wheelUnitPx, isZoomWheel, panDeltaFromWheel } from './wheel'

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
