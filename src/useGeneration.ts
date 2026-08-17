import { useCallback, useEffect, useRef, useState } from 'react'
import { generate, requestTitle } from './api/stream'
import { createRevealPacer, type RevealPacer } from './lib/revealPacer'
import { buildMessages } from './state/context'
import { findCenterSlot } from './canvas/geometry'
import type { Action, State } from './state/store'
import { blocksToText, isImageOnlyBox, type Box } from './state/types'

const NEW_BOX = { w: 360, h: 260 }

/** Shown when a prompt targets a box that is already streaming a reply. */
export const BOX_BUSY_MESSAGE = 'That box is already being written'

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

/**
 * One entry per in-flight generation, mapping its id to the box it writes
 * into. A chat-panel generation (or one whose target box isn't resolved yet)
 * maps to `undefined` — it can never collide with anything, since nothing
 * else can target "no box".
 */
export type ActiveGenerations = Map<string, string | undefined>

/** True when some in-flight generation is currently writing into `boxId`. */
export function isBoxActive(active: ActiveGenerations, boxId: string): boolean {
  for (const targetId of active.values()) {
    if (targetId === boxId) return true
  }
  return false
}

export type CanvasTarget =
  | { kind: 'new' }
  | { kind: 'inPlace'; targetId: string }

/**
 * Decides which box (if any) a canvas prompt would write into, before any
 * dispatch happens. A retry always rewrites its own box; a single selected
 * box that isn't image-only rewrites in place; everything else (nothing
 * selected, 2+ selected, or a single image-only box) lands in a new box and
 * can never collide with another generation.
 */
export function resolveCanvasTarget(selected: Box[], retryTargetId?: string): CanvasTarget {
  if (retryTargetId) return { kind: 'inPlace', targetId: retryTargetId }
  const singleSelectedIsImageOnly = selected.length === 1 && isImageOnlyBox(selected[0].blocks)
  if (selected.length === 1 && !singleSelectedIsImageOnly) {
    return { kind: 'inPlace', targetId: selected[0].id }
  }
  return { kind: 'new' }
}

export type ResolvedTarget = CanvasTarget | { kind: 'declined'; targetId: string }

/**
 * Decides where a prompt's answer goes once in-flight generations are taken
 * into account.
 *
 * The subtle case is rapid-fire prompting, which is the whole point of running
 * generations in parallel. Creating a box auto-selects it, so the very next
 * prompt resolves to an in-place rewrite of a box that is still streaming.
 * Declining there makes every prompt after the first silently do nothing.
 * Instead an ordinary prompt falls back to a new box: you cannot rewrite text
 * that is still being written, but you can certainly have another answer.
 *
 * A retry is different — it names one specific box by design, so there is no
 * sensible substitute and it is declined so the caller can say why.
 */
export function resolveTargetWithBusy(
  selected: Box[],
  retryTargetId: string | undefined,
  isBusy: (boxId: string) => boolean,
): ResolvedTarget {
  const target = resolveCanvasTarget(selected, retryTargetId)
  if (target.kind === 'inPlace' && isBusy(target.targetId)) {
    if (retryTargetId) return { kind: 'declined', targetId: target.targetId }
    return { kind: 'new' }
  }
  return target
}

export function useGeneration(
  state: State,
  dispatch: (a: Action) => void,
  viewportSize: { w: number; h: number },
  onBusyBox?: (boxId: string) => void,
) {
  // Authoritative, synchronously-updated bookkeeping for what's running.
  // Mutated the instant a generation starts/ends (never batched behind a
  // render), so the same-box guard in runCanvasPrompt is race-free even for
  // two submissions in the same tick. Mirrored into `activeCount` state
  // purely so components can render off it.
  const activeRef = useRef<ActiveGenerations>(new Map())
  const [activeCount, setActiveCount] = useState(0)
  const busy = activeCount > 0

  function syncActiveCount() {
    setActiveCount(activeRef.current.size)
  }

  function isBoxStreaming(boxId: string): boolean {
    return isBoxActive(activeRef.current, boxId)
  }

  // A ref mirror of `state`, kept current via effect. `runCanvasPrompt` and
  // `runChatPrompt` are async closures captured at prompt-submission time;
  // by the time an onDone fires the box may have been renamed (or, with
  // concurrent generations, other boxes may have been added/removed), so
  // anything that needs the *current* canvas reads this ref rather than the
  // stale snapshot closed over at call time. `buildMessages`, by contrast,
  // deliberately keeps using the closed-over `state` param below — a
  // prompt's context is what the user saw when they hit enter, not
  // whatever the canvas looks like once the reply finally lands.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  // `onBusyBox` is a fresh closure every render (App.tsx defines it inline),
  // so it's stashed in a ref the same way, letting runCanvasPrompt always
  // call the latest version without needing it in a dependency array.
  const onBusyBoxRef = useRef(onBusyBox)
  useEffect(() => {
    onBusyBoxRef.current = onBusyBox
  })

  function placeNewBox(prompt: string): Box {
    // Uses the live canvas, not the submit-time snapshot, so a box created
    // by one concurrent generation is accounted for when another one picks
    // its own free slot.
    const at = findCenterSlot(stateRef.current.boxes, stateRef.current.viewport, viewportSize, NEW_BOX)
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
   * box instead of choosing a target from the selection. Multiple calls may be
   * in flight at once — each gets its own reveal pacer and turn id — except
   * that two calls can never write into the *same* box concurrently: if the
   * resolved target is already streaming, this returns immediately without
   * dispatching anything, and `onBusyBox` is called instead.
   */
  async function runCanvasPrompt(
    prompt: string,
    selected: Box[],
    retryTargetId?: string,
  ): Promise<void> {
    const target = resolveTargetWithBusy(selected, retryTargetId, (id) =>
      isBoxActive(activeRef.current, id),
    )
    if (target.kind === 'declined') {
      onBusyBoxRef.current?.(target.targetId)
      return
    }

    // Registered synchronously, before any `await`, so a second call that
    // starts before this one yields still sees an accurate in-flight set —
    // JS runs everything up to the first `await` without interleaving.
    const genId = crypto.randomUUID()
    activeRef.current.set(genId, target.kind === 'inPlace' ? target.targetId : undefined)
    syncActiveCount()

    let pacer: RevealPacer | undefined
    try {
      // Submit-time snapshot: `state` here is the closure captured when this
      // render's runCanvasPrompt was created, i.e. exactly what the user saw
      // when they hit enter. It intentionally does NOT read stateRef, even
      // though other generations may be streaming into `state.turns` right
      // now — those belong to their own submit-time snapshots, not this one.
      const messages = buildMessages(state.turns, selected, prompt)

      // A single selected box that holds only images would be destroyed by
      // the in-place rewrite below (it replaces a box's blocks with plain
      // text), so it is treated like a 2+ selection instead: the answer
      // lands in a new box and the photo is left untouched.
      const singleSelectedIsImageOnly = selected.length === 1 && isImageOnlyBox(selected[0].blocks)

      // Every canvas prompt enters the same thread the chat panel shows, so
      // the history the model sees is exactly what the user can read.
      dispatch({
        type: 'addTurn',
        turn: {
          id: crypto.randomUUID(),
          role: 'user',
          blocks: [{ type: 'text', text: prompt }],
          label: `→ ${retryTargetId ? 'retried a box' : describeAction(selected.length, singleSelectedIsImageOnly)}`,
        },
      })

      // A box that already exists is rewritten through the shadow buffer, so
      // a failure can never destroy text that is already on the canvas.
      const inPlace = target.kind === 'inPlace'
      let targetId: string
      if (target.kind === 'inPlace') {
        targetId = target.targetId
      } else {
        const box = placeNewBox(prompt)
        dispatch({ type: 'addBox', box })
        targetId = box.id
        // The target box didn't exist when this generation registered above
        // — fill it in now so isBoxStreaming/the same-box guard see it too.
        activeRef.current.set(genId, targetId)
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
      // unpaced accumulation so a completed generation's title request
      // always sees the full reply, independent of how much the pacer has
      // revealed. This pacer is local to this call, so two concurrent
      // generations never share (and never interleave through) one buffer.
      let finalText = ''
      pacer = createRevealPacer((chunk) => {
        if (inPlace) dispatch({ type: 'appendShadow', id: targetId, text: chunk })
        else dispatch({ type: 'appendDelta', id: targetId, text: chunk })
        dispatch({ type: 'appendTurnDelta', id: turnId, text: chunk })
      })

      await generate(messages, {
        onDelta: (t) => {
          finalText += t
          pacer!.push(t)
        },
        onSources: (sources) => {
          dispatch({ type: 'setBoxSources', id: targetId, sources })
          dispatch({ type: 'updateTurn', id: turnId, patch: { sources } })
        },
        onError: (message) => {
          // Flush before settling so nothing already received is left
          // half-revealed behind the pacer.
          pacer!.flush()
          if (inPlace) dispatch({ type: 'rollbackShadow', id: targetId, error: message })
          else dispatch({ type: 'setBoxError', id: targetId, error: message })
          dispatch({ type: 'updateTurn', id: turnId, patch: { status: 'error', error: message } })
        },
        onDone: () => {
          pacer!.flush()
          if (inPlace) dispatch({ type: 'commitShadow', id: targetId })
          else dispatch({ type: 'setBoxStatus', id: targetId, status: 'idle' })
          dispatch({ type: 'updateTurn', id: turnId, patch: { status: undefined } })

          // Auto-title after the content is committed, without blocking or
          // delaying the visible completion above. Reads the live canvas
          // (not the submit-time snapshot) because by now other concurrent
          // generations, or the user, may have changed titles/boxes since
          // this one started. A box the user has already renamed by hand is
          // left alone; a failed or empty title is a silent no-op.
          const box = stateRef.current.boxes.find((b) => b.id === targetId)
          if (!box?.titleEdited && finalText.trim().length > 0) {
            void requestTitle(finalText).then((title) => {
              if (title) dispatch({ type: 'setBoxTitle', id: targetId, title })
            })
          }
        },
      })
    } finally {
      // Runs on success, on a thrown/rejected error, and if the stream is
      // cut short — the in-flight entry can never leak a permanently-
      // "running" slot, and a box guarded above always becomes writable
      // again once this settles.
      pacer?.stop()
      activeRef.current.delete(genId)
      syncActiveCount()
    }
  }

  async function runChatPrompt(prompt: string): Promise<void> {
    // Chat generations target no box, so they can never trip the same-box
    // guard; they're still tracked so activeCount reflects them.
    const genId = crypto.randomUUID()
    activeRef.current.set(genId, undefined)
    syncActiveCount()

    let pacer: RevealPacer | undefined
    try {
      // Chat prompts carry no box context — selection belongs to the omnibar.
      // Submit-time snapshot, same reasoning as runCanvasPrompt above.
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

      pacer = createRevealPacer((chunk) =>
        dispatch({ type: 'appendTurnDelta', id: turnId, text: chunk }),
      )

      await generate(messages, {
        onDelta: (t) => pacer!.push(t),
        onSources: (sources) => dispatch({ type: 'updateTurn', id: turnId, patch: { sources } }),
        onError: (message) => {
          pacer!.flush()
          dispatch({ type: 'updateTurn', id: turnId, patch: { status: 'error', error: message } })
        },
        onDone: () => {
          pacer!.flush()
          dispatch({ type: 'updateTurn', id: turnId, patch: { status: undefined } })
        },
      })
    } finally {
      pacer?.stop()
      activeRef.current.delete(genId)
      syncActiveCount()
    }
  }

  async function retryBox(boxId: string): Promise<void> {
    // Reads the live canvas, not the render that created this closure: by
    // the time the user clicks retry, other concurrent generations may have
    // dispatched changes this component hasn't re-rendered for yet.
    const box = stateRef.current.boxes.find((b) => b.id === boxId)
    if (!box?.lastPrompt) return
    // Reproduce the original context: a rewrite that failed still has its
    // original text, whereas a failed creation is empty.
    const hadContent = blocksToText(box.blocks).trim().length > 0
    await runCanvasPrompt(box.lastPrompt, hadContent ? [box] : [], boxId)
  }

  // `retryBox` is handed to Canvas -> TextBox as `onRetry`, and TextBox is
  // React.memo'd (see TextBox.tsx) to stop react-markdown from re-parsing
  // every box on every streaming tick. `retryBox` itself is a fresh closure
  // every render (it needs the current `stateRef`, exactly like before), so
  // exposing it directly would hand memoization a new function identity
  // constantly and defeat it for every box, not just the one being retried.
  // `retryBoxRef` always holds the latest closure; the function identity
  // returned to callers never changes.
  const retryBoxRef = useRef(retryBox)
  useEffect(() => {
    retryBoxRef.current = retryBox
  })
  const stableRetryBox = useCallback((boxId: string) => retryBoxRef.current(boxId), [])

  return { runCanvasPrompt, runChatPrompt, retryBox: stableRetryBox, busy, activeCount, isBoxStreaming }
}
