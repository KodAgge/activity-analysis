import { deepEqual } from '@tanstack/react-router'

/**
 * The territory view's URL state: which region the map is fitted to.
 *
 * Optional, unlike Progression's distance: the default is the largest
 * region, which only the payload knows, so a bare `/territory` is the
 * default rather than a URL to redirect away from. A region id a recompute
 * has retired falls back to the largest in the view, the way a route view
 * states a retired route id, rather than here, where the regions are not
 * known.
 */
export interface TerritorySearch {
  region?: string
}

export function validateTerritorySearch(search: Record<string, unknown>): TerritorySearch {
  const raw = search.region
  return typeof raw === 'string' && raw.trim() !== '' ? { region: raw.trim() } : {}
}

/**
 * The validated search when the raw one differs from it, so the route can
 * redirect an unknown key or an empty region out of the address bar the
 * way `/progression` does; `null` when the URL already says what the view
 * shows.
 */
export function territorySearchRedirectTarget(rawSearch: Record<string, unknown>): TerritorySearch | null {
  const clean = validateTerritorySearch(rawSearch)
  return deepEqual(rawSearch, clean) ? null : clean
}
