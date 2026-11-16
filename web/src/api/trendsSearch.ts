import { deepEqual } from '@tanstack/react-router'
import { resolvePeriodFields, seedCustom, type Period } from './period'

/**
 * The `/trends` search params: the period the charts are drawn over.
 *
 * Absent means the last 12 months, so a bare `/trends` needs no redirect
 * and a `/trends#decoupling` link from the activity page keeps its hash.
 * All time is therefore written out as `period=all`, the one view in the
 * application whose default is not the whole history: a trend line over
 * several years compresses the recent stretch a reader most often wants to
 * read into a sliver of the plot.
 */
export interface TrendsSearch {
  /** Absent means 'last_12_months'. */
  period?: Period
  /** Only meaningful, and only kept, with `period: 'custom'`. */
  from?: string
  to?: string
}

export const DEFAULT_TRENDS_PERIOD: Period = 'last_12_months'

/**
 * Parses and narrows the raw search object rather than trusting it, the
 * discipline `validateDistributionSearch` applies to its own period: an
 * unknown period, or a custom range with no valid date or a crossed one,
 * falls back to the default. Idempotent, which is what lets `router.tsx`'s
 * `beforeLoad` redirect once rather than loop.
 */
export function validateTrendsSearch(search: Record<string, unknown>): TrendsSearch {
  const fields = resolvePeriodFields(search.period, search.from, search.to, DEFAULT_TRENDS_PERIOD)
  if (fields.period === DEFAULT_TRENDS_PERIOD) return {}
  const result: TrendsSearch = { period: fields.period }
  if (fields.from !== undefined) result.from = fields.from
  if (fields.to !== undefined) result.to = fields.to
  return result
}

/** The validated search to redirect to, or `null` when the raw search is already that shape. */
export function trendsSearchRedirectTarget(raw: Record<string, unknown>): TrendsSearch | null {
  const clean = validateTrendsSearch(raw)
  return deepEqual(raw, clean) ? null : clean
}

/**
 * The search after the picker changes. Choosing `custom` seeds its dates
 * from the period it replaces, for the reason `seedCustom` gives; a bare
 * `period=custom` would validate back to the default and the select would
 * refuse the choice.
 */
export function applyTrendsSearchChange(search: TrendsSearch, change: TrendsSearch, today: string): TrendsSearch {
  const next: TrendsSearch = { ...search, ...change }
  const current = search.period ?? DEFAULT_TRENDS_PERIOD
  if (change.period === 'custom' && current !== 'custom' && change.from === undefined && change.to === undefined) {
    const seed = seedCustom(current, search.from, search.to, today)
    next.from = seed.from
    next.to = seed.to
  }
  return validateTrendsSearch(next as Record<string, unknown>)
}
