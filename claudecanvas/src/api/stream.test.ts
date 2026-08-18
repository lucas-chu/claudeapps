import { describe, it, expect } from 'vitest'
import { sanitizeTitle, describeApiError } from './stream'

describe('sanitizeTitle', () => {
  it('keeps a plain title unchanged', () => {
    expect(sanitizeTitle('Tides and moon phases')).toBe('Tides and moon phases')
  })

  it('strips surrounding quotes', () => {
    expect(sanitizeTitle('"Tides and moon phases"')).toBe('Tides and moon phases')
    expect(sanitizeTitle('“Tides and moon phases”')).toBe('Tides and moon phases')
  })

  it('strips markdown heading and emphasis markers', () => {
    expect(sanitizeTitle('## **Tides**')).toBe('Tides')
    expect(sanitizeTitle('`Tides`')).toBe('Tides')
  })

  it('collapses newlines and repeated spaces', () => {
    expect(sanitizeTitle('Tides\n  and\tmoon')).toBe('Tides and moon')
  })

  it('drops trailing sentence punctuation', () => {
    expect(sanitizeTitle('Tides and moon phases.')).toBe('Tides and moon phases')
  })

  it('caps length so a runaway reply cannot become the title', () => {
    expect(sanitizeTitle('x'.repeat(200))).toHaveLength(60)
  })

  it('returns empty for an empty reply', () => {
    expect(sanitizeTitle('   ')).toBe('')
  })
})

describe('describeApiError', () => {
  // The whole point of BYOK is that these two are the user's to fix, so they
  // must say what to do rather than surfacing a raw API string.
  it('names a rejected key', () => {
    expect(describeApiError({ status: 401 })).toMatch(/rejected/i)
  })

  it('names an exhausted balance behind the generic 400', () => {
    const err = Object.assign(new Error('Your credit balance is too low'), { status: 400 })
    expect(describeApiError(err)).toMatch(/out of credit/i)
  })

  it('names rate limiting', () => {
    expect(describeApiError({ status: 429 })).toMatch(/rate limited/i)
  })

  it('treats 5xx as an upstream problem', () => {
    expect(describeApiError({ status: 503 })).toMatch(/Anthropic API/i)
  })

  it('falls back to the error message when there is no status', () => {
    expect(describeApiError(new Error('network down'))).toBe('network down')
  })

  it('always produces something printable', () => {
    expect(describeApiError({})).toBe('Generation failed.')
  })
})
