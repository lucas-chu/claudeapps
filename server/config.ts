export type Config = {
  apiKey: string
  baseURL: string
  port: number
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com'

export function loadConfig(env: Record<string, string | undefined>): Config {
  const apiKey = env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Create a .env file in the project root ' +
        'containing:\n\n  ANTHROPIC_API_KEY=sk-ant-...\n\n' +
        'Copy .env.example to .env to get started.',
    )
  }
  return {
    apiKey,
    // Deliberately NOT ANTHROPIC_BASE_URL: an inherited shell variable must
    // never silently redirect requests. Override explicitly with COVE_BASE_URL.
    baseURL: env.COVE_BASE_URL ?? DEFAULT_BASE_URL,
    port: Number(env.COVE_PORT ?? 8787),
  }
}
