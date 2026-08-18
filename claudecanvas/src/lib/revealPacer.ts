export type RevealPacerOptions = {
  /** Tick interval in ms. Defaults to ~one animation frame. */
  intervalMs?: number
  /** Minimum characters emitted per tick, even when the backlog is small. */
  minChars?: number
  /** Backlog is divided by this to compute the catch-up slice per tick. */
  catchUpDivisor?: number
}

export type RevealPacer = {
  /** Adds newly-received text to the pacer's backlog. Never fabricates text. */
  push(text: string): void
  /** Emits the entire remaining backlog immediately, synchronously. */
  flush(): void
  /** Stops the pacer permanently: clears the timer and drops any backlog. */
  stop(): void
}

const DEFAULT_INTERVAL_MS = 16
const DEFAULT_MIN_CHARS = 3
const DEFAULT_CATCH_UP_DIVISOR = 8

/**
 * Drains text pushed via `push()` into `emit()` at a steady rate, instead of
 * dumping each chunk into the sink the instant it arrives. Only ever emits
 * characters that were previously pushed — it never fabricates, predicts, or
 * pads. If the backlog grows faster than it drains, each tick emits a larger
 * slice proportional to the backlog so the reveal catches back up.
 */
export function createRevealPacer(
  emit: (chunk: string) => void,
  opts: RevealPacerOptions = {},
): RevealPacer {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const minChars = opts.minChars ?? DEFAULT_MIN_CHARS
  const catchUpDivisor = opts.catchUpDivisor ?? DEFAULT_CATCH_UP_DIVISOR

  let backlog = ''
  let timer: ReturnType<typeof setInterval> | null = null
  let stopped = false

  function clearTimer() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function tick() {
    if (backlog.length === 0) {
      clearTimer()
      return
    }
    const count = Math.max(minChars, Math.ceil(backlog.length / catchUpDivisor))
    const chunk = backlog.slice(0, count)
    backlog = backlog.slice(count)
    emit(chunk)
  }

  function ensureTimer() {
    if (stopped || timer !== null || backlog.length === 0) return
    timer = setInterval(tick, intervalMs)
  }

  return {
    push(text: string) {
      if (stopped || !text) return
      backlog += text
      ensureTimer()
    },
    flush() {
      clearTimer()
      if (backlog.length === 0) return
      const chunk = backlog
      backlog = ''
      emit(chunk)
    },
    stop() {
      stopped = true
      clearTimer()
      backlog = ''
    },
  }
}
