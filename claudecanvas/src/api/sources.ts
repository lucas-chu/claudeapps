export type Source = { title: string; url: string }

/**
 * Web search results arrive as `web_search_tool_result` blocks. On failure the
 * API returns HTTP 200 with an error OBJECT in place of the result LIST, so the
 * shape must be checked rather than assumed.
 */
export function extractSources(content: unknown[]): Source[] {
  const out: Source[] = []
  const seen = new Set<string>()

  for (const block of content) {
    const b = block as { type?: string; content?: unknown }
    if (b?.type !== 'web_search_tool_result') continue
    if (!Array.isArray(b.content)) continue // error object, not results

    for (const item of b.content) {
      const r = item as { type?: string; title?: string; url?: string }
      if (r?.type !== 'web_search_result' || !r.url) continue
      if (seen.has(r.url)) continue
      seen.add(r.url)
      out.push({ title: r.title ?? r.url, url: r.url })
    }
  }
  return out
}
