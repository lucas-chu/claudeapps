import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadConfig } from '../src/config.js'
import { createLimiter } from '../src/limiter.js'
import { createReplayGuard } from '../src/replay.js'
import { handleClaim } from '../src/handlers.js'

const config = loadConfig(process.env)
const limiter = createLimiter(10, 60_000)
// Per-instance only under Vercel — a claim replayed against a different
// warm instance would not be caught. Documented, accepted tradeoff for a
// demo that issues placeholder codes, not real ones.
const replayGuard = createReplayGuard()

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleClaim(req, res, config, limiter, replayGuard)
}
