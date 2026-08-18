import { describe, expect, it } from 'vitest'
import { start, advance, verify, sign, proofMatches, HOPS } from './chain.js'

const SECRET = 'test-secret'

function walkFully(secret = SECRET, ttlMs = 60_000) {
  let claim = start(secret, ttlMs)
  const proof: string[] = []
  for (let i = 0; i < HOPS; i++) {
    const result = advance(claim, secret)
    if (!result.ok) throw new Error('unexpected: chain reported complete mid-walk')
    proof.push(result.fragment)
    claim = result.claim
  }
  return { claim, proof }
}

describe('chain', () => {
  it('accepts a token that walked every hop in order with matching proof', () => {
    const { claim, proof } = walkFully()
    expect(claim.hop).toBe(HOPS)
    expect(proofMatches(claim, proof, SECRET)).toBe(true)
  })

  it('rejects proof presented out of order', () => {
    const { claim, proof } = walkFully()
    const shuffled = [...proof].reverse()
    expect(proofMatches(claim, shuffled, SECRET)).toBe(false)
  })

  it('rejects proof with a skipped hop', () => {
    const { claim, proof } = walkFully()
    const skipped = proof.slice(1)
    expect(proofMatches(claim, [...skipped, 'padding'], SECRET)).toBe(false)
  })

  it('rejects a proof shorter or longer than total hops', () => {
    const { claim, proof } = walkFully()
    expect(proofMatches(claim, proof.slice(0, -1), SECRET)).toBe(false)
    expect(proofMatches(claim, [...proof, 'extra'], SECRET)).toBe(false)
  })

  it('advance refuses to move past total hops', () => {
    const { claim } = walkFully()
    const result = advance(claim, SECRET)
    expect(result.ok).toBe(false)
  })

  it('verify rejects a token signed with a different secret', () => {
    const claim = start(SECRET, 60_000)
    const token = sign(claim, 'wrong-secret')
    const result = verify(token, SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('signature')
  })

  it('verify rejects a tampered payload even if resigned incorrectly', () => {
    const claim = start(SECRET, 60_000)
    const token = sign(claim, SECRET)
    const [body] = token.split('.')
    const tamperedClaim = { ...claim, hop: HOPS } // pretend already complete
    const tamperedBody = Buffer.from(JSON.stringify(tamperedClaim), 'utf8').toString('base64url')
    const forged = `${tamperedBody}.${token.split('.')[1]}` // reuse original signature
    expect(body).not.toBe(tamperedBody)
    const result = verify(forged, SECRET)
    expect(result.ok).toBe(false)
  })

  it('verify rejects an expired token', () => {
    const claim = start(SECRET, 1000)
    const token = sign(claim, SECRET)
    const result = verify(token, SECRET, Date.now() + 2000)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('expired')
  })

  it('verify rejects malformed tokens', () => {
    expect(verify('', SECRET).ok).toBe(false)
    expect(verify('no-dot-here', SECRET).ok).toBe(false)
    expect(verify('.', SECRET).ok).toBe(false)
  })

  it('two independent walks never share a fragment sequence', () => {
    const a = walkFully()
    const b = walkFully()
    expect(a.proof).not.toEqual(b.proof)
  })
})
