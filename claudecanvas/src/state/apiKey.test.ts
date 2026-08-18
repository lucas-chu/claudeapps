import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  looksLikeApiKey,
  loadApiKey,
  saveApiKey,
  clearApiKey,
  currentScope,
  maskApiKey,
} from './apiKey'

function makeStorage() {
  const mem: Record<string, string> = {}
  return {
    mem,
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => {
      mem[k] = v
    },
    removeItem: (k: string) => {
      delete mem[k]
    },
  }
}

const local = makeStorage()
const session = makeStorage()
vi.stubGlobal('localStorage', local)
vi.stubGlobal('sessionStorage', session)

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'

describe('looksLikeApiKey', () => {
  it('accepts a well-formed key', () => {
    expect(looksLikeApiKey(KEY)).toBe(true)
  })

  it('tolerates surrounding whitespace from a paste', () => {
    expect(looksLikeApiKey(`  ${KEY}\n`)).toBe(true)
  })

  it('rejects the common paste mistakes', () => {
    expect(looksLikeApiKey('')).toBe(false)
    expect(looksLikeApiKey('sk-ant-')).toBe(false) // truncated
    expect(looksLikeApiKey(`"${KEY}"`)).toBe(false) // copied with quotes
    expect(looksLikeApiKey('sk-proj-abcdefghijklmnopqrst')).toBe(false) // wrong provider
  })
})

describe('key storage', () => {
  beforeEach(() => {
    for (const k of Object.keys(local.mem)) delete local.mem[k]
    for (const k of Object.keys(session.mem)) delete session.mem[k]
  })

  it('returns null when no key is stored', () => {
    expect(loadApiKey()).toBeNull()
    expect(currentScope()).toBeNull()
  })

  it('round-trips a session-scoped key without touching localStorage', () => {
    expect(saveApiKey(KEY, 'session')).toBe(true)
    expect(loadApiKey()).toBe(KEY)
    expect(currentScope()).toBe('session')
    expect(Object.keys(local.mem)).toHaveLength(0)
  })

  it('round-trips a remembered key', () => {
    expect(saveApiKey(KEY, 'local')).toBe(true)
    expect(loadApiKey()).toBe(KEY)
    expect(currentScope()).toBe('local')
  })

  it('trims a pasted key before storing it', () => {
    saveApiKey(`  ${KEY}\n`, 'session')
    expect(loadApiKey()).toBe(KEY)
  })

  it('leaves no copy behind when the scope changes', () => {
    // Otherwise "stop remembering me" would silently keep the old key on disk
    // and resurrect it on the next visit.
    saveApiKey(KEY, 'local')
    saveApiKey('sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzzzz', 'session')

    expect(Object.keys(local.mem)).toHaveLength(0)
    expect(loadApiKey()).toBe('sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzzzz')
  })

  it('clears both scopes', () => {
    saveApiKey(KEY, 'local')
    clearApiKey()
    expect(loadApiKey()).toBeNull()
    expect(currentScope()).toBeNull()
  })

  it('reports failure instead of throwing when storage is unavailable', () => {
    const spy = vi.spyOn(session, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    try {
      expect(saveApiKey(KEY, 'session')).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('survives storage that throws on read', () => {
    const spy = vi.spyOn(session, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    try {
      expect(loadApiKey()).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('maskApiKey', () => {
  it('shows enough to identify a key without revealing it', () => {
    const masked = maskApiKey(KEY)
    expect(masked).toContain('sk-ant-api0')
    expect(masked).toContain('6789')
    expect(masked).not.toContain('lmnopqrstuv')
  })

  it('never partially reveals a short string', () => {
    expect(maskApiKey('sk-ant')).toBe('••••')
  })
})
