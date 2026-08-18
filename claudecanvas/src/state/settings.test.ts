import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  loadSettings, saveSettings, apiEffort, DEFAULT_SETTINGS, EFFORT_LABELS,
  type Effort,
} from './settings'

const mem: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v },
  removeItem: (k: string) => { delete mem[k] },
})

describe('apiEffort', () => {
  // "auto" is not an API value. It must send *no* effort at all so the API's
  // own default applies — passing `effort: undefined` explicitly would be a
  // different thing, and sending "auto" would 400.
  it('maps auto to undefined so the parameter is omitted', () => {
    expect(apiEffort('auto')).toBeUndefined()
  })

  it('passes every real level through unchanged', () => {
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(apiEffort(e)).toBe(e)
    }
  })

  it('never emits the string "auto"', () => {
    const levels = Object.keys(EFFORT_LABELS) as Effort[]
    expect(levels.map(apiEffort).filter((e) => e === ('auto' as unknown))).toHaveLength(0)
  })
})

describe('settings persistence', () => {
  beforeEach(() => {
    for (const k of Object.keys(mem)) delete mem[k]
  })

  it('defaults to auto effort and standard speed', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.effort).toBe('auto')
    expect(DEFAULT_SETTINGS.speed).toBe('standard')
  })

  it('round-trips a choice', () => {
    saveSettings({ effort: 'xhigh', speed: 'fast' })
    expect(loadSettings()).toEqual({ effort: 'xhigh', speed: 'fast' })
  })

  it('falls back to defaults on corrupt storage rather than throwing', () => {
    mem['claude-canvas:settings:v1'] = '{not json'
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('rejects an unknown effort instead of forwarding it to the API', () => {
    // A hand-edited or stale value would otherwise 400 every request until
    // storage was cleared, with no way for the user to tell why.
    mem['claude-canvas:settings:v1'] = JSON.stringify({ effort: 'turbo', speed: 'fast' })
    expect(loadSettings()).toEqual({ effort: 'auto', speed: 'fast' })
  })

  it('rejects an unknown speed', () => {
    mem['claude-canvas:settings:v1'] = JSON.stringify({ effort: 'low', speed: 'ludicrous' })
    expect(loadSettings()).toEqual({ effort: 'low', speed: 'standard' })
  })

  it('survives storage that throws', () => {
    const spy = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    try {
      expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
    } finally {
      spy.mockRestore()
    }
  })
})
