import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadConfig } from '../src/config.js'
import { createLimiter } from '../src/limiter.js'
import { handleChallenge } from '../src/handlers.js'

// Module scope: reused across invocations on a warm instance, reset on cold
// start. Rate limiting is therefore per-instance under Vercel, not global —
// see the README's deployment notes.
const config = loadConfig(process.env)
const limiter = createLimiter(30, 60_000)

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  handleChallenge(req, res, config, limiter)
}
