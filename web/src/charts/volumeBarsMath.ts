import { calendarDate, calendarMonth } from '../format'

/**
 * The pure logic behind `VolumeBars.tsx`, kept in its own module for the
 * reason `streamPanelMath.ts` and `cssVar.ts` are: a file mixing a component
 * export with plain function exports cannot be Fast-Refreshed.
 */

/**
 * The calendar period one bar covers. `/api/overview` serves both a weekly
 * and a monthly series (see docs/reference/api.md), and nothing in a
 * `VolumePeriod` says which one it came from - `period_start` is a bare
 * date either way - so the caller has to state it.
 */
export type VolumeBucket = 'week' | 'month'

/**
 * How the hover readout heads one bucket.
 *
 * Naming the period is not decoration. Headed with `calendarDate` alone, a
 * week read as a single calendar day: the third bar of the Overview's
 * 12-week chart showed "18 August 2026" above "20.00 km", "1:40:00 moving"
 * and "4 runs", which is a plausible misreading of four runs and twenty
 * kilometres as one day's training. The x-axis ticks are the same bare
 * start date and stay that way - there is no room for more on a tick, and a
 * reader looking at an axis is reading a sequence rather than one value -
 * but a tooltip is the one place they look to disambiguate what a bar
 * covers.
 *
 * Which period it is comes from the caller rather than being assumed
 * here, because `VolumeBars` draws both series and the component cannot
 * tell them apart from the data.
 *
 * The two read differently because a week has no name and a month does.
 * "Week of 18 August 2026" is the best available for a week; a month gets
 * "August 2026", since "Month of 1 August 2026" carries the bare day this
 * heading exists to get rid of and would have shipped the moment the
 * monthly series got a chart of its own.
 */
export function bucketHeading(bucket: VolumeBucket, periodStart: string): string {
  return bucket === 'week' ? `Week of ${calendarDate(periodStart)}` : calendarMonth(periodStart)
}

/**
 * Where to put the readout's horizontal centre so it stays inside the
 * panel, given the pointer's offset from the panel's own left edge.
 *
 * The readout is centred on the pointer with `translateX(-50%)`, so half of
 * it hangs to either side and an unclamped offset takes that half outside
 * `.chart` at both ends of the chart: hovering the last bar of the 12-week
 * series put `left` within a few pixels of the panel's right edge, and
 * `.chart` sets no `overflow`, so the overflow joined the document's own
 * scrollable area and could widen it sideways at a phone-width viewport.
 *
 * `readoutWidthPx` is measured from the rendered element rather than
 * assumed, because the readout's content is what decides its width - "No
 * runs" is a fraction of the three-row form. jsdom reports 0 for it, which
 * degenerates gracefully to clamping the centre into `[0, panelWidthPx]`;
 * the width-dependent half is asserted on this function directly and in
 * the browser suite.
 *
 * A readout wider than the panel cannot be contained at all, so it is
 * centred: half of it visible either side beats all of it off one edge.
 */
export function clampReadoutLeft(
  cursorLeftPx: number,
  readoutWidthPx: number,
  panelWidthPx: number,
): number {
  if (panelWidthPx <= readoutWidthPx) return panelWidthPx / 2
  const half = readoutWidthPx / 2
  return Math.min(Math.max(cursorLeftPx, half), panelWidthPx - half)
}

/**
 * The y scale and its rules for a volume series: a top that is a round
 * number in the series' own unit, and the two or three horizontal rules
 * the chart draws at it.
 *
 * **Why three rules and not uPlot's default ladder.** The reference draws
 * exactly three - zero, a midpoint and the top - and nothing else; the
 * version this replaced drew whatever uPlot's auto-splits chose, plus a
 * vertical gridline per tick, and the critic measured the verticals
 * overshooting the plot by 28 px above and 10 px below. Three rules
 * clipped to the plot is both the reference's answer and a grid that
 * cannot overshoot, because the only lines left are the ones uPlot draws
 * across the plot itself.
 *
 * **Why the top is solved for rather than taken from the data.** uPlot
 * would otherwise range the scale to the tallest bar, putting the top rule
 * at an arbitrary number like 32 187 m, and the midpoint at half of it.
 * Rounding the *half* up to a nice number and doubling it gives a top that
 * is nice and a midpoint that is nice, which is the pair the reference
 * has: 0, 20 km, 40 km over a series whose tallest week reaches three
 * quarters of the top rule.
 *
 * The mantissas are the decimal ones. That is right for metres and for run
 * counts and approximate for seconds, which are base 60 - `moving_time` is
 * a supported metric with no current call site, and a 4 000-second rule is
 * still a readable rule, just not a round clock time. Said here rather
 * than discovered later.
 *
 * A series that is entirely zero - a store whose every week is a week off -
 * has no scale to solve for, so it gets a single rule at zero above a top
 * of 1, which draws an empty plot with a baseline rather than dividing by
 * nothing.
 */
export interface VolumeScale {
  /** The top of the y scale, which is also the topmost rule. */
  max: number
  /** Every horizontal rule, ascending, always starting at 0. */
  splits: number[]
}

const NICE_MANTISSAS = [1, 2, 2.5, 3, 4, 5, 6, 8, 10]

/** The smallest `m * 10^k` at or above `value`, for `m` a nice mantissa. */
function niceCeil(value: number): number {
  const exponent = Math.floor(Math.log10(value))
  const power = 10 ** exponent
  const mantissa = value / power
  const nice = NICE_MANTISSAS.find((candidate) => mantissa <= candidate + 1e-9) ?? 10
  return nice * power
}

export function volumeScale(maxValue: number): VolumeScale {
  if (!Number.isFinite(maxValue) || maxValue <= 0) return { max: 1, splits: [0] }
  const half = niceCeil(maxValue / 2)
  const max = half * 2
  return { max, splits: [0, half, max] }
}

/**
 * Which bars get an x-axis label.
 *
 * uPlot's own splits are chosen from the scale's numeric range, which for
 * an ordinal index scale means "every n-th integer" with no idea that the
 * integers are weeks or that the first and last one sit against the edge
 * of the canvas. Two faults came out of that: the full-history chart's
 * last label was clipped at a desktop width, and the tick count moved with
 * the width rather than with the series.
 *
 * So the ticks are placed here: at most `maxTicks` of them, evenly spaced,
 * and *centred* in the series so the outermost label has as much room to
 * either side as the spacing allows. For twelve weeks at five ticks that
 * is bars 1, 4, 7 and 10 - one bar of margin at the left and two at the
 * right - and for 148 weeks it is bars 13 to 133, which is thirteen bars
 * of margin at each end.
 *
 * Returns indices into `periods`, ascending. A series shorter than
 * `maxTicks` labels every bar, which is the only case where a label can
 * still sit against the edge, and at three bars there is nothing else
 * sensible to do.
 */
export function periodTickIndices(count: number, maxTicks: number): number[] {
  if (count <= 0 || maxTicks <= 0) return []
  const stride = Math.max(1, Math.ceil(count / maxTicks))
  const span = Math.floor((count - 1) / stride) * stride
  const start = Math.floor((count - 1 - span) / 2)
  const indices: number[] = []
  for (let index = start; index <= count - 1; index += stride) indices.push(index)
  return indices
}

/**
 * The x-scale range that puts a band of `count` bars *inside* its own plot.
 *
 * uPlot ranges an index scale to the data, `[0, count - 1]`, which puts the
 * first and last bar's centres exactly on the plot's left and right bounds
 * - so both are drawn half outside it and clipped to half width. Measured
 * on the round-1 capture: twelve bars came out 28, 11, 55, 55, 55, 55, 55,
 * 55, 55, 55, 11, 12 device px, the leading 28 being half of the 55 every
 * interior bar got, with 0 px of inset at the left bound and 33 px at the
 * right.
 *
 * Half a slot at each end fixes it by construction rather than by padding:
 * over `[-0.5, count - 0.5]` a slot is exactly `plotWidth / count`, index 0
 * sits half a slot in from the left and index `count - 1` half a slot in
 * from the right, so every bar is the same width and the band is centred in
 * its frame.
 *
 * A single-period series still gets a full slot, `[-0.5, 0.5]`, rather than
 * a zero-width range uPlot would have to invent a span for.
 */
export function barScaleRange(count: number): [number, number] {
  return [-0.5, Math.max(count, 1) - 0.5]
}

/** One bar's rectangle on the canvas, in the canvas's own pixels. */
export interface BarGeometry {
  x: number
  y: number
  width: number
  height: number
  /** Top-corner radius, already clamped so it cannot exceed the box. */
  radius: number
}

export interface BarGeometryParams {
  /** The slot's centre, `u.valToPos(index, 'x', true)`. */
  centreX: number
  /** One slot, `u.bbox.width / periods.length`. */
  slotWidth: number
  /** `u.valToPos(0, 'y', true)` - where a bar of no height would sit. */
  baselineY: number
  /** `u.valToPos(value, 'y', true)`. */
  valueY: number
  /** Share of the slot the bar fills. */
  widthFactor: number
  /** Upper bound on the drawn width, so a wide plot does not draw slabs. */
  maxWidthPx: number
  /** Floor on the drawn height, so a small week is a short bar. */
  minHeightPx: number
  /** Corner radius as a share of the drawn width, before clamping. */
  radiusFactor: number
}

/**
 * Where one bar is drawn, given where its slot and its value are.
 *
 * Three things are decided here rather than left to uPlot's own bars path
 * builder, which is why this chart draws its own bars at all.
 *
 * **A minimum drawn height.** A week with runs in it but very little
 * distance - the real store has three under 400 m - lands within a pixel of
 * the baseline, and uPlot drew it as a rounded rect a pixel tall: wider
 * than it was high, with a nub on top, which reads as a scratch on the axis
 * rather than as a short bar. The floor applies only to a bar that has some
 * height to begin with: a period of exactly zero returns `null` and draws
 * nothing, because a zero week is marked as "no runs" by the empty-period
 * mark and must not be promoted into a small bar. That distinction is the
 * whole argument for drawing bars instead of an area, so it is the one
 * thing this function may not blur.
 *
 * **A radius clamped to the box.** A corner radius stated as a share of the
 * *width* is larger than a short bar is tall, and a rounded rect whose
 * radius exceeds half its height is an anvil. Clamping to half the height
 * and half the width makes the corner degrade to a semicircular cap on a
 * short bar and stay a subtle round on a tall one.
 *
 * **A width cap.** Twelve bars across a 1500 px desktop plot render as
 * slabs at uPlot's default 100 px cap, which reads as a different chart
 * from the same twelve bars on a phone.
 */
export function barGeometry(params: BarGeometryParams): BarGeometry | null {
  const { centreX, slotWidth, baselineY, valueY, widthFactor } = params
  const { maxWidthPx, minHeightPx, radiusFactor } = params

  const rawHeight = baselineY - valueY
  if (!(rawHeight > 0)) return null

  const width = Math.min(slotWidth * widthFactor, maxWidthPx)
  const height = Math.max(rawHeight, minHeightPx)
  const radius = Math.min(radiusFactor * width, width / 2, height / 2)

  return { x: centreX - width / 2, y: baselineY - height, width, height, radius }
}

/** One empty-period mark on the canvas, in the canvas's own pixels. */
export interface EmptyMarkGeometry {
  cx: number
  cy: number
  /** The radius of the *stroked path*, not of the mark. See below. */
  radius: number
  lineWidth: number
}

export interface EmptyMarkParams {
  /** The slot's centre, `u.valToPos(index, 'x', true)`. */
  centreX: number
  /** One slot, `u.bbox.width / periods.length`. */
  slotWidth: number
  /** `u.valToPos(0, 'y', true)` - the line the mark sits on. */
  baselineY: number
  /** Share of the slot a bar fills, so the mark tracks the bar's width. */
  widthFactor: number
  /** The bar width cap, for the same reason. */
  maxWidthPx: number
  /** Upper bound on the mark's outer diameter. */
  maxDiameterPx: number
  /** Lower bound on it, so a dense series still shows something. */
  minDiameterPx: number
  /** The ring's stroke, before it is clamped by the radius. */
  strokePx: number
}

/**
 * Where the mark for a period with no runs is drawn: an open ring, the
 * width of a bar, resting on the baseline.
 *
 * **Why a ring and not a small bar.** This mark has exactly one job - to
 * say "this week had no runs" - and the two previous shapes both failed it
 * in opposite directions. Drawn at bar width it read as a very small week,
 * which is the one thing it exists not to say; shrunk to a 4x3 px rect to
 * stop that, it read as dirt on the baseline ("three of the twelve chart
 * bars render as 5-6 px crimson specks drawn at a third of the bar width",
 * round-3 critic). A rectangle sitting on an axis in a bar chart is a bar,
 * whatever its size, so no size solves it.
 *
 * A circle is not a bar at any size. It is also the reference's own
 * vocabulary for this: `you-tab-weekly-stats-and-12-week-chart.jpg` marks
 * its zero week - the JUL point - with the series' own round point marker
 * sitting on the zero line, the same marker every other week gets. Ours is
 * open rather than filled because a bar chart has no point markers to be
 * consistent with, and an outline reads as "the slot is empty" where a
 * solid dot would read as a quantity too small to draw.
 *
 * **Why it is sized off the bar.** At the width of a bar it is the same
 * object class as its neighbours - one mark per slot, all the same size -
 * rather than an annotation floating at some size of its own. Clamped at
 * both ends: 12 CSS px is as large as it is allowed to get on a wide
 * desktop plot, and 3 CSS px is the floor at which it is still visible in
 * the 148-week history strip, where one slot is about 2 CSS px.
 *
 * **Why `radius` is the path's and not the mark's.** A stroke is centred
 * on its path, so a ring of outer radius R is a path at `R - lineWidth/2`.
 * Clamping `lineWidth` to R and taking the path radius from it makes the
 * ring degrade continuously to a solid dot as the plot gets denser - at
 * `lineWidth === R` the stroke covers 0 to R exactly - with no branch and
 * no second shape to reason about.
 */
export function emptyMarkGeometry(params: EmptyMarkParams): EmptyMarkGeometry | null {
  const { centreX, slotWidth, baselineY, widthFactor, maxWidthPx } = params
  const { maxDiameterPx, minDiameterPx, strokePx } = params

  const barWidth = Math.min(slotWidth * widthFactor, maxWidthPx)
  const diameter = Math.min(Math.max(barWidth, minDiameterPx), maxDiameterPx)
  if (!(diameter > 0)) return null

  const outerRadius = diameter / 2
  const lineWidth = Math.min(strokePx, outerRadius)
  return {
    cx: centreX,
    cy: baselineY - outerRadius,
    radius: outerRadius - lineWidth / 2,
    lineWidth,
  }
}

/**
 * The weekly trend's window: two months, 8.7 weeks, rounded to whole weeks.
 * Chosen by the maintainer on 2026-09-27 over one and three months; the measurement
 * behind the choice is in docs/reference/math/consistency.md, "The weekly
 * distance trend".
 */
export const TREND_WINDOW_WEEKS = 9

/**
 * The mean of each period and the `window - 1` before it, or null.
 *
 * Null until the window is full, so the line starts where it is an average
 * of `window` periods rather than of however many happen to exist, and null
 * after `lastIndex`, the last period the store knows anything about - see
 * `trendLastIndex`. A zero period is a zero, not a gap: the series is dense
 * because a week off is a fact about the training, and an average that
 * skipped it would say the athlete ran more than they did.
 */
export function trailingMean(values: readonly number[], window: number, lastIndex: number): (number | null)[] {
  return values.map((_, i) => {
    if (i < window - 1 || i > lastIndex) return null
    let sum = 0
    for (let j = i - window + 1; j <= i; j++) sum += values[j] ?? 0
    return sum / window
  })
}

/**
 * The index of the last week the trend may reach, or -1 for none.
 *
 * Two kinds of week are not known, and both would drag the line towards
 * zero at exactly the point a reader looks at to see where they are now:
 *
 * - The week in progress. Its total is a partial week's, so it always reads
 *   low until its Sunday has passed.
 * - A week after the latest activity of any sport. The store is built from
 *   an export, and a week after the export ends is a week nothing is known
 *   about rather than a week off. Measured on the real store on 2026-09-27,
 *   four weeks after the export: counted as zeros they took 40% off a
 *   9-week average, and a 4-week one to 0. Any sport rather than
 *   running, because an athlete who stops running and keeps cycling has a
 *   history that goes on, and there the line should fall.
 *
 * `periodStarts` are the weeks' Mondays and both dates are local calendar
 * dates, all as ISO strings, which compare correctly as strings. A week is
 * finished once `today` has reached the Monday after it.
 */
export function trendLastIndex(periodStarts: readonly string[], lastActivityDate: string | null, today: string): number {
  if (lastActivityDate === null) return -1
  for (let i = periodStarts.length - 1; i >= 0; i--) {
    const start = periodStarts[i]
    if (start === undefined) continue
    if (start <= lastActivityDate && addDays(start, 7) <= today) return i
  }
  return -1
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * A `Date`'s calendar date on this machine's own clock, as an ISO string.
 *
 * The machine's clock is the athlete's, for the reason the API's own
 * `_today` gives: the server and the browser both run on the athlete's
 * machine. `toISOString` would be the UTC date instead, a day out for
 * every hour the local clock is past midnight and UTC is not.
 */
export function localIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(date.getFullYear())}-${month}-${day}`
}
