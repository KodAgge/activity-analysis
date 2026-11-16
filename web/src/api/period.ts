/**
 * Calendar periods a view can be scoped to - all time, the last or
 * previous 12 months, one calendar year, or a custom range - and the
 * arithmetic behind them: the half-open local-date range a period names,
 * its label, and the custom range's two date inputs.
 *
 * Shared by `/distributions` (`distributionSearch.ts`) and `/trends`
 * (`trendsSearch.ts`), so "Last 12 months" means the same days on both
 * pages. Each view owns its own URL keys and its own default period.
 */
import { calendarDate } from '../format'

export type Period = 'all' | 'last_12_months' | 'previous_12_months' | 'custom' | `year_${number}`

export const YEAR_PERIOD_RE = /^year_(\d{4})$/

/**
 * True for a real calendar date in `YYYY-MM-DD` form. Same construction as
 * `activitySearch.ts`'s own `isValidDateString`: the regex alone would
 * accept `2024-13-40`, and round-tripping through `Date` catches it.
 */
export function isValidDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** Narrows an arbitrary value to a `Period`, or `null` for anything else. */
export function isPeriod(value: unknown): value is Period {
  if (typeof value !== 'string') return false
  if (value === 'all' || value === 'last_12_months' || value === 'previous_12_months' || value === 'custom') {
    return true
  }
  return YEAR_PERIOD_RE.test(value)
}

export interface PeriodFields {
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
export function resolvePeriodFields(periodRaw: unknown, fromRaw: unknown, toRaw: unknown, fallback: Period): PeriodFields {
  const period = isPeriod(periodRaw) ? periodRaw : null
  if (period !== 'custom') return { period: period ?? fallback }

  const from = isValidDateString(fromRaw) ? fromRaw : undefined
  const to = isValidDateString(toRaw) ? toRaw : undefined
  if (from === undefined && to === undefined) return { period: fallback }
  if (from !== undefined && to !== undefined && !(from < to)) return { period: fallback }
  return { period: 'custom', from, to }
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
export function seedCustom(replaced: Period, from: string | undefined, to: string | undefined, today: string): CustomBounds {
  const range = periodRange(replaced, from, to, today)
  if (range.from !== null && range.to !== null) return { from: range.from, to: range.to }
  const fallback = periodRange('last_12_months', undefined, undefined, today)
  return { from: fallback.from ?? undefined, to: fallback.to ?? undefined }
}


export function inRange(date: string, range: DateRange): boolean {
  if (range.from !== null && date < range.from) return false
  if (range.to !== null && date >= range.to) return false
  return true
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
