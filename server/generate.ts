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
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
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

  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages,
      // Search is available, not forced: the model calls it only when the
      // question needs current information.
      tools: [{ type: 'web_search_20260209', name: 'web_search' }],
    } as Parameters<typeof client.messages.stream>[0])

    stream.on('text', (text) => sse(res, 'delta', { text }))

    const final = await stream.finalMessage()

    // A refusal is a successful HTTP 200 with empty or partial content. Report
    // it as an error rather than leaving an empty box on screen.
    if (final.stop_reason === 'refusal') {
      sse(res, 'error', {
        message: 'Claude declined this request.',
      })
      res.end()
      return
    }

    const sources = extractSources(final.content as unknown[])
    if (sources.length > 0) sse(res, 'sources', { sources })

    sse(res, 'done', {})
  } catch (err) {
    console.error('[generate]', err)
    sse(res, 'error', { message: (err as Error).message || 'Generation failed' })
  } finally {
    res.end()
  }
}
