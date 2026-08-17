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
