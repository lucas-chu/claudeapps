/**
 * Pure, DOM-free markdown editing transforms for the textarea toolbar.
 * Each function takes the full text plus a selection range and returns the
 * new text and the selection range that should be restored afterward, so a
 * caller (a click handler, a keyboard shortcut) can apply it to a real
 * <textarea> without this module ever touching the DOM.
 *
 * Every transform is designed to round-trip exactly: applying it and then
 * applying it again to the range it returns must restore the original text
 * byte-for-byte. That's what makes each one a toggle rather than a one-way edit.
 */

export type EditResult = { text: string; start: number; end: number }

/** Finds the start/end offsets of the full line(s) touching [start, end]. */
function lineBounds(text: string, start: number, end: number): { lineStart: number; lineEnd: number } {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const nextBreak = text.indexOf('\n', end)
  const lineEnd = nextBreak === -1 ? text.length : nextBreak
  return { lineStart, lineEnd }
}

/**
 * Wraps the selection in `marker` (e.g. `**` bold, `*` italic, `` ` `` code).
 * Toggles off if the selection is already wrapped, either because the
 * selection itself contains the markers ("**bold**" selected whole) or
 * because the markers sit just outside the selection ("**" + "bold" + "**"
 * with only "bold" selected). An empty selection inserts an empty marker
 * pair and places the caret between them.
 */
export function toggleWrap(text: string, start: number, end: number, marker: string): EditResult {
  const selection = text.slice(start, end)

  if (selection.length === 0) {
    const newText = text.slice(0, start) + marker + marker + text.slice(end)
    const pos = start + marker.length
    return { text: newText, start: pos, end: pos }
  }

  // Case 1: the markers are inside the selection itself.
  if (
    selection.length >= marker.length * 2 &&
    selection.startsWith(marker) &&
    selection.endsWith(marker)
  ) {
    const inner = selection.slice(marker.length, selection.length - marker.length)
    const newText = text.slice(0, start) + inner + text.slice(end)
    return { text: newText, start, end: start + inner.length }
  }

  // Case 2: the markers sit just outside the selection.
  const before = text.slice(Math.max(0, start - marker.length), start)
  const after = text.slice(end, end + marker.length)
  if (marker.length > 0 && before === marker && after === marker) {
    const newText =
      text.slice(0, start - marker.length) + selection + text.slice(end + marker.length)
    return { text: newText, start: start - marker.length, end: end - marker.length }
  }

  // Otherwise, wrap.
  const newText = text.slice(0, start) + marker + selection + marker + text.slice(end)
  return { text: newText, start: start + marker.length, end: end + marker.length }
}

/**
 * Applies `prefix` (e.g. '- ', '> ', '# ') to the start of every line the
 * selection touches, expanding the selection to whole lines. Toggles off —
 * stripping the prefix from every touched line — only when every touched
 * line already has it; otherwise the prefix is added to whichever lines
 * lack it (lines that already have it are left alone).
 */
export function toggleLinePrefix(text: string, start: number, end: number, prefix: string): EditResult {
  const { lineStart, lineEnd } = lineBounds(text, start, end)
  const segment = text.slice(lineStart, lineEnd)
  const lines = segment.split('\n')
  const allHave = lines.every((l) => l.startsWith(prefix))

  const newLines = allHave
    ? lines.map((l) => l.slice(prefix.length))
    : lines.map((l) => (l.startsWith(prefix) ? l : prefix + l))

  const newSegment = newLines.join('\n')
  const newText = text.slice(0, lineStart) + newSegment + text.slice(lineEnd)
  return { text: newText, start: lineStart, end: lineStart + newSegment.length }
}

const ORDERED_RE = /^\d+\.\s/

/**
 * Numbers every line the selection touches `1. `, `2. `, … expanding the
 * selection to whole lines. Toggles off — removing the numbering — only
 * when every touched line is already numbered.
 */
export function toggleOrderedList(text: string, start: number, end: number): EditResult {
  const { lineStart, lineEnd } = lineBounds(text, start, end)
  const segment = text.slice(lineStart, lineEnd)
  const lines = segment.split('\n')
  const allHave = lines.every((l) => ORDERED_RE.test(l))

  const newLines = allHave
    ? lines.map((l) => l.replace(ORDERED_RE, ''))
    : lines.map((l, i) => `${i + 1}. ${l.replace(ORDERED_RE, '')}`)

  const newSegment = newLines.join('\n')
  const newText = text.slice(0, lineStart) + newSegment + text.slice(lineEnd)
  return { text: newText, start: lineStart, end: lineStart + newSegment.length }
}

/**
 * Turns the selection into `[selection](url)`. An empty selection inserts
 * `[](url)` with the caret placed between the brackets. An empty `url`
 * falls back to the literal placeholder text "url" inside the parens.
 */
export function insertLink(text: string, start: number, end: number, url: string): EditResult {
  const label = text.slice(start, end)
  const href = url.length > 0 ? url : 'url'
  const inserted = `[${label}](${href})`
  const newText = text.slice(0, start) + inserted + text.slice(end)

  if (label.length === 0) {
    const pos = start + 1 // just after the opening '['
    return { text: newText, start: pos, end: pos }
  }
  const labelStart = start + 1 // just after the opening '['
  return { text: newText, start: labelStart, end: labelStart + label.length }
}

/**
 * Matches a GFM task list item line, capturing (1) leading indentation,
 * (2) the bullet marker (`-`, `*`, `+`), (3) the whitespace between the
 * marker and the checkbox, (4) the checkbox's contents (` `, `x` or `X`),
 * and (5) everything after the closing `]` verbatim.
 */
const TASK_RE = /^([ \t]*)([-*+])([ \t]+)\[([ xX])\](.*)$/

/** Rewrites a task line's checkbox to `checked`, leaving everything else on
 *  the line untouched. Returns non-task lines unchanged. */
function setTaskChecked(line: string, checked: boolean): string {
  const m = TASK_RE.exec(line)
  if (!m) return line
  const [, indent, bullet, gap, , rest] = m
  return `${indent}${bullet}${gap}[${checked ? 'x' : ' '}]${rest}`
}

/**
 * Flips `- [ ]` <-> `- [x]` on the given 1-indexed line, preserving that
 * line's exact indentation, bullet marker and trailing content. A line that
 * isn't a task item (or a line number outside the text) is returned
 * unchanged.
 *
 * Cascades to children: checking or unchecking a parent task also sets
 * every more-deeply-indented line beneath it to the same state, stopping at
 * the first line indented at or shallower than the parent (a sibling, or
 * the end of the sublist; blank lines are skipped without ending it). This
 * is a deliberate choice, not an accident - it's the behavior people expect
 * from nested checklists ("check off the whole sub-list by checking its
 * heading"). It's one-directional by design: checking every child never
 * auto-checks the parent, since that would let a stray click on a leaf item
 * silently mark an unrelated ancestor "done".
 */
export function toggleTaskAtLine(text: string, line: number): string {
  const lines = text.split('\n')
  const idx = line - 1
  if (idx < 0 || idx >= lines.length) return text

  const m = TASK_RE.exec(lines[idx])
  if (!m) return text

  const wasChecked = m[4] !== ' '
  const checked = !wasChecked
  const parentIndent = m[1].length
  lines[idx] = setTaskChecked(lines[idx], checked)

  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim().length === 0) continue // a blank line doesn't end the sublist
    const indent = (/^[ \t]*/.exec(l) as RegExpExecArray)[0].length
    if (indent <= parentIndent) break // sibling (or shallower): cascade stops here
    lines[i] = setTaskChecked(l, checked)
  }

  return lines.join('\n')
}

/**
 * Toolbar action: turns every line the selection touches into a task item
 * (`- [ ] `), expanding the selection to whole lines like the other
 * line-prefix helpers. Toggles off - stripping the task syntax back to
 * plain text - only when every touched line is already a task item.
 */
export function toggleTaskLine(text: string, start: number, end: number): EditResult {
  const { lineStart, lineEnd } = lineBounds(text, start, end)
  const segment = text.slice(lineStart, lineEnd)
  const lines = segment.split('\n')
  const allTasks = lines.every((l) => TASK_RE.test(l))

  const newLines = allTasks
    ? lines.map((l) => {
        const m = TASK_RE.exec(l)
        if (!m) return l
        const [, indent, , , , rest] = m
        // `rest` starts with the single space between `]` and the item's
        // text (see TASK_RE); drop just that one so plain-text round-trips
        // exactly through toggle-on/toggle-off.
        return indent + rest.replace(/^ /, '')
      })
    : lines.map((l) => {
        if (TASK_RE.test(l)) return l
        const indent = (/^[ \t]*/.exec(l) as RegExpExecArray)[0]
        return `${indent}- [ ] ${l.slice(indent.length)}`
      })

  const newSegment = newLines.join('\n')
  const newText = text.slice(0, lineStart) + newSegment + text.slice(lineEnd)
  return { text: newText, start: lineStart, end: lineStart + newSegment.length }
}

/** Adds two spaces of leading indentation to every line the selection
 *  touches, expanding the selection to whole lines. This is the nesting
 *  affordance for task (and other) lists: indenting a line under a task
 *  item makes it a child for `toggleTaskAtLine`'s cascade. */
export function indentLines(text: string, start: number, end: number): EditResult {
  const { lineStart, lineEnd } = lineBounds(text, start, end)
  const segment = text.slice(lineStart, lineEnd)
  const newSegment = segment
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n')
  const newText = text.slice(0, lineStart) + newSegment + text.slice(lineEnd)
  return { text: newText, start: lineStart, end: lineStart + newSegment.length }
}

/** Removes up to two spaces of leading indentation from every line the
 *  selection touches. Never goes below zero indentation, and a line with a
 *  single stray leading space is trimmed to zero rather than left alone or
 *  corrupted by slicing into its content. */
export function outdentLines(text: string, start: number, end: number): EditResult {
  const { lineStart, lineEnd } = lineBounds(text, start, end)
  const segment = text.slice(lineStart, lineEnd)
  const newSegment = segment
    .split('\n')
    .map((l) => (l.startsWith('  ') ? l.slice(2) : l.startsWith(' ') ? l.slice(1) : l))
    .join('\n')
  const newText = text.slice(0, lineStart) + newSegment + text.slice(lineEnd)
  return { text: newText, start: lineStart, end: lineStart + newSegment.length }
}

/**
 * Pure text transform for pressing Enter inside a task list item, so the
 * textarea's keydown handler in TextBox.tsx can stay a thin caller like
 * every other toolbar action here. Returns `null` when the line the caret
 * sits on isn't a task item, so the caller falls back to the textarea's own
 * newline handling.
 *
 * Splits the line at the caret like a normal Enter would (text before the
 * caret stays on the first line, text from the caret onward moves to the
 * new one), then prefixes the new line with the same indentation and
 * bullet marker as the current line - reusing the current bullet character
 * rather than always `-` matters because CommonMark treats a changed
 * bullet character as starting a new list; inserting a `-` continuation
 * under a `*` list would silently split it in two.
 *
 * If the current item has no text at all (just the marker), Enter instead
 * clears the line back to its bare indentation - the conventional way to
 * end a list from an empty trailing item.
 */
export function continueTaskOnEnter(text: string, caret: number): EditResult | null {
  const { lineStart, lineEnd } = lineBounds(text, caret, caret)
  const line = text.slice(lineStart, lineEnd)
  const m = TASK_RE.exec(line)
  if (!m) return null
  const [, indent, bullet, gap, , rest] = m

  if (rest.trim().length === 0) {
    const newText = text.slice(0, lineStart) + indent + text.slice(lineEnd)
    const pos = lineStart + indent.length
    return { text: newText, start: pos, end: pos }
  }

  const insertion = `\n${indent}${bullet}${gap}[ ] `
  const newText = text.slice(0, caret) + insertion + text.slice(caret)
  const pos = caret + insertion.length
  return { text: newText, start: pos, end: pos }
}
