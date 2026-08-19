import type { IncomingMessage, ServerResponse } from 'node:http'
import { handlePage } from '../src/handlers.js'

export default function handler(_req: IncomingMessage, res: ServerResponse): void {
  handlePage(res)
}
