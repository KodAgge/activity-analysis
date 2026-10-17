import { useCallback, useSyncExternalStore } from 'react'

/**
 * The activity view's desktop layout, where the hero is pinned beside the
 * charts: `ActivityDetail.module.css`'s `@media (min-width: 60rem)` block,
 * restated because a stylesheet and a script cannot share a constant. Below
 * it is the phone layout, whose hero collapses instead.
 */
export const DESKTOP_LAYOUT_QUERY = '(min-width: 60rem)'

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
