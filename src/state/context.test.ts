import { describe, it, expect } from 'vitest'
import { buildMessages, trimTurns, EXCERPT_LIMIT, MAX_IMAGES_PER_REQUEST, type ContentBlock } from './context'
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

const imageBox = (id: string, data: string, mime = 'image/jpeg'): Box => ({
  id, x: 0, y: 0, w: 320, h: 220,
  blocks: [{ type: 'image', mime, data }],
  render: 'markdown', status: 'idle',
})

const mixedBox = (id: string, text: string, data: string, mime = 'image/jpeg'): Box => ({
  id, x: 0, y: 0, w: 320, h: 220,
  blocks: [
    { type: 'text', text },
    { type: 'image', mime, data },
  ],
  render: 'markdown', status: 'idle',
})

/** Asserts content is a string and narrows it for TS, rather than trusting the union blindly. */
function asString(content: string | ContentBlock[]): string {
  if (typeof content !== 'string') throw new Error('expected string content, got blocks')
  return content
}

/** Asserts content is a block array and narrows it for TS. */
function asBlocks(content: string | ContentBlock[]): ContentBlock[] {
  if (!Array.isArray(content)) throw new Error('expected block-array content, got a string')
  return content
}

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
    const last = asString(msgs[msgs.length - 1].content)
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

  it('collapses adjacent same-role messages left by a dropped empty turn', () => {
    // user, assistant(empty -> dropped), user leaves two adjacent user turns.
    const history = [
      turn('a', 'user', 'first question'),
      turn('b', 'assistant', ''),
      turn('c', 'user', 'second question'),
    ]
    const msgs = buildMessages(history, [], 'third question')
    const roles = msgs.map((m) => m.role)
    for (let i = 1; i < roles.length; i++) {
      expect(roles[i]).not.toBe(roles[i - 1])
    }
    // The dropped assistant turn leaves 'first question', 'second question'
    // and the new prompt all as consecutive user messages; all three merge.
    expect(msgs).toEqual([
      { role: 'user', content: 'first question\n\nsecond question\n\nthird question' },
    ])
  })

  it('leaves normal alternating history unchanged', () => {
    const history = [
      turn('a', 'user', 'hello'),
      turn('b', 'assistant', 'hi there'),
    ]
    const msgs = buildMessages(history, [], 'again')
    expect(msgs).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'again' },
    ])
  })
})

describe('buildMessages with images', () => {
  it('sends image blocks before a single text block for a selected image box', () => {
    const msgs = buildMessages([], [imageBox('i1', 'data:image/jpeg;base64,AAAA')], 'what is this?')
    const content = asBlocks(msgs[msgs.length - 1].content)

    expect(content).toHaveLength(2)
    expect(content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' },
    })
    expect(content[1].type).toBe('text')
    const textBlock = content[1] as Extract<ContentBlock, { type: 'text' }>
    expect(textBlock.text).toContain('what is this?')
  })

  it('still produces a plain string for a text-only selection (regression)', () => {
    const msgs = buildMessages([], [box('b1', 'Q3 revenue was flat')], 'summarize')
    const last = msgs[msgs.length - 1].content
    expect(typeof last).toBe('string')
    expect(asString(last)).toContain('Q3 revenue was flat')
  })

  it('includes both the image and the text for a mixed text+image box', () => {
    const msgs = buildMessages(
      [], [mixedBox('m1', 'caption text', 'data:image/jpeg;base64,AAAA')], 'describe this',
    )
    const content = asBlocks(msgs[msgs.length - 1].content)

    expect(content.some((b) => b.type === 'image')).toBe(true)
    const textBlock = content.find((b) => b.type === 'text') as Extract<ContentBlock, { type: 'text' }>
    expect(textBlock.text).toContain('caption text')
    expect(textBlock.text).toContain('describe this')
  })

  it('caps images at 5 per request and notes the omission in the text block', () => {
    const boxes = Array.from({ length: 7 }, (_, i) =>
      imageBox(`i${i}`, `data:image/jpeg;base64,AAAA${i}`),
    )
    const msgs = buildMessages([], boxes, 'go')
    const content = asBlocks(msgs[msgs.length - 1].content)

    const images = content.filter((b) => b.type === 'image')
    expect(images).toHaveLength(MAX_IMAGES_PER_REQUEST)
    const textBlock = content.find((b) => b.type === 'text') as Extract<ContentBlock, { type: 'text' }>
    expect(textBlock.text).toContain('2 more image')
  })

  it('skips an image block with a malformed data URL rather than sending it broken', () => {
    const bad: Box = {
      id: 'bad1', x: 0, y: 0, w: 320, h: 220,
      blocks: [{ type: 'image', mime: 'image/jpeg', data: 'not-a-data-url' }],
      render: 'markdown', status: 'idle',
    }
    const msgs = buildMessages([], [bad], 'what is this?')
    // No valid image survived, so this falls back to the plain-string shape
    // exactly as a text-only (empty) selection would.
    expect(typeof msgs[msgs.length - 1].content).toBe('string')
  })

  it('never puts image blocks into history messages, only the final prompt', () => {
    const history = [turn('a', 'assistant', 'previous answer')]
    const msgs = buildMessages(history, [imageBox('i1', 'data:image/jpeg;base64,AAAA')], 'go')
    const historyMessages = msgs.slice(0, -1)
    expect(historyMessages.length).toBeGreaterThan(0)
    for (const m of historyMessages) {
      expect(typeof m.content).toBe('string')
    }
    // The final message is the one that actually carries the image.
    expect(Array.isArray(msgs[msgs.length - 1].content)).toBe(true)
  })
})
