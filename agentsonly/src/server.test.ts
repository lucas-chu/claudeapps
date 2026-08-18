import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createApp } from './server.js'
import type { Config } from './config.js'
import { HOPS } from './chain.js'

let server: Server
let baseUrl: string

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    secret: 'integration-secret',
    ttlMs: 60_000,
    ephemeralSecret: true,
    ...overrides,
  }
}

function boot(config: Config = testConfig()): Promise<void> {
  return new Promise((resolve) => {
    server = createApp(config)
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${port}`
      resolve()
    })
  })
}

async function walkFully(): Promise<{ token: string; proof: string[] }> {
  const challenge = (await (await fetch(`${baseUrl}/api/challenge`)).json()) as {
    token: string
  }
  let token = challenge.token
  const proof: string[] = []
  for (let i = 0; i < HOPS; i++) {
    const hop = (await (await fetch(`${baseUrl}/api/hop?token=${encodeURIComponent(token)}`)).json()) as {
      fragment: string
      token: string
      done: boolean
    }
    proof.push(hop.fragment)
    token = hop.token
  }
  return { token, proof }
}

beforeEach(async () => {
  await boot()
})

afterEach(() => {
  server.close()
})

describe('agentsonly server', () => {
  it('serves the page as HTML', async () => {
    const res = await fetch(`${baseUrl}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('application/json')
  })

  it('walks the full chain and claims successfully', async () => {
    const { token, proof } = await walkFully()
    const res = await fetch(`${baseUrl}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, proof }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; reference: string }
    expect(json.ok).toBe(true)
    expect(json.reference).toMatch(/^DEMO-/)
  })

  it('rejects claiming the same completed chain twice', async () => {
    const { token, proof } = await walkFully()
    const first = await fetch(`${baseUrl}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, proof }),
    })
    expect(first.status).toBe(200)
    const second = await fetch(`${baseUrl}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, proof }),
    })
    expect(second.status).toBe(409)
  })

  it('rejects claiming with a chain that has not finished all hops', async () => {
    const challenge = (await (await fetch(`${baseUrl}/api/challenge`)).json()) as { token: string }
    const res = await fetch(`${baseUrl}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: challenge.token, proof: [] }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects claiming when a hop was skipped', async () => {
    const challenge = (await (await fetch(`${baseUrl}/api/challenge`)).json()) as { token: string }
    let token = challenge.token
    const proof: string[] = []
    for (let i = 0; i < HOPS; i++) {
      const hop = (await (await fetch(`${baseUrl}/api/hop?token=${encodeURIComponent(token)}`)).json()) as {
        fragment: string
        token: string
      }
      // Skip recording the first fragment to simulate a caller that jumped in late.
      if (i > 0) proof.push(hop.fragment)
      token = hop.token
    }
    const res = await fetch(`${baseUrl}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, proof }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a hop request with a tampered token', async () => {
    const challenge = (await (await fetch(`${baseUrl}/api/challenge`)).json()) as { token: string }
    const tampered = challenge.token.slice(0, -1) + (challenge.token.endsWith('a') ? 'b' : 'a')
    const res = await fetch(`${baseUrl}/api/hop?token=${encodeURIComponent(tampered)}`)
    expect(res.status).toBe(400)
  })

  it('refuses a second hop request past the total', async () => {
    const challenge = (await (await fetch(`${baseUrl}/api/challenge`)).json()) as { token: string }
    let token = challenge.token
    for (let i = 0; i < HOPS; i++) {
      const hop = (await (await fetch(`${baseUrl}/api/hop?token=${encodeURIComponent(token)}`)).json()) as {
        token: string
      }
      token = hop.token
    }
    const res = await fetch(`${baseUrl}/api/hop?token=${encodeURIComponent(token)}`)
    expect(res.status).toBe(409)
  })

  it('404s on unknown routes', async () => {
    const res = await fetch(`${baseUrl}/nope`)
    expect(res.status).toBe(404)
  })

  it('rate limits repeated claim attempts from the same caller', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 15 }, () =>
        fetch(`${baseUrl}/api/claim`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: 'x', proof: [] }),
        }),
      ),
    )
    expect(attempts.some((r) => r.status === 429)).toBe(true)
  })
})
