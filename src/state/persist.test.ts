import { describe, it, expect, beforeEach, vi } from 'vitest'
import { save, load, STORAGE_KEY } from './persist'
import { initialState } from './store'

const mem: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v },
  removeItem: (k: string) => { delete mem[k] },
})

describe('persistence', () => {
  beforeEach(() => { delete mem[STORAGE_KEY] })

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
