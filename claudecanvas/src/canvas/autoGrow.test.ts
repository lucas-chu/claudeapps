import { describe, it, expect } from 'vitest'
import { autoGrowHeight, MAX_AUTO_GROW_H, GROW_EPSILON_PX } from './autoGrow'

describe('autoGrowHeight', () => {
  it('leaves a box alone when nothing is clipped', () => {
    expect(autoGrowHeight(260, 0, 1)).toBeNull()
  })

  it('grows by exactly the clipped amount at zoom 1', () => {
    expect(autoGrowHeight(260, 40, 1)).toBe(300)
  })

  it('converts screen overflow to world px through zoom', () => {
    // Zoomed out, every world pixel buys half a screen pixel of room.
    expect(autoGrowHeight(260, 40, 0.5)).toBe(340)
    expect(autoGrowHeight(260, 40, 2)).toBe(280)
  })

  it('ignores sub-pixel layout rounding', () => {
    expect(autoGrowHeight(260, GROW_EPSILON_PX, 1)).toBeNull()
    expect(autoGrowHeight(260, 1, 1)).toBeNull()
  })

  it('never shrinks a box, whatever the measurement says', () => {
    expect(autoGrowHeight(260, -120, 1)).toBeNull()
  })

  it('clamps growth at the ceiling', () => {
    expect(autoGrowHeight(MAX_AUTO_GROW_H - 100, 10_000, 1)).toBe(MAX_AUTO_GROW_H)
  })

  it('stops growing once the ceiling is reached', () => {
    expect(autoGrowHeight(MAX_AUTO_GROW_H, 500, 1)).toBeNull()
    // A box the user dragged taller than the ceiling is left as-is, not pulled
    // back down to it.
    expect(autoGrowHeight(MAX_AUTO_GROW_H + 400, 500, 1)).toBeNull()
  })

  it('honours an explicit ceiling', () => {
    expect(autoGrowHeight(260, 500, 1, 400)).toBe(400)
  })

  it('refuses to divide by a zero or negative zoom', () => {
    expect(autoGrowHeight(260, 40, 0)).toBeNull()
    expect(autoGrowHeight(260, 40, -1)).toBeNull()
  })

  it('rejects non-finite inputs rather than producing a NaN height', () => {
    expect(autoGrowHeight(Number.NaN, 40, 1)).toBeNull()
    expect(autoGrowHeight(260, Number.NaN, 1)).toBeNull()
    expect(autoGrowHeight(260, Number.POSITIVE_INFINITY, 1)).toBeNull()
    expect(autoGrowHeight(260, 40, Number.NaN)).toBeNull()
  })

  it('converges on a body tall enough for the content, then asks for nothing', () => {
    // The component's feedback loop: grow, re-measure, repeat. `bodyH` is the
    // scrolling body inside the box, which gains every world pixel the box does.
    const contentH = 700
    let h = 260
    let bodyH = 240
    for (let i = 0; i < 10; i++) {
      const next = autoGrowHeight(h, contentH - bodyH, 1)
      if (next === null) break
      bodyH += next - h
      h = next
    }
    expect(bodyH).toBeGreaterThanOrEqual(contentH)
    expect(autoGrowHeight(h, contentH - bodyH, 1)).toBeNull()
  })
})
