import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
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
  const p = worldToScreen({ x: box.x, y: box.y }, viewport)
  // Shadow text is the in-flight rewrite; showing it lets the user watch the
  // stream without committing over the original until it succeeds.
  const text = shadowText !== undefined ? shadowText : blocksToText(box.blocks)

  return (
    <div
      className={`box ${selected ? 'is-selected' : ''} ${box.status === 'error' ? 'is-error' : ''}`}
      style={{
        left: p.x,
        top: p.y,
        width: box.w * viewport.zoom,
        height: box.h * viewport.zoom,
      }}
      onPointerDown={(e) => onSelect(e, box.id)}
    >
      <div
        className="box-header"
        onPointerDown={(e) => {
          (e.currentTarget as Element).setPointerCapture(e.pointerId)
          onDragStart(e, box.id)
        }}
      >
        <span className="box-status">
          {box.status === 'streaming' ? '…' : box.status === 'error' ? '!' : ''}
        </span>
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
            <ReactMarkdown>{text}</ReactMarkdown>
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
              e.stopPropagation()
              ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
              onResizeStart(e, box.id, h)
            }}
          />
        ))}
    </div>
  )
}
