export type Limiter = {
  /** Returns true if the call under `key` is allowed, false if throttled. */
  take: (key: string) => boolean
}

/**
 * Fixed-window counter, not sliding — good enough to stop naive farming
 * without pulling in a dependency. State grows with distinct keys and is
 * never swept; fine for a demo process that restarts often, not for a
 * long-lived deployment with many distinct IPs.
 */
export function createLimiter(max: number, windowMs: number): Limiter {
  const hits = new Map<string, { count: number; resetAt: number }>()
  return {
    take(key: string): boolean {
      const now = Date.now()
      const entry = hits.get(key)
      if (!entry || now > entry.resetAt) {
        hits.set(key, { count: 1, resetAt: now + windowMs })
        return true
      }
      if (entry.count >= max) return false
      entry.count += 1
      return true
    },
  }
}
