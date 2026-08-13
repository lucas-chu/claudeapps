import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Action, State } from '../state/store'
import { blocksToText } from '../state/types'
import type { useGeneration } from '../useGeneration'

export default function ChatPanel({
  state, dispatch, gen, onPromote,
}: {
  state: State
  dispatch: (a: Action) => void
  gen: ReturnType<typeof useGeneration>
  onPromote: (turnId: string) => void
}) {
  const [prompt, setPrompt] = useState('')
  const [open, setOpen] = useState(true)

  async function send() {
    const text = prompt.trim()
    if (!text || gen.busy) return
    setPrompt('')
    await gen.runChatPrompt(text)
  }

  if (!open) {
    return (
      <button className="chat-reopen" onClick={() => setOpen(true)}>
        Chat
      </button>
    )
  }

  return (
    <aside className="chat">
      <header className="chat-head">
        <strong>Conversation</strong>
        <span className="chat-count">{state.turns.length} turns</span>
        <button onClick={() => dispatch({ type: 'clearThread' })} title="Clear thread">
          Clear
        </button>
        <button onClick={() => setOpen(false)} title="Collapse">
          ×
        </button>
      </header>

      <div className="chat-scroll">
        {state.turns.map((t) => (
          <div key={t.id} id={`turn-${t.id}`} className={`turn turn-${t.role}`}>
            {t.label && <div className="turn-label">{t.label}</div>}
            <div className="turn-body">
              <ReactMarkdown>{blocksToText(t.blocks)}</ReactMarkdown>
            </div>
            {t.status === 'error' && <div className="turn-error">{t.error}</div>}
            {t.sources && t.sources.length > 0 && (
              <div className="box-sources">
                {t.sources.map((s) => (
                  <a key={s.url} href={s.url} target="_blank" rel="noreferrer">
                    {s.title}
                  </a>
                ))}
              </div>
            )}
            {t.role === 'assistant' && t.status !== 'streaming' && (
              <button className="turn-promote" onClick={() => onPromote(t.id)}>
                Send to canvas
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="chat-input">
        <input
          value={prompt}
          placeholder="Message Claude…"
          disabled={gen.busy}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send()
          }}
        />
        <button onClick={send} disabled={gen.busy || !prompt.trim()}>
          {gen.busy ? '…' : '↵'}
        </button>
      </div>
    </aside>
  )
}
