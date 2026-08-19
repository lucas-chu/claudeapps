import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleHealth } from '../src/handlers.js'

export default function handler(_req: IncomingMessage, res: ServerResponse): void {
  handleHealth(res)
}
