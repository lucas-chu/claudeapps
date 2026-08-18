import Anthropic from '@anthropic-ai/sdk'
import type { ApiMessage } from '../state/context'
import type { Source } from '../state/types'
import { extractSources } from './sources'
import { loadApiKey } from '../state/apiKey'

export type StreamHandlers = {
  onDelta: (text: string) => void
  onSources: (sources: Source[]) => void
  onError: (message: string) => void
  onDone: () => void
}

const MODEL = 'claude-opus-5'
const MAX_TOKENS = 16000

const TITLE_MAX_TOKENS = 32
const TITLE_INPUT_LIMIT = 2000
const TITLE_OUTPUT_LIMIT = 60

const TITLE_SYSTEM_PROMPT =
  'Write a short title, at most 5 words, describing the content below. ' +
  'Respond with plain text only: no quotes, no trailing punctuation, no markdown, ' +
  'no preamble — just the title itself.'

const webSearchTool: Anthropic.Messages.ToolUnion = {
  type: 'web_search_20260209',
  name: 'web_search',
}

/** Raised in place of a request when no key has been entered yet. */
export const NO_KEY_MESSAGE = 'Add your Anthropic API key to start generating.'

/**
 * The browser talks to the Anthropic API directly, so the user's key is the
 * only credential in play and never leaves their machine except to Anthropic.
 * `dangerouslyAllowBrowser` is what unlocks that path — the SDK refuses to run
 * in a browser without it, and setting it also makes the SDK send the
 * `anthropic-dangerous-direct-browser-access` header the API requires for a
 * cross-origin call from a page.
 */
function makeClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
}

/**
 * Turns an SDK error into something worth showing a user. The API's own
 * messages are long and JSON-ish, and the two failures a BYOK app actually
 * hits — a bad key and a spent balance — deserve to say what to do about it.
 */
export function describeApiError(err: unknown): string {
  const status = (err as { status?: number })?.status
  if (status === 401) return 'That API key was rejected. Check it in Settings.'
  if (status === 403) return 'That API key is not allowed to use this model.'
  if (status === 429) return 'Rate limited by the Anthropic API — try again shortly.'
  if (status === 400) {
    const message = (err as Error)?.message ?? ''
    // Surface credit exhaustion plainly; it reads as a generic 400 otherwise.
    if (/credit balance/i.test(message)) return 'Your Anthropic account is out of credit.'
  }
  if (status && status >= 500) return 'The Anthropic API is having trouble — try again shortly.'
  const message = (err as Error)?.message
  return message ? message : 'Generation failed.'
}

/** Strips surrounding quotes/markdown and collapses whitespace, regardless of what the model returned. */
export function sanitizeTitle(raw: string): string {
  let title = raw.trim()
  // Strip a matching pair of surrounding quote characters (straight or curly).
  title = title.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim()
  // Strip common markdown emphasis/heading markers.
  title = title.replace(/^#+\s*/, '')
  title = title.replace(/\*\*?([^*]*)\*\*?/g, '$1')
  title = title.replace(/`+/g, '')
  // Collapse all whitespace (including newlines) to single spaces.
  title = title.replace(/\s+/g, ' ').trim()
  // Drop a single trailing punctuation mark left over from a sentence-y reply.
  title = title.replace(/[.!?,;:]+$/, '').trim()
  return title.slice(0, TITLE_OUTPUT_LIMIT)
}

export async function generate(
  messages: ApiMessage[],
  handlers: StreamHandlers,
): Promise<void> {
  const apiKey = loadApiKey()
  if (!apiKey) {
    handlers.onError(NO_KEY_MESSAGE)
    return
  }

  try {
    const stream = makeClient(apiKey).messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: messages as Anthropic.Messages.MessageParam[],
      // No `effort` override and no `thinking` param: adaptive thinking is the
      // default on opus-5, and disabling it makes tool calls leak as plain text
      // so web search would silently never run. Search is available, not
      // forced — the model calls it only when the question needs it.
      tools: [webSearchTool],
    })

    stream.on('text', (text) => handlers.onDelta(text))

    const final = await stream.finalMessage()

    // A refusal is a successful HTTP 200 with empty or partial content. Report
    // it as an error rather than leaving an empty box on screen.
    if (final.stop_reason === 'refusal') {
      handlers.onError('Claude declined this request.')
      return
    }

    const sources = extractSources(final.content as unknown[])
    if (sources.length > 0) handlers.onSources(sources)

    handlers.onDone()
  } catch (err) {
    handlers.onError(describeApiError(err))
  }
}

/**
 * Requests a short auto-generated title for a piece of text. Never throws —
 * a failed title is a silent no-op for the caller, so any error (no key,
 * network, refusal, malformed reply) resolves to an empty string.
 */
export async function requestTitle(text: string): Promise<string> {
  const apiKey = loadApiKey()
  if (!apiKey) return ''

  try {
    const message = await makeClient(apiKey).messages.create({
      model: MODEL,
      max_tokens: TITLE_MAX_TOKENS,
      system: TITLE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text.slice(0, TITLE_INPUT_LIMIT) }],
      // Low effort is right for a 32-token label: it is not a reasoning task,
      // and the title is generated after the box is already readable.
      output_config: { effort: 'low' },
    })

    if (message.stop_reason === 'refusal') return ''

    const block = message.content.find((b) => b.type === 'text')
    return block && 'text' in block ? sanitizeTitle(block.text) : ''
  } catch {
    return ''
  }
}

/**
 * Spends one cheap request to find out whether a key works, so the settings
 * dialog can answer immediately instead of letting the first real prompt fail.
 * Resolves to null on success, or a human-readable reason.
 */
export async function verifyApiKey(apiKey: string): Promise<string | null> {
  try {
    await makeClient(apiKey).messages.create({
      model: MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
      output_config: { effort: 'low' },
    })
    return null
  } catch (err) {
    return describeApiError(err)
  }
}
