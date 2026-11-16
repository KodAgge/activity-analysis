import { deepEqual } from '@tanstack/react-router'
import { DEFAULT_VARIABLE, isVariableId, localParts } from '../charts/distributionVariables'
import type { DistributionRun, VariableId } from '../charts/distributionVariables'
import type { BarMeasure } from '../charts/histogramMath'
import {
  inRange,
  periodLabel,
  periodRange,
  resolvePeriodFields,
  seedCustom,
  type DateRange,
  type Period,
} from './period'

/**
 * The `/distributions` search params: the variable, the period and vs
 * period for comparing, the day-of-week and treadmill filters, how groups
 * are compared, and which bucket is selected.
 *
 * `variable` alone has no "absent" state - the view always shows one - so
 * it is the one key `validateDistributionSearch` writes even at its
 * default, which is what makes a bare `/distributions` redirect to
 * `?variable=distance` the way `/progression` redirects to `?distance=5k`.
 * Every other key is optional and is dropped once it equals its own
 * default, following `api/activitySearch.ts`'s rule.
 */
export interface DistributionSearch {
  variable: VariableId
  /** Absent means 'runs'. */
  measure?: BarMeasure
  /** Absent means 'all'. */
  period?: Period
  /** Only meaningful, and only kept, with `period: 'custom'`. */
  from?: string
  to?: string
  /** Absent means 'all'. */
  days?: Days
  /** Absent means 'include'. */
  treadmill?: Treadmill
  /** Absent means 'none'. */
  compare?: Compare
  /** The second period under `compare: 'periods'`. Absent means 'previous_12_months'. */
  vs?: Period
  vs_from?: string
  vs_to?: string
  /** The selected bucket's key, meaningful only for the current `variable`. */
  bucket?: string
}

export type Days = 'all' | 'weekdays' | 'weekends'
export type Treadmill = 'include' | 'exclude'
export type Compare = 'none' | 'periods' | 'days' | 'surface' | 'years'

const MEASURES = ['runs', 'distance', 'time'] as const satisfies readonly BarMeasure[]
const DAYS_VALUES = ['all', 'weekdays', 'weekends'] as const satisfies readonly Days[]
const TREADMILL_VALUES = ['include', 'exclude'] as const satisfies readonly Treadmill[]
const COMPARE_VALUES = ['none', 'periods', 'days', 'surface', 'years'] as const satisfies readonly Compare[]

const DEFAULT_MEASURE: BarMeasure = 'runs'
const DEFAULT_PERIOD: Period = 'all'
const DEFAULT_DAYS: Days = 'all'
const DEFAULT_TREADMILL: Treadmill = 'include'
const DEFAULT_COMPARE: Compare = 'none'
const DEFAULT_VS: Period = 'previous_12_months'

function isOneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

/**
 * Parses and narrows the raw search object rather than trusting it, the
 * same discipline `validateActivitySearch` and `validateProgressionSearch`
 * apply to their own routes: an unrecognised or malformed value is dropped
 * or falls back to the default rather than reaching a component or a
 * network boundary. Idempotent, which is what lets `router.tsx`'s
 * `beforeLoad` redirect once rather than loop.
 */
export function validateDistributionSearch(search: Record<string, unknown>): DistributionSearch {
  const variable = isVariableId(search.variable) ? search.variable : DEFAULT_VARIABLE
  const result: DistributionSearch = { variable }

  if (isOneOf(MEASURES, search.measure) && search.measure !== DEFAULT_MEASURE) {
    result.measure = search.measure
  }

  const periodFields = resolvePeriodFields(search.period, search.from, search.to, DEFAULT_PERIOD)
  if (periodFields.period !== DEFAULT_PERIOD) {
    result.period = periodFields.period
    if (periodFields.from !== undefined) result.from = periodFields.from
    if (periodFields.to !== undefined) result.to = periodFields.to
  }

  if (isOneOf(DAYS_VALUES, search.days) && search.days !== DEFAULT_DAYS) {
    result.days = search.days
  }
  if (isOneOf(TREADMILL_VALUES, search.treadmill) && search.treadmill !== DEFAULT_TREADMILL) {
    result.treadmill = search.treadmill
  }
  if (isOneOf(COMPARE_VALUES, search.compare) && search.compare !== DEFAULT_COMPARE) {
    result.compare = search.compare
  }

  if (result.compare === 'periods') {
    const vsFields = resolvePeriodFields(search.vs, search.vs_from, search.vs_to, DEFAULT_VS)
    if (vsFields.period !== DEFAULT_VS) {
      result.vs = vsFields.period
      if (vsFields.from !== undefined) result.vs_from = vsFields.from
      if (vsFields.to !== undefined) result.vs_to = vsFields.to
    }
  }

  const bucket = resolveBucket(search.bucket)
  if (bucket !== undefined) result.bucket = bucket

  return result
}

/**
 * The selected bucket's key, or `undefined` when there is none to select.
 *
 * The router's default `parseSearch` is `JSON.parse` over each raw query
 * value (`defaultParseSearch` in `@tanstack/router-core`, confirmed by
 * reading it rather than assumed), so a hand-typed or pasted
 * `?bucket=5000` arrives here as the *number* `5000`, not the string
 * `'5000'` - the same reason `validateActivitySearch`'s `limit` and
 * `offset` are read as `number`. Most bucket keys are exactly this shape:
 * `histogramMath.bucketsFor` builds a numeric variable's regular-bucket
 * keys with `String(lo)` and a category's with `String(category.key)`, so
 * a numeric key is the common case rather than an edge one, and only the
 * two open-edge keys (`'below'`/`'above'`) are non-numeric strings to
 * begin with. Accepting only `typeof === 'string'` therefore dropped the
 * bucket selection on most of the URLs a reader would actually type or
 * share, so a finite number is accepted here too and normalised to the
 * same string form the bucket keys are actually built in.
 */
function resolveBucket(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/**
 * The validated search `/distributions` should redirect its raw URL search
 * to, or `null` when the raw search is already exactly that shape. Same
 * shape and reasoning as `activitySearchRedirectTarget`: comparing by value
 * rather than by key set is what catches a key resolved to a different
 * valid value, and idempotence is what stops this looping.
 */
export function distributionSearchRedirectTarget(raw: Record<string, unknown>): DistributionSearch | null {
  const clean = validateDistributionSearch(raw)
  return deepEqual(raw, clean) ? null : clean
}

/**
 * The search after one control changes, with the rules the validator alone
 * cannot apply, because they depend on what the search was before:
 *
 * - changing `variable` clears `bucket`, whose key names a bucket on the old
 *   variable's axis;
 * - choosing `compare=periods` from all time sets `period` to the last 12
 *   months, so the default comparison is those against the 12 before;
 * - choosing `custom` for either period seeds its dates (see `seedCustom`).
 *
 * The result is validated, so a value set back to its default leaves the
 * URL. A key in `change` set to `undefined` clears it.
 */
export function applySearchChange(
  search: DistributionSearch,
  change: Partial<DistributionSearch>,
  today: string,
): DistributionSearch {
  const next: DistributionSearch = { ...search, ...change }

  if (change.variable !== undefined && change.variable !== search.variable && !('bucket' in change)) {
    delete next.bucket
  }

  if (change.compare === 'periods' && search.compare !== 'periods' && (next.period ?? DEFAULT_PERIOD) === DEFAULT_PERIOD) {
    next.period = 'last_12_months'
  }

  if (change.period === 'custom' && search.period !== 'custom' && change.from === undefined && change.to === undefined) {
    const seed = seedCustom(search.period ?? DEFAULT_PERIOD, search.from, search.to, today)
    next.from = seed.from
    next.to = seed.to
  }

  if (change.vs === 'custom' && search.vs !== 'custom' && change.vs_from === undefined && change.vs_to === undefined) {
    const seed = seedCustom(search.vs ?? DEFAULT_VS, search.vs_from, search.vs_to, today)
    next.vs_from = seed.from
    next.vs_to = seed.to
  }

  return validateDistributionSearch(next as unknown as Record<string, unknown>)
}

/** The distinct calendar years, ascending, that any run's local date falls in. */
export function yearsIn(runs: readonly DistributionRun[]): number[] {
  const years = new Set<number>()
  for (const run of runs) {
    years.add(Number(localParts(run).date.slice(0, 4)))
  }
  return [...years].sort((a, b) => a - b)
}

function filterByPeriod(runs: readonly DistributionRun[], range: DateRange): DistributionRun[] {
  return runs.filter((run) => inRange(localParts(run).date, range))
}

function isWeekend(run: DistributionRun): boolean {
  const weekday = localParts(run).isoWeekday
  return weekday === 6 || weekday === 7
}

function filterByDays(runs: readonly DistributionRun[], days: Days): DistributionRun[] {
  if (days === 'all') return [...runs]
  return runs.filter((run) => (days === 'weekends' ? isWeekend(run) : !isWeekend(run)))
}

function isTreadmillRun(run: DistributionRun): boolean {
  return run.is_indoor === true
}

function filterByTreadmill(runs: readonly DistributionRun[], treadmill: Treadmill): DistributionRun[] {
  if (treadmill === 'include') return [...runs]
  return runs.filter((run) => !isTreadmillRun(run))
}

/** One group of runs to draw as its own bar set or its own overlay series, with the label its section or key names it by. */
export interface Group {
  key: string
  label: string
  runs: DistributionRun[]
}

/**
 * The groups `charts/Histogram.tsx` draws for the current search, over
 * every served run.
 *
 * Filters apply in one order - period, then days, then treadmill - except
 * that `compare: 'periods'` replaces the period filter with two of them,
 * one per group, and `compare: 'days'`/`compare: 'surface'` each skip the
 * filter they are themselves splitting on. A disabled control keeps its URL value so turning the comparison
 * off restores the filter the reader had, even though it did nothing while
 * the comparison was active.
 */
export function groupsFor(search: DistributionSearch, runs: readonly DistributionRun[], today: string): Group[] {
  const days = search.days ?? DEFAULT_DAYS
  const treadmill = search.treadmill ?? DEFAULT_TREADMILL
  const compare = search.compare ?? DEFAULT_COMPARE
  const period = search.period ?? DEFAULT_PERIOD

  if (compare === 'periods') {
    const vs = search.vs ?? DEFAULT_VS
    const groupA = filterByTreadmill(
      filterByDays(filterByPeriod(runs, periodRange(period, search.from, search.to, today)), days),
      treadmill,
    )
    const groupB = filterByTreadmill(
      filterByDays(filterByPeriod(runs, periodRange(vs, search.vs_from, search.vs_to, today)), days),
      treadmill,
    )
    return [
      { key: 'a', label: periodLabel(period, search.from, search.to), runs: groupA },
      { key: 'b', label: periodLabel(vs, search.vs_from, search.vs_to), runs: groupB },
    ]
  }

  const periodFiltered = filterByPeriod(runs, periodRange(period, search.from, search.to, today))

  if (compare === 'days') {
    const treadmillFiltered = filterByTreadmill(periodFiltered, treadmill)
    return [
      { key: 'weekdays', label: 'Weekdays', runs: treadmillFiltered.filter((run) => !isWeekend(run)) },
      { key: 'weekends', label: 'Weekends', runs: treadmillFiltered.filter((run) => isWeekend(run)) },
    ]
  }

  if (compare === 'surface') {
    const daysFiltered = filterByDays(periodFiltered, days)
    return [
      { key: 'outdoor', label: 'Outdoor', runs: daysFiltered.filter((run) => !isTreadmillRun(run)) },
      { key: 'treadmill', label: 'Treadmill', runs: daysFiltered.filter((run) => isTreadmillRun(run)) },
    ]
  }

  const filtered = filterByTreadmill(filterByDays(periodFiltered, days), treadmill)

  if (compare === 'years') {
    return yearsIn(filtered).map((year) => ({
      key: String(year),
      label: String(year),
      runs: filtered.filter((run) => Number(localParts(run).date.slice(0, 4)) === year),
    }))
  }

  return [{ key: 'all', label: 'All runs', runs: filtered }]
}
