import { describe, it, expect } from 'vitest'
import { toggleWrap, toggleLinePrefix, toggleOrderedList, insertLink } from './markdownActions'

describe('toggleWrap', () => {
  it('wraps a selection in the marker', () => {
    const text = 'Hello world'
    const r = toggleWrap(text, 6, 11, '**')
    expect(r.text).toBe('Hello **world**')
    expect(r.text.slice(r.start, r.end)).toBe('world')
  })

  it('toggling back off restores the original text exactly', () => {
    const text = 'Hello world'
    const once = toggleWrap(text, 6, 11, '**')
    const twice = toggleWrap(once.text, once.start, once.end, '**')
    expect(twice.text).toBe(text)
    expect(twice.start).toBe(6)
    expect(twice.end).toBe(11)
  })

  it('un-wraps when the selection itself contains the markers', () => {
    const text = 'Hello **world**'
    const r = toggleWrap(text, 6, 16, '**') // selection = "**world**"
    expect(r.text).toBe('Hello world')
    expect(r.text.slice(r.start, r.end)).toBe('world')
  })

  it('handles a multi-line selection', () => {
    const text = 'line one\nline two'
    const once = toggleWrap(text, 5, 13, '*') // "one\nline"
    expect(once.text).toBe('line *one\nline* two')
    const twice = toggleWrap(once.text, once.start, once.end, '*')
    expect(twice.text).toBe(text)
    expect(twice.start).toBe(5)
    expect(twice.end).toBe(13)
  })

  it('inserts an empty marker pair and places the caret between them on an empty selection', () => {
    const text = 'abc'
    const r = toggleWrap(text, 1, 1, '**')
    expect(r.text).toBe('a****bc')
    expect(r.start).toBe(3)
    expect(r.end).toBe(3)
  })

  it('wraps a selection at the very start of the text', () => {
    const text = 'abc def'
    const r = toggleWrap(text, 0, 3, '`')
    expect(r.text).toBe('`abc` def')
    expect(r.text.slice(r.start, r.end)).toBe('abc')
    const back = toggleWrap(r.text, r.start, r.end, '`')
    expect(back.text).toBe(text)
    expect(back.start).toBe(0)
    expect(back.end).toBe(3)
  })

  it('wraps a selection at the very end of the text', () => {
    const text = 'abc def'
    const r = toggleWrap(text, 4, 7, '*')
    expect(r.text).toBe('abc *def*')
    expect(r.text.slice(r.start, r.end)).toBe('def')
    const back = toggleWrap(r.text, r.start, r.end, '*')
    expect(back.text).toBe(text)
    expect(back.start).toBe(4)
    expect(back.end).toBe(7)
  })

  it('never loses characters outside the toggled range', () => {
    const text = 'prefix-[[[world]]]-suffix'
    const r = toggleWrap(text, 8, 18, '**')
    expect(r.text.startsWith('prefix-[')).toBe(true)
    expect(r.text.endsWith('-suffix')).toBe(true)
  })
})

describe('toggleLinePrefix', () => {
  it('applies the prefix to a single-line selection', () => {
    const text = 'hello world'
    const r = toggleLinePrefix(text, 2, 4, '- ')
    expect(r.text).toBe('- hello world')
    expect(r.text.slice(r.start, r.end)).toBe('- hello world')
  })

  it('toggling back off restores the original text exactly', () => {
    const text = 'hello world'
    const once = toggleLinePrefix(text, 2, 4, '> ')
    const twice = toggleLinePrefix(once.text, once.start, once.end, '> ')
    expect(twice.text).toBe(text)
  })

  it('applies to every line touched by a multi-line selection, expanding to whole lines', () => {
    const text = 'first\nsecond\nthird'
    // Selection lands mid-"first" and mid-"third".
    const r = toggleLinePrefix(text, 2, 16, '- ')
    expect(r.text).toBe('- first\n- second\n- third')
    expect(r.start).toBe(0)
    expect(r.end).toBe(r.text.length)
  })

  it('toggling a multi-line prefix back off restores the original exactly', () => {
    const text = 'first\nsecond\nthird'
    const once = toggleLinePrefix(text, 2, 16, '## ')
    const twice = toggleLinePrefix(once.text, once.start, once.end, '## ')
    expect(twice.text).toBe(text)
  })

  it('applies to an empty selection by prefixing the current line', () => {
    const text = 'only line'
    const r = toggleLinePrefix(text, 3, 3, '> ')
    expect(r.text).toBe('> only line')
  })

  it('handles a selection at the very start of the text', () => {
    const text = 'first\nsecond'
    const r = toggleLinePrefix(text, 0, 0, '# ')
    expect(r.text).toBe('# first\nsecond')
    expect(r.start).toBe(0)
  })

  it('handles a selection at the very end of the text', () => {
    const text = 'first\nsecond'
    const r = toggleLinePrefix(text, 12, 12, '# ')
    expect(r.text).toBe('first\n# second')
    expect(r.end).toBe(r.text.length)
  })

  it('does not double-prefix a line that already has it when adding to others', () => {
    const text = '- first\nsecond'
    const r = toggleLinePrefix(text, 0, text.length, '- ')
    expect(r.text).toBe('- first\n- second')
  })
})

describe('toggleOrderedList', () => {
  it('numbers every touched line', () => {
    const text = 'a\nb\nc'
    const r = toggleOrderedList(text, 0, text.length)
    expect(r.text).toBe('1. a\n2. b\n3. c')
    expect(r.start).toBe(0)
    expect(r.end).toBe(r.text.length)
  })

  it('toggling back off restores the original text exactly', () => {
    const text = 'a\nb\nc'
    const once = toggleOrderedList(text, 0, text.length)
    const twice = toggleOrderedList(once.text, once.start, once.end)
    expect(twice.text).toBe(text)
  })

  it('handles a multi-line selection that only partially spans the lines', () => {
    const text = 'alpha\nbeta\ngamma'
    const once = toggleOrderedList(text, 2, 12)
    expect(once.text).toBe('1. alpha\n2. beta\n3. gamma')
    const twice = toggleOrderedList(once.text, once.start, once.end)
    expect(twice.text).toBe(text)
  })

  it('handles an empty selection on a single line', () => {
    const text = 'only line'
    const r = toggleOrderedList(text, 4, 4)
    expect(r.text).toBe('1. only line')
  })

  it('handles a selection at the very start of the text', () => {
    const text = 'first\nsecond'
    const r = toggleOrderedList(text, 0, 0)
    expect(r.text).toBe('1. first\nsecond')
  })

  it('handles a selection at the very end of the text', () => {
    const text = 'first\nsecond'
    const r = toggleOrderedList(text, 12, 12)
    expect(r.text).toBe('first\n1. second')
  })
})

describe('insertLink', () => {
  it('turns the selection into a markdown link', () => {
    const text = 'see the docs here'
    const r = insertLink(text, 8, 12, 'https://example.com')
    expect(r.text).toBe('see the [docs](https://example.com) here')
    expect(r.text.slice(r.start, r.end)).toBe('docs')
  })

  it('inserts [](url) with the caret between the brackets on an empty selection', () => {
    const text = 'see here'
    const r = insertLink(text, 4, 4, 'https://example.com')
    expect(r.text).toBe('see [](https://example.com)here')
    expect(r.start).toBe(5)
    expect(r.end).toBe(5)
  })

  it('falls back to a literal "url" placeholder when url is empty', () => {
    const text = 'click me'
    const r = insertLink(text, 0, 5, '')
    expect(r.text).toBe('[click](url) me')
    expect(r.text.slice(r.start, r.end)).toBe('click')
  })

  it('handles an empty selection with an empty url', () => {
    const text = 'abc'
    const r = insertLink(text, 3, 3, '')
    expect(r.text).toBe('abc[](url)')
    expect(r.start).toBe(4)
    expect(r.end).toBe(4)
  })

  it('handles a selection at the very start of the text', () => {
    const text = 'docs here'
    const r = insertLink(text, 0, 4, 'https://x.test')
    expect(r.text).toBe('[docs](https://x.test) here')
    expect(r.text.slice(r.start, r.end)).toBe('docs')
  })

  it('handles a selection at the very end of the text', () => {
    const text = 'see docs'
    const r = insertLink(text, 4, 8, 'https://x.test')
    expect(r.text).toBe('see [docs](https://x.test)')
    expect(r.text.slice(r.start, r.end)).toBe('docs')
  })

  it('never loses the surrounding text', () => {
    const text = 'before MIDDLE after'
    const r = insertLink(text, 7, 13, 'https://x.test')
    expect(r.text.startsWith('before [')).toBe(true)
    expect(r.text.endsWith('](https://x.test) after')).toBe(true)
  })
})
