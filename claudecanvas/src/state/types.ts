export type Source = { title: string; url: string }

export type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; data: string }
  | { type: 'html'; html: string }
  /**
   * A freehand/shape/text drawing made with Excalidraw. `elements` is
   * Excalidraw's own serialisable scene format (kept as `unknown[]` here so
   * this module never depends on the Excalidraw package). `preview` is a
   * downscaled PNG data URL regenerated whenever editing settles — it is
   * what lets vision (see state/context.ts) "see" the drawing; a drawing
   * with no preview yet is simply skipped rather than sent broken.
   */
  | { type: 'drawing'; elements: unknown[]; appState?: unknown; preview?: string }

export type BoxStatus = 'idle' | 'streaming' | 'error'

export type Box = {
  id: string
  x: number
  y: number
  w: number
  h: number
  blocks: Block[]
  render: 'markdown' | 'html'
  status: BoxStatus
  error?: string
  sources?: Source[]
  fromTurnId?: string
  /** The prompt that last generated this box, so a failure can be retried. */
  lastPrompt?: string
  /** Short auto-generated (or user-edited) label shown in the box header. */
  title?: string
  /** True once the user renames the box by hand, so auto-titling stops overwriting it. */
  titleEdited?: boolean
}

export type Turn = {
  id: string
  role: 'user' | 'assistant'
  blocks: Block[]
  /** Set on omnibar-originated turns, e.g. 'edited box "Pricing notes"'. */
  label?: string
  sources?: Source[]
  status?: 'streaming' | 'error'
  error?: string
}

/** Appends to the trailing text block, creating one when the list is empty or ends in a non-text block. */
export function appendToBlocks(blocks: Block[], text: string): Block[] {
  const out = [...blocks]
  const last = out[out.length - 1]
  if (last && last.type === 'text') {
    out[out.length - 1] = { type: 'text', text: last.text + text }
  } else {
    out.push({ type: 'text', text })
  }
  return out
}

/**
 * Flattens a block list to plain text. Image and drawing blocks are elided
 * (a drawing's content lives in `elements`/`preview`, not text); html blocks
 * contribute their markup.
 */
export function blocksToText(blocks: Block[]): string {
  return blocks
    .map((b) => (b.type === 'text' ? b.text : b.type === 'html' ? b.html : ''))
    .join('')
}

/** True when a box holds only image blocks — an in-place text rewrite would destroy it. */
export function isImageOnlyBox(blocks: Block[]): boolean {
  return blocks.length > 0 && blocks.every((b) => b.type === 'image')
}

/** True when a box holds only a drawing block — an in-place text rewrite would destroy it. */
export function isDrawingOnlyBox(blocks: Block[]): boolean {
  return blocks.length > 0 && blocks.every((b) => b.type === 'drawing')
}
