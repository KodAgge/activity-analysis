import { deepEqual } from '@tanstack/react-router'
import type { operations } from './schema'

/**
 * The `/api/activities` search params, typed straight from the generated
 * schema so a filter renamed or retyped on the backend is a compile error
 * here rather than a 422 discovered in the browser. `sort` and `order` are
 * literal unions in the schema, which is what makes an invalid value a type
 * error instead of a bad request.
 */
export type ActivitySearch = NonNullable<
  operations['activities_api_activities_get']['parameters']['query']
>

// Matches the endpoint's own default (see `src/activity_analysis/api/routers/
// activities.py` and `RUNNING_SPORT` in `analysis/pipeline.py`): the browser
// covers every sport, but running is the training this application is about.
const DEFAULT_SPORT = 'running'

/**
 * The two sentinel `sport` values `docs/reference/api.md` documents:
 * `all` turns the sport filter off entirely, and `unknown` selects the
 * activities whose sport is null - what GPX ingestion records, and what
 * `/api/sports` reports as its null bucket. Mirrors `ALL_SPORTS` and
 * `UNKNOWN_SPORT` in `src/activity_analysis/api/queries.py`; the generated
 * schema types `sport` as a plain `string` (it isn't a closed enum on the
 * backend either), so these can't be read from `schema.d.ts` the way
 * `source`/`sort`/`order` are - the Python source is the only place they
 * live.
 */
export const ALL_SPORTS = 'all'
export const UNKNOWN_SPORT = 'unknown'

/**
 * The search keys that choose how the result set is presented rather than
 * which rows are in it. Every other key on the search object is a filter,
 * by construction: `isUnfilteredSearch` never has to be told about a new
 * filter, only about a new presentation key, which is rare and obvious.
 *
 * The list used to be the other way round - six filter keys named by hand -
 * and the five filters added later were not added to it, so an empty result
 * under a distance bound was reported as an empty store.
 */
const NON_FILTER_KEYS: ReadonlySet<string> = new Set<keyof ActivitySearch>([
  'sort',
  'order',
  'offset',
  'limit',
])

/**
 * True when nothing in `search` narrows the list, so an empty result means
 * an empty store rather than filters that matched nothing.
 *
 * `sport` is off only at `ALL_SPORTS`: the default, running, is itself a
 * filter, and an empty page under it says nothing about the store as a
 * whole. An empty search string is not a filter. Anything else that is
 * present and defined is one, including a key this module has never heard
 * of, which is what makes the check hold for a filter added next month.
 */
export function isUnfilteredSearch(search: ActivitySearch): boolean {
  return Object.entries(search).every(([key, value]) => {
    if (NON_FILTER_KEYS.has(key)) return true
    if (key === 'sport') return value === ALL_SPORTS
    return value === undefined || value === ''
  })
}

const SOURCES = ['garmin_fit', 'strava_fit', 'gpx'] as const
const SORTS = [
  'start_time_utc',
  'distance_m',
  'elapsed_time_s',
  'moving_time_s',
  // Pace sorts by the speed it is the reciprocal of - the API stores no
  // pace, so there is no pace column to name. `COLUMNS` in
  // `views/Activities.tsx` is what maps the Pace header onto this key and
  // inverts the direction the reader expects.
  'avg_speed_mps',
  'avg_hr_bpm',
] as const
const ORDERS = ['desc', 'asc'] as const

// src/activity_analysis/api/routers/activities.py: `limit: int = Query(50, ge=1, le=200)`.
const MIN_LIMIT = 1
const MAX_LIMIT = 200
// `offset: int = Query(0, ge=0)`. No declared upper bound.
const MIN_OFFSET = 0

function isOneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

/**
 * True for a real calendar date in `YYYY-MM-DD` form, the shape `from` and
 * `to` are compared against. The regex alone would accept `2024-13-40`;
 * round-tripping through `Date` and comparing the parsed value's own
 * ISO date back against the input catches that.
 */
function isValidDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/**
 * An integer clamped into `[min, max]`, or `undefined` when the raw value is
 * not an integer at all.
 *
 * A fractional value (`limit=2.5`) has no sane integer reading - the
 * endpoint's own type is `int`, and Pydantic 422s rather than rounding it -
 * so it is dropped rather than forwarded. An integer merely outside the
 * bound (`limit=9999`, `offset=-5`) does have an obvious one, so it is
 * clamped rather than dropped.
 */
/**
 * A finite, non-negative number, or `undefined` for anything else.
 *
 * Fractional values are allowed here where `clampInt` rejects them: the
 * endpoint types these four as `float`, and a distance filter of 7.5 km is
 * an ordinary thing for a reader to ask for.
 */
function nonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value
}

function clampInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  return Math.min(Math.max(value, min), max)
}

/**
 * Parses and narrows the raw search object rather than trusting it: a value
 * of the wrong type, out of its enum, or out of its numeric bound is
 * dropped or clamped rather than forwarded to a backend that would 422 on
 * it. `sport` alone gets a default when absent, matching the endpoint's own
 * default.
 *
 * This function is idempotent - `validateActivitySearch(validateActivitySearch(x))`
 * always equals `validateActivitySearch(x)` - which is what lets
 * `router.tsx`'s `beforeLoad` redirect to a clean URL exactly once rather
 * than looping: a URL already equal to its own validated form validates to
 * itself again.
 *
 * This function alone does not close the gap it looks like it closes.
 * TanStack Router computes a matched route's `search` as the *raw, entirely
 * unvalidated* parent search overlaid with this function's own return value
 * - confirmed by reading `matchRoutesInternal` in
 * `@tanstack/router-core`, not assumed from its types - so a key this
 * function drops can still resurface on the object a component's
 * `useSearch()` reads back, unchanged. Two things close that gap, deliberately
 * both: `router.tsx`'s `beforeLoad` redirects to the validated search when it
 * differs from the raw one, which is what makes `useSearch()` itself
 * trustworthy for a view; and `queries.activities` re-runs its input through
 * this same function immediately before building the request regardless, which
 * is the point that actually decides what the API sees and must not depend on
 * the redirect having already run.
 */
export function validateActivitySearch(search: Record<string, unknown>): ActivitySearch {
  const validated: ActivitySearch = {
    sport: typeof search.sport === 'string' ? search.sport : DEFAULT_SPORT,
  }
  if (isValidDateString(search.from)) validated.from = search.from
  if (isValidDateString(search.to)) validated.to = search.to
  if (isOneOf(SOURCES, search.source)) validated.source = search.source
  if (typeof search.has_hr === 'boolean') validated.has_hr = search.has_hr
  if (typeof search.has_pr === 'boolean') validated.has_pr = search.has_pr
  if (typeof search.q === 'string') validated.q = search.q
  if (isOneOf(SORTS, search.sort)) validated.sort = search.sort
  if (isOneOf(ORDERS, search.order)) validated.order = search.order
  // The four numeric filters. Non-negative and finite, and dropped rather
  // than clamped when they are neither: unlike `limit`, an out-of-range
  // distance has no obvious intended reading to clamp to, and forwarding a
  // negative one would 422.
  const minDistance = nonNegativeNumber(search.min_distance_m)
  if (minDistance !== undefined) validated.min_distance_m = minDistance
  const maxDistance = nonNegativeNumber(search.max_distance_m)
  if (maxDistance !== undefined) validated.max_distance_m = maxDistance
  const minMoving = nonNegativeNumber(search.min_moving_time_s)
  if (minMoving !== undefined) validated.min_moving_time_s = minMoving
  const maxMoving = nonNegativeNumber(search.max_moving_time_s)
  if (maxMoving !== undefined) validated.max_moving_time_s = maxMoving
  const limit = clampInt(search.limit, MIN_LIMIT, MAX_LIMIT)
  if (limit !== undefined) validated.limit = limit
  const offset = clampInt(search.offset, MIN_OFFSET, Number.MAX_SAFE_INTEGER)
  if (offset !== undefined) validated.offset = offset
  return validated
}

/**
 * The validated search `/activities` should redirect its raw URL search to,
 * or `null` when the raw search is already exactly that shape and no
 * redirect is warranted.
 *
 * Extracted out of `router.tsx`'s `beforeLoad` so the redirect decision
 * itself is unit-testable directly, without going through a live router:
 * TanStack Router's own protection against navigating to a location
 * identical to the current one means a redirect *to* the current URL is a
 * silent no-op at the router level regardless of whether this function was
 * right to propose it, which would mask a broken loop guard here rather
 * than exposing it.
 *
 * Comparing by *value* (`deepEqual`), not by key set, is what catches a
 * clamped value: `limit=9999` and its clamped `limit=200` share the same
 * key, so a same-keys check would wrongly see no difference and never
 * redirect, leaving `9999` sitting in the address bar - misleading to
 * bookmark or share - even though the app is really requesting 200 rows.
 * `validateActivitySearch` is idempotent, so re-running it on an
 * already-clean `rawSearch` always reproduces `rawSearch` exactly, which is
 * what makes `null` the answer for a clean input and stops this looping:
 * the redirect's own destination validates to itself.
 */
export function activitySearchRedirectTarget(
  rawSearch: Record<string, unknown>,
): ActivitySearch | null {
  const clean = validateActivitySearch(rawSearch)
  return deepEqual(rawSearch, clean) ? null : clean
}
