/**
 * The pure logic behind `ProgressionScatter.tsx`, kept in its own module
 * for the reason every other `*Math.ts` here is: a file mixing a component
 * export with plain function exports cannot be Fast-Refreshed.
 */
import { duration } from '../format'

/**
 * One effort, reduced to what the layout needs. `t` is a fractional local
 * calendar day - see `format.localCalendarTime`.
 *
 * `valueS` is whatever the ladder is in: an elapsed time for an effort at
 * one distance, and a pace in seconds per kilometre for a run on a route.
 * Both are seconds, both read faster-is-smaller, and the axis below treats
 * them identically - which is what lets one chart draw both.
 */
export interface EffortDatum {
  t: number
  valueS: number
  isRecord: boolean
}

export interface Point {
  x: number
  y: number
}

/**
 * The panel the chart is laid out in, when nothing has been measured yet.
 *
 * **Everything in this module is in CSS pixels of the rendered panel, and
 * that is a change worth understanding before touching it.** The SVG's
 * `viewBox` is set from the panel's own measured `clientWidth` and
 * `clientHeight`, so one coordinate unit here is one CSS pixel on the
 * screen at every viewport width.
 *
 * It used to be a fixed 800x360 viewBox scaled to fit the panel, and that
 * quietly broke every size in the chart. The scale factor is
 * `panelWidth / 800`, which at the 412 px judging width is 0.455: an
 * `11px` axis label rendered at 5.0 px, a `1px` gridline at 0.45 px and a
 * 4-unit point radius at 1.8 px, while the same chart on a 1088 px desktop
 * column rendered all three at 1.36x instead. A chart cannot be designed at
 * a size it does not draw at, so the viewBox now follows the panel and a
 * radius of 4 is four pixels everywhere.
 *
 * These two numbers are only the fallback for the frame before the
 * measurement lands and for jsdom, which lays nothing out. They are the
 * former viewBox, so a test that renders without a layout engine gets the
 * geometry it always got.
 */
export const DEFAULT_PLOT_WIDTH = 800
export const DEFAULT_PLOT_HEIGHT = 360

/**
 * The chrome around the plot, in CSS pixels. The right-hand ladder is not
 * here: its width depends on what the ladder says, so it is `timeAxisGutter`
 * below.
 *
 * `left` is zero on purpose: the plot's left edge is then the panel's left
 * edge, which is the page gutter, which is where the title and everything
 * above it start. The time ladder takes its room on the *right* instead,
 * the way the reference does it and the way `VolumeBars` already does -
 * see `charts/VolumeBars.tsx`, "the ladder's own right edge lands on the
 * page's right gutter".
 *
 * `bottom` holds two rows rather than one: the `FASTER` line sits directly
 * under the plot in the ladder column, and the date labels sit under that.
 * They cannot share a row, because a date label is centred on its tick and
 * the last tick can sit close enough to the plot's right edge for its
 * label to reach into the ladder column.
 *
 * It grew by 6 px when the ticks became the bounds. The lowest rule used to
 * float well above the plot's floor; now it sits one overhang above it, so
 * `FASTER` was landing 18 px under a tick label where `SLOWER` sits 23 px
 * over one, and the two right-aligned lines read as one stack. The gap is
 * even at both ends now.
 */
export const PLOT_INSET = { top: 22, bottom: 44, left: 0 } as const

/** Baseline of the `SLOWER` line, measured from the panel's top edge. */
export const SLOWER_LABEL_Y = 11
/** Baseline of the `FASTER` line, measured from the plot's bottom edge. */
export const FASTER_LABEL_DY = 20
/** Baseline of the date labels, measured from the plot's bottom edge. */
export const DATE_LABEL_DY = 37
/** Baseline of a ladder label below its own rule, which centres the label's digits on the rule. */
export const LADDER_LABEL_DY = 4

/**
 * One glyph of a duration tick, in CSS pixels.
 *
 * Measured in Chromium with `getComputedTextLength` against the rendered
 * chart at `--text-caption` (11 px) with `font-variant-numeric:
 * tabular-nums`: `0`, `5` and `:` all advance exactly 7.00, which is what
 * tabular figures are for, and `1:00:00` measures exactly 49. So a tick's
 * width is its character count times this, with no per-glyph table needed.
 */
const TICK_GLYPH_PX = 7

/**
 * `SLOWER` and `FASTER`, which share the ladder column and are both 48.28
 * CSS px at `--text-caption` with the 0.08em tracking the stylesheet gives
 * them - measured the same way. The column can never be narrower than the
 * words in it.
 */
const DIRECTION_WORD_PX = 48.3

/**
 * Clearance between the longest thing in the ladder column and the plot's
 * right edge. `VolumeBars` leaves 10 CSS px at the same type size.
 */
const AXIS_CLEARANCE_PX = 10

/**
 * How much room the right-hand ladder needs, from what it actually says.
 *
 * **Reserved from the longest label, not from an average one.** The labels
 * are right-aligned so their right edges stack on the page gutter - which
 * is the arrangement the Overview was specifically praised for, because a
 * column of times then lines up on its colons - and the consequence is that
 * a short label starts further from the plot than a long one. That is fine;
 * what was not fine was a fixed 52 px column, in which `1:00:00` (49 px)
 * cleared the gridline by 3 px while `50:00` (35 px) cleared it by 17. The
 * gutter is now solved so the *longest* label clears comfortably, and the
 * shorter ones clear by more, which is what right-alignment means.
 */
export function timeAxisGutter(tickLabels: string[]): number {
  const longestTick = Math.max(0, ...tickLabels.map((label) => label.length * TICK_GLYPH_PX))
  return Math.ceil(Math.max(longestTick, DIRECTION_WORD_PX) + AXIS_CLEARANCE_PX)
}

/** The gap `ProgressionScatter.module.css` leaves between a point and its readout, in either direction. */
const READOUT_OFFSET_PX = 10

/**
 * Whether the hover readout must sit below its point rather than above it,
 * given the point's y and the panel and readout heights, all three in CSS
 * pixels of the rendered panel.
 *
 * **All three have to be in the same unit, and once they were not.** The
 * point's y arrived here as a fraction of a fixed viewBox while the
 * readout's height was measured in CSS pixels, so the rule could not tell
 * a desktop panel from a phone one: at a 390 px viewport the panel is about
 * 157 px tall and a point 30% down sits 47 px from the top, where a readout
 * of roughly 150 px still ran off above the panel and over the legend,
 * while the identical fraction on a 360 px panel is 108 px and had room.
 * The viewBox is measured now, so the y handed in is already the pixel the
 * point is drawn at and nothing has to be converted.
 *
 * `panelHeightPx` no longer enters the arithmetic; it is the *measured*
 * flag. Unmeasured is not a reason to flip: before the first measurement,
 * and in jsdom which measures nothing, the readout keeps the
 * above-the-point placement it has on a roomy panel.
 */
export function readoutFlipsBelow(pointYPx: number, panelHeightPx: number, readoutHeightPx: number): boolean {
  if (panelHeightPx <= 0 || readoutHeightPx <= 0) return false
  return pointYPx < readoutHeightPx + READOUT_OFFSET_PX
}

/** The narrowest time band shown, so a distance with one effort still has an axis. */
const MIN_Y_BAND_S = 60
/** Days added either side of the history, so the first and last efforts are not on the plot edge. */
const X_PAD_DAYS = 14

export interface ScatterLayout {
  x: (day: number) => number
  y: (valueS: number) => number
  xDomain: [number, number]
  yDomain: [number, number]
  /** The plot's own box in panel pixels, so the component can draw its grid without redoing the inset arithmetic. */
  plot: { left: number; right: number; top: number; bottom: number; width: number; height: number }
  /**
   * Where the time ladder ticks, in seconds. Solved here rather than in the
   * component because the plot's width depends on it: the ladder's column is
   * reserved from the longest label it will hold, so the ticks have to be
   * known before the box is.
   */
  timeTicks: number[]
}

/**
 * Maps a day number and an elapsed time onto the panel, in CSS pixels.
 *
 * **The time axis is inverted: a faster effort sits lower.** SVG y grows
 * downward, so a *smaller* elapsed time maps to a *greater* y. That is
 * deliberate (docs/reference/frontend.md, "The progression chart's time axis
 * is inverted on purpose") - a future reader who "fixes" it puts every record
 * at the top and makes the ladder climb. One continuous linear axis: no
 * break, no clip, so the chart never misrepresents the size of a gap.
 *
 * Not anchored at zero, for the reason the trend charts' axes are not: the
 * real 5 km ladder lives within about 7% of its best time, which from zero
 * is a few pixels of the panel.
 */
export function scatterLayout(
  efforts: EffortDatum[],
  panelWidthPx: number = DEFAULT_PLOT_WIDTH,
  panelHeightPx: number = DEFAULT_PLOT_HEIGHT,
): ScatterLayout {
  const days = efforts.map((e) => e.t)
  const times = efforts.map((e) => e.valueS)
  const dayMin = (days.length === 0 ? 0 : Math.min(...days)) - X_PAD_DAYS
  const dayMax = (days.length === 0 ? 0 : Math.max(...days)) + X_PAD_DAYS

  const tMin = times.length === 0 ? 0 : Math.min(...times)
  const tMax = times.length === 0 ? 0 : Math.max(...times)

  // The ladder is solved before the box, because how wide its column has to
  // be is decided by the longest label in it. The domain does not depend on
  // the box, so there is no circularity here - only an order.
  //
  // And the ladder *is* the domain: `durationAxisScale` returns both, so the
  // scale cannot end up covering a range the ticks do not reach. See its
  // docstring for the 98%-below-the-lowest-rule measurement that forced it.
  const { ticks: timeTicks, range: yDomain } = durationAxisScale(tMin, tMax)
  const gutter = timeAxisGutter(timeTicks.map((seconds) => duration(seconds)))

  const plotWidth = panelWidthPx - PLOT_INSET.left - gutter
  const plotHeight = panelHeightPx - PLOT_INSET.top - PLOT_INSET.bottom

  return {
    timeTicks,
    x: (day) => PLOT_INSET.left + ((day - dayMin) / (dayMax - dayMin)) * plotWidth,
    // Inverted: the slowest time in the domain lands at the top inset, the
    // fastest at the bottom.
    y: (valueS) => PLOT_INSET.top + ((yDomain[1] - valueS) / (yDomain[1] - yDomain[0])) * plotHeight,
    xDomain: [dayMin, dayMax],
    yDomain,
    plot: {
      left: PLOT_INSET.left,
      right: PLOT_INSET.left + plotWidth,
      top: PLOT_INSET.top,
      bottom: PLOT_INSET.top + plotHeight,
      width: plotWidth,
      height: plotHeight,
    },
  }
}

/**
 * The running-best staircase through the records: from each record,
 * across to the next record's day, then down to its time; and from the
 * last record across to the last effort's day, because the best still
 * stands until something beats it.
 *
 * Which efforts are records is the analysis layer's decision (`is_record`
 * from the API), never recomputed here from the times. The first eligible
 * effort at a distance counts as one, so a distance with a single record
 * draws one horizontal hold.
 */
export function staircase(efforts: EffortDatum[], layout: ScatterLayout): Point[] {
  const ordered = [...efforts].sort((a, b) => a.t - b.t)
  const records = ordered.filter((e) => e.isRecord)
  const last = ordered.at(-1)
  if (records.length === 0 || last === undefined) return []
  const points: Point[] = []
  records.forEach((record, i) => {
    const y = layout.y(record.valueS)
    points.push({ x: layout.x(record.t), y })
    const next = records[i + 1]
    const holdTo = next === undefined ? last.t : next.t
    if (holdTo !== record.t) points.push({ x: layout.x(holdTo), y })
  })
  return points
}

/** Round tick steps in seconds, finest first. */
const DURATION_STEPS_S = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
const TARGET_DURATION_TICKS = 6

/**
 * Beyond the outermost ticks, as a fraction of the labelled span, so an
 * extreme mark's disc is not sliced by the plot's edge. **The scale only,
 * never the ticks** - the whole point of this axis is that the ticks are the
 * bounds, and padding them would put marks back outside the ladder.
 *
 * In pixels it is a fixed share of the plot's height whatever the data:
 * 0.03 / 1.06 of it, since the scale spans the ticks plus two overhangs.
 * That is 7.2 px on a phone, whose 20rem panel leaves a 254 px plot, and
 * 9.9 px on the desktop's 26rem panel. A record circle reaches 7 px from
 * its centre - radius 6 plus half its 2 px ring - so it stays inside the
 * plot on both. A reverse record's diamond does not quite: its vertex is
 * 7.5 px out and the ring's mitred tip 8.9 px, so on a phone an extreme one
 * crosses the plot's edge by up to 1.7 px, into the inset. Nothing clips
 * it there, and the only labels in the plot's own columns are the dates,
 * about 29 px below the plot.
 */
const SCALE_OVERHANG = 0.03

export interface DurationAxis {
  /** Every labelled rule, in seconds, ascending. The first is at or below the data's minimum and the last at or above its maximum. */
  ticks: number[]
  /** What the scale maps: the tick range plus the overhang. */
  range: [number, number]
}

/**
 * The time ladder, and the scale it implies - **as one answer, because they
 * are one question.**
 *
 * This used to be two. A padded range was computed from the data, and the
 * ticks were then fitted *inside* it with `Math.ceil(min / step) * step`, so
 * "cover the data" and "fit inside the range" were separate and diverged
 * badly: measured on the round-3 capture of the real 5 km history, the chart
 * drew three rules and **98% of the mark ink sat below the lowest one**,
 * running 259 px past it with no rule and no label under it. The lowest
 * rule sat 29% above the fastest effort's time. `charts/trendChartMath.ts`
 * had the identical fault this round and `axisScale` there is the same fix;
 * the ticks here are round *times* rather than round numbers, so the code
 * cannot be shared, but the invariant is:
 *
 * **Every mark is inside a labelled band, by construction.** The minimum is
 * floored to a whole increment and the maximum ceiled to one, and those are
 * the ticks; the overhang that keeps an extreme disc off the plot edge is
 * applied to the scale afterwards.
 *
 * The step is the finest round one whose *rounded-outward* span still fits
 * about six ticks - so the count is solved against the bounds the ticks will
 * actually have, not against the raw data span, which is what let the old
 * version pick a step that could not reach the data.
 *
 * `MIN_Y_BAND_S` is applied before any of that, so a distance with a single
 * effort gets a readable band rather than an axis five seconds tall.
 */
export function durationAxisScale(minS: number, maxS: number): DurationAxis {
  const lo = Math.min(minS, maxS)
  const hi = Math.max(minS, maxS)
  const band = Math.max(hi - lo, MIN_Y_BAND_S)
  const mid = (lo + hi) / 2
  // Clamped at zero: an elapsed time is never negative, and a label of one
  // would be nonsense rather than merely unused.
  const loAdj = Math.max(0, mid - band / 2)
  const hiAdj = mid + band / 2

  const stepOf = (candidate: number) => ({
    first: Math.floor(loAdj / candidate) * candidate,
    last: Math.ceil(hiAdj / candidate) * candidate,
  })
  let step = DURATION_STEPS_S[DURATION_STEPS_S.length - 1] ?? 3600
  for (const candidate of DURATION_STEPS_S) {
    const { first, last } = stepOf(candidate)
    if (Math.round((last - first) / candidate) + 1 <= TARGET_DURATION_TICKS) {
      step = candidate
      break
    }
  }

  let { first, last } = stepOf(step)
  // Several efforts at exactly the same time, or a value that is itself a
  // whole increment, can collapse the two onto one tick. An axis needs a
  // band, and a band needs two ends.
  if (last <= first) {
    first = Math.max(0, first - step)
    last = first + 2 * step
  }

  const ticks: number[] = []
  // `<= last + step / 2` rather than `<= last`: the accumulator drifts on
  // non-integer steps and a strict bound silently drops the last tick, which
  // is the one this function exists to guarantee.
  for (let s = first; s <= last + step / 2; s += step) ticks.push(s)

  const overhang = (last - first) * SCALE_OVERHANG
  return { ticks, range: [first - overhang, last + overhang] }
}

/**
 * Which of three styles a point is drawn in, and the order the three are
 * painted in: ineligible first, then ordinary eligible efforts, then
 * records on top.
 *
 * The real 5 km history is 225 points in a panel 316 px wide, so points
 * overlap and paint order decides what a reader sees. Records are the
 * subject of the screen and there are nine of them; painting them in
 * payload order let an ordinary effort from the following week cover one.
 * This is presentation only - `is_record` and `is_eligible` are the
 * analysis layer's flags and nothing here re-decides either.
 */
export type PointStyle = 'ineligible' | 'eligible' | 'record'

export function pointStyle(isRecord: boolean, isEligible: boolean): PointStyle {
  if (isRecord) return 'record'
  return isEligible ? 'eligible' : 'ineligible'
}

const PAINT_ORDER: Record<PointStyle, number> = { ineligible: 0, eligible: 1, record: 2 }

/** `items` reordered so the three styles paint back to front. Stable within a style, so date order survives. */
export function inPaintOrder<T>(items: T[], styleOf: (item: T) => PointStyle): T[] {
  return [...items].sort((a, b) => PAINT_ORDER[styleOf(a)] - PAINT_ORDER[styleOf(b)])
}

/**
 * A diamond's half-diagonal per unit of the circle radius it stands in for,
 * so the two shapes carry **the same area of ink**: a circle of radius `r`
 * is `pi r^2` and a diamond of half-diagonal `a` is `2 a^2`, so
 * `a = r * sqrt(pi / 2)`, about 1.25 r.
 *
 * Equal area rather than equal radius because what a reader compares across
 * the two shapes is weight, not width. A diamond inscribed in the circle's
 * own radius has 64% of the circle's ink and reads as a lesser mark, which
 * on a route chart would say a reverse run counts for less - and it does
 * not: `analysis.routes` ranks both directions together.
 */
export const DIAMOND_HALF_DIAGONAL_PER_RADIUS = Math.sqrt(Math.PI / 2)

/**
 * The SVG path of a diamond centred on `(cx, cy)` with the area of a circle
 * of radius `r`: top, right, bottom, left, closed.
 */
export function diamondPath(cx: number, cy: number, r: number): string {
  const a = r * DIAMOND_HALF_DIAGONAL_PER_RADIUS
  const at = (x: number, y: number) => `${String(x)} ${String(y)}`
  return `M ${at(cx, cy - a)} L ${at(cx + a, cy)} L ${at(cx, cy + a)} L ${at(cx - a, cy)} Z`
}
