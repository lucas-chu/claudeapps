import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRevealPacer } from './revealPacer'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createRevealPacer', () => {
  it('emits nothing before anything is pushed', () => {
    const emitted: string[] = []
    createRevealPacer((c) => emitted.push(c))
    vi.advanceTimersByTime(1000)
    expect(emitted).toEqual([])
  })

  it('emits pushed text in order and in full', () => {
    const emitted: string[] = []
    const pacer = createRevealPacer((c) => emitted.push(c))
    pacer.push('Hello, ')
    vi.advanceTimersByTime(50)
    pacer.push('world!')
    vi.advanceTimersByTime(5000)
    expect(emitted.join('')).toBe('Hello, world!')
  })

  it('never emits more or less than what was pushed', () => {
    const emitted: string[] = []
    const pacer = createRevealPacer((c) => emitted.push(c))
    const input = 'The quick brown fox jumps over the lazy dog. '.repeat(20)
    pacer.push(input)
    vi.advanceTimersByTime(60_000)
    expect(emitted.join('')).toBe(input)
  })

  it('flush() emits everything still pending immediately', () => {
    const emitted: string[] = []
    const pacer = createRevealPacer((c) => emitted.push(c))
    pacer.push('some received text')
    // No timer ticks have run yet — everything is still backlog.
    pacer.flush()
    expect(emitted.join('')).toBe('some received text')
  })

  it('flush() is a no-op when there is nothing pending', () => {
    const emitted: string[] = []
    const pacer = createRevealPacer((c) => emitted.push(c))
    pacer.push('abc')
    pacer.flush()
    const callsAfterFirstFlush = emitted.length
    pacer.flush()
    expect(emitted.length).toBe(callsAfterFirstFlush)
  })

  it('never emits text that was not pushed', () => {
    const emitted: string[] = []
    const pacer = createRevealPacer((c) => emitted.push(c))
    pacer.push('abc')
    vi.advanceTimersByTime(16)
    // Whatever has been emitted so far must be a prefix of what was pushed.
    expect('abc'.startsWith(emitted.join(''))).toBe(true)
    pacer.flush()
    expect(emitted.join('')).toBe('abc')
  })

  it('drains a large backlog faster than a small one (catch-up behavior)', () => {
    const smallEmitted: string[] = []
    const smallPacer = createRevealPacer((c) => smallEmitted.push(c))
    smallPacer.push('x'.repeat(10))
    vi.advanceTimersByTime(16)
    const smallFirstTick = smallEmitted[0]?.length ?? 0

    const largeEmitted: string[] = []
    const largePacer = createRevealPacer((c) => largeEmitted.push(c))
    largePacer.push('y'.repeat(8000))
    vi.advanceTimersByTime(16)
    const largeFirstTick = largeEmitted[0]?.length ?? 0

    expect(largeFirstTick).toBeGreaterThan(smallFirstTick)
  })

  it('stop() prevents further emission', () => {
    const emitted: string[] = []
    const pacer = createRevealPacer((c) => emitted.push(c))
    pacer.push('abc')
    vi.advanceTimersByTime(16)
    const emittedBeforeStop = emitted.join('')
    pacer.stop()
    pacer.push('def')
    vi.advanceTimersByTime(5000)
    pacer.flush()
    expect(emitted.join('')).toBe(emittedBeforeStop)
  })
})
