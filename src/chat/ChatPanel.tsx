import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import type { Action, State } from '../state/store'
import { blocksToText } from '../state/types'
import type { useGeneration } from '../useGeneration'

/** Renders links so they open in a new tab and don't trigger turn selection. */
function MarkdownLink({
  href, children, ...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      {...rest}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onPointerDown={(e) => {
        if (e.altKey || e.button === 1) return
        e.stopPropagation()
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  )
}

const markdownComponents = { a: MarkdownLink }

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

  // Submitting clears the input right away so the next message can be typed
  // immediately — chat generations run concurrently, each streaming into its
  // own turn, so there's nothing to wait on here.
  async function send() {
    const text = prompt.trim()
    if (!text) return
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
              {t.status === 'streaming' && blocksToText(t.blocks).length === 0 ? (
                <div className="thinking" aria-label="Thinking">
                  <span /><span /><span />
                </div>
              ) : (
                <ReactMarkdown remarkPlugins={[remarkBreaks, remarkGfm]} components={markdownComponents}>
                  {blocksToText(t.blocks)}
                </ReactMarkdown>
              )}
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
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send()
          }}
        />
        <button onClick={send} disabled={!prompt.trim()}>
          ↵
        </button>
      </div>
    </aside>
  )
}
