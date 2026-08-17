import { useCallback, useEffect, useRef, useState } from 'react'
import { generate, requestTitle } from './api/stream'
import { createRevealPacer } from './lib/revealPacer'
import { buildMessages } from './state/context'
import { findCenterSlot } from './canvas/geometry'
import type { Action, State } from './state/store'
import { blocksToText, isImageOnlyBox, type Box } from './state/types'

const NEW_BOX = { w: 360, h: 260 }

/**
 * `singleBoxIsImageOnly` only changes the result when exactly one box is
 * selected — it is ignored (and defaults to false) for every other count, so
 * existing callers passing just a count keep their exact prior output.
 */
export function describeAction(selectionCount: number, singleBoxIsImageOnly = false): string {
  if (selectionCount === 0) return 'created a box'
  if (selectionCount === 1) return singleBoxIsImageOnly ? 'answered about an image' : 'edited a box'
  return `used ${selectionCount} boxes as context`
}

export function useGeneration(
  state: State,
  dispatch: (a: Action) => void,
  viewportSize: { w: number; h: number },
) {
  const [busy, setBusy] = useState(false)

  // A ref mirror of `state`, kept current via effect. `runCanvasPrompt` is an
  // async closure captured at prompt-submission time; by the time its
  // onDone fires the box may have been renamed, so the titleEdited check
  // needs the latest state rather than the stale value closed over at call
  // time.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  function placeNewBox(prompt: string): Box {
    const at = findCenterSlot(state.boxes, state.viewport, viewportSize, NEW_BOX)
    return {
      id: crypto.randomUUID(),
      x: at.x, y: at.y, w: NEW_BOX.w, h: NEW_BOX.h,
      blocks: [{ type: 'text', text: '' }],
      render: 'markdown',
      status: 'streaming',
      lastPrompt: prompt,
    }
  }

  /**
   * Streams a reply into a box. Passing `retryTargetId` regenerates an existing
   * box instead of choosing a target from the selection.
   */
  async function runCanvasPrompt(
    prompt: string,
    selected: Box[],
    retryTargetId?: string,
  ): Promise<void> {
    if (busy) return
    setBusy(true)

    const messages = buildMessages(state.turns, selected, prompt)

    // A single selected box that holds only images would be destroyed by the
    // in-place rewrite below (it replaces a box's blocks with plain text), so
    // it is treated like a 2+ selection instead: the answer lands in a new
    // box and the photo is left untouched.
    const singleSelectedIsImageOnly = selected.length === 1 && isImageOnlyBox(selected[0].blocks)

    // Every canvas prompt enters the same thread the chat panel shows, so the
    // history the model sees is exactly what the user can read.
    dispatch({
      type: 'addTurn',
      turn: {
        id: crypto.randomUUID(),
        role: 'user',
        blocks: [{ type: 'text', text: prompt }],
        label: `→ ${retryTargetId ? 'retried a box' : describeAction(selected.length, singleSelectedIsImageOnly)}`,
      },
    })

    // A box that already exists is rewritten through the shadow buffer, so a
    // failure can never destroy text that is already on the canvas.
    const inPlace = Boolean(retryTargetId) || (selected.length === 1 && !singleSelectedIsImageOnly)
    let targetId: string
    if (retryTargetId) {
      targetId = retryTargetId
    } else if (selected.length === 1 && !singleSelectedIsImageOnly) {
      targetId = selected[0].id
    } else {
      const box = placeNewBox(prompt)
      dispatch({ type: 'addBox', box })
      targetId = box.id
    }

    dispatch({ type: 'setBoxPrompt', id: targetId, prompt })
    if (inPlace) dispatch({ type: 'beginShadow', id: targetId })

    const turnId = crypto.randomUUID()
    dispatch({
      type: 'addTurn',
      turn: {
        id: turnId, role: 'assistant',
        blocks: [{ type: 'text', text: '' }], status: 'streaming',
      },
    })

    // The reveal pacer smooths the sentence-sized deltas the server sends
    // into a steady per-frame trickle. Both the box and its chat-turn
    // mirror are dispatched from the same paced chunk each tick, so they
    // never drift out of sync with each other. `finalText` tracks the raw,
    // unpaced accumulation so a completed generation's title request always
    // sees the full reply, independent of how much the pacer has revealed.
    let finalText = ''
    const pacer = createRevealPacer((chunk) => {
      if (inPlace) dispatch({ type: 'appendShadow', id: targetId, text: chunk })
      else dispatch({ type: 'appendDelta', id: targetId, text: chunk })
      dispatch({ type: 'appendTurnDelta', id: turnId, text: chunk })
    })

    try {
      await generate(messages, {
        onDelta: (t) => {
          finalText += t
          pacer.push(t)
        },
        onSources: (sources) => {
          dispatch({ type: 'setBoxSources', id: targetId, sources })
          dispatch({ type: 'updateTurn', id: turnId, patch: { sources } })
        },
        onError: (message) => {
          // Flush before settling so nothing already received is left
          // half-revealed behind the pacer.
          pacer.flush()
          if (inPlace) dispatch({ type: 'rollbackShadow', id: targetId, error: message })
          else dispatch({ type: 'setBoxError', id: targetId, error: message })
          dispatch({ type: 'updateTurn', id: turnId, patch: { status: 'error', error: message } })
        },
        onDone: () => {
          pacer.flush()
          if (inPlace) dispatch({ type: 'commitShadow', id: targetId })
          else dispatch({ type: 'setBoxStatus', id: targetId, status: 'idle' })
          dispatch({ type: 'updateTurn', id: turnId, patch: { status: undefined } })

          // Auto-title after the content is committed, without blocking or
          // delaying the visible completion above. A box the user has
          // already renamed by hand is left alone; a failed or empty title
          // is a silent no-op.
          const box = stateRef.current.boxes.find((b) => b.id === targetId)
          if (!box?.titleEdited && finalText.trim().length > 0) {
            void requestTitle(finalText).then((title) => {
              if (title) dispatch({ type: 'setBoxTitle', id: targetId, title })
            })
          }
        },
      })
    } finally {
      pacer.stop()
      setBusy(false)
    }
  }

  async function runChatPrompt(prompt: string): Promise<void> {
    if (busy) return
    setBusy(true)

    // Chat prompts carry no box context — selection belongs to the omnibar.
    const messages = buildMessages(state.turns, [], prompt)

    dispatch({
      type: 'addTurn',
      turn: { id: crypto.randomUUID(), role: 'user', blocks: [{ type: 'text', text: prompt }] },
    })

    const turnId = crypto.randomUUID()
    dispatch({
      type: 'addTurn',
      turn: {
        id: turnId, role: 'assistant',
        blocks: [{ type: 'text', text: '' }], status: 'streaming',
      },
    })

    const pacer = createRevealPacer((chunk) =>
      dispatch({ type: 'appendTurnDelta', id: turnId, text: chunk }),
    )

    try {
      await generate(messages, {
        onDelta: (t) => pacer.push(t),
        onSources: (sources) => dispatch({ type: 'updateTurn', id: turnId, patch: { sources } }),
        onError: (message) => {
          pacer.flush()
          dispatch({ type: 'updateTurn', id: turnId, patch: { status: 'error', error: message } })
        },
        onDone: () => {
          pacer.flush()
          dispatch({ type: 'updateTurn', id: turnId, patch: { status: undefined } })
        },
      })
    } finally {
      pacer.stop()
      setBusy(false)
    }
  }

  async function retryBox(boxId: string): Promise<void> {
    const box = state.boxes.find((b) => b.id === boxId)
    if (!box?.lastPrompt) return
    // Reproduce the original context: a rewrite that failed still has its
    // original text, whereas a failed creation is empty.
    const hadContent = blocksToText(box.blocks).trim().length > 0
    await runCanvasPrompt(box.lastPrompt, hadContent ? [box] : [], boxId)
  }

  // `retryBox` is handed to Canvas -> TextBox as `onRetry`, and TextBox is
  // React.memo'd (see TextBox.tsx) to stop react-markdown from re-parsing
  // every box on every streaming tick. `retryBox` itself is a fresh closure
  // every render (it needs the current `state`/`busy`, exactly like before),
  // so exposing it directly would hand memoization a new function identity
  // constantly and defeat it for every box, not just the one being retried.
  // `retryBoxRef` always holds the latest closure; the function identity
  // returned to callers never changes.
  const retryBoxRef = useRef(retryBox)
  useEffect(() => {
    retryBoxRef.current = retryBox
  })
  const stableRetryBox = useCallback((boxId: string) => retryBoxRef.current(boxId), [])

  return { runCanvasPrompt, runChatPrompt, retryBox: stableRetryBox, busy }
}
