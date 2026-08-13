import { useEffect, useReducer, useRef, useState } from 'react'
import Canvas from './canvas/Canvas'
import Omnibar from './Omnibar'
import { useGeneration } from './useGeneration'
import { reducer, initialState } from './state/store'

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const shellRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 1200, h: 800 })
  const gen = useGeneration(state, dispatch, size)

  useEffect(() => {
    const measure = () => {
      const el = shellRef.current
      if (el) setSize({ w: el.clientWidth, h: el.clientHeight })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ type: 'clearSelection' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app">
      <div className="canvas-shell" ref={shellRef}>
        <Canvas state={state} dispatch={dispatch} />
        <Omnibar state={state} gen={gen} />
      </div>
    </div>
  )
}
