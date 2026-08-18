import { useEffect, useRef, useState } from 'react'
import {
  looksLikeApiKey,
  saveApiKey,
  clearApiKey,
  loadApiKey,
  currentScope,
  maskApiKey,
  type KeyScope,
} from './state/apiKey'
import { verifyApiKey } from './api/stream'

type Props = {
  /** Shown as a blocking gate on first run, dismissible when a key exists. */
  dismissible: boolean
  onClose: () => void
  onSaved: () => void
}

/**
 * Where the user supplies their own Anthropic key.
 *
 * The key is checked against the API before it is accepted. That costs one
 * near-empty request, and it buys the difference between "Saved" followed by a
 * confusing failure on the first real prompt, and being told immediately that
 * the key is wrong — which is the whole failure mode of a bring-your-own-key
 * app.
 */
export default function ApiKeyDialog({ dismissible, onClose, onSaved }: Props) {
  const [value, setValue] = useState('')
  const [remember, setRemember] = useState<KeyScope>('session')
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const existing = loadApiKey()
  const existingScope = currentScope()

  useEffect(() => {
    inputRef.current?.focus()
    if (existingScope) setRemember(existingScope)
    // Run once on open: re-running would fight the user's own radio choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!dismissible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dismissible, onClose])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const key = value.trim()

    if (!looksLikeApiKey(key)) {
      setError('That doesn’t look like an Anthropic key — they start with “sk-ant-”.')
      return
    }

    setChecking(true)
    setError(null)
    // Verify before storing, so a rejected key never becomes the saved one.
    const failure = await verifyApiKey(key)
    setChecking(false)
    if (failure) {
      setError(failure)
      return
    }

    if (!saveApiKey(key, remember)) {
      setError('Your browser refused to store the key (private mode?).')
      return
    }
    setValue('')
    onSaved()
  }

  function forget() {
    clearApiKey()
    setValue('')
    onSaved()
  }

  return (
    <div className="key-backdrop" onMouseDown={dismissible ? onClose : undefined}>
      <div
        className="key-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="key-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="key-title">
          {existing ? 'Your Anthropic API key' : 'Add your Anthropic API key'}
        </h2>

        <p className="key-blurb">
          Claude Canvas calls the Anthropic API straight from this browser. Your key
          goes to Anthropic and nowhere else — this app has no server to send it to.
          Usage is billed to your own account.
        </p>

        {existing && (
          <p className="key-current">
            Currently using <code>{maskApiKey(existing)}</code>
            {existingScope === 'local' ? ' (remembered on this device)' : ' (this tab only)'}.
          </p>
        )}

        <form onSubmit={submit}>
          <input
            ref={inputRef}
            className="key-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-ant-..."
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setError(null)
            }}
            aria-invalid={error ? true : undefined}
          />

          <fieldset className="key-scope">
            <legend>Keep it</legend>
            <label>
              <input
                type="radio"
                name="scope"
                checked={remember === 'session'}
                onChange={() => setRemember('session')}
              />
              until I close this tab
            </label>
            <label>
              <input
                type="radio"
                name="scope"
                checked={remember === 'local'}
                onChange={() => setRemember('local')}
              />
              on this device
            </label>
          </fieldset>

          {error && (
            <p className="key-error" role="alert">
              {error}
            </p>
          )}

          <div className="key-actions">
            <a
              className="key-help"
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noreferrer noopener"
            >
              Get a key ↗
            </a>
            <span className="key-spacer" />
            {existing && (
              <button type="button" className="key-forget" onClick={forget}>
                Forget key
              </button>
            )}
            {dismissible && (
              <button type="button" onClick={onClose}>
                Cancel
              </button>
            )}
            <button type="submit" className="key-save" disabled={checking || !value.trim()}>
              {checking ? 'Checking…' : existing ? 'Replace key' : 'Save key'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
