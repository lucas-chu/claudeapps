import { createServer, type Server } from 'node:http'
import type { Config } from './config.js'
import { createLimiter } from './limiter.js'
import { createReplayGuard } from './replay.js'
import {
  handlePage,
  handleHealth,
  handleChallenge,
  handleHop,
  handleClaim,
  sendJson,
} from './handlers.js'

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

    if (req.method === 'GET' && url.pathname === '/') return handlePage(res)
    if (req.method === 'GET' && url.pathname === '/api/health') return handleHealth(res)
    if (req.method === 'GET' && url.pathname === '/api/challenge') {
      return handleChallenge(req, res, config, challengeLimiter)
    }
    if (req.method === 'GET' && url.pathname === '/api/hop') {
      return handleHop(req, res, url, config, hopLimiter)
    }
    if (req.method === 'POST' && url.pathname === '/api/claim') {
      return handleClaim(req, res, config, claimLimiter, replayGuard)
    }

    sendJson(res, 404, { error: 'not found' })
  })
}
