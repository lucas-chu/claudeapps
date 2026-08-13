import { describe, it, expect } from 'vitest'
import {
  screenToWorld, worldToScreen, rectsOverlap, findFreeSlot, zoomAt,
  MIN_ZOOM, MAX_ZOOM,
} from './geometry'

describe('coordinate transforms', () => {
  const viewports = [
    { x: 0, y: 0, zoom: 1 },
    { x: 120, y: -80, zoom: 0.5 },
    { x: -640, y: 340, zoom: 2.5 },
  ]

  it('round-trips screen -> world -> screen at every zoom level', () => {
    for (const vp of viewports) {
      for (const p of [{ x: 0, y: 0 }, { x: 300, y: 200 }, { x: -50, y: 900 }]) {
        const back = worldToScreen(screenToWorld(p, vp), vp)
        expect(back.x).toBeCloseTo(p.x, 6)
        expect(back.y).toBeCloseTo(p.y, 6)
      }
    }
  })

  it('maps the screen origin to the viewport origin', () => {
    const vp = { x: 120, y: -80, zoom: 0.5 }
    expect(screenToWorld({ x: 0, y: 0 }, vp)).toEqual({ x: 120, y: -80 })
  })

  it('halves screen distance into world distance at zoom 2', () => {
    const vp = { x: 0, y: 0, zoom: 2 }
    expect(screenToWorld({ x: 100, y: 100 }, vp)).toEqual({ x: 50, y: 50 })
  })
})

describe('rectsOverlap', () => {
  const a = { x: 0, y: 0, w: 100, h: 100 }
  it('detects overlap', () => {
    expect(rectsOverlap(a, { x: 50, y: 50, w: 100, h: 100 })).toBe(true)
  })
  it('treats edge-touching as not overlapping', () => {
    expect(rectsOverlap(a, { x: 100, y: 0, w: 100, h: 100 })).toBe(false)
  })
  it('detects separation', () => {
    expect(rectsOverlap(a, { x: 300, y: 300, w: 10, h: 10 })).toBe(false)
  })
})

describe('findFreeSlot', () => {
  const size = { w: 320, h: 220 }

  it('centers the box on an empty canvas', () => {
    const p = findFreeSlot([], { x: 1000, y: 500 }, size)
    expect(p).toEqual({ x: 1000 - 160, y: 500 - 110 })
  })

  it('never returns a position overlapping an existing box', () => {
    const boxes = [{ x: 840, y: 390, w: 320, h: 220 }]
    const p = findFreeSlot(boxes, { x: 1000, y: 500 }, size)
    expect(rectsOverlap({ ...p, ...size }, boxes[0])).toBe(false)
  })

  it('packs many boxes without any overlaps', () => {
    const placed: { x: number; y: number; w: number; h: number }[] = []
    for (let i = 0; i < 12; i++) {
      const p = findFreeSlot(placed, { x: 0, y: 0 }, size)
      placed.push({ ...p, ...size })
    }
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++)
        expect(rectsOverlap(placed[i], placed[j])).toBe(false)
  })
})

describe('zoomAt', () => {
  it('keeps the world point under the cursor fixed', () => {
    const vp = { x: 100, y: 100, zoom: 1 }
    const cursor = { x: 400, y: 300 }
    const before = screenToWorld(cursor, vp)
    const after = screenToWorld(cursor, zoomAt(vp, cursor, 1.2))
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('clamps to the zoom bounds', () => {
    const vp = { x: 0, y: 0, zoom: 1 }
    expect(zoomAt(vp, { x: 0, y: 0 }, 100).zoom).toBe(MAX_ZOOM)
    expect(zoomAt(vp, { x: 0, y: 0 }, 0.001).zoom).toBe(MIN_ZOOM)
  })
})
