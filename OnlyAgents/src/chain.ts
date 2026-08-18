import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Hops required before /api/claim will listen. Enough to be a real walk. */
export const HOPS = 4

const FRAGMENT_CHARS = 8

export type Claim = {
  nonce: string
  /** Hops completed so far. The chain is walkable only in order. */
  hop: number
  total: number
  /**
   * Rolling digest of every fragment handed out so far. Deliberately NOT the
   * fragments themselves: the token travels through the client, so anything
   * stored here is readable by the caller. A digest lets the server check the
   * walk happened without ever shipping the answer.
   */
  acc: string
  exp: number
}

function hmac(secret: string, input: string): string {
  return createHmac('sha256', secret).update(input).digest('hex')
}

function encode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url')
}

function decode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8')
}

/** Constant-time compare of two hex digests of equal expected length. */
function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

export function seed(nonce: string, secret: string): string {
  return hmac(secret, `seed:${nonce}`)
}

/**
 * The fragment for a given hop. Derived rather than random so the server keeps
 * no per-chain state — the whole protocol is stateless apart from spent nonces.
 */
export function fragmentFor(nonce: string, hop: number, secret: string): string {
  return hmac(secret, `fragment:${nonce}:${hop}`).slice(0, FRAGMENT_CHARS)
}

export function fold(acc: string, fragment: string, secret: string): string {
  return hmac(secret, `${acc}:${fragment}`)
}

export function sign(claim: Claim, secret: string): string {
  const body = encode(JSON.stringify(claim))
  return `${body}.${hmac(secret, body)}`
}

export type VerifyResult =
  | { ok: true; claim: Claim }
  | { ok: false; reason: 'malformed' | 'signature' | 'expired' }

export function verify(token: string, secret: string, now = Date.now()): VerifyResult {
  const split = token.lastIndexOf('.')
  if (split <= 0 || split === token.length - 1) return { ok: false, reason: 'malformed' }
  const body = token.slice(0, split)
  const signature = token.slice(split + 1)

  // Signature before parsing: never interpret a payload we haven't authenticated.
  if (!digestsEqual(signature, hmac(secret, body))) return { ok: false, reason: 'signature' }

  let claim: Claim
  try {
    claim = JSON.parse(decode(body)) as Claim
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const shaped =
    claim !== null &&
    typeof claim === 'object' &&
    typeof claim.nonce === 'string' &&
    Number.isInteger(claim.hop) &&
    Number.isInteger(claim.total) &&
    typeof claim.acc === 'string' &&
    typeof claim.exp === 'number'
  if (!shaped) return { ok: false, reason: 'malformed' }

  if (now > claim.exp) return { ok: false, reason: 'expired' }
  return { ok: true, claim }
}

export function start(secret: string, ttlMs: number, now = Date.now()): Claim {
  const nonce = randomBytes(12).toString('hex')
  return { nonce, hop: 0, total: HOPS, acc: seed(nonce, secret), exp: now + ttlMs }
}

export type AdvanceResult =
  | { ok: true; fragment: string; claim: Claim }
  | { ok: false; reason: 'complete' }

/**
 * Take one hop. There is no way to jump ahead: the token for hop n+1 exists
 * only as the return value of hop n, and it is signed.
 */
export function advance(claim: Claim, secret: string): AdvanceResult {
  if (claim.hop >= claim.total) return { ok: false, reason: 'complete' }
  const fragment = fragmentFor(claim.nonce, claim.hop, secret)
  return {
    ok: true,
    fragment,
    claim: { ...claim, hop: claim.hop + 1, acc: fold(claim.acc, fragment, secret) },
  }
}

/**
 * Replay the caller's fragments through the same fold and see whether we land
 * on the digest the final token carries. Only a caller that read every hop
 * response body can produce them, and only in the right order.
 */
export function proofMatches(claim: Claim, proof: string[], secret: string): boolean {
  if (proof.length !== claim.total) return false
  if (!proof.every((f) => typeof f === 'string')) return false
  let acc = seed(claim.nonce, secret)
  for (const fragment of proof) acc = fold(acc, fragment, secret)
  return digestsEqual(acc, claim.acc)
}
