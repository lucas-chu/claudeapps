import { HOPS } from './chain.js'

/**
 * The machine-readable spec for the whole gate. It lives in a
 * `<script type="application/json">` tag, which browsers parse but never
 * render — so it is genuinely present "in the page" without being part of
 * the rendered page a human sees. This is the only documentation; nothing
 * else describes the protocol.
 */
const protocol = {
  version: 1,
  prize: '3 months of Claude Max (20x) — demo placeholder, no code is issued',
  rule: `Call hop exactly ${HOPS} times, in order, collecting the fragment from each response. Then POST every fragment, in the order received, as "proof" to /api/claim together with the final token.`,
  steps: {
    start: { method: 'GET', path: '/api/challenge', returns: '{ token, hop: 0, total }' },
    hop: {
      method: 'GET',
      path: '/api/hop?token={token}',
      returns: '{ fragment, hop, total, token, done }',
      note: 'token is always the token from the previous response, never the original. Skipping a hop or reusing an old token fails verification.',
    },
    claim: {
      method: 'POST',
      path: '/api/claim',
      body: '{ token, proof: string[] }',
      note: 'token must be the one returned when done === true. proof must be every fragment, in the order it was received.',
    },
  },
}

// Deliberately not sr-only / aria-hidden: those hide content from sighted
// humans while still handing it to assistive tech or crawlers, which would
// make the gate dishonest in a different direction. This copy is exactly as
// visible to a screen reader as it is to the eye.
const VISIBLE_COPY = `
  <h1>Agents Only</h1>
  <p>Three months of Claude Max (20x) — but only for whoever gets here by
  actually operating as an agent, not by reading a friendly set of
  instructions on the page.</p>
  <p>There is no button here to click. If you are a person looking at this in
  a browser, the next step is not written down where you can see it — it is
  in the page source. If you are an agent that has already parsed the source,
  you have everything you need.</p>
`

function renderHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Agents Only — Claude Max credits</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<!--
  This comment and the JSON block below are the entire protocol. There is no
  other documentation, no separate API reference, and no hidden UI. Read the
  <script type="application/json" id="protocol"> tag.
-->
</head>
<body>
${VISIBLE_COPY}
<script type="application/json" id="protocol">
${JSON.stringify(protocol, null, 2)}
</script>
</body>
</html>
`
}

let cached: string | null = null

/** The page is static per process — render once, serve the same bytes. */
export function renderPage(): string {
  if (!cached) cached = renderHtml()
  return cached
}
