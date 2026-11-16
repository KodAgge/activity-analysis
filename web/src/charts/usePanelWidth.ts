import { useCallback, useRef, useState } from 'react'

/**
 * The widest a chart is drawn when printed, in CSS pixels: an A4 page's
 * 210mm less `Plan.module.css`'s two 12mm margins is about 186mm, or 700px.
 * A viewBox set from the screen's wider panel would be shrunk to the page
 * by `max-width: 100%`, text included, so the labels would print at half
 * their size.
 */
export const PRINT_WIDTH_PX = 700

/**
 * A panel's content width in CSS pixels, kept current with a
 * `ResizeObserver`, through a callback ref.
 *
 * For an SVG chart that sets its `viewBox` from the width it is drawn at,
 * so one coordinate unit is one CSS pixel: `ProgressionScatter.tsx`
 * records what a fixed viewBox scaled to fit did to label and mark sizes.
 *
 * While the page is printed the width is capped at `PRINT_WIDTH_PX`, and
 * measured again when the `print` media query changes either way, which
 * is not a resize the observer is promised to report.
 *
 * 0 until the first measurement and where the element has no layout, as
 * in jsdom, which a caller treats as "lay out at a fallback width".
 */
export function usePanelWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
  const [width, setWidth] = useState(0)
  const cleanupRef = useRef<(() => void) | null>(null)

  const ref = useCallback((node: T | null) => {
    cleanupRef.current?.()
    cleanupRef.current = null
    if (node === null) return
    const print = typeof window.matchMedia === 'function' ? window.matchMedia('print') : null
    const measure = () => {
      const w = node.clientWidth
      setWidth(print?.matches === true ? Math.min(w, PRINT_WIDTH_PX) : w)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(node)
    print?.addEventListener('change', measure)
    cleanupRef.current = () => {
      observer?.disconnect()
      print?.removeEventListener('change', measure)
    }
  }, [])

  return [ref, width]
}
