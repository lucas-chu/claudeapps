import { describe, it, expect } from 'vitest'
import { buildMessages, trimTurns, EXCERPT_LIMIT } from './context'
import { MAX_TURNS } from './store'
import type { Box, Turn } from './types'

const turn = (id: string, role: 'user' | 'assistant', text: string): Turn => ({
  id, role, blocks: [{ type: 'text', text }],
})

const box = (id: string, text: string): Box => ({
  id, x: 0, y: 0, w: 320, h: 220,
  blocks: [{ type: 'text', text }],
  render: 'markdown', status: 'idle',
})

describe('trimTurns', () => {
  it('keeps only the most recent MAX_TURNS', () => {
    const turns = Array.from({ length: 20 }, (_, i) => turn(`t${i}`, 'user', `m${i}`))
    const kept = trimTurns(turns)
    expect(kept).toHaveLength(MAX_TURNS)
    expect(kept[kept.length - 1].id).toBe('t19')
  })

  it('leaves a short thread alone', () => {
    const turns = [turn('a', 'user', 'x')]
    expect(trimTurns(turns)).toHaveLength(1)
  })

  it('truncates long assistant turns to an excerpt', () => {
    const long = 'x'.repeat(EXCERPT_LIMIT + 500)
    const [out] = trimTurns([turn('a', 'assistant', long)])
    const text = out.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
    expect(text.length).toBeLessThanOrEqual(EXCERPT_LIMIT + 1)
  })
})

describe('buildMessages', () => {
  it('ends with the prompt as a user message', () => {
    const msgs = buildMessages([], [], 'write a haiku')
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: 'write a haiku' })
  })

  it('includes prior turns before the prompt', () => {
    const msgs = buildMessages(
      [turn('a', 'user', 'hello'), turn('b', 'assistant', 'hi there')],
      [], 'again',
    )
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(msgs[0].content).toBe('hello')
  })

  it('embeds selected box contents in the final user message', () => {
    const msgs = buildMessages([], [box('b1', 'Q3 revenue was flat')], 'summarize this')
    const last = msgs[msgs.length - 1].content
    expect(last).toContain('Q3 revenue was flat')
    expect(last).toContain('summarize this')
  })

  it('labels each selected box so multiple sources stay distinguishable', () => {
    const msgs = buildMessages([], [box('b1', 'alpha'), box('b2', 'beta')], 'merge')
    const last = msgs[msgs.length - 1].content
    expect(last).toContain('alpha')
    expect(last).toContain('beta')
    expect(last.match(/<box/g)).toHaveLength(2)
  })

  it('never leaks box contents into the history portion', () => {
    const history = [turn('a', 'assistant', 'previous answer')]
    const msgs = buildMessages(history, [box('b1', 'SECRET BOX TEXT')], 'go')
    const historyPart = msgs.slice(0, -1).map((m) => m.content).join('\n')
    expect(historyPart).not.toContain('SECRET BOX TEXT')
  })

  it('drops empty turns rather than sending blank messages', () => {
    const msgs = buildMessages([turn('a', 'user', '   ')], [], 'go')
    expect(msgs).toHaveLength(1)
  })
})
