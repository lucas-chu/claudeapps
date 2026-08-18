import { describe, it, expect } from 'vitest'
import { extractSources } from './sources'

describe('extractSources', () => {
  it('pulls title and url out of web_search_tool_result blocks', () => {
    const content = [
      { type: 'text', text: 'Here is what I found.' },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', title: 'Anthropic', url: 'https://anthropic.com' },
          { type: 'web_search_result', title: 'Docs', url: 'https://docs.example' },
        ],
      },
    ]
    expect(extractSources(content)).toEqual([
      { title: 'Anthropic', url: 'https://anthropic.com' },
      { title: 'Docs', url: 'https://docs.example' },
    ])
  })

  it('returns nothing when no search happened', () => {
    expect(extractSources([{ type: 'text', text: 'hi' }])).toEqual([])
  })

  it('tolerates an error object instead of a result list', () => {
    const content = [
      { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    ]
    expect(extractSources(content)).toEqual([])
  })

  it('de-duplicates repeated urls', () => {
    const content = [
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', title: 'A', url: 'https://a.example' },
          { type: 'web_search_result', title: 'A again', url: 'https://a.example' },
        ],
      },
    ]
    expect(extractSources(content)).toHaveLength(1)
  })
})
