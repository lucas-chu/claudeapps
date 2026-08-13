import { useState } from 'react'
import { generate } from './api/stream'
import { buildMessages } from './state/context'
import { findFreeSlot, screenToWorld } from './canvas/geometry'
import type { Action, State } from './state/store'
import { blocksToText, type Box } from './state/types'

const NEW_BOX = { w: 360, h: 260 }

export function describeAction(selectionCount: number): string {
  if (selectionCount === 0) return 'created a box'
  if (selectionCount === 1) return 'edited a box'
  return `used ${selectionCount} boxes as context`
}

export function useGeneration(
  state: State,
  dispatch: (a: Action) => void,
  viewportSize: { w: number; h: number },
) {
  const [busy, setBusy] = useState(false)

  function placeNewBox(prompt: string): Box {
    const center = screenToWorld(
      { x: viewportSize.w / 2, y: viewportSize.h / 2 },
      state.viewport,
    )
    const at = findFreeSlot(state.boxes, center, NEW_BOX)
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

    // Every canvas prompt enters the same thread the chat panel shows, so the
    // history the model sees is exactly what the user can read.
    dispatch({
      type: 'addTurn',
      turn: {
        id: crypto.randomUUID(),
        role: 'user',
        blocks: [{ type: 'text', text: prompt }],
        label: `→ ${retryTargetId ? 'retried a box' : describeAction(selected.length)}`,
      },
    })

    // A box that already exists is rewritten through the shadow buffer, so a
    // failure can never destroy text that is already on the canvas.
    const inPlace = Boolean(retryTargetId) || selected.length === 1
    let targetId: string
    if (retryTargetId) {
      targetId = retryTargetId
    } else if (selected.length === 1) {
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

    await generate(messages, {
      onDelta: (t) => {
        if (inPlace) dispatch({ type: 'appendShadow', id: targetId, text: t })
        else dispatch({ type: 'appendDelta', id: targetId, text: t })
        dispatch({ type: 'appendTurnDelta', id: turnId, text: t })
      },
      onSources: (sources) => {
        dispatch({ type: 'setBoxSources', id: targetId, sources })
        dispatch({ type: 'updateTurn', id: turnId, patch: { sources } })
      },
      onError: (message) => {
        if (inPlace) dispatch({ type: 'rollbackShadow', id: targetId, error: message })
        else dispatch({ type: 'setBoxError', id: targetId, error: message })
        dispatch({ type: 'updateTurn', id: turnId, patch: { status: 'error', error: message } })
      },
      onDone: () => {
        if (inPlace) dispatch({ type: 'commitShadow', id: targetId })
        else dispatch({ type: 'setBoxStatus', id: targetId, status: 'idle' })
        dispatch({ type: 'updateTurn', id: turnId, patch: { status: undefined } })
      },
    })

    setBusy(false)
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

    await generate(messages, {
      onDelta: (t) => dispatch({ type: 'appendTurnDelta', id: turnId, text: t }),
      onSources: (sources) => dispatch({ type: 'updateTurn', id: turnId, patch: { sources } }),
      onError: (message) =>
        dispatch({ type: 'updateTurn', id: turnId, patch: { status: 'error', error: message } }),
      onDone: () => dispatch({ type: 'updateTurn', id: turnId, patch: { status: undefined } }),
    })

    setBusy(false)
  }

  async function retryBox(boxId: string): Promise<void> {
    const box = state.boxes.find((b) => b.id === boxId)
    if (!box?.lastPrompt) return
    // Reproduce the original context: a rewrite that failed still has its
    // original text, whereas a failed creation is empty.
    const hadContent = blocksToText(box.blocks).trim().length > 0
    await runCanvasPrompt(box.lastPrompt, hadContent ? [box] : [], boxId)
  }

  return { runCanvasPrompt, runChatPrompt, retryBox, busy }
}
