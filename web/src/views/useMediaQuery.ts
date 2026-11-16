import { useCallback, useSyncExternalStore } from 'react'

/**
 * The activity view's desktop layout, where the hero is pinned beside the
 * charts: `ActivityDetail.module.css`'s `@media (min-width: 60rem)` block,
 * restated because a stylesheet and a script cannot share a constant. Below
 * it is the phone layout, whose hero collapses instead.
 */
export const DESKTOP_LAYOUT_QUERY = '(min-width: 60rem)'

/**
 * The desktop layout, or a printed page. A printed A4 page is narrower than
 * `DESKTOP_LAYOUT_QUERY`, so a view that draws a grid on desktop and a list
 * on a phone asks this instead to keep its grid on paper.
 */
export const DESKTOP_OR_PRINT_QUERY = `${DESKTOP_LAYOUT_QUERY}, print`

/** Whether `query` matches now, re-rendering the caller when that changes. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches)
}
