import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
// Aliased: this file already uses the global DOM `Element` type (see the
// pointer-capture casts below), which a bare `Element` import from 'hast'
// would silently shadow.
import type { Element as HastElement } from 'hast'
import type { Viewport } from './geometry'
import { worldToScreen } from './geometry'
import DrawingBox from './DrawingBox'
import type { Action } from '../state/store'
import { blocksToText, type Box } from '../state/types'
import {
  toggleWrap, toggleLinePrefix, toggleOrderedList, insertLink,
  toggleTaskAtLine, toggleTaskLine, indentLines, outdentLines, continueTaskOnEnter,
  type EditResult,
} from '../lib/markdownActions'

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
  /** True for exactly one render after this box is created via "+ New box". */
  autoEdit?: boolean
  /** Called once autoEdit has been acted on, so the parent can clear it. */
  onAutoEditConsumed?: () => void
}

/** Renders links so they open in a new tab and don't trigger box drag/select. */
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

/**
 * Line number (1-indexed, matching react-markdown's `node.position`) of the
 * task-list `<li>` currently being rendered. Set by MarkdownListItem, read
 * by MarkdownTaskCheckbox - see the comment on MarkdownListItem for why the
 * line number has to be threaded through like this instead of read
 * directly off the checkbox's own node.
 */
const TaskLineContext = createContext<number | undefined>(undefined)

type TaskActions = { canToggle: boolean; onToggle: (line: number) => void }
/**
 * Provided once per TextBox render (see the `taskActions` useMemo below),
 * carrying the dispatch + streaming-guard logic every checkbox in this box
 * needs. Keeping this in context (rather than a prop) is what lets
 * `markdownComponents` stay a single stable module-level object instead of
 * being rebuilt - and thus react-markdown's whole tree re-diffed - on every
 * render (see the big comment on TextBox above for why that matters).
 */
const TaskActionsContext = createContext<TaskActions | null>(null)

/**
 * Renders GFM task-list `<li>`s. remark-gfm's checkboxes are synthesized
 * during the mdast -> hast conversion (see mdast-util-to-hast's `listItem`
 * handler, which builds the `<input>` element by hand) and are never
 * `state.patch`-ed with a source position, so the `<input>` node
 * react-markdown hands MarkdownTaskCheckbox has `node.position === undefined`
 * - there is no way to recover the source line from the checkbox node
 * itself. The enclosing `<li>`, in contrast, *is* patched with the position
 * of the original mdast listItem, so this component reads
 * `node.position.start.line` once, here, and threads it down through
 * context to whichever checkbox needs it.
 */
function MarkdownListItem({
  node, className, children, ...rest
}: React.LiHTMLAttributes<HTMLLIElement> & { node?: HastElement }) {
  const isTask = node?.properties?.className?.includes('task-list-item') ?? false
  const line = node?.position?.start.line
  if (!isTask || line === undefined) {
    return <li className={className} {...rest}>{children}</li>
  }
  return (
    <li className={className} {...rest}>
      <TaskLineContext.Provider value={line}>{children}</TaskLineContext.Provider>
    </li>
  )
}

/**
 * Enabled, clickable stand-in for the `disabled` checkbox react-markdown
 * renders by default for GFM task items. Maps a click back to its source
 * line via TaskLineContext (set by the enclosing MarkdownListItem) rather
 * than by matching text content or counting checkboxes - both break as
 * soon as two items have the same text, or the list gets reordered.
 */
function MarkdownTaskCheckbox({
  node: _node, ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { node?: HastElement }) {
  const line = useContext(TaskLineContext)
  const actions = useContext(TaskActionsContext)
  if (rest.type !== 'checkbox' || line === undefined || !actions) {
    // No line to toggle (shouldn't happen for a real task checkbox, but
    // fall back to the original read-only rendering rather than guessing).
    return <input {...rest} readOnly />
  }
  return (
    <input
      {...rest}
      disabled={!actions.canToggle}
      onChange={() => actions.onToggle(line)}
      onPointerDown={(e) => {
        // Same alt/middle-button pan pass-through as the rest of this file
        // (see the box/handle/header handlers below), plus: a checkbox
        // click must toggle the task, not select or drag the box under it.
        if (e.altKey || e.button === 1) return
        e.stopPropagation()
      }}
      onClick={(e) => e.stopPropagation()}
    />
  )
}

const markdownComponents = { a: MarkdownLink, li: MarkdownListItem, input: MarkdownTaskCheckbox }

const TOOLBAR_HEIGHT = 34
const TOOLBAR_GAP = 6
const FALLBACK_TOOLBAR_POS = { top: 6, left: 6 }

/** Conservative single-URL check: http(s), parses cleanly, no whitespace. */
function isPlainUrl(s: string): boolean {
  if (!/^https?:\/\/\S+$/.test(s)) return false
  try {
    // eslint-disable-next-line no-new
    new URL(s)
    return true
  } catch {
    return false
  }
}

/**
 * Measures where `index` falls in `el`'s rendered text using the standard
 * hidden-mirror technique: an offscreen div copies the textarea's font,
 * padding, border and width, and a marker span inside it reveals the caret's
 * offset. Returns coordinates relative to the *unscrolled* content.
 */
function measureCaretOffset(el: HTMLTextAreaElement, index: number): { top: number; left: number } {
  const style = window.getComputedStyle(el)
  const div = document.createElement('div')
  const props: (keyof CSSStyleDeclaration)[] = [
    'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth',
    'borderLeftWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontStyle', 'fontVariant', 'fontWeight', 'fontSize', 'lineHeight', 'fontFamily',
    'textAlign', 'textIndent', 'letterSpacing', 'wordSpacing', 'tabSize',
  ]
  for (const p of props) {
    // Computed style values copy across as strings for every property above.
    ;(div.style as unknown as Record<string, string>)[p as string] = style[p] as string
  }
  div.style.position = 'absolute'
  div.style.visibility = 'hidden'
  div.style.whiteSpace = 'pre-wrap'
  div.style.wordWrap = 'break-word'
  div.style.top = '-9999px'
  div.style.left = '-9999px'

  document.body.appendChild(div)
  try {
    div.textContent = el.value.slice(0, index)
    const marker = document.createElement('span')
    marker.textContent = el.value.slice(index) || '.'
    div.appendChild(marker)
    return { top: marker.offsetTop, left: marker.offsetLeft }
  } finally {
    document.body.removeChild(div)
  }
}

/**
 * A streaming dispatch fires every ~16ms (see the reveal pacer), which
 * re-renders Canvas and, without this, every box on it - each one re-running
 * react-markdown's full remark+GFM parse regardless of whether its own
 * content changed. Memoizing means an unrelated box's re-render is skipped
 * whenever its props are unchanged, which requires Canvas to hand it
 * reference-stable callbacks (see the useCallback wrapping in Canvas.tsx);
 * the reducer already preserves box-object identity for untouched boxes
 * (see `mapBox` in state/store.ts).
 */
function TextBox({
  box, viewport, selected, shadowText, dispatch,
  onDragStart, onResizeStart, onSelect, onRetry,
  autoEdit, onAutoEditConsumed,
}: Props) {
  const [editing, setEditing] = useState(false)
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null)
  const [toolbarPos, setToolbarPos] = useState<{ top: number; left: number }>(FALLBACK_TOOLBAR_POS)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const p = worldToScreen({ x: box.x, y: box.y }, viewport)
  // Shadow text is the in-flight rewrite; showing it lets the user watch the
  // stream without committing over the original until it succeeds.
  const text = shadowText !== undefined ? shadowText : blocksToText(box.blocks)
  const imageOnly = box.blocks.length > 0 && box.blocks.every((b) => b.type === 'image')
  const drawingOnly = box.blocks.length > 0 && box.blocks.every((b) => b.type === 'drawing')
  // The text is mid-rewrite (either a shadow stream in flight, or the box
  // hasn't yet caught up to a commit) - toggling a checkbox now would race
  // the stream and get clobbered the moment it replaces box.blocks.
  const canToggleTasks = shadowText === undefined && box.status !== 'streaming'
  const taskActions = useMemo<TaskActions>(
    () => ({
      canToggle: canToggleTasks,
      onToggle: (line) => dispatch({ type: 'setBoxText', id: box.id, text: toggleTaskAtLine(text, line) }),
    }),
    [canToggleTasks, dispatch, box.id, text],
  )

  // A box created via "+ New box" enters edit mode immediately, once, so the
  // user can start typing without a double-click. Image-only and
  // drawing-only boxes never edit as markdown, so they never consume
  // autoEdit either.
  useEffect(() => {
    if (autoEdit && !imageOnly && !drawingOnly) {
      setEditing(true)
      onAutoEditConsumed?.()
    }
    // Runs once, at mount, for the box this render belongs to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!sel || !editing) return
    const el = textareaRef.current
    const bodyEl = bodyRef.current
    if (!el || !bodyEl) {
      setToolbarPos(FALLBACK_TOOLBAR_POS)
      return
    }
    try {
      const caret = measureCaretOffset(el, sel.start)
      const bodyRect = bodyEl.getBoundingClientRect()
      const textRect = el.getBoundingClientRect()
      const left = textRect.left - bodyRect.left + caret.left - el.scrollLeft
      const top = textRect.top - bodyRect.top + caret.top - el.scrollTop - TOOLBAR_HEIGHT - TOOLBAR_GAP
      setToolbarPos({ top: Math.max(0, top), left: Math.max(0, left) })
    } catch {
      // Measurement is a nice-to-have; never let it hide the toolbar.
      setToolbarPos(FALLBACK_TOOLBAR_POS)
    }
  }, [sel, editing, text])

  function updateSelection() {
    const el = textareaRef.current
    if (!el || el.selectionStart == null || el.selectionEnd == null || el.selectionStart === el.selectionEnd) {
      setSel(null)
      return
    }
    setSel({ start: el.selectionStart, end: el.selectionEnd })
  }

  function applyAction(fn: (t: string, s: number, e: number) => EditResult) {
    const el = textareaRef.current
    if (!el) return
    const start = el.selectionStart ?? 0
    const end = el.selectionEnd ?? 0
    const result = fn(text, start, end)
    dispatch({ type: 'setBoxText', id: box.id, text: result.text })
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(result.start, result.end)
      updateSelection()
    })
  }

  function handleEditorKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Tab') {
      // The main nesting affordance: Tab/Shift-Tab indent or outdent every
      // line the selection touches. preventDefault keeps focus in the
      // textarea instead of jumping to the next focusable element.
      e.preventDefault()
      applyAction((t, s, en) => (e.shiftKey ? outdentLines(t, s, en) : indentLines(t, s, en)))
      return
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const el = textareaRef.current
      if (el && el.selectionStart != null && el.selectionStart === el.selectionEnd) {
        const result = continueTaskOnEnter(text, el.selectionStart)
        if (result) {
          e.preventDefault()
          dispatch({ type: 'setBoxText', id: box.id, text: result.text })
          requestAnimationFrame(() => {
            el.focus()
            el.setSelectionRange(result.start, result.end)
            updateSelection()
          })
          return
        }
      }
    }

    const mod = e.metaKey || e.ctrlKey
    if (!mod) return
    if (e.key === 'b' || e.key === 'B') {
      e.preventDefault()
      applyAction((t, s, en) => toggleWrap(t, s, en, '**'))
    } else if (e.key === 'i' || e.key === 'I') {
      e.preventDefault()
      applyAction((t, s, en) => toggleWrap(t, s, en, '*'))
    } else if (e.key === 'k' || e.key === 'K') {
      e.preventDefault()
      applyAction((t, s, en) => insertLink(t, s, en, ''))
    }
  }

  function handleEditorPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const el = textareaRef.current
    if (!el) return
    const start = el.selectionStart ?? 0
    const end = el.selectionEnd ?? 0
    if (start === end) return // no selection: let the default paste happen
    const pasted = e.clipboardData.getData('text/plain').trim()
    if (!isPlainUrl(pasted)) return
    e.preventDefault()
    applyAction((t, s, en) => insertLink(t, s, en, pasted))
  }

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
            onDoubleClick={(e) => {
              // Keep the header's onPointerDown (the drag handle) from also
              // starting a drag out from under this rename.
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

      <div
        className={`box-body ${drawingOnly ? 'box-body-drawing' : ''}`}
        ref={bodyRef}
        onDoubleClick={() => {
          if (imageOnly || drawingOnly) return
          setEditing(true)
        }}
      >
        {editing ? (
          <>
            <textarea
              ref={textareaRef}
              className="box-editor"
              autoFocus
              value={text}
              onChange={(e) =>
                dispatch({ type: 'setBoxText', id: box.id, text: e.target.value })
              }
              onSelect={updateSelection}
              onMouseUp={updateSelection}
              onKeyUp={updateSelection}
              onKeyDown={handleEditorKeyDown}
              onPaste={handleEditorPaste}
              onBlur={() => {
                setEditing(false)
                setSel(null)
              }}
            />
            {sel && (
              <div
                className="md-toolbar"
                style={{ top: toolbarPos.top, left: toolbarPos.left }}
                onPointerDown={(e) => {
                  if (e.altKey || e.button === 1) return
                  e.stopPropagation()
                }}
              >
                <button type="button" className="md-toolbar-btn" title="Bold (Cmd/Ctrl+B)"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyAction((t, s, en) => toggleWrap(t, s, en, '**'))}>
                  <strong>B</strong>
                </button>
                <button type="button" className="md-toolbar-btn" title="Italic (Cmd/Ctrl+I)"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyAction((t, s, en) => toggleWrap(t, s, en, '*'))}>
                  <em>I</em>
                </button>
                <button type="button" className="md-toolbar-btn" title="Code"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyAction((t, s, en) => toggleWrap(t, s, en, '`'))}>
                  {'<>'}
                </button>
                <button type="button" className="md-toolbar-btn" title="Heading"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyAction((t, s, en) => toggleLinePrefix(t, s, en, '## '))}>
                  H
                </button>
                <button type="button" className="md-toolbar-btn" title="Bullet list"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyAction((t, s, en) => toggleLinePrefix(t, s, en, '- '))}>
                  •
                </button>
                <button type="button" className="md-toolbar-btn" title="Numbered list"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyAction((t, s, en) => toggleOrderedList(t, s, en))}>
                  1.
                </button>
                <button type="button" className="md-toolbar-btn" title="Task list"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyAction((t, s, en) => toggleTaskLine(t, s, en))}>
                  ☑
                </button>
                <button type="button" className="md-toolbar-btn" title="Quote"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyAction((t, s, en) => toggleLinePrefix(t, s, en, '> '))}>
                  "
                </button>
                <button type="button" className="md-toolbar-btn" title="Link (Cmd/Ctrl+K)"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyAction((t, s, en) => insertLink(t, s, en, ''))}>
                  🔗
                </button>
              </div>
            )}
          </>
        ) : box.status === 'streaming' && text.length === 0 ? (
          // Adaptive thinking on claude-opus-5 means several seconds can pass
          // before the first token. Without this the box just sits empty and
          // reads as broken.
          <div className="thinking" aria-label="Thinking">
            <span /><span /><span />
          </div>
        ) : drawingOnly ? (
          <DrawingBox box={box} dispatch={dispatch} />
        ) : imageOnly ? (
          <div className="box-blocks">
            {box.blocks.map((block, i) =>
              block.type === 'image' ? (
                <img
                  key={i}
                  src={block.data}
                  alt=""
                  style={{ maxWidth: '100%', height: 'auto', display: 'block' }}
                />
              ) : null,
            )}
          </div>
        ) : (
          <div className="box-markdown">
            <TaskActionsContext.Provider value={taskActions}>
              <ReactMarkdown remarkPlugins={[remarkBreaks, remarkGfm]} components={markdownComponents}>
                {text}
              </ReactMarkdown>
            </TaskActionsContext.Provider>
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

export default memo(TextBox)
