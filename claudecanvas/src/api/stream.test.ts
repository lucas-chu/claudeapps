import { describe, it, expect } from 'vitest'
import { parseSSE } from './stream'

describe('parseSSE', () => {
  it('parses a single complete event', () => {
    const out = parseSSE('event: delta\ndata: {"text":"hi"}\n\n')
    expect(out).toEqual([{ event: 'delta', data: { text: 'hi' } }])
  })

  it('parses several events in one chunk', () => {
    const out = parseSSE(
      'event: delta\ndata: {"text":"a"}\n\nevent: delta\ndata: {"text":"b"}\n\n',
    )
    expect(out.map((e) => e.data.text)).toEqual(['a', 'b'])
  })

  it('ignores a trailing partial event', () => {
    const out = parseSSE('event: delta\ndata: {"text":"a"}\n\nevent: delta\ndata: {"te')
    expect(out).toHaveLength(1)
  })

  it('returns nothing for an empty buffer', () => {
    expect(parseSSE('')).toEqual([])
  })
})
