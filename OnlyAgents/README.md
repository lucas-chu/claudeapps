# OnlyAgents

A form for 3 months of Claude Max (20x) that "only agents can fill out."

Read that claim narrowly. This is proof-of-agenthood theatre, not access
control. Nothing here can verify *who* is on the other end of a TCP
connection, or stop a human from writing five lines of `curl` and passing the
gate themselves. What it *can* do is make the path unreachable to a human
clicking around a browser: the instructions for how to proceed are never
rendered on the page, only present in the HTML source, and completing the
task requires making a short sequence of HTTP calls in order — not something
a browser does for you by default. A person with a terminal is, at that
point, doing exactly what an agent does: operating programmatically. That's
the honest line this project draws, and it's the only line it can draw.

The credits are also a demo placeholder. `/api/claim` never mints a real
code — see "Why no real codes" below.

## Run it

```bash
cd OnlyAgents
npm install
npm run dev       # http://localhost:8788
```

`ONLYAGENTS_SECRET` is optional; if unset, a random secret is generated at
boot and printed to the log. That means every restart invalidates any chain
that's mid-walk — fine for a demo, not for anything you'd run continuously.

## The protocol

Everything below is also written into the page's HTML source
(`GET /` — see the `<script type="application/json" id="protocol">` block and
the comment above it). The rendered page tells a human that the instructions
aren't rendered; it does not repeat them.

1. `GET /api/challenge` → `{ token, hop: 0, total }`
2. `GET /api/hop?token={token}` → `{ fragment, hop, total, token, done }`,
   repeated `total` times. Each call's `token` must be the one from the
   *previous* response — the original challenge token only works for hop 0.
3. `POST /api/claim` with `{ token, proof }`, where `token` is the one
   returned when `done: true`, and `proof` is every fragment collected, in
   the order received.

A request that skips a hop, replays an old token, or submits fragments out
of order fails at `/api/claim` — the accumulated digest inside the token
only matches a proof that walked the chain honestly, in order, start to
finish.

## How the chain works (`src/chain.ts`)

Tokens are HMAC-signed, not stored server-side — the process holds no
per-chain session, only the signing secret. Each token carries a nonce, the
current hop count, an expiry, and a rolling digest (`acc`) folded from every
fragment issued so far. `/api/hop` derives the next fragment from
`HMAC(secret, nonce:hop)` — deterministic, so the server never needs to
remember what it handed out — folds it into `acc`, and signs the result as
the next token. `/api/claim` independently replays the caller's submitted
`proof` through the same fold and checks it lands on the `acc` the final
token carries. There is no way to produce a matching `acc` without having
received every fragment, in order, from the server itself.

A per-nonce replay guard (`src/replay.ts`) stops a valid `token` + `proof`
pair from being claimed twice, and a per-IP fixed-window limiter
(`src/limiter.ts`) caps how often one caller can hit `/api/challenge`,
`/api/hop`, and `/api/claim`.

## Why no real codes

This repo has no fulfillment system, no inventory of codes, and no way to
verify a claim against Anthropic's actual billing systems. `/api/claim`
returns a `DEMO-` reference and a message explaining what a real deployment
would do instead. Wiring up real single-use codes would mean: a finite pool
supplied out of band, stricter per-identity (not just per-IP) rate limits,
and a decision about what "agent" needs to mean before money changes hands —
none of which this project takes a position on.

## Known limitations

- Rate limiting keys off `socket.remoteAddress` only; behind a proxy every
  caller looks the same. Deliberate — trusting `X-Forwarded-For` would let a
  caller reset its own limit by lying about its IP.
- The limiter's hit map is never swept, so memory grows with the number of
  distinct callers. Acceptable for a short-lived demo process, not for a
  long-running deployment.
- The signing secret is per-process when generated. Multi-instance
  deployment requires setting `ONLYAGENTS_SECRET` explicitly so every
  instance can verify tokens issued by any other.
