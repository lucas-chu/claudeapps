import { useReducer } from 'react'
import Canvas from './canvas/Canvas'
import { reducer, initialState } from './state/store'

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState)

  return (
    <div className="app">
      <Canvas state={state} dispatch={dispatch} />
      <button
        style={{ position: 'absolute', left: 12, top: 12, zIndex: 10 }}
        onClick={() =>
          dispatch({
            type: 'addBox',
            box: {
              id: crypto.randomUUID(),
              x: 80, y: 80, w: 320, h: 220,
              blocks: [{ type: 'text', text: '**Drag me.** Resize me. Double-click to edit.' }],
              render: 'markdown', status: 'idle',
            },
          })
        }
      >
        Add box
      </button>
    </div>
  )
}
