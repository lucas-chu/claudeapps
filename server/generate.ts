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
