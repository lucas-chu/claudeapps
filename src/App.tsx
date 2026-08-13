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
    const el = shellRef.current
    if (!el) return

    const measure = (w: number, h: number) => {
      if (w === 0 || h === 0) return
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }

    measure(el.clientWidth, el.clientHeight)

    const observer = new ResizeObserver(() => {
      measure(el.clientWidth, el.clientHeight)
    })
    observer.observe(el)
    return () => observer.disconnect()
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
