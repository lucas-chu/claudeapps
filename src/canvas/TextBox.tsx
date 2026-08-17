import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import type { Viewport } from './geometry'
import { worldToScreen } from './geometry'
import type { Action } from '../state/store'
import { blocksToText, type Box } from '../state/types'

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
export type Handle = (typeof HANDLES)[number]

type Props = {
  box: Box
  viewport: Viewport
  selected: boolean
  shadowText?: string
  dispatch: (a: Action) => void
  onDragStart: (e: React.PointerEvent, id: string) => void
  onResizeStart: (e: React.PointerEvent, id: string, handle: Handle) => void
  onSelect: (e: React.PointerEvent, id: string) => void
  onRetry: (id: string) => void
}

export default function TextBox({
  box, viewport, selected, shadowText, dispatch,
  onDragStart, onResizeStart, onSelect, onRetry,
}: Props) {
  const [editing, setEditing] = useState(false)
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const p = worldToScreen({ x: box.x, y: box.y }, viewport)
  // Shadow text is the in-flight rewrite; showing it lets the user watch the
  // stream without committing over the original until it succeeds.
  const text = shadowText !== undefined ? shadowText : blocksToText(box.blocks)

  function startTitleEdit() {
    setTitleDraft(box.title ?? '')
    setTitleEditing(true)
  }

  function commitTitle() {
    dispatch({ type: 'renameBox', id: box.id, title: titleDraft.trim() })
    setTitleEditing(false)
  }

  return (
    <div
      className={`box ${selected ? 'is-selected' : ''} ${box.status === 'error' ? 'is-error' : ''}`}
      style={{
        left: p.x,
        top: p.y,
        width: box.w * viewport.zoom,
        height: box.h * viewport.zoom,
      }}
      onPointerDown={(e) => {
        // Alt-drag and middle-drag pan the canvas even when they land on a
        // box; let the event bubble unstopped so Canvas's handler sees it.
        if (e.altKey || e.button === 1) return
        onSelect(e, box.id)
      }}
    >
      <div
        className="box-header"
        onPointerDown={(e) => {
          if (e.altKey || e.button === 1) return
          ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
          onDragStart(e, box.id)
        }}
      >
        <span className="box-status">
          {box.status === 'streaming' ? '…' : box.status === 'error' ? '!' : ''}
        </span>

        {titleEditing ? (
          <input
            className="box-title-input"
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onPointerDown={(e) => {
              if (e.altKey || e.button === 1) return
              e.stopPropagation()
            }}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitTitle()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setTitleEditing(false)
              }
            }}
          />
        ) : (
          <span
            className={`box-title ${box.title ? '' : 'is-placeholder'}`}
            onPointerDown={(e) => {
              if (e.altKey || e.button === 1) return
              e.stopPropagation()
            }}
            onClick={(e) => {
              e.stopPropagation()
              startTitleEdit()
            }}
            title={box.title || 'Untitled'}
          >
            {box.title || 'Untitled'}
          </span>
        )}

        <button
          className="box-delete"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => dispatch({ type: 'deleteBox', id: box.id })}
          title="Delete"
        >
          ×
        </button>
      </div>

      <div className="box-body" onDoubleClick={() => setEditing(true)}>
        {editing ? (
          <textarea
            className="box-editor"
            autoFocus
            value={text}
            onChange={(e) =>
              dispatch({ type: 'setBoxText', id: box.id, text: e.target.value })
            }
            onBlur={() => setEditing(false)}
          />
        ) : (
          <div className="box-markdown">
            <ReactMarkdown remarkPlugins={[remarkBreaks]}>{text}</ReactMarkdown>
          </div>
        )}
      </div>

      {box.status === 'error' && (
        <div className="box-errmsg">
          <span>{box.error}</span>
          {box.lastPrompt && (
            <button
              className="box-retry"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onRetry(box.id)}
            >
              Retry
            </button>
          )}
        </div>
      )}

      {box.sources && box.sources.length > 0 && (
        <div className="box-sources">
          {box.sources.map((s) => (
            <a key={s.url} href={s.url} target="_blank" rel="noreferrer" title={s.url}>
              {s.title}
            </a>
          ))}
        </div>
      )}

      {box.fromTurnId && (
        <button
          className="box-provenance"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            const el = document.getElementById(`turn-${box.fromTurnId}`)
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            el?.classList.add('is-highlit')
            setTimeout(() => el?.classList.remove('is-highlit'), 1600)
          }}
        >
          from chat ↗
        </button>
      )}

      {selected &&
        HANDLES.map((h) => (
          <div
            key={h}
            className={`handle handle-${h}`}
            onPointerDown={(e) => {
              if (e.altKey || e.button === 1) return
              e.stopPropagation()
              ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
              onResizeStart(e, box.id, h)
            }}
          />
        ))}
    </div>
  )
}
