import { randomBytes } from 'node:crypto'

export type Config = {
  port: number
  secret: string
  /** How long a chain walk may take, start to claim. */
  ttlMs: number
  /** Whether the secret was generated for this process rather than supplied. */
  ephemeralSecret: boolean
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const supplied = env.AGENTSONLY_SECRET
  return {
    port: Number(env.AGENTSONLY_PORT ?? 8788),
    // A generated secret is fine for a demo, but every restart invalidates
    // in-flight chains, so the server says so out loud at boot.
    secret: supplied ?? randomBytes(32).toString('hex'),
    ephemeralSecret: !supplied,
    ttlMs: Number(env.AGENTSONLY_TTL_MS ?? 120_000),
  }
}
