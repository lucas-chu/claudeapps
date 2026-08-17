import { MAX_TURNS } from './store'
import { blocksToText, type Box, type Turn } from './types'

/** A single content block in an Anthropic-shaped multimodal message. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

export type ApiMessage = { role: 'user' | 'assistant'; content: string | ContentBlock[] }

/** Assistant turns longer than this are excerpted before entering history. */
export const EXCERPT_LIMIT = 400

/**
 * Hard cap on images sent in a single request. Selecting more than this still
 * works — the extra images are omitted and the model is told so in the text
 * block, rather than silently dropping them without a trace.
 */
export const MAX_IMAGES_PER_REQUEST = 5

/**
 * Keeps the most recent turns and shortens long assistant replies. Full box
 * contents are supplied explicitly by selection, so history stays cheap.
 */
/**
 * Drops exchanges that haven't finished yet.
 *
 * This matters once generations run in parallel. Firing three prompts in a row
 * leaves three user turns in the thread whose assistant replies are all still
 * streaming. Without this filter, prompt 2's history contains prompt 1's
 * unanswered question — and since adjacent same-role messages are collapsed,
 * the model receives "name a fish\n\nname a bird" as one message and dutifully
 * answers both. Observed live: three rapid prompts produced boxes reading
 * "Fish: clownfish. Bird: robin."
 *
 * A user turn is only context once it has a completed assistant reply, so an
 * in-flight or errored pair is excluded until it settles.
 */
export function completedTurns(turns: Turn[]): Turn[] {
  const out: Turn[] = []
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]
    if (turn.status === 'streaming' || turn.status === 'error') continue
    if (turn.role === 'user') {
      const reply = turns[i + 1]
      const answered = reply?.role === 'assistant' && !reply.status
      if (!answered) continue
    }
    out.push(turn)
  }
  return out
}

export function trimTurns(turns: Turn[], max = MAX_TURNS): Turn[] {
  return completedTurns(turns).slice(-max).map((t) => {
    const text = blocksToText(t.blocks)
    if (text.length <= EXCERPT_LIMIT) return t
    return { ...t, blocks: [{ type: 'text', text: text.slice(0, EXCERPT_LIMIT) + '…' }] }
  })
}

function boxContext(selected: Box[]): string {
  if (selected.length === 0) return ''
  const parts = selected.map((b, i) => {
    const text = blocksToText(b.blocks)
    return `<box index="${i + 1}">\n${text}\n</box>`
  })
  return parts.join('\n\n') + '\n\n'
}

// Matches `data:<media-type>;base64,<data>`. The data half is captured
// greedily (with `s` so embedded newlines don't stop it) and whitespace is
// stripped afterward, since some sources wrap base64 at a fixed column.
const DATA_URL_RE = /^data:([^;,]+);base64,(.*)$/s
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Splits a stored `data:<mime>;base64,<data>` URL into the media type and
 * bare base64 payload the Anthropic API expects. Returns null for anything
 * that doesn't match, so a corrupted block can be skipped rather than sent
 * as a broken image block.
 */
function parseImageDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const match = DATA_URL_RE.exec(dataUrl)
  if (!match) return null
  const mediaType = match[1].trim()
  const data = match[2].replace(/\s+/g, '')
  if (!mediaType || !data || !BASE64_RE.test(data)) return null
  return { mediaType, data }
}

/**
 * Collects valid image blocks from the selected boxes, in selection order,
 * capped at MAX_IMAGES_PER_REQUEST. Blocks with a malformed data URL are
 * dropped silently (never sent broken); `omitted` counts valid images beyond
 * the cap so the caller can tell the model what was left out.
 *
 * A drawing block contributes its `preview` (a PNG data URL snapshot of the
 * Excalidraw scene) the same way an image block contributes its `data` —
 * this is what lets vision "see" a drawing. A drawing with no preview yet
 * (never edited, or mid-debounce) is skipped rather than sent broken.
 */
function collectImages(selected: Box[]): { blocks: ContentBlock[]; omitted: number } {
  const valid: ContentBlock[] = []
  for (const box of selected) {
    for (const block of box.blocks) {
      const dataUrl = block.type === 'image' ? block.data : block.type === 'drawing' ? block.preview : undefined
      if (!dataUrl) continue
      const parsed = parseImageDataUrl(dataUrl)
      if (!parsed) continue
      valid.push({
        type: 'image',
        source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data },
      })
    }
  }
  return {
    blocks: valid.slice(0, MAX_IMAGES_PER_REQUEST),
    omitted: Math.max(0, valid.length - MAX_IMAGES_PER_REQUEST),
  }
}

function omissionNote(omitted: number): string {
  if (omitted === 0) return ''
  const plural = omitted === 1 ? '' : 's'
  return (
    `\n\n(${omitted} more image${plural} selected but not sent — only the first ` +
    `${MAX_IMAGES_PER_REQUEST} images are included per request.)`
  )
}

/**
 * Merges two message contents of the same role that ended up adjacent, e.g.
 * when a dropped empty turn leaves two user messages back to back. Plain
 * strings concatenate exactly as before; if either side carries content
 * blocks, both sides are normalized to blocks and merged with every image
 * first, then a single combined text block, preserving the image-before-text
 * ordering the API requires.
 */
export function mergeContent(a: ApiMessage['content'], b: ApiMessage['content']): ApiMessage['content'] {
  if (typeof a === 'string' && typeof b === 'string') return `${a}\n\n${b}`

  const toBlocks = (c: ApiMessage['content']): ContentBlock[] =>
    typeof c === 'string' ? (c.length > 0 ? [{ type: 'text', text: c }] : []) : c

  const combined = [...toBlocks(a), ...toBlocks(b)]
  const images = combined.filter((blk) => blk.type === 'image')
  const texts = combined.filter((blk) => blk.type === 'text').map((blk) => blk.text)

  const merged: ContentBlock[] = [...images]
  if (texts.length > 0) merged.push({ type: 'text', text: texts.join('\n\n') })
  return merged
}

/**
 * The Anthropic API requires strict user/assistant alternation. Dropping
 * empty turns (e.g. an assistant turn that errored before any delta) can
 * leave two turns of the same role adjacent, so merge runs of the same role
 * into one message rather than sending them back to back.
 */
function collapseAdjacentRoles(messages: ApiMessage[]): ApiMessage[] {
  const out: ApiMessage[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (last && last.role === m.role) {
      last.content = mergeContent(last.content, m.content)
    } else {
      out.push({ ...m })
    }
  }
  return out
}

export function buildMessages(
  turns: Turn[],
  selected: Box[],
  prompt: string,
): ApiMessage[] {
  const history: ApiMessage[] = trimTurns(turns)
    .map((t) => ({ role: t.role, content: blocksToText(t.blocks).trim() }))
    .filter((m) => m.content.length > 0)

  const text = boxContext(selected) + prompt
  const { blocks: images, omitted } = collectImages(selected)

  // Images (if any) always come first, then a single text block — the order
  // the API requires. No images selected keeps the plain-string shape this
  // had before vision existed, so the common case's wire format never changes.
  const finalMessage: ApiMessage =
    images.length === 0
      ? { role: 'user', content: text }
      : { role: 'user', content: [...images, { type: 'text', text: text + omissionNote(omitted) }] }

  // Collapse across the history/prompt boundary too: a dropped empty turn
  // can leave the last history message and the new prompt both 'user'.
  return collapseAdjacentRoles([...history, finalMessage])
}
