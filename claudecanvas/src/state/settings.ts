/**
 * Generation settings the user controls, persisted per browser.
 *
 * These are spending decisions, not preferences: effort changes how many
 * tokens a question costs, and fast mode is billed at a premium rate. In a
 * bring-your-own-key app that is the visitor's own money, so both are explicit
 * and both default to the cheaper choice.
 */

const STORAGE_KEY = 'claude-canvas:settings:v1'

/**
 * `auto` is not an API value — the levels are low/medium/high/xhigh/max and
 * the API's own default is `high`. `auto` means "send no effort at all and
 * let the API decide", which is the honest way to expose a default that may
 * change server-side rather than pinning it to today's value.
 */
export type Effort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Speed = 'standard' | 'fast'

export type Settings = { effort: Effort; speed: Speed }

export const DEFAULT_SETTINGS: Settings = { effort: 'auto', speed: 'standard' }

const EFFORTS: readonly Effort[] = ['auto', 'low', 'medium', 'high', 'xhigh', 'max']
const SPEEDS: readonly Speed[] = ['standard', 'fast']

/** Human labels, kept next to the values so the UI can't drift from them. */
export const EFFORT_LABELS: Record<Effort, string> = {
  auto: 'Auto',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Very high',
  max: 'Max',
}

/**
 * The `effort` to send, or undefined to omit the parameter entirely. Callers
 * must spread this rather than passing `effort: undefined`, so that `auto`
 * genuinely sends nothing.
 */
export function apiEffort(effort: Effort): Exclude<Effort, 'auto'> | undefined {
  return effort === 'auto' ? undefined : effort
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Partial<Settings>
    // Validate rather than trust: a hand-edited or stale value must not be
    // forwarded to the API, where it would 400 every request until cleared.
    return {
      effort: EFFORTS.includes(parsed.effort as Effort)
        ? (parsed.effort as Effort)
        : DEFAULT_SETTINGS.effort,
      speed: SPEEDS.includes(parsed.speed as Speed)
        ? (parsed.speed as Speed)
        : DEFAULT_SETTINGS.speed,
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Losing a preference is not worth surfacing; the default still applies.
  }
}
