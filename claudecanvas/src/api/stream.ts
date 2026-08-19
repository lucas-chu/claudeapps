import Anthropic from '@anthropic-ai/sdk'
import type { ApiMessage } from '../state/context'
import type { Source } from '../state/types'
import { extractSources } from './sources'
import { loadApiKey } from '../state/apiKey'
import { loadSettings, apiEffort } from '../state/settings'

export type StreamHandlers = {
  onDelta: (text: string) => void
  /**
   * Running summary of Claude's reasoning, if the model produced any.
   * Adaptive thinking means several seconds can pass before the first answer
   * token; without this the user stares at a pulsing dot and calls it slow.
   */
  onThinking?: (summary: string) => void
  /** Reports a fallback the user should know about (e.g. fast mode declined). */
  onNotice?: (message: string) => void
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
 * How many times a paused turn will be resumed before giving up.
 *
 * Web search runs a *server-side* sampling loop, and when it reaches its
 * iteration limit the API returns a successful message with
 * `stop_reason: "pause_turn"` — a partial answer, not an error. The client is
 * expected to send the conversation back so the server resumes where it left
 * off; the SDK does not do this for you. Without it, a research-heavy question
 * simply stops mid-answer and looks finished.
 *
 * A bound is still needed so a pathological question can't loop forever, and
 * hitting it says so rather than passing off a truncated answer as complete.
 */
export const MAX_CONTINUATIONS = 6

export const TRUNCATED_MESSAGE =
  'This answer was still going after several rounds of research and was cut short.'

export const FAST_FALLBACK_MESSAGE =
  'Fast mode was rate limited — this answer ran at standard speed.'

/**
 * Fast mode is a research preview on opus-5, billed at a premium rate and
 * carrying its own rate limit separate from standard capacity. It therefore
 * goes through the beta endpoint and needs this flag; see FAST_FALLBACK_MESSAGE
 * for what happens when that separate limit is hit.
 */
const FAST_MODE_BETA = 'fast-mode-2026-02-01'

/**
 * Reasoning is streamed as a summary, never raw. `display` defaults to
 * `omitted` on opus-5, which is what made a long think look like a hang.
 * Thinking itself stays ON: disabling it on opus-5 makes tool calls leak into
 * the visible text, so web search would silently never run.
 */
const THINKING: Anthropic.Messages.ThinkingConfigParam = {
  type: 'adaptive',
  display: 'summarized',
}

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
    const client = makeClient(apiKey)
    // Grows by one assistant turn each time the server pauses. The user's
    // message is never repeated: the API detects the trailing server_tool_use
    // block and resumes on its own, and an added "continue" would derail it.
    let convo = [...messages] as Anthropic.Messages.MessageParam[]
    const sources: Source[] = []
    const seenUrls = new Set<string>()

    const settings = loadSettings()
    const effort = apiEffort(settings.effort)
    // Latched, not re-read: once a request falls back to standard speed, the
    // rest of a paused-and-resumed answer stays there rather than re-trying
    // fast mode on every continuation.
    let useFast = settings.speed === 'fast'

    // Search is available, not forced — the model calls it only when the
    // question needs current information.
    const paramsFor = (convo: Anthropic.Messages.MessageParam[]) => ({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: convo,
      tools: [webSearchTool],
      thinking: THINKING,
      // Spread, never `effort: undefined`: "auto" must send no effort at all,
      // so whatever the API's own default is applies.
      ...(effort ? { output_config: { effort } } : {}),
    })

    /**
     * One request. The two endpoints are kept in separate branches rather
     * than behind a shared variable because the beta and stable stream types
     * form a union whose `.on()` overloads aren't mutually callable.
     */
    const runOnce = async (convo: Anthropic.Messages.MessageParam[], fast: boolean) => {
      if (fast) {
        const st = client.beta.messages.stream({
          ...paramsFor(convo),
          speed: 'fast',
          betas: [FAST_MODE_BETA],
        })
        st.on('text', (text) => handlers.onDelta(text))
        // The snapshot, not the delta: the UI shows a running summary, so
        // re-accumulating deltas here would duplicate the SDK's own work.
        st.on('thinking', (_delta, snapshot) => handlers.onThinking?.(snapshot))
        return await st.finalMessage()
      }
      const st = client.messages.stream(paramsFor(convo))
      st.on('text', (text) => handlers.onDelta(text))
      st.on('thinking', (_delta, snapshot) => handlers.onThinking?.(snapshot))
      return await st.finalMessage()
    }

    for (let round = 0; ; round++) {
      let final
      try {
        final = await runOnce(convo, useFast)
      } catch (err) {
        // Fast mode is a research preview with its own rate limit, separate
        // from standard capacity. Being turned away from it should cost the
        // user a slower answer, never the answer itself.
        if (!useFast) throw err
        const status = (err as { status?: number })?.status
        if (status !== 429 && status !== 400 && status !== 404) throw err
        useFast = false
        handlers.onNotice?.(FAST_FALLBACK_MESSAGE)
        final = await runOnce(convo, false)
      }

      // A refusal is a successful HTTP 200 with empty or partial content. Report
      // it as an error rather than leaving an empty box on screen.
      if (final.stop_reason === 'refusal') {
        handlers.onError('Claude declined this request.')
        return
      }

      // Citations accumulate across rounds; a source found in round 1 must not
      // be lost because round 3 is the one that finishes.
      for (const source of extractSources(final.content as unknown[])) {
        if (seenUrls.has(source.url)) continue
        seenUrls.add(source.url)
        sources.push(source)
      }

      if (final.stop_reason !== 'pause_turn') break

      if (round >= MAX_CONTINUATIONS) {
        // Say so rather than presenting a truncated answer as a complete one.
        if (sources.length > 0) handlers.onSources(sources)
        handlers.onError(TRUNCATED_MESSAGE)
        return
      }

      // The beta and stable SDKs describe content with different (structurally
      // wider) block unions, even though the wire format is identical — so a
      // fast-mode message can't be assigned back into the stable param type
      // without this. Only the assistant turn we just received is re-sent, so
      // it is exactly what the API produced.
      convo = [
        ...convo,
        { role: 'assistant', content: final.content as Anthropic.Messages.ContentBlockParam[] },
      ]
    }

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
