import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { Config } from './config.js'
import { renderPage } from './page.js'
import { start, advance, verify, proofMatches, sign } from './chain.js'
import { createLimiter } from './limiter.js'
import { createReplayGuard } from './replay.js'

const MAX_BODY_BYTES = 8 * 1024

function clientKey(req: IncomingMessage): string {
  // Trusting only the socket address, not X-Forwarded-For, keeps a caller
  // from resetting its own rate limit by spoofing a header. It also means
  // a real deployment behind a proxy would see one key for every request —
  // acceptable for a demo, called out in the README.
  return req.socket.remoteAddress ?? 'unknown'
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function createApp(config: Config): Server {
  // Separate budgets: challenge/hop are cheap and legitimately called
  // `total` times per walk, claim is the one that would matter if this
  // minted anything real.
  const challengeLimiter = createLimiter(30, 60_000)
  const hopLimiter = createLimiter(60, 60_000)
  const claimLimiter = createLimiter(10, 60_000)
  const replayGuard = createReplayGuard()

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://internal')

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(renderPage())
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/challenge') {
      if (!challengeLimiter.take(clientKey(req))) {
        sendJson(res, 429, { error: 'rate limited' })
        return
      }
      const claim = start(config.secret, config.ttlMs)
      sendJson(res, 200, { token: sign(claim, config.secret), hop: claim.hop, total: claim.total })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/hop') {
      if (!hopLimiter.take(clientKey(req))) {
        sendJson(res, 429, { error: 'rate limited' })
        return
      }
      const token = url.searchParams.get('token')
      if (!token) {
        sendJson(res, 400, { error: 'missing token' })
        return
      }
      const verified = verify(token, config.secret)
      if (!verified.ok) {
        sendJson(res, 400, { error: `invalid token: ${verified.reason}` })
        return
      }
      const result = advance(verified.claim, config.secret)
      if (!result.ok) {
        sendJson(res, 409, { error: 'chain already complete, submit to /api/claim' })
        return
      }
      sendJson(res, 200, {
        fragment: result.fragment,
        hop: result.claim.hop,
        total: result.claim.total,
        token: sign(result.claim, config.secret),
        done: result.claim.hop >= result.claim.total,
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/claim') {
      if (!claimLimiter.take(clientKey(req))) {
        sendJson(res, 429, { error: 'rate limited' })
        return
      }
      let parsed: unknown
      try {
        const raw = await readBody(req)
        parsed = JSON.parse(raw)
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' })
        return
      }
      const body = parsed as { token?: unknown; proof?: unknown }
      if (typeof body.token !== 'string' || !Array.isArray(body.proof)) {
        sendJson(res, 400, { error: 'expected { token: string, proof: string[] }' })
        return
      }
      const verified = verify(body.token, config.secret)
      if (!verified.ok) {
        sendJson(res, 400, { error: `invalid token: ${verified.reason}` })
        return
      }
      if (verified.claim.hop < verified.claim.total) {
        sendJson(res, 400, { error: 'chain incomplete' })
        return
      }
      if (!proofMatches(verified.claim, body.proof as string[], config.secret)) {
        sendJson(res, 400, { error: 'proof does not match the chain walked' })
        return
      }
      if (!replayGuard.claim(verified.claim.nonce, verified.claim.exp)) {
        sendJson(res, 409, { error: 'this chain has already been claimed' })
        return
      }
      sendJson(res, 200, {
        ok: true,
        message:
          'Verified: this was completed by a caller walking the chain programmatically, ' +
          'not a human clicking through a browser. This is a demo — in a real deployment ' +
          'a single-use Claude Max (20x), 3-month code would be issued here instead of this message.',
        reference: `DEMO-${verified.claim.nonce}`,
      })
      return
    }

    sendJson(res, 404, { error: 'not found' })
  })
}
