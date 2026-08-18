import { describe, it, expect } from 'vitest'
import { loadConfig } from './config'

describe('loadConfig', () => {
  it('reads the api key from the environment', () => {
    const c = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-test' })
    expect(c.apiKey).toBe('sk-ant-test')
  })

  it('defaults the base url to the public api', () => {
    const c = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-test' })
    expect(c.baseURL).toBe('https://api.anthropic.com')
  })

  it('ignores an inherited ANTHROPIC_BASE_URL unless COVE_BASE_URL is set', () => {
    const c = loadConfig({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      ANTHROPIC_BASE_URL: 'https://inherited.example.com',
    })
    expect(c.baseURL).toBe('https://api.anthropic.com')
  })

  it('honors an explicit COVE_BASE_URL override', () => {
    const c = loadConfig({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      COVE_BASE_URL: 'https://explicit.example.com',
    })
    expect(c.baseURL).toBe('https://explicit.example.com')
  })

  it('throws a readable error when the key is missing', () => {
    expect(() => loadConfig({})).toThrow(/ANTHROPIC_API_KEY/)
  })

  it('defaults the port to 8787', () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: 'k' }).port).toBe(8787)
  })
})
