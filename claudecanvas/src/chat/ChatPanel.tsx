import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import type { Action, State } from '../state/store'
import { DEFAULT_CHAT_WIDTH, MAX_CHAT_WIDTH, MIN_CHAT_WIDTH } from '../state/store'
import { blocksToText } from '../state/types'
import type { useGeneration } from '../useGeneration'

/** Below this total window width there isn't room for both the canvas and
 * the chat panel side by side (see GAP 2d) - the panel auto-collapses to the
 * "Chat" pill rather than forcing itself open and squeezing the canvas down
 * to nothing, the way a fixed 360px panel did at a measured 431px window. */
const NARROW_WINDOW_PX = 700

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
  // Starts closed if the window is already too narrow on first paint - the
  // panel must not force itself open (GAP 2d) even before any resize event
  // has fired.
  const [open, setOpen] = useState(() => window.innerWidth >= NARROW_WINDOW_PX)
  const scrollRef = useRef<HTMLDivElement>(null)
  const chatWidth = state.chatWidth ?? DEFAULT_CHAT_WIDTH

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state.turns])

  // Auto-collapse when the window crosses into "too narrow for canvas + chat
  // to coexist" (GAP 2d), instead of leaving a fixed-width panel to squeeze
  // the canvas down to nothing the way it did at a measured 431px window.
  // Edge-triggered on the narrow/wide *transition* (via wasNarrowRef) rather
  // than re-checked on every resize while already narrow, so it never fights
  // a manual reopen via the "Chat" pill while the window stays narrow.
  // `autoClosedRef` records whether this effect (not the user) was the one
  // that closed it, so only an auto-close gets auto-reopened once there's
  // room again - a close the user asked for themselves is left alone. The
  // panel's chosen width (state.chatWidth) is never touched by any of this.
  const wasNarrowRef = useRef(window.innerWidth < NARROW_WINDOW_PX)
  const autoClosedRef = useRef(false)
  useEffect(() => {
    const checkWidth = () => {
      const narrow = window.innerWidth < NARROW_WINDOW_PX
      const enteringNarrow = narrow && !wasNarrowRef.current
      const leavingNarrow = !narrow && wasNarrowRef.current
      wasNarrowRef.current = narrow
      if (enteringNarrow) {
        setOpen((wasOpen) => {
          if (wasOpen) autoClosedRef.current = true
          return false
        })
      } else if (leavingNarrow && autoClosedRef.current) {
        autoClosedRef.current = false
        setOpen(true)
      }
    }
    window.addEventListener('resize', checkWidth)
    return () => window.removeEventListener('resize', checkWidth)
  }, [])

  // Drag-resize via the left-edge grab strip (GAP 2a/2b). Pointer capture on
  // the strip itself means the drag keeps tracking even once the cursor
  // leaves the (few-px-wide) strip - no window-level listeners to add or
  // clean up.
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const [resizing, setResizing] = useState(false)

  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: chatWidth }
    e.currentTarget.setPointerCapture(e.pointerId)
    setResizing(true)
  }, [chatWidth])

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    // The panel is on the right edge of the app, so dragging the strip left
    // (cursor moves toward negative x) grows the panel.
    const proposed = drag.startWidth + (drag.startX - e.clientX)
    // Never more than the smaller of MAX_CHAT_WIDTH or half the window - the
    // guarantee that the panel can never swallow the canvas, even mid-drag.
    const maxWidth = Math.min(MAX_CHAT_WIDTH, window.innerWidth / 2)
    const next = Math.min(maxWidth, Math.max(MIN_CHAT_WIDTH, proposed))
    dispatch({ type: 'setChatWidth', width: next })
  }, [dispatch])

  const onResizeEnd = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    dragRef.current = null
    setResizing(false)
  }, [])

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
    <aside className="chat" style={{ width: chatWidth, flex: `0 0 ${chatWidth}px` }}>
      <div
        className={`chat-resize-handle${resizing ? ' is-dragging' : ''}`}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        title="Drag to resize"
      />
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
