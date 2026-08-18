import { describe, it, expect } from 'vitest'
import {
  toggleWrap, toggleLinePrefix, toggleOrderedList, insertLink,
  toggleTaskAtLine, toggleTaskLine, indentLines, outdentLines, continueTaskOnEnter,
} from './markdownActions'

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

describe('toggleTaskAtLine', () => {
  it('toggles an unchecked task to checked', () => {
    const text = '- [ ] buy milk'
    expect(toggleTaskAtLine(text, 1)).toBe('- [x] buy milk')
  })

  it('toggles a checked task back to unchecked', () => {
    const text = '- [x] buy milk'
    expect(toggleTaskAtLine(text, 1)).toBe('- [ ] buy milk')
  })

  it('preserves exact indentation and bullet marker style', () => {
    const text = 'intro\n  * [ ] nested item\noutro'
    expect(toggleTaskAtLine(text, 2)).toBe('intro\n  * [x] nested item\noutro')
  })

  it('leaves a non-task line unchanged', () => {
    const text = 'just a plain line\nsecond line'
    expect(toggleTaskAtLine(text, 1)).toBe(text)
  })

  it('leaves the text unchanged when the line number is out of range', () => {
    const text = '- [ ] only line'
    expect(toggleTaskAtLine(text, 5)).toBe(text)
    expect(toggleTaskAtLine(text, 0)).toBe(text)
  })

  it('cascades checking to nested children', () => {
    const text = '- [ ] parent\n  - [ ] child one\n  - [ ] child two'
    expect(toggleTaskAtLine(text, 1)).toBe('- [x] parent\n  - [x] child one\n  - [x] child two')
  })

  it('cascades unchecking to nested children', () => {
    const text = '- [x] parent\n  - [x] child one\n  - [x] child two'
    expect(toggleTaskAtLine(text, 1)).toBe('- [ ] parent\n  - [ ] child one\n  - [ ] child two')
  })

  it('cascades through multiple nesting levels', () => {
    const text = '- [ ] parent\n  - [ ] child\n    - [ ] grandchild'
    expect(toggleTaskAtLine(text, 1)).toBe('- [x] parent\n  - [x] child\n    - [x] grandchild')
  })

  it('cascade stops at the first sibling (a line indented at or below the parent)', () => {
    const text = '- [ ] parent\n  - [ ] child\n- [ ] sibling'
    expect(toggleTaskAtLine(text, 1)).toBe('- [x] parent\n  - [x] child\n- [ ] sibling')
  })

  it('toggling a child only affects its own descendants, not its parent or siblings', () => {
    const text = '- [ ] parent\n  - [ ] child\n  - [ ] child two'
    expect(toggleTaskAtLine(text, 2)).toBe('- [ ] parent\n  - [x] child\n  - [ ] child two')
  })
})

describe('toggleTaskLine', () => {
  it('turns a single-line selection into a task item', () => {
    const r = toggleTaskLine('buy milk', 2, 4)
    expect(r.text).toBe('- [ ] buy milk')
  })

  it('turns every touched line into a task item', () => {
    const text = 'first\nsecond\nthird'
    const r = toggleTaskLine(text, 0, text.length)
    expect(r.text).toBe('- [ ] first\n- [ ] second\n- [ ] third')
    expect(r.start).toBe(0)
    expect(r.end).toBe(r.text.length)
  })

  it('removes task syntax when every touched line already has it', () => {
    const text = '- [ ] first\n- [x] second'
    const r = toggleTaskLine(text, 0, text.length)
    expect(r.text).toBe('first\nsecond')
  })

  it('toggling on then off restores the original text exactly', () => {
    const text = 'alpha\nbeta'
    const once = toggleTaskLine(text, 0, text.length)
    const twice = toggleTaskLine(once.text, once.start, once.end)
    expect(twice.text).toBe(text)
  })
})

describe('indentLines / outdentLines', () => {
  it('indents a single line by two spaces', () => {
    expect(indentLines('hello', 0, 5).text).toBe('  hello')
  })

  it('indents every line the selection touches', () => {
    const text = 'a\nb\nc'
    expect(indentLines(text, 0, text.length).text).toBe('  a\n  b\n  c')
  })

  it('outdents a line that has two leading spaces', () => {
    expect(outdentLines('  hello', 0, 7).text).toBe('hello')
  })

  it('round-trips: indent then outdent restores the original text', () => {
    const text = 'first\nsecond'
    const once = indentLines(text, 0, text.length)
    const twice = outdentLines(once.text, once.start, once.end)
    expect(twice.text).toBe(text)
  })

  it('outdent at zero indentation is a no-op and never corrupts the line', () => {
    const text = 'no indent here'
    expect(outdentLines(text, 0, text.length).text).toBe(text)
  })

  it('outdent trims a single stray leading space down to zero', () => {
    expect(outdentLines(' one space', 0, 10).text).toBe('one space')
  })
})

describe('continueTaskOnEnter', () => {
  it('returns null for a line that is not a task item', () => {
    expect(continueTaskOnEnter('just text', 4)).toBeNull()
  })

  it('inserts a new task item with the same indentation and bullet', () => {
    const text = '  * [ ] buy milk'
    const r = continueTaskOnEnter(text, text.length)
    expect(r?.text).toBe('  * [ ] buy milk\n  * [ ] ')
    expect(r?.start).toBe(r?.text.length)
  })

  it('splits an in-progress item at the caret, like a plain newline would', () => {
    const text = '- [ ] buy milk'
    const caret = '- [ ] buy'.length // right after "buy", before the space
    const r = continueTaskOnEnter(text, caret)
    // The space that separated "buy" and "milk" moves down with "milk" as
    // literal content, same as a naive split of any plain text would do.
    expect(r?.text).toBe('- [ ] buy\n- [ ]  milk')
  })

  it('clears an empty task item instead of continuing the list', () => {
    const text = '- [ ] '
    const r = continueTaskOnEnter(text, text.length)
    expect(r?.text).toBe('')
    expect(r?.start).toBe(0)
  })
})
