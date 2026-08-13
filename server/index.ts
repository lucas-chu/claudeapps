import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { loadConfig } from './config.js'
import { handleGenerate } from './generate.js'

// Minimal .env loader — avoids a dependency and keeps startup explicit.
function readDotEnv(): Record<string, string> {
  try {
    const raw = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    const out: Record<string, string> = {}
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
    return out
  } catch {
    return {}
  }
}

let config
try {
  config = loadConfig({ ...readDotEnv(), ...process.env })
} catch (err) {
  console.error(`\n  Cove Canvas cannot start.\n\n  ${(err as Error).message}\n`)
  process.exit(1)
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  if (req.method === 'POST' && req.url === '/api/generate') {
    await handleGenerate(req, res, config)
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

server.listen(config.port, () => {
  console.log(`  cove-canvas server ready on http://localhost:${config.port}`)
})
