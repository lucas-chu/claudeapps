import { describe, it, expect, beforeEach, vi } from 'vitest'
import { save, load, STORAGE_KEY, LEGACY_STORAGE_KEY } from './persist'
import { initialState } from './store'

const mem: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v },
  removeItem: (k: string) => { delete mem[k] },
})

describe('persistence', () => {
  beforeEach(() => { delete mem[STORAGE_KEY]; delete mem[LEGACY_STORAGE_KEY] })

  it('returns null when nothing is stored', () => {
    expect(load()).toBeNull()
  })

  it('round-trips state', () => {
    const s = {
      ...initialState,
      boxes: [{
        id: 'a', x: 1, y: 2, w: 320, h: 220,
        blocks: [{ type: 'text' as const, text: 'hi' }],
        render: 'markdown' as const, status: 'idle' as const,
      }],
      viewport: { x: 10, y: 20, zoom: 1.5 },
    }
    save(s)
    expect(load()).toEqual({ ...s, shadow: {}, selection: [] })
  })

  it('round-trips a drawing block (elements/appState survive JSON.parse intact)', () => {
    const s = {
      ...initialState,
      boxes: [{
        id: 'a', x: 0, y: 0, w: 480, h: 360,
        blocks: [{
          type: 'drawing' as const,
          elements: [{ id: 'el1', type: 'rectangle', x: 1, y: 2, width: 10, height: 20 }],
          appState: { viewBackgroundColor: '#ffffff', zoom: { value: 1 } },
          preview: 'data:image/png;base64,AAAA',
        }],
        render: 'markdown' as const, status: 'idle' as const,
      }],
    }
    save(s)
    const out = load()!
    expect(out.boxes[0].blocks).toEqual(s.boxes[0].blocks)
  })

  it('never persists in-flight shadow buffers or streaming status', () => {
    save({
      ...initialState,
      shadow: { a: 'partial' },
      boxes: [{
        id: 'a', x: 0, y: 0, w: 320, h: 220,
        blocks: [{ type: 'text' as const, text: 'x' }],
        render: 'markdown' as const, status: 'streaming' as const,
      }],
    })
    const out = load()!
    expect(out.shadow).toEqual({})
    expect(out.boxes[0].status).toBe('idle')
  })

  it('returns null on corrupt data rather than throwing', () => {
    mem[STORAGE_KEY] = '{not json'
    expect(load()).toBeNull()
  })

  it('save() returns true on success', () => {
    expect(save(initialState)).toBe(true)
  })

  it('reads a canvas written under the pre-rename key', () => {
    const s = {
      ...initialState,
      boxes: [{
        id: 'a', x: 1, y: 2, w: 320, h: 220,
        blocks: [{ type: 'text' as const, text: 'from cove canvas' }],
        render: 'markdown' as const, status: 'idle' as const,
      }],
    }
    mem[LEGACY_STORAGE_KEY] = JSON.stringify(s)
    expect(load()!.boxes[0].blocks).toEqual(s.boxes[0].blocks)
  })

  it('prefers the current key over a stale pre-rename copy', () => {
    mem[LEGACY_STORAGE_KEY] = JSON.stringify({ ...initialState, boxes: [{
      id: 'old', x: 0, y: 0, w: 1, h: 1,
      blocks: [{ type: 'text' as const, text: 'stale' }],
      render: 'markdown' as const, status: 'idle' as const,
    }] })
    save({ ...initialState, boxes: [] })
    expect(load()!.boxes).toEqual([])
  })

  it('drops the pre-rename copy once the current key is written', () => {
    mem[LEGACY_STORAGE_KEY] = JSON.stringify(initialState)
    save(initialState)
    expect(mem[LEGACY_STORAGE_KEY]).toBeUndefined()
    expect(mem[STORAGE_KEY]).toBeDefined()
  })

  it('keeps the pre-rename copy when the save fails, so nothing is lost', () => {
    mem[LEGACY_STORAGE_KEY] = JSON.stringify(initialState)
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError')
    })
    try {
      expect(save(initialState)).toBe(false)
    } finally {
      spy.mockRestore()
    }
    expect(mem[LEGACY_STORAGE_KEY]).toBeDefined()
    expect(load()).not.toBeNull()
  })

  it('save() returns false instead of throwing when storage is full', () => {
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError')
    })
    try {
      expect(save(initialState)).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })
})
