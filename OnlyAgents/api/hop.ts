import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadConfig } from '../src/config.js'
import { createLimiter } from '../src/limiter.js'
import { handleHop } from '../src/handlers.js'

const config = loadConfig(process.env)
const limiter = createLimiter(60, 60_000)

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://internal')
  handleHop(req, res, url, config, limiter)
}
