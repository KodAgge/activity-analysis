import { NO_VALUE, distance, hoursFromSeconds, hoursLabel, pace, percentLabel, runCount, trimmedNumber } from '../format'
import type {
  CategoryVariable,
  DistributionRun,
  DistributionVariable,
  NumericVariable,
  VariableId,
} from './distributionVariables'
import { volumeScale, type VolumeScale } from './volumeBarsMath'

/**
 * Buckets, assignment, totals, shares, medians and positions for the
 * Distributions view's histogram, kept pure and out of `Histogram.tsx` for
 * the reason every other `*Math.ts` chart module here is: a file mixing a
 * component export with plain function exports cannot be Fast-Refreshed,
 * and this is testable directly against a synthetic run with a known
 * answer, the same discipline `CLAUDE.md` asks of the backend's
 * `analysis/` layer.
 */

/** What one bar's height counts: a run, its distance, or its moving time. Named `BarMeasure` because `../format` already exports `Measure`, a formatted value with its unit. */
export type BarMeasure = 'runs' | 'distance' | 'time'

/**
 * One bucket on a variable's axis.
 *
 * `lo`/`hi` are in bucket space (SI, except pace in s/km) and are null on
 * whichever side an open bucket has no edge: `below` has no `lo`, `above`
 * no `hi`. A category bucket carries its category's key as both, since it
 * has no span to speak of.
 */
export interface Bucket {
  key: string
  lo: number | null
  hi: number | null
  label: string
}

/** Bucket totals for one `BarMeasure`, and how many served runs did and did not have a value to place in one. */
export interface Tally {
  totals: number[]
  counted: number
  missing: number
}

// Bucket-placement decisions are made on this many rounded thousandths of a
// bucket-space unit, not on the raw floats. A boundary built by repeated
// addition - the fifth of sixteen 2.5-wide decoupling buckets, say - can
// carry noise like 7.5000000000000009, and comparing that directly against
// a value of exactly 7.5 puts it one bucket short. Rounding both sides to
// the same number of thousandths before comparing removes the noise
// without touching the precision any variable here actually needs (pace,
// the finest, is whole seconds).
const MILLI = 1000

function toMilli(value: number): number {
  return Math.round(value * MILLI)
}

/** A bucket-space number back from its milli-scaled integer, for building `lo`/`hi`. */
function fromMilli(milli: number): number {
  return milli / MILLI
}

function isNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value)
}

function categoryBuckets(variable: CategoryVariable): Bucket[] {
  return variable.categories.map((category) => ({
    key: String(category.key),
    lo: category.key,
    hi: category.key,
    label: category.label,
  }))
}

/**
 * Regular and open buckets covering `values`: a regular ladder from
 * the floored minimum (or the open-below edge, if any value is under it)
 * up to the bucket containing the maximum (or the open-at-or-above edge,
 * if any value reaches it), each `width` wide.
 */
function numericBuckets(variable: NumericVariable, values: readonly number[]): Bucket[] {
  if (values.length === 0) return []

  const widthMilli = toMilli(variable.width)
  const valuesMilli = values.map(toMilli)
  const minMilli = Math.min(...valuesMilli)
  const maxMilli = Math.max(...valuesMilli)
  const openBelowMilli = variable.openBelow === undefined ? null : toMilli(variable.openBelow)
  const openAtOrAboveMilli = variable.openAtOrAbove === undefined ? null : toMilli(variable.openAtOrAbove)

  const hasBelow = openBelowMilli !== null && minMilli < openBelowMilli
  const hasAbove = openAtOrAboveMilli !== null && maxMilli >= openAtOrAboveMilli

  const startMilli = hasBelow && openBelowMilli !== null ? openBelowMilli : Math.floor(minMilli / widthMilli) * widthMilli
  const regularEndMilli =
    hasAbove && openAtOrAboveMilli !== null
      ? openAtOrAboveMilli
      : startMilli + Math.floor((maxMilli - startMilli) / widthMilli) * widthMilli + widthMilli

  const buckets: Bucket[] = []

  if (hasBelow && variable.openBelow !== undefined) {
    const hi = variable.openBelow
    buckets.push({ key: 'below', lo: null, hi, label: `< ${variable.edgeLabel(hi)}` })
  }

  const regularCount = Math.max(0, Math.round((regularEndMilli - startMilli) / widthMilli))
  for (let i = 0; i < regularCount; i++) {
    const loMilli = startMilli + i * widthMilli
    const lo = fromMilli(loMilli)
    const hi = fromMilli(loMilli + widthMilli)
    buckets.push({ key: String(lo), lo, hi, label: `${variable.edgeLabel(lo)} to ${variable.edgeLabel(hi)}` })
  }

  if (hasAbove && variable.openAtOrAbove !== undefined) {
    const lo = variable.openAtOrAbove
    buckets.push({ key: 'above', lo, hi: null, label: `≥ ${variable.edgeLabel(lo)}` })
  }

  return buckets
}

/**
 * The buckets for `variable`, built from every value in `runs`.
 *
 * Always pass every served run, never a filtered or compared subset:
 * filtering and comparing never move the axis, so a period filter or a
 * comparison group narrows which runs are tallied into these buckets, not
 * which values decided where the buckets sit. Two compared groups this way
 * always share one set of buckets, and a filtered chart's bars stay
 * comparable to the unfiltered one a reader just came from.
 */
export function bucketsFor(variable: DistributionVariable, runs: readonly DistributionRun[]): Bucket[] {
  if (variable.kind === 'category') return categoryBuckets(variable)
  const values = runs.map((run) => variable.value(run)).filter(isNumber)
  return numericBuckets(variable, values)
}

/** The index into `buckets` that `value` (in bucket space) falls into, or -1 if none does. */
export function bucketIndex(variable: DistributionVariable, buckets: readonly Bucket[], value: number): number {
  if (buckets.length === 0) return -1

  if (variable.kind === 'category') {
    return buckets.findIndex((bucket) => bucket.lo === value)
  }

  const valueMilli = toMilli(value)

  const first = buckets[0]
  if (first !== undefined && first.key === 'below' && first.hi !== null && valueMilli < toMilli(first.hi)) {
    return 0
  }

  const last = buckets[buckets.length - 1]
  if (last !== undefined && last.key === 'above' && last.lo !== null && valueMilli >= toMilli(last.lo)) {
    return buckets.length - 1
  }

  return buckets.findIndex(
    (bucket) => bucket.lo !== null && bucket.hi !== null && valueMilli >= toMilli(bucket.lo) && valueMilli < toMilli(bucket.hi),
  )
}

/** Bucket totals under `measure`, and how many of `runs` did (`counted`) and did not (`missing`) have a value to place. */
export function tally(
  variable: DistributionVariable,
  buckets: readonly Bucket[],
  runs: readonly DistributionRun[],
  measure: BarMeasure,
): Tally {
  const totals = new Array<number>(buckets.length).fill(0)
  let counted = 0
  let missing = 0

  for (const run of runs) {
    const value = variable.value(run)
    if (value === null) {
      missing += 1
      continue
    }
    const idx = bucketIndex(variable, buckets, value)
    if (idx === -1) {
      missing += 1
      continue
    }
    counted += 1
    const current = totals[idx] ?? 0
    totals[idx] = current + weightFor(run, measure)
  }

  return { totals, counted, missing }
}

function weightFor(run: DistributionRun, measure: BarMeasure): number {
  if (measure === 'runs') return 1
  if (measure === 'distance') return run.distance_m ?? 0
  return run.moving_time_s ?? 0
}

/** Each total as a percentage of the sum, or all zero (never `NaN`) when the sum is zero - an empty compared group, say. */
export function shares(totals: readonly number[]): number[] {
  const sum = totals.reduce((a, b) => a + b, 0)
  if (sum === 0) return totals.map(() => 0)
  return totals.map((total) => (total / sum) * 100)
}

/** The median of `values`, or null when there are none. Averages the two middle values on an even count. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] ?? null
  const lower = sorted[mid - 1]
  const upper = sorted[mid]
  if (lower === undefined || upper === undefined) return null
  return (lower + upper) / 2
}

/** The median of `variable`'s value over `runs`, skipping runs with none. */
export function medianOf(variable: DistributionVariable, runs: readonly DistributionRun[]): number | null {
  const values = runs.map((run) => variable.value(run)).filter(isNumber)
  return median(values)
}

/**
 * Where `value` sits along the whole axis, as a fraction of a bucket width:
 * `0` is the left edge of the first bucket, `buckets.length` the right edge
 * of the last. A regular bucket places it proportionally inside its span;
 * an open bucket (`below` or `above`, which has no span) places it at the
 * bucket's own centre, `index + 0.5`.
 *
 * A category places it continuously too, rather than only at an exact
 * category's own centre, because this function's main caller is a median
 * tick and `medianOf` averages the two middle values on an even count: a
 * median start hour of 12.5 or a median weekday of 3.5 is an ordinary
 * answer, not an edge case, and finding no exact bucket for it must not
 * make the tick disappear for roughly half of every group. Every category
 * variable's keys are consecutive integers (hours 0..23, weekdays 1..7,
 * days-since-previous-run 0..7, months 1..12), so the position is linear
 * in the value the same way a numeric bucket's is linear in bucket space,
 * anchored on the first category's own key and clamped to the axis so a
 * value outside the categories' range still lands on it rather than past
 * either end.
 *
 * Returns -1 when `buckets` is empty, or when a numeric `value` falls in
 * no bucket at all (below every regular bucket with no open-below edge,
 * say).
 */
export function positionOf(variable: DistributionVariable, buckets: readonly Bucket[], value: number): number {
  if (variable.kind === 'category') return categoryPosition(buckets, value)

  const idx = bucketIndex(variable, buckets, value)
  if (idx === -1) return -1
  const bucket = buckets[idx]
  if (bucket === undefined) return -1
  if (bucket.lo === null || bucket.hi === null) return idx + 0.5
  const span = bucket.hi - bucket.lo
  if (span <= 0) return idx + 0.5
  return idx + (value - bucket.lo) / span
}

function categoryPosition(buckets: readonly Bucket[], value: number): number {
  if (buckets.length === 0) return -1
  const first = buckets[0]
  if (first === undefined || first.lo === null) return -1
  const position = value - first.lo + 0.5
  return Math.max(0, Math.min(buckets.length, position))
}

/** Every run in `runs` whose value falls in the bucket named `key`, or `[]` when no bucket has that key. */
export function runsInBucket(
  variable: DistributionVariable,
  buckets: readonly Bucket[],
  key: string,
  runs: readonly DistributionRun[],
): DistributionRun[] {
  const idx = buckets.findIndex((bucket) => bucket.key === key)
  if (idx === -1) return []
  return runs.filter((run) => {
    const value = variable.value(run)
    return value !== null && bucketIndex(variable, buckets, value) === idx
  })
}

/**
 * The bars one group draws: each group's share of itself when comparing,
 * so groups of different sizes compare by shape, and
 * the absolute total otherwise, with time in hours so the y scale can pick
 * round hours.
 */
export function barValues(totals: readonly number[], measure: BarMeasure, comparing: boolean): number[] {
  if (comparing) return shares(totals)
  if (measure === 'time') return totals.map(hoursFromSeconds)
  return [...totals]
}

// One function per choice, at module level, so a caller handing one to
// `Histogram` hands the same identity on every render: the formatter is
// part of the chart's options, and a new one rebuilds the chart.
const FORMAT_COUNT = (value: number): string => trimmedNumber(value)
const FORMAT_KM = (metres: number): string => distance(metres, Number.isInteger(metres / 1000) ? 0 : 1)
const FORMAT_HOURS = (hours: number): string => hoursLabel(hours)
const FORMAT_SHARE = (percent: number): string => percentLabel(percent)

/** How a bar value from `barValues` reads, on the axis and in the readout. */
export function barFormatter(measure: BarMeasure, comparing: boolean): (value: number) => string {
  if (comparing) return FORMAT_SHARE
  if (measure === 'distance') return FORMAT_KM
  if (measure === 'time') return FORMAT_HOURS
  return FORMAT_COUNT
}

/** What one group contributes to a chart: its tally, its bars, its median and where the median's tick sits. */
export interface GroupSeries {
  tally: Tally
  values: number[]
  median: number | null
  /** Fractional bucket position for the median tick, or null when there is none to draw. */
  medianAt: number | null
}

/** One group's `GroupSeries` over `buckets`, which must come from every served run (see `bucketsFor`). */
export function groupSeries(
  variable: DistributionVariable,
  buckets: readonly Bucket[],
  runs: readonly DistributionRun[],
  measure: BarMeasure,
  comparing: boolean,
): GroupSeries {
  const counts = tally(variable, buckets, runs, measure)
  const groupMedian = medianOf(variable, runs)
  const position = groupMedian === null ? -1 : positionOf(variable, buckets, groupMedian)
  return {
    tally: counts,
    values: barValues(counts.totals, measure, comparing),
    median: groupMedian,
    medianAt: position === -1 ? null : position,
  }
}

/** `runsInBucket`, newest first: the order the bucket list reads in. */
export function bucketRuns(
  variable: DistributionVariable,
  buckets: readonly Bucket[],
  key: string,
  runs: readonly DistributionRun[],
): DistributionRun[] {
  return runsInBucket(variable, buckets, key, runs).sort(
    (a, b) => Date.parse(b.start_time_utc) - Date.parse(a.start_time_utc),
  )
}

/**
 * A bucket list's heading: the group, then the bucket as a reader names it.
 * A category bucket reads through the variable's own formatter, `17:00` or
 * `7+ days`, since its axis label alone is a bare `17` or `7+`; a numeric
 * one is its range and the caption's unit, `6 to 7 km`.
 */
export function bucketListTitle(variable: DistributionVariable, bucket: Bucket, groupLabel: string): string {
  if (variable.kind === 'category' && bucket.lo !== null) return `${groupLabel}, ${variable.formatValue(bucket.lo)}`
  return variable.unit === '' ? `${groupLabel}, ${bucket.label}` : `${groupLabel}, ${bucket.label} ${variable.unit}`
}

/**
 * Variables the row's own label, the run's local start as `Tue 22 Sep 2026
 * 18:00`, already names: the hour, the weekday and the month.
 */
const NAMED_BY_START: ReadonlySet<VariableId> = new Set(['start_hour', 'weekday', 'month'])

/** A bucket list row's value and meta, apart from its label. */
export interface BucketRowParts {
  value: string
  meta: string[]
}

/**
 * What a bucket list row shows beside the run's local start: the
 * variable's value, then distance and pace as meta. Nothing on the row says
 * one thing twice: a variable the start already names shows the run's
 * distance as its value instead, and distance or pace, as the value, leaves
 * the meta.
 */
export function bucketRowParts(variable: DistributionVariable, run: DistributionRun): BucketRowParts {
  const km = distance(run.distance_m)
  const perKm = pace(run.avg_speed_mps)
  if (variable.id === 'distance' || NAMED_BY_START.has(variable.id)) return { value: km, meta: [perKm] }
  if (variable.id === 'pace') return { value: perKm, meta: [km] }
  const value = variable.value(run)
  return { value: value === null ? NO_VALUE : variable.formatValue(value), meta: [km, perKm] }
}

/**
 * The y scale and its three rules, `volumeScale`'s, with the midpoint
 * rounded up to a whole number when `wholeNumbers`: bars counting runs
 * would otherwise put a rule at 2.5 or 0.5 runs. Only a midpoint under 10
 * can be fractional, the mantissa 2.5 or a power of ten below one, and its
 * ceiling is then a nice number in its own right.
 */
export function histogramScale(maxValue: number, wholeNumbers: boolean): VolumeScale {
  const scale = volumeScale(maxValue)
  const half = scale.splits[1]
  if (!wholeNumbers || half === undefined || Number.isInteger(half)) return scale
  const whole = Math.ceil(half)
  return { max: whole * 2, splits: [0, whole, whole * 2] }
}

/**
 * One group's part of a caption: `Weekends: 7 of 10 runs, 3 left out,
 * median run 150 bpm`. The count is never a percentage and never dropped,
 * even at nothing missing; `label` is null for the one
 * group a chart that compares nothing has, whose name would only repeat the
 * period picker. The median is of the variable over the group's runs,
 * unweighted by the bar measure, which is why it is the median run's.
 */
export function groupCaption(label: string | null, counts: Tally, medianText: string | null): string {
  const parts = [`${String(counts.counted)} of ${runCount(counts.counted + counts.missing)}`]
  if (counts.missing > 0) parts.push(`${String(counts.missing)} left out`)
  if (medianText !== null) parts.push(`median run ${medianText}`)
  const text = parts.join(', ')
  return label === null ? text : `${label}: ${text}`
}

const MEASURE_NOUN: Record<BarMeasure, string> = { runs: 'runs', distance: 'kilometres', time: 'hours' }

/** What a bar counts, as a plural noun: `runs`, `kilometres`, `hours`. */
export function measureNoun(measure: BarMeasure): string {
  return MEASURE_NOUN[measure]
}

/**
 * The caption's opening: the variable, its unit, the variable's own note,
 * and under a comparison what each group's bars are a share of.
 */
export function variableCaption(
  variable: DistributionVariable,
  referenceMps: number | null,
  measure: BarMeasure,
  comparing: boolean,
): string {
  const name = variable.unit === '' ? variable.label(referenceMps) : `${variable.label(referenceMps)}, ${variable.unit}`
  const sentences = [`${name}.`]
  if (variable.note !== undefined) sentences.push(variable.note)
  if (comparing) sentences.push(`Each bar is a share of its own group's ${measureNoun(measure)}.`)
  return sentences.join(' ')
}

// ---------------------------------------------------------------------------
// Chart geometry for `Histogram.tsx`. The x scale puts bucket i's centre at
// i and its edges at i - 0.5 and i + 0.5, over `barScaleRange` from
// `volumeBarsMath.ts`, so a fractional bucket position p (0 is the left
// edge of the first bucket) is the scale value p - 0.5.
// ---------------------------------------------------------------------------

/**
 * The width of the widest of `labels`, estimated at `charPx` per character.
 *
 * An estimate rather than a measurement because the only canvas that could
 * measure it is uPlot's own, whose font state uPlot caches and would not
 * know had changed. A per-character width taken slightly wide for the axis
 * font errs toward thinning one label more than strictly needed, which is
 * the safe direction: two labels touching is the fault being prevented.
 */
export function estimateLabelWidthPx(labels: readonly string[], charPx: number): number {
  let widest = 0
  for (const label of labels) widest = Math.max(widest, [...label].length)
  return widest * charPx
}

export interface XLabelParams {
  count: number
  /** The plot's width in CSS pixels. */
  plotWidthPx: number
  /** The widest label's width in CSS pixels; see `estimateLabelWidthPx`. */
  labelWidthPx: number
  /** The least air between two neighbouring labels. */
  gapPx: number
  /**
   * How far past the plot's right edge a label may reach: the y-axis
   * column on that side. The left edge has none, because the plot starts
   * at the canvas edge, where a label would be sliced.
   */
  rightRoomPx: number
}

/**
 * Which buckets get an x-axis label: every n-th, n the fewest slots a label
 * and its gap need, restricted to the buckets whose centred label stays on
 * the canvas, and centred within those the way `periodTickIndices` centres
 * its ladder so the spare slots split evenly between the two ends.
 *
 * Indices, ascending. Empty for no buckets or an unmeasured plot, and empty
 * too if not one label fits, which no bucket count here reaches at a phone
 * width.
 */
export function xLabelIndices(params: XLabelParams): number[] {
  const { count, plotWidthPx, labelWidthPx, gapPx, rightRoomPx } = params
  if (count <= 0 || !(plotWidthPx > 0)) return []

  const slot = plotWidthPx / count
  const stride = Math.max(1, Math.ceil((labelWidthPx + gapPx) / slot - 1e-9))
  const half = labelWidthPx / 2
  // Centre (i + 0.5) * slot must sit at least `half` from the left edge and
  // `half` inside the right edge plus its room; both bounds are linear in
  // i, so the buckets that fit are one contiguous run.
  const first = Math.max(0, Math.ceil(half / slot - 0.5 - 1e-9))
  const last = Math.min(count - 1, Math.floor((plotWidthPx + rightRoomPx - half) / slot - 0.5 + 1e-9))
  if (first > last) return []

  const span = Math.floor((last - first) / stride) * stride
  const start = first + Math.floor((last - first - span) / 2)
  const indices: number[] = []
  for (let index = start; index <= last; index += stride) indices.push(index)
  return indices
}

/** One point of an outline, as `[x scale value, y value]`. */
export type OutlinePoint = [number, number]

/**
 * The second group's stepped outline, as polylines in scale space: up from
 * the baseline at a bucket's left edge, across it at its value, and back
 * down at the end of each run of non-empty buckets.
 *
 * The pen lifts across an empty bucket rather than stroking along the
 * baseline, where the zero rule already is: an accent line lying on the
 * axis reads as a mark on it rather than as the group having nothing
 * there. An empty group, all zeros, is therefore no outline at all.
 */
export function outlineSegments(values: readonly number[]): OutlinePoint[][] {
  const segments: OutlinePoint[][] = []
  let current: OutlinePoint[] | null = null

  for (let i = 0; i < values.length; i++) {
    const value = values[i] ?? 0
    const left = i - 0.5
    if (!(value > 0)) {
      if (current !== null) {
        current.push([left, 0])
        segments.push(current)
        current = null
      }
      continue
    }
    current ??= [[left, 0]]
    current.push([left, value], [i + 0.5, value])
  }

  if (current !== null) {
    current.push([values.length - 0.5, 0])
    segments.push(current)
  }
  return segments
}

/**
 * A median tick's x on the scale, from its fractional bucket position, or
 * null when there is no tick to draw: no median, or a position
 * `positionOf` could not place (it returns -1 then) or one off the axis.
 */
export function medianScaleX(medianAt: number | null, count: number): number | null {
  if (medianAt === null || !Number.isFinite(medianAt) || count <= 0) return null
  if (medianAt < 0 || medianAt > count) return null
  return medianAt - 0.5
}

/**
 * The bucket an arrow key moves the keyboard cursor to: one along, held at
 * either end. With no cursor yet it enters from the end the key points
 * away from, so right starts at the first bucket and left at the last.
 */
export function stepBucket(current: number | null, delta: 1 | -1, count: number): number | null {
  if (count <= 0) return null
  if (current === null) return delta > 0 ? 0 : count - 1
  return Math.min(count - 1, Math.max(0, current + delta))
}

/** The centre of bucket `index`'s slot, in the same CSS pixels as `plotLeftPx` and `plotWidthPx`. */
export function slotCentrePx(index: number, count: number, plotLeftPx: number, plotWidthPx: number): number {
  if (count <= 0) return plotLeftPx
  return plotLeftPx + ((index + 0.5) * plotWidthPx) / count
}
