import { MAX_TURNS } from './store'
import { blocksToText, type Box, type Turn } from './types'

export type ApiMessage = { role: 'user' | 'assistant'; content: string }

/** Assistant turns longer than this are excerpted before entering history. */
export const EXCERPT_LIMIT = 400

/**
 * Keeps the most recent turns and shortens long assistant replies. Full box
 * contents are supplied explicitly by selection, so history stays cheap.
 */
export function trimTurns(turns: Turn[], max = MAX_TURNS): Turn[] {
  return turns.slice(-max).map((t) => {
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

export function buildMessages(
  turns: Turn[],
  selected: Box[],
  prompt: string,
): ApiMessage[] {
  const history: ApiMessage[] = trimTurns(turns)
    .map((t) => ({ role: t.role, content: blocksToText(t.blocks).trim() }))
    .filter((m) => m.content.length > 0)

  return [...history, { role: 'user', content: boxContext(selected) + prompt }]
}
