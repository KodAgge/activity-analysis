import { dateOfCalendarDay, dayMonthLabel, monthYearLabel, yearLabel } from '../format'

/**
 * The pure logic behind `TrendChart.tsx`, kept in its own module for the
 * reason `streamPanelMath.ts` and `volumeBarsMath.ts` are: a file mixing a
 * component export with plain function exports cannot be Fast-Refreshed.
 */

/** One activity's value on one series. `t` is a fractional local calendar day - see `format.localCalendarTime`. */
export interface TrendPointDatum {
  t: number
  /** Null is a run that produced no value here, and it breaks the line. */
  v: number | null
  /**
   * A short annotation for the hover readout - the effort tag, in the
   * trends view - so a reader can see which points are which without the
   * chart pretending to know what the tag means.
   */
  note?: string
}

export interface TrendSeries {
  label: string
  points: TrendPointDatum[]
  /**
   * Draw dots and no line. For a raw per-activity series shown faintly
   * beneath its smoothed form, so the smoothing never hides its inputs.
   */
  scatter?: boolean
  /**
   * Draw this scatter at the quieter of the two tonal values, for a raw
   * per-run series sitting *beneath* the smoothed line it feeds rather
   * than being the chart's own subject. See `SCATTER` in `TrendChart.tsx`
   * for the two values and why one setting could not serve both cases.
   */
  faint?: boolean
  /**
   * One edge of an envelope rather than a curve to be read on its own.
   *
   * Two series marked this way are filled between and stroked at a lower
   * tone, with the series between them drawn at full strength as the
   * subject. **It is a rendering of series the payload already carries, not
   * a computed metric**: the fill's two boundaries are exactly the two
   * stored columns, and nothing is averaged, interpolated or derived.
   *
   * It is honest here because the three reference-pace series are *ordered*
   * at essentially every instant - slow at or below median at or below
   * fast, measured on the real store on 2026-10-16 at 224 of 227 smoothed
   * instants for heart rate and 227 of 227 for cadence - so they do not
   * cross and a band between the outer two contains the middle one. A set of series that
   * did cross would be misrepresented by an envelope and must not use this.
   */
  edge?: boolean
  /**
   * Mark this series' most recent observation, the way the reference marks
   * its current week: a solid dot inside a translucent halo.
   *
   * Opt-in rather than automatic, for the reason `VolumeBars` refuses the
   * same mark: a component handed an arbitrary series cannot know that its
   * last point is *current* rather than merely last. A caller that has a
   * stat above the chart naming that exact value does know, so it says so.
   */
  markLatest?: boolean
  /**
   * Which palette entry to draw in, 1 to 5. Defaults to the series'
   * position plus one, which is the palette in its fixed order. Set it
   * only to tie a series to another's hue - the raw points beneath their
   * own smoothed line - never to reorder the palette.
   */
  paletteSlot?: 1 | 2 | 3 | 4 | 5
  /**
   * A CSS custom property to stroke this series with, such as `--pace-2`.
   * Overrides `paletteSlot`. For a series that belongs to a ramp rather
   * than to the categorical palette: the three reference paces are ordinal
   * and take the sequential ramp, for the reason `tokens.css` records.
   */
  colorVar?: string
  /**
   * Read this series in the hover readout at its last value at or before
   * the hovered instant, rather than only at an instant it has a point at.
   * For a quantity that holds between updates on its own time base, such as
   * Garmin's VO2max, one value per day it changed: on any instant, the
   * watch's VO2max is its last update. A null of the series' own still reads
   * as missing, and the line itself is drawn exactly as any other.
   */
  holdsLastForReadout?: boolean
}

export interface AlignedSeries {
  /** Strictly increasing fractional day numbers, the union of every series' `t`. */
  x: number[]
  /**
   * One row per series, one entry per `x`: null where the series' own point
   * there has no value, undefined where the series has no point there at all.
   */
  ys: (number | null | undefined)[][]
  /** The note at each `x`, from the point whose value is there. */
  notes: (string | undefined)[]
}

/**
 * Puts every series onto one shared x axis, which is the only shape uPlot
 * takes. A null the payload itself carried stays a null and breaks the
 * line, which is the house rule: a run that produced no fit is a gap, not a
 * straight segment through it.
 *
 * An instant one series has and another does not is undefined in the
 * second, which uPlot draws through. Series that share their instants, one
 * point per run each, never meet that case, because every run is in every
 * series with a null where it has no value. A series on its own time base
 * does: Garmin's VO2max is one point per calendar day beside estimates that
 * are one per run, and the two almost never share an instant. Were each
 * missing instant a null, every line would break at every point of the
 * other and draw as dashes, which is what the first render of it did.
 *
 * `t` is `format.localCalendarTime`, so two runs on one day are two x
 * positions and both are kept. Only points at the identical instant share a
 * slot, because uPlot needs strictly increasing x; there the later point
 * wins the value and its note with it, so the readout never shows one run's
 * value under another run's effort tag.
 *
 * **The axis is trimmed to the first and last instant any series has a
 * value at.** A caller hands one point per activity whether or not that
 * activity produced the quantity being drawn, which is the right shape
 * because the effort filtering happens upstream of the chart. On the store
 * of 2026-09-12, 51 of the 208 runs the efficiency fit covered carried no
 * heart rate at all - the oldest 51, the history's whole first year - so
 * untrimmed the heart rate chart's x scale ranged over a year at which
 * every one of its series was null: measured on the rendered
 * canvas, **35.0% of that plot's width held no ink of any kind and its
 * first ink fell 30.1% of the way across**, under a tick naming a year the
 * chart never reaches. Every fitted run carries heart rate on the store of
 * 2026-10-16, so the trim is idle there until a run without a strap enters
 * the fit.
 *
 * The cadence chart was the control that showed this is the data and not
 * the drawing: cadence was recorded on all 208, and its plot measured 0.0%
 * blank with 31.5% of its ink inside its own first 30%.
 *
 * **Only the leading and trailing runs of all-null instants are trimmed,
 * and that distinction is load-bearing.** An all-null instant *between* two
 * observations is a run that produced no fit, and dropping it would join
 * its neighbours with a straight segment through a value nobody measured,
 * which is the same thing `spanGaps` would do and the same reason it is
 * off. So the trim cannot remove a drawn value: by construction it only
 * ever removes instants at which nothing is drawn.
 */
export function alignSeries(series: TrendSeries[]): AlignedSeries {
  const instants = new Set<number>()
  for (const s of series) for (const p of s.points) instants.add(p.t)
  const withValue = new Set<number>()
  for (const s of series) for (const p of s.points) if (p.v !== null) withValue.add(p.t)
  const all = [...instants].sort((a, b) => a - b)
  const first = all.findIndex((t) => withValue.has(t))
  const x = first === -1 ? [] : all.slice(first, all.findLastIndex((t) => withValue.has(t)) + 1)
  const index = new Map(x.map((t, i) => [t, i]))
  const notes: (string | undefined)[] = x.map(() => undefined)
  const ys = series.map((s) => {
    const y: (number | null | undefined)[] = x.map(() => undefined)
    for (const p of s.points) {
      const i = index.get(p.t)
      if (i === undefined) continue
      y[i] = p.v
      if (p.note !== undefined) notes[i] = p.note
    }
    return y
  })
  return { x, ys, notes }
}

/**
 * The value a series reads out at `index`: its own value there, or for a
 * held series its last value at or before it. The search back passes only
 * instants the series has no point at (undefined) and stops at a null of its
 * own, which is a gap rather than a hold.
 */
export function readoutValue(
  row: readonly (number | null | undefined)[],
  index: number,
  holdsLast: boolean,
): number | null {
  const own = row[index]
  if (own !== undefined || !holdsLast) return own ?? null
  for (let i = index - 1; i >= 0; i--) {
    const value = row[i]
    if (value !== undefined) return value
  }
  return null
}

/** The narrowest band the axis will show, so a flat series is a line in a panel rather than a panel-high smear or nothing. */
const MIN_RANGE_BAND = 2

/** Nice tick increments, as mantissas against a power of ten. */
const NICE_STEPS = [1, 2, 2.5, 5, 10] as const

/** How many labelled bands an axis may be cut into, unless a caller says otherwise. */
const DEFAULT_MAX_INTERVALS = 5

export interface AxisScale {
  /** The scale's own bounds. Always at or outside the data's. */
  min: number
  max: number
  /** Every tick, `min` and `max` included, evenly spaced. */
  splits: number[]
}

/**
 * The y scale and its ticks, solved together so that the labelled range and
 * the drawn range cannot come apart.
 *
 * **This is the fault it exists to fix, measured.** The previous version
 * (`paddedRange`) returned a range only - the data's band padded a tenth
 * either side - and left the ticks to uPlot's own splitting. uPlot then
 * placed nice increments *inside* that range, which is a different question
 * from covering it, and the two answers diverged badly: on the heart rate
 * chart uPlot drew four rules, and **159 device px of data sat below the
 * lowest labelled rule with no rule and no label beneath it**, while the
 * topmost rule floated 20 px above the highest mark. The data escaped its
 * own axis at one end and the axis named a value nothing reached at the
 * other.
 *
 * So the bounds are the ticks. `min` is the data's minimum floored to a
 * whole increment and `max` its maximum ceiled to one, which makes three
 * guarantees the caller can rely on:
 *
 * - every mark sits inside a labelled band, because `min <= dataMin` and
 *   `max >= dataMax` by construction;
 * - a rule is drawn at both ends of the plot, because `min` and `max` are
 *   themselves splits;
 * - no label is more than one increment away from a value the series
 *   reaches, which is as close as round numbers get. The reference accepts
 *   the same: its ladder tops at 40 km over a series peaking three quarters
 *   of the way up.
 *
 * **The outermost labels therefore name values the data does not reach, and
 * that is the trade rather than a fault.** Two reviewers have now read it as
 * one - "neither of its axis labels names a value the dots reach" - so it is
 * written down here: flooring the minimum and ceiling the maximum is exactly
 * what puts every mark inside a labelled band, and containment and
 * every-label-reached are mutually exclusive unless the data happens to land
 * on round numbers. Containment is the more important property, because a
 * mark outside its own axis is a chart lying about its data while a label
 * one increment clear of the extreme is a chart being careful. **Do not
 * "fix" this by cropping the ladder to the data.** What *is* a fault, and a
 * different one, is an increment so coarse that the outermost labels sit far
 * from the data rather than one step from it - a band of 100 to 200 over
 * data spanning under 60% of it. The answer there is more intervals, not a
 * tighter crop; see `maxIntervals`.
 *
 * **Still never zero-anchored.** Heart rate at a reference pace lives in a
 * narrow band far from zero and the finding this chart exists to show is
 * the store fit's yearly time term (`docs/reference/math/efficiency.md`),
 * under 5% of that band's level per year on the store of 2026-10-16. On a
 * zero-anchored axis that is under 5% of the panel height per year, which
 * is nothing; cropped to the data it is the whole panel. Cadence and VO2max have the same shape.
 *
 * A flat or near-flat series is widened to `MIN_RANGE_BAND` about its own
 * midpoint before anything else happens, for the reason the elevation
 * panel's floor exists: a series that does not move should look like one
 * that does not move, not like a panel-high sawtooth of rounding noise.
 */
export function axisScale(
  dataMin: number,
  dataMax: number,
  maxIntervals: number = DEFAULT_MAX_INTERVALS,
): AxisScale {
  const mid = (dataMin + dataMax) / 2
  const lo = Math.min(dataMin, mid - MIN_RANGE_BAND / 2)
  const hi = Math.max(dataMax, mid + MIN_RANGE_BAND / 2)
  const intervals = Math.max(1, Math.floor(maxIntervals))

  // Flooring and ceiling can add an interval at each end, so a first guess
  // that exactly fits the band can overflow the budget. Step up the ladder
  // until it does not, rather than returning a ladder with more rungs than
  // the panel has room to label.
  let increment = niceIncrement((hi - lo) / intervals)
  for (let guard = 0; guard < 8; guard += 1) {
    const min = Math.floor(lo / increment) * increment
    const max = Math.ceil(hi / increment) * increment
    if (Math.round((max - min) / increment) <= intervals) {
      return { min, max, splits: ladder(min, max, increment) }
    }
    increment = niceIncrement(increment * 1.5)
  }
  const min = Math.floor(lo / increment) * increment
  const max = Math.ceil(hi / increment) * increment
  return { min, max, splits: ladder(min, max, increment) }
}

/**
 * How far the scale runs past its own outermost ticks, as a fraction of the
 * tick band.
 *
 * The ticks cover the data exactly, which means the extreme mark can land
 * on the bound, and a mark on the bound is half-clipped by the canvas edge -
 * the latest-observation halo, at 9 px against a 224 px panel, worst of
 * all. 6% clears it at every height this renders at. It is the same air
 * `paddedDayRange` gives the x axis and for the same reason, and it costs
 * nothing that matters: the outermost rules simply sit a little inside the
 * plot rather than on its edges.
 */
const RANGE_OVERHANG = 0.06

/** The scale bounds for an `AxisScale`: its tick band with the overhang added. */
export function axisRange(scale: AxisScale): [number, number] {
  const overhang = (scale.max - scale.min) * RANGE_OVERHANG
  return [scale.min - overhang, scale.max + overhang]
}

/**
 * The uPlot scale range that puts an `AxisScale`'s own tick band between two
 * fractions of the plot's height, measured from the bottom.
 *
 * This is what lets one plot carry two bands at two scales. uPlot maps a
 * scale across the *whole* plot box, so the only way to confine a series to
 * part of the height is to widen its scale past its data by exactly the
 * right amount: a band that should occupy the bottom fifth gets a scale five
 * times its own span, with its data at the low end.
 *
 * The widening never reaches a label. `splits` still returns the band's own
 * ticks, so every rule drawn and every number written belongs to the band's
 * own ladder, and every mark in the band sits inside a labelled step of it -
 * the invariant `axisScale` exists for. The outer labels may name values the
 * data does not reach, because `axisScale` floors and ceils to whole
 * increments. What the inflated range buys is only *where on the canvas* the
 * band lands.
 *
 * Returns the range unchanged in span terms when `to` and `from` are one, and
 * guards the degenerate case rather than dividing by zero.
 */
export function bandRange(scale: AxisScale, from: number, to: number): [number, number] {
  const height = to - from
  if (!(height > 0)) return [scale.min, scale.max]
  const span = (scale.max - scale.min) / height
  const min = scale.min - from * span
  return [min, min + span]
}

/**
 * The lowest and highest value across the given series - every one of them
 * unless `rows` names which - or null when none has a value. A chart that
 * draws its subject and its raw inputs in two bands solves one extent per
 * band, which is the whole point of taking the rows.
 *
 * Found once rather than by each of the two callbacks that need it - the scale's bounds and the axis's ticks have to
 * be solved from the same numbers or they diverge, which is the fault
 * `axisScale` exists to fix.
 */
export function seriesExtent(aligned: AlignedSeries, rows?: readonly number[]): [number, number] | null {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  const chosen = rows === undefined ? aligned.ys : rows.map((i) => aligned.ys[i] ?? [])
  for (const row of chosen) {
    for (const value of row) {
      if (value === null || value === undefined || !Number.isFinite(value)) continue
      if (value < lo) lo = value
      if (value > hi) hi = value
    }
  }
  return Number.isFinite(lo) ? [lo, hi] : null
}

/** The smallest nice increment at or above `raw`: 1, 2, 2.5 or 5 against a power of ten. */
function niceIncrement(raw: number): number {
  if (!(raw > 0)) return 1
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  for (const step of NICE_STEPS) {
    const candidate = step * magnitude
    if (candidate >= raw - raw * 1e-9) return candidate
  }
  return 10 * magnitude
}

/**
 * The evenly spaced ticks from `min` to `max`. Built by multiplying the
 * index rather than by repeated addition, so a fractional increment like
 * 2.5 cannot accumulate floating-point drift into a label.
 */
function ladder(min: number, max: number, increment: number): number[] {
  const count = Math.round((max - min) / increment)
  const decimals = Math.max(0, -Math.floor(Math.log10(increment)) + 2)
  const round = (v: number) => Number(v.toFixed(decimals))
  return Array.from({ length: count + 1 }, (_, i) => round(min + i * increment))
}

/**
 * Fraction of the x span added at each end when the plot's width is not
 * known, which is only the first frame before uPlot has a bbox.
 */
const X_RANGE_PAD_FRACTION = 0.015

/**
 * The x range: the data's own span with enough air at each end that the
 * widest mark is drawn whole.
 *
 * The plot's left edge is the page gutter and its right edge is the
 * ladder's, both with zero uPlot padding, which is what puts every chart on
 * this screen and the Overview's on one pair of edges. The cost is that a
 * mark at the extreme of the data is centred on the plot bound and half of
 * it falls outside: measured before the fix, the earliest run rendered as a
 * half disc, and once the latest observation got a 9 px halo that
 * overflowed the plot by 4 CSS px into the ladder's gutter.
 *
 * **The clearance is a pixel measurement, so it cannot be a fraction of the
 * span.** A fraction that clears a 10 px mark on a 308 px phone plot leaves
 * ten times the needed dead space on a 920 px desktop one. Given the plot's
 * width the exact pad is arithmetic: `clearance / (width - 2 * clearance)`
 * of the span puts the extreme mark's centre exactly `clearance` pixels
 * inside the bound. Without a width - the first frame, before uPlot has
 * measured itself - it falls back to a fraction.
 *
 * A single point, or several on one instant, gets a one-day band about
 * itself rather than a zero-width scale uPlot cannot divide by.
 */
export function paddedDayRange(
  dataMin: number,
  dataMax: number,
  plotWidthPx?: number,
  clearancePx?: number,
): [number, number] {
  const span = dataMax - dataMin
  if (!(span > 0)) return [dataMin - 0.5, dataMax + 0.5]
  const usable =
    plotWidthPx === undefined || clearancePx === undefined ? 0 : plotWidthPx - 2 * clearancePx
  const fraction =
    Number.isFinite(usable) && usable > 0 && clearancePx !== undefined
      ? clearancePx / usable
      : X_RANGE_PAD_FRACTION
  const pad = span * fraction
  return [dataMin - pad, dataMax + pad]
}

/** The month strides an axis may step by, coarsest last; every one divides twelve so a ladder stays aligned to Januaries. */
const MONTH_STRIDES = [1, 2, 3, 4, 6, 12, 24, 60]
/** CSS pixels one `Mon YYYY` tick needs so its neighbours do not collide, with room to spare. */
const MIN_TICK_SPACING_PX = 72

/** Months since year zero, for stepping a calendar month at a time. */
function monthOrdinal(day: number): number {
  const date = dateOfCalendarDay(day)
  return date.getUTCFullYear() * 12 + date.getUTCMonth()
}

function dayOfMonthStart(ordinal: number): number {
  const year = Math.floor(ordinal / 12)
  const month = ordinal - year * 12
  return Math.floor(Date.UTC(year, month, 1) / 86_400_000)
}

/** Day strides for a range too short to hold a month start, finest first. */
const DAY_STRIDES = [1, 2, 7, 14]

/** The finest stride whose ladder over `span` units fits in `maxTicks`, or the coarsest if none does. */
function fittingStride(strides: readonly number[], span: number, maxTicks: number): number {
  for (const candidate of strides) {
    if (Math.ceil(span / candidate) <= maxTicks) return candidate
  }
  return strides[strides.length - 1] ?? 1
}

function isMonthStart(day: number): boolean {
  return dateOfCalendarDay(day).getUTCDate() === 1
}

/**
 * Tick positions for an axis of day numbers, whole or fractional: month
 * starts at a uniform stride, the finest from `MONTH_STRIDES` that fits the
 * width. The ticks themselves are always whole days.
 *
 * Uniform, not thinned: a ladder stepping 1, 1, 1, 2 months reads as an
 * error even though every label on it is true, which is what
 * `streamPanelMath.paceAxisSplits` records for the pace axis. The strides
 * are multiples that align on 1 January, so at twelve months and beyond
 * every tick is a year boundary and `dateTickLabels` can drop the month.
 *
 * **A range that contains no first-of-month falls back to a day stride.**
 * Month starts alone would leave such an axis with no date ticks at all,
 * and that is reachable rather than theoretical: the progression chart pads
 * a distance's history by 14 days either side, so a distance whose only
 * efforts fall mid-month - a single half marathon, of which the real store
 * holds six - spans 2 March to 30 March and holds no 1st. The chart drew
 * its time ticks against a blank date axis.
 *
 * That is the *only* condition the day ladder handles, which is why an
 * empty month ladder is retried at finer strides first. Anchoring can step
 * clean over every month start in a range that holds plenty of them: at a
 * plot under 216 px only two ticks fit, so a four-year span picks the
 * 60-month stride, whose multiples are the Januaries of years divisible by
 * five, and 2020-12-05 to 2024-12-20 contains none. Falling straight to
 * days there gave 106 whole-day ticks on a four-year axis, every one
 * labelled `D Mon` with no year. Walking down `MONTH_STRIDES` instead
 * finds 24 months, which lands on two Januaries in range, and the day
 * ladder is reached only when no month stride yields a tick at all - which
 * is exactly the range shorter than a month its own strides are sized for.
 *
 * `widthPx` is the plot's width in CSS pixels; see `StreamPanel.tsx` on
 * dividing uPlot's canvas-pixel `bbox` by the pixel ratio before it gets
 * here.
 */
export function dateAxisSplits(minDay: number, maxDay: number, widthPx: number): number[] {
  if (!(maxDay > minDay)) return []
  const maxTicks = Math.max(1, Math.floor(widthPx / MIN_TICK_SPACING_PX))
  const first = monthOrdinal(minDay)
  const last = monthOrdinal(maxDay)
  const widest = fittingStride(MONTH_STRIDES, last - first + 1, maxTicks)
  for (let i = MONTH_STRIDES.indexOf(widest); i >= 0; i -= 1) {
    const stride = MONTH_STRIDES[i]
    if (stride === undefined) continue
    const splits = monthLadder(first, last, stride, minDay, maxDay)
    if (splits.length > 0) return splits
  }
  return dayAxisSplits(minDay, maxDay, maxTicks)
}

/**
 * The month starts at `stride` months inside `[minDay, maxDay]`, anchored on
 * a multiple of the stride so a yearly one lands on Januaries and a
 * quarterly one on quarter starts. Empty when the anchoring steps over the
 * range, which is what sends `dateAxisSplits` to a finer stride.
 */
function monthLadder(first: number, last: number, stride: number, minDay: number, maxDay: number): number[] {
  const splits: number[] = []
  for (let ordinal = Math.ceil(first / stride) * stride; ordinal <= last; ordinal += stride) {
    const day = dayOfMonthStart(ordinal)
    if (day >= minDay && day <= maxDay) splits.push(day)
  }
  return splits
}

/** The day-stride ladder `dateAxisSplits` falls back to. Whole days, uniform, inside the range. */
function dayAxisSplits(minDay: number, maxDay: number, maxTicks: number): number[] {
  // `firstDay` is already at or past `minDay`, and the ladder is anchored
  // at or past `firstDay`, so no tick can fall below the range.
  const firstDay = Math.ceil(minDay)
  const lastDay = Math.floor(maxDay)
  if (lastDay < firstDay) return []
  const stride = fittingStride(DAY_STRIDES, lastDay - firstDay + 1, maxTicks)
  const splits: number[] = []
  for (let day = Math.ceil(firstDay / stride) * stride; day <= lastDay; day += stride) splits.push(day)
  return splits
}

/**
 * Labels for `dateAxisSplits`'s ticks: bare years when every tick is a
 * 1 January, `Mon YYYY` when every tick is a month start, and `D Mon` for
 * the day-stride ladder. The year stays on a month tick because a trend
 * spans years and "Oct" alone does not say which; it comes off a day tick
 * because a day ladder only ever covers one month.
 */
export function dateTickLabels(splits: number[]): string[] {
  if (splits.length === 0) return []
  if (!splits.every(isMonthStart)) return splits.map((d) => dayMonthLabel(d))
  const allJanuaries = splits.every((d) => dateOfCalendarDay(d).getUTCMonth() === 0)
  return splits.map((d) => (allJanuaries ? yearLabel(d) : monthYearLabel(d)))
}
