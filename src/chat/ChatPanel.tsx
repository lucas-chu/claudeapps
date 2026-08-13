import { useEffect, useRef, useState } from 'react'
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
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state.turns])

  async function send() {
    const text = prompt.trim()
    if (!text || gen.busy) return
    setPrompt('')
    await gen.runChatPrompt(text)
  }

  async function retryTurn(i: number) {
    const prev = state.turns[i - 1]
    if (!prev || prev.role !== 'user') return
    await gen.runChatPrompt(blocksToText(prev.blocks))
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

      <div className="chat-scroll" ref={scrollRef}>
        {state.turns.map((t, i) => (
          <div key={t.id} id={`turn-${t.id}`} className={`turn turn-${t.role}`}>
            {t.label && <div className="turn-label">{t.label}</div>}
            <div className="turn-body">
              <ReactMarkdown>{blocksToText(t.blocks)}</ReactMarkdown>
            </div>
            {t.status === 'error' && (
              <div className="turn-error">
                <span>{t.error}</span>
                <button className="turn-promote" onClick={() => retryTurn(i)}>
                  Retry
                </button>
              </div>
            )}
            {t.sources && t.sources.length > 0 && (
              <div className="box-sources">
                {t.sources.map((s) => (
                  <a key={s.url} href={s.url} target="_blank" rel="noreferrer">
                    {s.title}
                  </a>
                ))}
              </div>
            )}
            {t.role === 'assistant' &&
              t.status !== 'streaming' &&
              t.status !== 'error' &&
              blocksToText(t.blocks).trim().length > 0 && (
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
