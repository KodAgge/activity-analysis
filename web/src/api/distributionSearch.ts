import { deepEqual } from '@tanstack/react-router'
import { DEFAULT_VARIABLE, isVariableId, localParts } from '../charts/distributionVariables'
import type { DistributionRun, VariableId } from '../charts/distributionVariables'
import type { BarMeasure } from '../charts/histogramMath'
import { calendarDate } from '../format'

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

export type Period = 'all' | 'last_12_months' | 'previous_12_months' | 'custom' | `year_${number}`
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

const YEAR_PERIOD_RE = /^year_(\d{4})$/

function isOneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

/**
 * True for a real calendar date in `YYYY-MM-DD` form. Same construction as
 * `activitySearch.ts`'s own `isValidDateString`: the regex alone would
 * accept `2024-13-40`, and round-tripping through `Date` catches it.
 */
function isValidDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** Narrows an arbitrary value to a `Period`, or `null` for anything else. */
function isPeriod(value: unknown): value is Period {
  if (typeof value !== 'string') return false
  if (value === 'all' || value === 'last_12_months' || value === 'previous_12_months' || value === 'custom') {
    return true
  }
  return YEAR_PERIOD_RE.test(value)
}

interface PeriodFields {
  period: Period
  from?: string
  to?: string
}

/**
 * Resolves one period slot - `period`/`from`/`to`, or `vs`/`vs_from`/`vs_to` -
 * to its clean shape, falling back to `fallback` (`'all'` for the first
 * slot, `'previous_12_months'` for the second) whenever the input cannot
 * stand on its own.
 *
 * `custom` needs at least one valid date to survive at all; given both,
 * `from` must precede `to` or neither is kept. Either failure drops the
 * whole triple back to `fallback` with no dates, which is what lets the
 * caller decide whether to write anything by comparing the result against
 * that same fallback.
 */
function resolvePeriodFields(periodRaw: unknown, fromRaw: unknown, toRaw: unknown, fallback: Period): PeriodFields {
  const period = isPeriod(periodRaw) ? periodRaw : null
  if (period !== 'custom') return { period: period ?? fallback }

  const from = isValidDateString(fromRaw) ? fromRaw : undefined
  const to = isValidDateString(toRaw) ? toRaw : undefined
  if (from === undefined && to === undefined) return { period: fallback }
  if (from !== undefined && to !== undefined && !(from < to)) return { period: fallback }
  return { period: 'custom', from, to }
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

/** A bucket-space calendar date back from a `Date`, in `YYYY-MM-DD`, read with `getUTC*`. */
function toDateString(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * `dateStr` shifted by whole months and days, in UTC on the date's own
 * fields rather than on an instant - `Date.UTC` normalises an out-of-range
 * month or day itself, which is exactly what a 29 February today shifted
 * back 12 months needs: the target year has no 29 February, so it lands on
 * 1 March instead, deliberately, rather than being clamped to the 28th.
 */
function shiftDate(dateStr: string, months: number, days: number): string {
  const [year, month, day] = dateStr.split('-').map(Number) as [number, number, number]
  return toDateString(new Date(Date.UTC(year, month - 1 + months, day + days)))
}

/** A half-open range of local calendar dates, `from` inclusive and `to` exclusive. Either side is `null` for an unbounded end. */
export interface DateRange {
  from: string | null
  to: string | null
}

/**
 * The half-open local-date range a period names, against `today` (see
 * `todayLocalDate`).
 *
 * - `all` is unbounded on both ends.
 * - `last_12_months` is `[today - 12 months, today + 1 day)`, so today
 *   itself is included.
 * - `previous_12_months` is the 12 months before that.
 * - `year_YYYY` is the calendar year.
 * - `custom` is `from`/`to` verbatim, the same inclusive-from/exclusive-to
 *   convention `/api/activities` uses.
 */
export function periodRange(period: Period, from: string | undefined, to: string | undefined, today: string): DateRange {
  if (period === 'custom') return { from: from ?? null, to: to ?? null }
  if (period === 'last_12_months') {
    return { from: shiftDate(today, -12, 0), to: shiftDate(today, 0, 1) }
  }
  if (period === 'previous_12_months') {
    return { from: shiftDate(today, -24, 0), to: shiftDate(today, -12, 0) }
  }
  const yearMatch = YEAR_PERIOD_RE.exec(period)
  if (yearMatch !== null) {
    const year = Number(yearMatch[1])
    return { from: `${year}-01-01`, to: `${year + 1}-01-01` }
  }
  return { from: null, to: null }
}

/**
 * The last day a custom range includes, from the exclusive end the URL
 * holds: `2026-02-01` is through `2026-01-31`. The URL keeps `/api/activities`'
 * exclusive convention, while a reader who picks "to 31
 * January" means through the 31st, so the date input and the label both
 * show this day.
 */
export function inclusiveLastDay(to: string): string {
  return shiftDate(to, 0, -1)
}

/** The exclusive end the URL stores for a range whose last included day is `lastDay`. */
export function exclusiveEnd(lastDay: string): string {
  return shiftDate(lastDay, 0, 1)
}

/**
 * The picker's and a compared group's label for a period, given its own
 * `from`/`to` when it is `custom`. A custom range is labelled by its last
 * included day, not by the exclusive end the URL holds.
 */
export function periodLabel(period: Period, from: string | undefined, to: string | undefined): string {
  if (period === 'last_12_months') return 'Last 12 months'
  if (period === 'previous_12_months') return 'Previous 12 months'
  if (period === 'custom') {
    const last = to === undefined ? undefined : inclusiveLastDay(to)
    if (from !== undefined && last !== undefined) return `${calendarDate(from)} to ${calendarDate(last)}`
    if (from !== undefined) return `From ${calendarDate(from)}`
    if (last !== undefined) return `Through ${calendarDate(last)}`
    return 'Custom range'
  }
  const yearMatch = YEAR_PERIOD_RE.exec(period)
  if (yearMatch !== null) return yearMatch[1] as string
  return 'All time'
}

/** A custom range's two bounds as the URL holds them: `from` inclusive, `to` exclusive, either absent. */
export interface CustomBounds {
  from?: string
  to?: string
}

/**
 * The bounds after a reader edits one date input: `from` as picked, or the
 * last included day, stored as the day after it. An emptied input clears
 * its bound and a value that is not a date changes nothing. When the edit
 * would put the start on or after the end, the other bound moves to keep a
 * one-day range, because the validator drops a crossed range back to all
 * time and the picker would jump away from what the reader was editing.
 */
export function customBoundChange(current: CustomBounds, bound: 'from' | 'lastDay', value: string): CustomBounds {
  if (value !== '' && !isValidDateString(value)) return { ...current }
  if (bound === 'from') {
    if (value === '') return current.to === undefined ? {} : { to: current.to }
    const to = current.to !== undefined && current.to <= value ? exclusiveEnd(value) : current.to
    return to === undefined ? { from: value } : { from: value, to }
  }
  if (value === '') return current.from === undefined ? {} : { from: current.from }
  const to = exclusiveEnd(value)
  const from = current.from !== undefined && current.from >= to ? value : current.from
  return from === undefined ? { to } : { from, to }
}

/**
 * The bounds a newly chosen custom range starts from: the range of the
 * period it replaces, or the last 12 months when that one is unbounded.
 * Without a seed the validator would drop a bare `period=custom` back to
 * all time, and the picker would refuse the choice.
 */
function seedCustom(replaced: Period, from: string | undefined, to: string | undefined, today: string): CustomBounds {
  const range = periodRange(replaced, from, to, today)
  if (range.from !== null && range.to !== null) return { from: range.from, to: range.to }
  const fallback = periodRange('last_12_months', undefined, undefined, today)
  return { from: fallback.from ?? undefined, to: fallback.to ?? undefined }
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

function inRange(date: string, range: DateRange): boolean {
  if (range.from !== null && date < range.from) return false
  if (range.to !== null && date >= range.to) return false
  return true
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

/**
 * The viewer's own calendar date, `YYYY-MM-DD`, read with the *machine*-local
 * getters (`getFullYear`/`getMonth`/`getDate`) rather than `getUTC*`.
 *
 * This is the one deliberate exception to "always `getUTC*`" in this
 * module and in `charts/distributionVariables.ts`: everywhere else a date
 * is read off a run's own wall clock via its stored UTC offset, but "today"
 * for choosing a period has no run and no offset to shift by - it is
 * whatever calendar date the person looking at the screen is currently on,
 * which is exactly what the machine-local getters give.
 */
export function todayLocalDate(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
