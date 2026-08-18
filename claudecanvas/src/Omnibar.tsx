import { useState } from 'react'
import type { State } from './state/store'
import { blocksToText, isDrawingOnlyBox, isImageOnlyBox, type Box } from './state/types'
import type { useGeneration } from './useGeneration'

export default function Omnibar({
  state, gen,
}: {
  state: State
  gen: ReturnType<typeof useGeneration>
}) {
  const [prompt, setPrompt] = useState('')

  const selected: Box[] = state.boxes.filter((b) => state.selection.includes(b.id))

  // Submitting clears the input right away — generations run concurrently
  // now, so there's no reason to make the user wait before typing the next
  // prompt. A prompt whose target box is already streaming isn't queued: it
  // is declined by useGeneration's same-box guard, which surfaces a toast
  // (see App.tsx's onBusyBox) rather than silently discarding it.
  async function run() {
    const text = prompt.trim()
    if (!text) return
    setPrompt('')
    await gen.runCanvasPrompt(text, selected)
  }

  const hint =
    selected.length === 0
      ? 'Ask anything — the answer lands in a new box'
      : selected.length === 1
        ? isImageOnlyBox(selected[0].blocks)
          ? 'Ask about this image'
          : isDrawingOnlyBox(selected[0].blocks)
            ? 'Ask about this drawing'
            : `Rewrite "${blocksToText(selected[0].blocks).slice(0, 24) || 'this box'}…"`
        : `Use ${selected.length} boxes as context`

  return (
    <div className="omnibar">
      <input
        value={prompt}
        placeholder={hint}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') run()
        }}
      />
      {gen.activeCount > 0 && (
        <span className="omnibar-running">{gen.activeCount} running</span>
      )}
      <button onClick={run} disabled={!prompt.trim()}>
        ↵
      </button>
    </div>
  )
}
