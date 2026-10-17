import { useCallback, useRef, useState } from 'react'

/**
 * An element's border-box height in CSS pixels, kept current with a
 * `ResizeObserver`, through a callback ref.
 *
 * 0 while no element is attached, before the first observation, and where
 * `ResizeObserver` does not exist (jsdom), which is the value a caller's
 * layout arithmetic should treat as "takes no room".
 *
 * Written for the pace panel's note: the desktop stream stack in
 * `ActivityDetail.module.css` (`.pinned`) sizes four plots from fixed
 * per-section constants, and the note's height depends on how its sentence
 * wraps, which only the browser knows.
 */
export function useElementHeight<T extends Element>(): [(node: T | null) => void, number] {
  const [height, setHeight] = useState(0)
  const observerRef = useRef<ResizeObserver | null>(null)

  const ref = useCallback((node: T | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (node === null) {
      setHeight(0)
      return
    }
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.borderBoxSize[0]
      if (box !== undefined) setHeight(box.blockSize)
    })
    observer.observe(node)
    observerRef.current = observer
  }, [])

  return [ref, height]
}
