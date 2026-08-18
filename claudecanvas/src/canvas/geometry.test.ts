import { describe, it, expect } from 'vitest'
import {
  screenToWorld, worldToScreen, rectsOverlap, findFreeSlot, zoomAt,
  fitViewport, resetViewport,
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

describe('fitViewport', () => {
  const vpSize = { w: 800, h: 600 }

  it('returns the identity/reset viewport for an empty box list', () => {
    expect(fitViewport([], vpSize)).toEqual(resetViewport())
  })

  it('centers a single small box without zooming in past 1', () => {
    const box = { x: 1000, y: 1000, w: 100, h: 80 }
    const vp = fitViewport([box], vpSize)
    expect(vp.zoom).toBe(1)
    const center = worldToScreen({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, vp)
    expect(center.x).toBeCloseTo(vpSize.w / 2, 6)
    expect(center.y).toBeCloseTo(vpSize.h / 2, 6)
  })

  it('never zooms in past 1 even for a tiny box on a large viewport', () => {
    const box = { x: 0, y: 0, w: 20, h: 20 }
    const vp = fitViewport([box], { w: 4000, h: 3000 })
    expect(vp.zoom).toBe(1)
  })

  it('fits several spread-out boxes entirely inside the resulting view', () => {
    const boxes = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 2000, y: 100, w: 150, h: 120 },
      { x: 900, y: 1800, w: 200, h: 90 },
    ]
    const vp = fitViewport(boxes, vpSize)
    for (const b of boxes) {
      const topLeft = worldToScreen({ x: b.x, y: b.y }, vp)
      const bottomRight = worldToScreen({ x: b.x + b.w, y: b.y + b.h }, vp)
      expect(topLeft.x).toBeGreaterThanOrEqual(-1e-6)
      expect(topLeft.y).toBeGreaterThanOrEqual(-1e-6)
      expect(bottomRight.x).toBeLessThanOrEqual(vpSize.w + 1e-6)
      expect(bottomRight.y).toBeLessThanOrEqual(vpSize.h + 1e-6)
    }
  })

  it('clamps to MIN_ZOOM for an enormous bounding box', () => {
    const boxes = [
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 500000, y: 500000, w: 10, h: 10 },
    ]
    const vp = fitViewport(boxes, vpSize)
    expect(vp.zoom).toBe(MIN_ZOOM)
  })

  it('respects the margin around the fitted content', () => {
    const box = { x: 0, y: 0, w: 2000, h: 100 } // width is the constraining axis
    const margin = 40
    const vp = fitViewport([box], vpSize, { margin })
    const left = worldToScreen({ x: box.x, y: box.y }, vp).x
    const right = worldToScreen({ x: box.x + box.w, y: box.y }, vp).x
    expect(left).toBeCloseTo(margin, 6)
    expect(right).toBeCloseTo(vpSize.w - margin, 6)
  })
})
