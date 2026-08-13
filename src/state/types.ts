export type Source = { title: string; url: string }

export type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; data: string }
  | { type: 'html'; html: string }

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

/** Flattens a block list to plain text. Image and html blocks are elided. */
export function blocksToText(blocks: Block[]): string {
  return blocks
    .map((b) => (b.type === 'text' ? b.text : b.type === 'html' ? b.html : ''))
    .join('')
}
