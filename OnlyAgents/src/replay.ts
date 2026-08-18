export type ReplayGuard = {
  /** Marks `nonce` spent. Returns true the first time, false on every replay. */
  claim: (nonce: string, expiresAt: number) => boolean
}

/**
 * A finished chain's final token stays validly signed until it expires, so
 * without this a captured token+proof pair could be replayed to /api/claim
 * repeatedly. Nonces are swept once they pass the same expiry the chain
 * token itself carries — no need to remember them any longer than the token
 * would have been accepted anyway.
 */
export function createReplayGuard(): ReplayGuard {
  const spent = new Map<string, number>()
  function sweep(now: number): void {
    for (const [nonce, exp] of spent) if (exp < now) spent.delete(nonce)
  }
  return {
    claim(nonce, expiresAt) {
      const now = Date.now()
      sweep(now)
      if (spent.has(nonce)) return false
      spent.set(nonce, expiresAt)
      return true
    },
  }
}
