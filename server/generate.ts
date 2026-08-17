import type { IncomingMessage, ServerResponse } from 'node:http'
import Anthropic from '@anthropic-ai/sdk'
import type { Config } from './config.js'
import { extractSources } from './sources.js'

const MODEL = 'claude-opus-5'
const MAX_TOKENS = 16000

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function sse(res: ServerResponse, event: string, payload: unknown) {
  // The client may have disconnected between the last write and this one;
  // writing to an ended/destroyed response would risk an unhandled 'error'.
  if (res.writableEnded || res.destroyed) return
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
}

// Strips anything resembling an Anthropic API key so it can never reach a
// log line or a client payload, regardless of how the SDK populates errors.
const API_KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]+/g
function redact(message: string): string {
  return message.replace(API_KEY_PATTERN, '[redacted]')
}

// SDK 0.116.0 exports a proper type for the web_search_20260209 tool variant
// (Anthropic.Messages.ToolUnion includes WebSearchTool20260209), so a plain
// annotation is enough here — no cast needed, and model/max_tokens/messages
// below stay fully type-checked.
const webSearchTool: Anthropic.Messages.ToolUnion = {
  type: 'web_search_20260209',
  name: 'web_search',
}

const TITLE_MODEL = 'claude-opus-5'
const TITLE_MAX_TOKENS = 32
const TITLE_INPUT_LIMIT = 2000
const TITLE_OUTPUT_LIMIT = 60

const TITLE_SYSTEM_PROMPT =
  'Write a short title, at most 5 words, describing the content below. ' +
  'Respond with plain text only: no quotes, no trailing punctuation, no markdown, ' +
  'no preamble — just the title itself.'

/** Strips surrounding quotes/markdown and collapses whitespace, regardless of what the model returned. */
function sanitizeTitle(raw: string): string {
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

export async function handleTitle(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
): Promise<void> {
  let text: string
  try {
    const parsed = JSON.parse(await readBody(req))
    text = parsed.text
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('text must be a non-empty string')
    }
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: (err as Error).message }))
    return
  }

  const client = new Anthropic({ apiKey: config.apiKey, baseURL: config.baseURL })

  try {
    const message = await client.messages.create({
      model: TITLE_MODEL,
      max_tokens: TITLE_MAX_TOKENS,
      system: TITLE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text.slice(0, TITLE_INPUT_LIMIT) }],
      // Low effort is right for a 32-token label: it is not a reasoning task,
      // and the title is generated after the box is already readable.
      output_config: { effort: 'low' },
    })

    // A failed title must never surface as an error to the user — respond
    // 200 with an empty title and let the client silently skip it.
    if (message.stop_reason === 'refusal') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ title: '' }))
      return
    }

    const textBlock = message.content.find((b) => b.type === 'text')
    const title = textBlock && 'text' in textBlock ? sanitizeTitle(textBlock.text) : ''

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ title }))
  } catch (err) {
    const message = redact((err as Error).message || 'Title generation failed')
    console.error('[title]', { message, status: (err as { status?: number }).status })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ title: '' }))
  }
}

export async function handleGenerate(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
): Promise<void> {
  let messages: { role: 'user' | 'assistant'; content: string }[]
  try {
    const parsed = JSON.parse(await readBody(req))
    messages = parsed.messages
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('messages must be a non-empty array')
    }
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: (err as Error).message }))
    return
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })

  const client = new Anthropic({ apiKey: config.apiKey, baseURL: config.baseURL })

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages,
    // No `effort` override here: an A/B against the live API showed low effort
    // gave no measurable time-to-first-token win (9.1s vs 9.4-10.8s), so it was
    // only trading answer quality for nothing. Do not add a `thinking` param
    // either — disabling thinking on opus-5 makes tool calls leak as plain text
    // (web search would silently never run) and <thinking> tags leak into output.
    // Search is available, not forced: the model calls it only when the
    // question needs current information.
    tools: [webSearchTool],
  })

  // If the client goes away mid-stream (reload, tab close, server restart on
  // their end), stop burning tokens against a dead socket instead of running
  // the request to completion.
  let clientGone = false
  const onClose = () => {
    clientGone = true
    stream.abort()
  }
  req.on('close', onClose)

  try {
    stream.on('text', (text) => sse(res, 'delta', { text }))

    const final = await stream.finalMessage()

    // A refusal is a successful HTTP 200 with empty or partial content. Report
    // it as an error rather than leaving an empty box on screen.
    if (final.stop_reason === 'refusal') {
      sse(res, 'error', {
        message: 'Claude declined this request.',
      })
      return
    }

    const sources = extractSources(final.content as unknown[])
    if (sources.length > 0) sse(res, 'sources', { sources })

    sse(res, 'done', {})
  } catch (err) {
    // A client-initiated abort surfaces here as a rejected finalMessage()
    // (APIUserAbortError); the socket is already gone, so there is nothing
    // to report and nothing to write.
    if (!clientGone) {
      const message = redact((err as Error).message || 'Generation failed')
      console.error('[generate]', { message, status: (err as { status?: number }).status })
      sse(res, 'error', { message })
    }
  } finally {
    req.off('close', onClose)
    if (!clientGone && !res.writableEnded) res.end()
  }
}
