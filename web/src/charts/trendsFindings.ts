import type { components } from '../api/schema'
import { calendarDayOfDate, localCalendarDay, trimmedNumber } from '../format'

/**
 * The figures the Trends page's explanatory copy states about the viewer's
 * own history, computed from the `/api/trends` and `/api/fitness` payloads
 * the page already holds.
 *
 * The copy used to quote figures measured on the maintainer's own store, and
 * for any other runner those were false. Each function here answers one
 * sentence's question over the payload in hand, and returns null when the
 * data cannot support the claim - too few runs, a missing channel, no Garmin
 * series - so the view drops the sentence or falls back to a neutral one
 * rather than printing a figure the sample cannot carry.
 *
 * None of this is a metric the analysis layer owns. Each result is a summary
 * of stored columns for one sentence of prose, the kind of reading
 * `docs/reference/math/efficiency.md` assigns to the frontend ("fitting a
 * line through them and reporting a slope is the frontend's"); nothing here
 * is plotted, and no chart or headline number reads it.
 *
 * The method behind each one mirrors the document that defined the figure
 * it replaces: `efficiency.md` for the decoupling medians, the step against
 * the gap and the two linear trends, `vo2max.md` for the ratio to VDOT and
 * the pairing with Garmin's days.
 */

type TrendPoint = components['schemas']['TrendPoint']
type FitnessPoint = components['schemas']['FitnessPoint']
type DeviceVo2maxPoint = components['schemas']['DeviceVo2maxPoint']

/**
 * Fewest runs a median the copy quotes may rest on. Below ten, one run moves
 * the median by a large share of the spread, so the sentence would describe
 * a few sessions rather than the history.
 */
export const MIN_MEDIAN_RUNS = 10

/**
 * Fewest paired runs behind a ratio or a mean offset between two estimates,
 * for the reason `MIN_MEDIAN_RUNS` gives.
 */
export const MIN_RATIO_PAIRS = 10

/**
 * Fewest paired runs behind a quoted correlation. A correlation's standard
 * error is about one over the square root of the count, so at 20 it is near
 * 0.2 and the first decimal the page prints still means something; at 10 it
 * would be near 0.3.
 */
export const MIN_CORRELATION_PAIRS = 20

/**
 * Fewest runs behind a linear trend over the history. A slope and its
 * standard error from a handful of runs read as a finding about a few weeks
 * rather than about the history.
 */
export const MIN_TREND_RUNS = 20

/**
 * How many of its own standard errors a linear trend must be from zero
 * before the copy says it trends: the conventional two-sided 95% line, the
 * same bar `efficiency.md` reads its slopes against as `|t| > 2`.
 */
export const TREND_STANDARD_ERRORS = 2

/**
 * Fitted seconds a run in the decoupling population needs to count as a long
 * run of an hour or more, the second population `efficiency.md`'s
 * decoupling table measures: `fit_seconds`, the same column the 40-minute
 * population rule is defined on.
 */
export const HOUR_OR_MORE_FIT_SECONDS = 3600

/** Where a value sits against a reference, at the one decimal the page prints. */
export type Side = 'above' | 'below' | 'at'

/**
 * Compared at one decimal, with `toFixed(1)` as `format.formatDecoupling`
 * and `components/decouplingMath.ts` compare, so a value the page prints as
 * `+5.0%` reads as on a 5% line rather than over a line it visibly equals.
 */
export function sideOf(value: number, reference: number): Side {
  const shown = Number(value.toFixed(1))
  if (shown > reference) return 'above'
  if (shown < reference) return 'below'
  return 'at'
}

/** A finite number, or null: the payload's nullable columns, read without coalescing an absence to zero. */
function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The median of `values`, or null when there are none. Averages the two middle values on an even count. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const upper = sorted[mid]
  if (upper === undefined) return null
  if (sorted.length % 2 === 1) return upper
  const lower = sorted[mid - 1]
  return lower === undefined ? null : (lower + upper) / 2
}

/** The arithmetic mean, or null when there are no values. */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/**
 * The sample standard deviation, dividing by `n - 1` as pandas' `std` does,
 * which is what `vo2max.md` measured the ratio's spread with. Null below two
 * values, where it is undefined.
 */
export function sampleStandardDeviation(values: readonly number[]): number | null {
  const centre = mean(values)
  if (centre === null || values.length < 2) return null
  const squares = values.reduce((sum, value) => sum + (value - centre) ** 2, 0)
  return Math.sqrt(squares / (values.length - 1))
}

/**
 * Pearson's correlation between two paired series, or null when it is
 * undefined: fewer than two pairs, or either series constant.
 */
export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length !== ys.length) throw new Error('pearson: the two series must be paired')
  const mx = mean(xs)
  const my = mean(ys)
  if (mx === null || my === null || xs.length < 2) return null
  let sxy = 0
  let sxx = 0
  let syy = 0
  xs.forEach((x, i) => {
    const y = ys[i] ?? my
    sxy += (x - mx) * (y - my)
    sxx += (x - mx) ** 2
    syy += (y - my) ** 2
  })
  if (sxx === 0 || syy === 0) return null
  return sxy / Math.sqrt(sxx * syy)
}

/** An ordinary least squares line through paired points, with the slope's standard error. */
export interface LinearTrend {
  n: number
  slope: number
  standardError: number
  /** The slope over its standard error, signed. */
  t: number
}

/**
 * Ordinary least squares of `ys` on `xs`, with the textbook standard error
 * of the slope, `sqrt(SSR / (n - 2) / Sxx)`.
 *
 * Null when the line or its error is undefined: fewer than three points,
 * every x the same, or residuals of exactly zero, which no real history
 * produces and which would make the ratio infinite.
 */
export function linearTrend(xs: readonly number[], ys: readonly number[]): LinearTrend | null {
  if (xs.length !== ys.length) throw new Error('linearTrend: the two series must be paired')
  const n = xs.length
  const mx = mean(xs)
  const my = mean(ys)
  if (mx === null || my === null || n < 3) return null
  let sxy = 0
  let sxx = 0
  xs.forEach((x, i) => {
    sxy += (x - mx) * ((ys[i] ?? my) - my)
    sxx += (x - mx) ** 2
  })
  if (sxx === 0) return null
  const slope = sxy / sxx
  const intercept = my - slope * mx
  const ssr = xs.reduce((sum, x, i) => sum + ((ys[i] ?? my) - (intercept + slope * x)) ** 2, 0)
  const standardError = Math.sqrt(ssr / (n - 2) / sxx)
  if (!(standardError > 0)) return null
  return { n, slope, standardError, t: slope / standardError }
}

const MS_PER_DAY = 86_400_000

/** The run's UTC instant in days, the x of a trend over the history. A t statistic does not depend on x's unit. */
function dayOfInstant(startTimeUtc: string): number {
  return Date.parse(startTimeUtc) / MS_PER_DAY
}

/** Oldest first by UTC instant, because nothing in the payload's contract promises an order. */
function byStart<T extends { start_time_utc: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => Date.parse(a.start_time_utc) - Date.parse(b.start_time_utc))
}

function carriesHeartRate(point: TrendPoint): boolean {
  return (
    finite(point.hr_at_slow_bpm) !== null ||
    finite(point.hr_at_median_bpm) !== null ||
    finite(point.hr_at_fast_bpm) !== null
  )
}

/** How late the heart rate record starts against the history the fit covers. */
export interface HeartRateRecordStart {
  /** Runs the fit covers, the whole trends payload. */
  fitted: number
  /** Runs among them that carry no heart rate at all. */
  withoutHeartRate: number
  /** How many of those come before the first run that does. */
  beforeFirst: number
  /** Runs that carry cadence, the channel the chart below reads. */
  withCadence: number
}

/**
 * Why the heart rate chart starts after the history does, or null when it
 * does not: when no run lacks heart rate before the first that has it, or
 * when no run has heart rate at all, where the chart's own empty state
 * speaks instead.
 *
 * "No heart rate at all" is all three raw `hr_at_*_bpm` columns null, the
 * fit's own record that the run had no channel to fit.
 */
export function heartRateRecordStart(items: readonly TrendPoint[]): HeartRateRecordStart | null {
  const ordered = byStart(items)
  const firstWith = ordered.findIndex(carriesHeartRate)
  if (firstWith <= 0) return null
  return {
    fitted: ordered.length,
    withoutHeartRate: ordered.filter((point) => !carriesHeartRate(point)).length,
    beforeFirst: firstWith,
    withCadence: ordered.filter((point) => finite(point.cadence_at_median_spm) !== null).length,
  }
}

/** The raw per-run heart rate's step from one run to the next, against the gap between the paces. */
export interface StepAgainstGap {
  runs: number
  /** The median step at the median reference over the median fast-minus-slow gap. */
  ratio: number
}

/**
 * How much further the raw heart rate at the median reference moves from one
 * run to the next than the fast and slow references sit apart on one run,
 * the measurement `efficiency.md`'s smoothed-series table makes: a step is
 * the absolute difference between consecutive runs in start-time order over
 * the runs that carry the column, and the gap is `hr_at_fast_bpm -
 * hr_at_slow_bpm` per run.
 *
 * Null below `MIN_MEDIAN_RUNS`, on a gap that is not positive, or when the
 * step is not larger than the gap at the one decimal the page prints: the
 * sentence says the raw lines would cross, and they only do when a typical
 * step exceeds the gap.
 */
export function heartRateStepAgainstGap(items: readonly TrendPoint[]): StepAgainstGap | null {
  const values = byStart(items)
    .map((point) => finite(point.hr_at_median_bpm))
    .filter((value): value is number => value !== null)
  if (values.length < MIN_MEDIAN_RUNS) return null
  const steps = values.slice(1).map((value, i) => Math.abs(value - (values[i] ?? value)))
  const gaps = items.flatMap((point) => {
    const fast = finite(point.hr_at_fast_bpm)
    const slow = finite(point.hr_at_slow_bpm)
    return fast === null || slow === null ? [] : [fast - slow]
  })
  const step = median(steps)
  const gap = median(gaps)
  if (step === null || gap === null || !(gap > 0)) return null
  const ratio = step / gap
  return Number(trimmedNumber(ratio)) > 1 ? { runs: values.length, ratio } : null
}

/** The smoothed heart rate VO2max against the smoothed VDOT, over the runs that carry both. */
export interface EstimateAgainstVdot {
  pairs: number
  /** The median ratio less one, as a percentage: positive when the heart rate estimate sits above. */
  medianOffsetPct: number
  side: Side
  /** The ratio's sample standard deviation, in percentage points of VDOT. */
  spreadPoints: number
}

/**
 * The comparison `vo2max.md`'s "Why the level is a model output" makes: the
 * median of `hr_vo2max_smoothed / vdot_smoothed` over the rows carrying both,
 * and the standard deviation of that ratio. Null below `MIN_RATIO_PAIRS`.
 */
export function heartRateEstimateAgainstVdot(items: readonly FitnessPoint[]): EstimateAgainstVdot | null {
  const ratios = items.flatMap((point) => {
    const heartRate = finite(point.hr_vo2max_smoothed)
    const vdot = finite(point.vdot_smoothed)
    return heartRate === null || vdot === null || !(vdot > 0) ? [] : [heartRate / vdot]
  })
  if (ratios.length < MIN_RATIO_PAIRS) return null
  const middle = median(ratios)
  const spread = sampleStandardDeviation(ratios)
  if (middle === null || spread === null) return null
  const medianOffsetPct = (middle - 1) * 100
  return { pairs: ratios.length, medianOffsetPct, side: sideOf(medianOffsetPct, 0), spreadPoints: spread * 100 }
}

/** One run paired with Garmin's value for its day. */
export interface DevicePair {
  point: FitnessPoint
  garmin: number
}

/**
 * Each fitness row with Garmin's value for the run's local calendar day or
 * the latest day before it, the pairing `vo2max.md`'s "Against Garmin's own"
 * makes. A run before Garmin's first day has no pair and is left out.
 *
 * The local day uses the offset the trends payload carries for the run and
 * falls back to the UTC day where it carries none, the same join and
 * fallback the VO2max chart dates its points by.
 */
export function pairWithDevice(
  items: readonly FitnessPoint[],
  offsets: ReadonlyMap<string, number | null>,
  device: readonly DeviceVo2maxPoint[],
): DevicePair[] {
  const days = device
    .map((entry) => ({ day: calendarDayOfDate(entry.calendar_date), value: entry.vo2max }))
    .sort((a, b) => a.day - b.day)
  return items.flatMap((point) => {
    const day = localCalendarDay(point.start_time_utc, offsets.get(point.activity_id) ?? null)
    // The last Garmin day at or before the run's, by binary search.
    let lo = 0
    let hi = days.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((days[mid]?.day ?? Number.POSITIVE_INFINITY) <= day) lo = mid + 1
      else hi = mid
    }
    const match = days[lo - 1]
    return match === undefined ? [] : [{ point, garmin: match.value }]
  })
}

/** One estimate against Garmin's own over the runs that pair. */
export interface OffsetFromDevice {
  pairs: number
  /** The mean of `estimate / garmin - 1`, as a percentage. */
  meanOffsetPct: number
  side: Side
}

/** The smoothed heart rate estimate against Garmin, with the correlation between the two. */
export interface HeartRateFromDevice extends OffsetFromDevice {
  /** Null below `MIN_CORRELATION_PAIRS`, or where it is undefined. */
  correlation: number | null
}

export interface AgainstDevice {
  heartRate: HeartRateFromDevice | null
  vdot: OffsetFromDevice | null
}

function offsetFromDevice(
  pairs: readonly DevicePair[],
  estimate: (point: FitnessPoint) => number | null | undefined,
): { estimates: number[]; garmin: number[]; offset: OffsetFromDevice } | null {
  const usable = pairs.flatMap((pair) => {
    const value = finite(estimate(pair.point))
    return value === null || !(pair.garmin > 0) ? [] : [{ value, garmin: pair.garmin }]
  })
  if (usable.length < MIN_RATIO_PAIRS) return null
  const meanOffsetPct = mean(usable.map((pair) => (pair.value / pair.garmin - 1) * 100))
  if (meanOffsetPct === null) return null
  return {
    estimates: usable.map((pair) => pair.value),
    garmin: usable.map((pair) => pair.garmin),
    offset: { pairs: usable.length, meanOffsetPct, side: sideOf(meanOffsetPct, 0) },
  }
}

/**
 * The two smoothed estimates against Garmin's own, as `vo2max.md`'s "Which
 * estimate is closer" table reads them: the mean percentage offset over the
 * paired runs, and for the heart rate estimate the correlation with Garmin's
 * value. Each half is null below `MIN_RATIO_PAIRS`.
 *
 * The seasonal swing that document goes on to describe is not computed. It
 * rests on one winter of one history, and the document itself leaves its
 * cause open.
 */
export function estimatesAgainstDevice(
  items: readonly FitnessPoint[],
  offsets: ReadonlyMap<string, number | null>,
  device: readonly DeviceVo2maxPoint[],
): AgainstDevice {
  const pairs = pairWithDevice(items, offsets, device)
  const heartRate = offsetFromDevice(pairs, (point) => point.hr_vo2max_smoothed)
  const vdot = offsetFromDevice(pairs, (point) => point.vdot_smoothed)
  return {
    heartRate:
      heartRate === null
        ? null
        : {
            ...heartRate.offset,
            correlation:
              heartRate.offset.pairs < MIN_CORRELATION_PAIRS ? null : pearson(heartRate.estimates, heartRate.garmin),
          },
    vdot: vdot?.offset ?? null,
  }
}

/** A median decoupling over a set of runs, and where it sits against a line. */
export interface DecouplingMedian {
  runs: number
  medianPct: number
  side: Side
}

export interface DecouplingLevels {
  /** Every run in the population the chart plots. */
  population: DecouplingMedian
  /** Those of an hour or more of fitted running; null below `MIN_MEDIAN_RUNS`. */
  hourOrMore: DecouplingMedian | null
}

function decouplingMedian(points: readonly TrendPoint[], line: number): DecouplingMedian | null {
  const values = points
    .map((point) => finite(point.decoupling_pct))
    .filter((value): value is number => value !== null)
  if (values.length < MIN_MEDIAN_RUNS) return null
  const middle = median(values)
  return middle === null ? null : { runs: values.length, medianPct: middle, side: sideOf(middle, line) }
}

/**
 * The raw `decoupling_pct` median over the population the chart plots,
 * `is_aerobic_long_run`, and over those of `HOUR_OR_MORE_FIT_SECONDS` or
 * more, each against `line`: the two bottom rows of `efficiency.md`'s
 * decoupling table. Null when the population itself is below
 * `MIN_MEDIAN_RUNS`.
 */
export function decouplingLevels(items: readonly TrendPoint[], line: number): DecouplingLevels | null {
  const population = items.filter((point) => point.is_aerobic_long_run === true)
  const level = decouplingMedian(population, line)
  if (level === null) return null
  const long = population.filter((point) => (point.fit_seconds ?? 0) >= HOUR_OR_MORE_FIT_SECONDS)
  return { population: level, hourOrMore: decouplingMedian(long, line) }
}

/** The median decoupling of all-out and of easy sessions, across every run with a value. */
export interface DecouplingAcrossSessions {
  allOutPct: number
  easyPct: number
  /** How far apart the two medians are, in percentage points, unsigned. */
  apartPoints: number
}

/**
 * The all-out and easy rows of `efficiency.md`'s decoupling table, over every
 * run with a value whatever its length. Null when either tag has fewer than
 * `MIN_MEDIAN_RUNS`.
 */
export function decouplingAcrossSessions(items: readonly TrendPoint[]): DecouplingAcrossSessions | null {
  const medianFor = (tag: string) => {
    const values = items
      .filter((point) => point.effort_tag === tag)
      .map((point) => finite(point.decoupling_pct))
      .filter((value): value is number => value !== null)
    return values.length < MIN_MEDIAN_RUNS ? null : median(values)
  }
  const allOutPct = medianFor('all_out')
  const easyPct = medianFor('easy')
  if (allOutPct === null || easyPct === null) return null
  return { allOutPct, easyPct, apartPoints: Math.abs(allOutPct - easyPct) }
}

export type TrendDirection = 'rises' | 'falls' | 'flat' | 'constant'

/** A linear trend over the history, read against its own standard error. */
export interface TrendFinding {
  runs: number
  /** How many of its own standard errors the trend is from zero, unsigned; zero when `constant`. */
  standardErrors: number
  /**
   * `flat` under `TREND_STANDARD_ERRORS` at the one decimal the page prints
   * the ratio at. `constant` when every run carries the same value, where
   * the standard error is zero and the ratio undefined.
   */
  direction: TrendDirection
}

function trendOf(items: readonly TrendPoint[], field: (point: TrendPoint) => number | null | undefined): TrendFinding | null {
  const points = items.flatMap((point) => {
    const value = finite(field(point))
    return value === null ? [] : [{ x: dayOfInstant(point.start_time_utc), y: value }]
  })
  if (points.length < MIN_TREND_RUNS) return null
  const first = points[0]?.y
  if (points.every((p) => p.y === first)) return { runs: points.length, standardErrors: 0, direction: 'constant' }
  const fit = linearTrend(
    points.map((p) => p.x),
    points.map((p) => p.y),
  )
  if (fit === null) return null
  const standardErrors = Math.abs(fit.t)
  const direction: TrendDirection =
    Number(trimmedNumber(standardErrors)) < TREND_STANDARD_ERRORS ? 'flat' : fit.slope > 0 ? 'rises' : 'falls'
  return { runs: fit.n, standardErrors, direction }
}

/**
 * The linear trend over time in each run's raw shrunk cadence slope,
 * `cadence_slope_shrunk_spm_per_mps`, the series `efficiency.md`'s "The
 * cadence slope as its own metric" tests. Null below `MIN_TREND_RUNS`.
 *
 * `constant` when the fit found no spread between runs beyond what their
 * own errors explain: `between_activity_tau` floors at zero and every run
 * takes the shared slope exactly.
 */
export function cadenceSlopeTrend(items: readonly TrendPoint[]): TrendFinding | null {
  return trendOf(items, (point) => point.cadence_slope_shrunk_spm_per_mps)
}

/**
 * How many runs carry a finite shrunk cadence slope: the count
 * `cadenceSlopeTrend` holds against `MIN_TREND_RUNS`. Fewer than the fitted
 * runs when a watch records no cadence, since the fit still writes a row.
 */
export function runsWithCadenceSlope(items: readonly TrendPoint[]): number {
  return items.filter((point) => finite(point.cadence_slope_shrunk_spm_per_mps) !== null).length
}

/**
 * The linear trend over time in each run's raw cadence at the median
 * reference pace, `cadence_at_median_spm`, the level that document sets
 * beside the slope. The raw column rather than the smoothed one, because a
 * trailing mean's neighbours share most of their runs and its residuals are
 * nothing like independent. Null below `MIN_TREND_RUNS`.
 */
export function cadenceLevelTrend(items: readonly TrendPoint[]): TrendFinding | null {
  return trendOf(items, (point) => point.cadence_at_median_spm)
}
