import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { loadConfig } from './config.js'
import { handleGenerate, handleTitle, handleConvertImage } from './generate.js'

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
  // The project's .env must win over an inherited shell variable — the same
  // silent-override hazard CANVAS_BASE_URL is deliberately guarded against
  // above. A stale exported ANTHROPIC_API_KEY would otherwise beat .env and
  // produce a confusing 401 while .env looks correct.
  const dotEnv = readDotEnv()
  config = loadConfig({ ...process.env, ...dotEnv })
  console.log(`  key source: ${dotEnv.ANTHROPIC_API_KEY ? '.env' : 'environment'}`)
} catch (err) {
  console.error(`\n  Claude Canvas cannot start.\n\n  ${(err as Error).message}\n`)
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
  if (req.method === 'POST' && req.url === '/api/title') {
    await handleTitle(req, res, config)
    return
  }
  if (req.method === 'POST' && req.url === '/api/convert-image') {
    await handleConvertImage(req, res, config)
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

server.listen(config.port, () => {
  console.log(`  claude-canvas server ready on http://localhost:${config.port}`)
})
