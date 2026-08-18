import { describe, expect, it } from 'vitest'
import { renderPage } from './page.js'
import { HOPS } from './chain.js'

/**
 * Strips tags a human's browser would never show as text: <script> contents,
 * HTML comments, and the tags themselves. What's left approximates what a
 * sighted reader (and a screen reader, since nothing here is aria-hidden)
 * actually perceives.
 */
function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
}

describe('page', () => {
  const html = renderPage()
  const visible = visibleText(html)

  it('exposes the full protocol in the HTML source', () => {
    expect(html).toContain('application/json')
    expect(html).toContain('/api/challenge')
    expect(html).toContain('/api/hop')
    expect(html).toContain('/api/claim')
    expect(html).toContain(String(HOPS))
  })

  it('does not leak protocol paths or steps into rendered text', () => {
    expect(visible).not.toContain('/api/challenge')
    expect(visible).not.toContain('/api/hop')
    expect(visible).not.toContain('/api/claim')
  })

  it('does not hide the visible copy from assistive tech (no aria-hidden/sr-only tricks)', () => {
    expect(html).not.toContain('aria-hidden')
    expect(html).not.toContain('sr-only')
  })

  it('is honest that a human reading the page will not find instructions there', () => {
    expect(visible.toLowerCase()).toContain('page source')
  })

  it('renders identical bytes on repeated calls', () => {
    expect(renderPage()).toBe(html)
  })
})
