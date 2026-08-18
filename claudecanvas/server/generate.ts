import type { IncomingMessage, ServerResponse } from 'node:http'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, readFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import type { Config } from './config.js'
import { extractSources } from './sources.js'

const execFile = promisify(execFileCb)

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
  // Content can be a plain string or an array of content blocks (vision
  // requests send images before a trailing text block). Individual blocks are
  // deliberately not deep-validated here — the Anthropic API is the authority
  // on block shape, so a malformed block surfaces as a normal API error
  // rather than being rejected at this layer.
  let messages: Anthropic.Messages.MessageParam[]
  try {
    const parsed = JSON.parse(await readBody(req))
    const rawMessages = parsed.messages
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      throw new Error('messages must be a non-empty array')
    }
    for (const m of rawMessages) {
      const content = (m as { content?: unknown } | null)?.content
      if (typeof content !== 'string' && !Array.isArray(content)) {
        throw new Error('each message content must be a string or an array of content blocks')
      }
    }
    messages = rawMessages
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

// Real iPhone HEICs choke heic2any's bundled libheif ("ERR_LIBHEIF format not
// supported"), so conversion happens here instead, via macOS's own `sips`.
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024 // 40MB
const SIPS_TIMEOUT_MS = 20_000

/**
 * Reads the raw request body into a Buffer, capping it at maxBytes. A client
 * sending more than that is never buffered in full: as soon as the running
 * total crosses the cap, a 413 is written immediately and the request socket
 * is destroyed so nothing keeps accumulating in memory. Returns null in that
 * case so the caller knows a response has already been sent.
 */
function readBodyBuffer(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false

    req.on('data', (chunk: Buffer) => {
      if (settled) return
      total += chunk.length
      if (total > maxBytes) {
        settled = true
        res.writeHead(413, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'image exceeds 40MB limit' }))
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

export async function handleConvertImage(
  req: IncomingMessage,
  res: ServerResponse,
  _config: Config,
): Promise<void> {
  // sips is macOS-only. Check before touching the body at all, so a
  // non-macOS host never buffers a large upload just to reject it anyway.
  if (process.platform !== 'darwin') {
    res.writeHead(501, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'HEIC conversion requires macOS' }))
    return
  }

  let bytes: Buffer | null
  try {
    bytes = await readBodyBuffer(req, res, MAX_UPLOAD_BYTES)
  } catch (err) {
    console.error('[convert-image]', { message: redact((err as Error).message || 'body read failed') })
    if (!res.writableEnded) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'could not read request body' }))
    }
    return
  }
  // A null result means readBodyBuffer already wrote the 413 itself.
  if (bytes === null) return

  if (bytes.length === 0) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'empty request body' }))
    return
  }

  // Server-generated names only. Never derive a filename from anything the
  // client sends: the request body is written to disk purely as opaque
  // bytes, under a name only this handler chooses, so nothing the client
  // controls can influence a filesystem path or, via execFile's argv array,
  // be interpreted as shell syntax.
  const id = randomUUID()
  const inPath = join(tmpdir(), `cove-convert-${id}.heic`)
  const outPath = join(tmpdir(), `cove-convert-${id}.jpg`)

  try {
    await writeFile(inPath, bytes)

    // execFile (not exec) with an argv array and no shell: the input is a
    // server-chosen temp path, never client-controlled text, so there is
    // nothing here a crafted upload could turn into a shell command.
    await execFile('sips', ['-s', 'format', 'jpeg', '-Z', '1280', inPath, '--out', outPath], {
      timeout: SIPS_TIMEOUT_MS,
    })

    const jpeg = await readFile(outPath)
    res.writeHead(200, { 'content-type': 'image/jpeg' })
    res.end(jpeg)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // ENOENT here means the `sips` binary itself could not be found (e.g. a
    // non-standard macOS setup) rather than a bad image.
    if (code === 'ENOENT') {
      res.writeHead(501, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'HEIC conversion requires macOS' }))
      return
    }
    // Log the real reason server-side, but never leak the temp paths (or
    // anything else about the host filesystem) to the client.
    const message = redact((err as Error).message || 'HEIC conversion failed')
    console.error('[convert-image]', { message })
    res.writeHead(422, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'could not convert image' }))
  } finally {
    await Promise.allSettled([unlink(inPath), unlink(outPath)])
  }
}
