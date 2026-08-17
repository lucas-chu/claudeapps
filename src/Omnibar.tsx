import { useState } from 'react'
import type { State } from './state/store'
import { blocksToText, isImageOnlyBox, type Box } from './state/types'
import type { useGeneration } from './useGeneration'

export default function Omnibar({
  state, gen,
}: {
  state: State
  gen: ReturnType<typeof useGeneration>
}) {
  const [prompt, setPrompt] = useState('')

  const selected: Box[] = state.boxes.filter((b) => state.selection.includes(b.id))

  async function run() {
    const text = prompt.trim()
    if (!text || gen.busy) return
    setPrompt('')
    await gen.runCanvasPrompt(text, selected)
  }

  const hint =
    selected.length === 0
      ? 'Ask anything — the answer lands in a new box'
      : selected.length === 1
        ? isImageOnlyBox(selected[0].blocks)
          ? 'Ask about this image'
          : `Rewrite "${blocksToText(selected[0].blocks).slice(0, 24) || 'this box'}…"`
        : `Use ${selected.length} boxes as context`

  return (
    <div className="omnibar">
      <input
        value={prompt}
        placeholder={hint}
        disabled={gen.busy}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') run()
        }}
      />
      <button onClick={run} disabled={gen.busy || !prompt.trim()}>
        {gen.busy ? '…' : '↵'}
      </button>
    </div>
  )
}
