import { deepEqual } from '@tanstack/react-router'

/**
 * The `/progression` search params: the one chosen distance, so a view of
 * the 10 km progression is a shareable link.
 *
 * `distance` is a string and not a closed union, on purpose. The key set
 * belongs to `analysis/best_efforts.py`, the schema types
 * `ProgressionPoint.distance_key` as a plain string for the same reason,
 * and the endpoint already answers an unknown key with a 404 that the view
 * renders as a stated absence. A closed list here would break the whole
 * view the day a distance is added, and would hide the 404 branch that
 * exists to be seen.
 */
export interface ProgressionSearch {
  distance: string
}

/**
 * The distance the view opens on when the URL names none. 5 km because it
 * is the distance with the deepest eligible history that is still a race
 * distance - 155 eligible efforts and 9 records on the real store - so the
 * first thing a reader sees is a ladder rather than a handful of points.
 */
export const DEFAULT_DISTANCE_KEY = '5k'

/**
 * Parses and narrows the raw search object rather than trusting it: a
 * missing, empty or non-string `distance` becomes the default, and every
 * other key is dropped. Idempotent, which is what lets `router.tsx`'s
 * `beforeLoad` redirect once rather than loop - see
 * `validateActivitySearch` for the full argument, and for why validation
 * alone does not clean the URL.
 */
export function validateProgressionSearch(search: Record<string, unknown>): ProgressionSearch {
  const raw = search.distance
  const distance = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : DEFAULT_DISTANCE_KEY
  return { distance }
}

/**
 * The validated search `/progression` should redirect its raw URL search
 * to, or `null` when the raw search is already exactly that shape. Same
 * shape and same reasoning as `activitySearchRedirectTarget`.
 */
export function progressionSearchRedirectTarget(rawSearch: Record<string, unknown>): ProgressionSearch | null {
  const clean = validateProgressionSearch(rawSearch)
  return deepEqual(rawSearch, clean) ? null : clean
}
