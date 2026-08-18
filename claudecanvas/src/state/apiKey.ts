/**
 * Where the user's own Anthropic API key lives.
 *
 * Claude Canvas talks to the Anthropic API straight from the browser, so the
 * key never reaches a server of ours — there is nothing to receive it and
 * nothing to log it. The trade is that the key sits in this tab's storage,
 * which any script running on the page could read. That is inherent to
 * bring-your-own-key in a static app; the mitigation is that the page ships
 * no third-party scripts and no analytics.
 */

/** Persistent across restarts. Chosen when the user ticks "remember". */
const LOCAL_KEY = 'claude-canvas:api-key'
/** Cleared when the tab closes. The default, and the safer of the two. */
const SESSION_KEY = 'claude-canvas:api-key:session'

export type KeyScope = 'session' | 'local'

/**
 * A cheap shape check, not validation — only the API can say whether a key is
 * real. It exists to catch the common paste mistakes (a stray quote, a
 * truncated copy, the wrong secret entirely) before a request is spent on
 * them, so the user gets an immediate answer instead of a 401 three seconds
 * later.
 */
export function looksLikeApiKey(raw: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{16,}$/.test(raw.trim())
}

/**
 * Session storage wins over local: if a key was entered for this tab only, it
 * is the one the user most recently chose, and a stale "remembered" key must
 * not shadow it.
 */
export function loadApiKey(): string | null {
  try {
    const key = sessionStorage.getItem(SESSION_KEY) ?? localStorage.getItem(LOCAL_KEY)
    return key && key.trim() ? key.trim() : null
  } catch {
    // Storage can throw outright in private mode or with cookies blocked.
    return null
  }
}

/** Returns false when storage rejected the write, so the UI can say so. */
export function saveApiKey(raw: string, scope: KeyScope): boolean {
  const key = raw.trim()
  try {
    // Always clear both first: switching scope must not leave the previous
    // copy behind, which would resurrect the old key on the next load.
    clearApiKey()
    if (scope === 'local') localStorage.setItem(LOCAL_KEY, key)
    else sessionStorage.setItem(SESSION_KEY, key)
    return true
  } catch {
    return false
  }
}

export function clearApiKey(): void {
  try {
    localStorage.removeItem(LOCAL_KEY)
    sessionStorage.removeItem(SESSION_KEY)
  } catch {
    // Nothing to do — a key we cannot remove is also one we cannot read.
  }
}

/** Which storage the current key came from, for the settings UI to reflect. */
export function currentScope(): KeyScope | null {
  try {
    if (sessionStorage.getItem(SESSION_KEY)) return 'session'
    if (localStorage.getItem(LOCAL_KEY)) return 'local'
  } catch {
    return null
  }
  return null
}

/**
 * `sk-ant-api03-AbCd…WxYz` — enough to tell two keys apart when deciding
 * whether to replace one, without putting the secret back on screen.
 */
export function maskApiKey(key: string): string {
  if (key.length <= 12) return '••••'
  return `${key.slice(0, 11)}…${key.slice(-4)}`
}
