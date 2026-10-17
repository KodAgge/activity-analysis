import type uPlot from 'uplot'
import { altitude, cadence, distance, heartRate, pace, paceFromSpeed, paceSecondsPerKm, speedFromPaceSeconds } from '../format'
import { cssPixelRatio, scaleDash } from './canvasPixels'

/**
 * The pure logic behind `StreamPanel.tsx`, kept in its own module so that
 * file exports only the `StreamPanel` component - a file mixing a component
 * export with plain function exports cannot be Fast-Refreshed.
 */

export type StreamChannel = 'pace' | 'hr' | 'cadence' | 'elevation'

export const CHANNEL_LABEL: Record<StreamChannel, string> = {
  pace: 'Pace',
  hr: 'Heart rate',
  cadence: 'Cadence',
  elevation: 'Elevation',
}

/**
 * The unit each channel's y axis is in, for the axis label and the panel
 * heading. Pace is the one that is not the stored unit: the axis is linear
 * in `speed_mps` and only its tick *labels* are pace, so what a reader sees
 * on that axis is min/km even though nothing in the data is.
 */
export const CHANNEL_UNIT: Record<StreamChannel, string> = {
  pace: 'min/km',
  hr: 'bpm',
  cadence: 'spm',
  elevation: 'm',
}

/** The channels drawn as a filled area rather than a bare stroke. */
export const CHANNEL_IS_FILLED: Record<StreamChannel, boolean> = {
  pace: false,
  hr: false,
  cadence: false,
  elevation: true,
}

const PACE_TICK_STOP_LABEL = 'stop'

/**
 * `speedMps` handed to this must be a *tick position* the axis chose, not a
 * data sample - a real sample of exactly 0 is a stop, and this reads the
 * same for both, which is the point.
 */
export const paceTick = (speedMps: number): string =>
  speedMps <= 0 ? PACE_TICK_STOP_LABEL : paceFromSpeed(speedMps)

const NICE_PACE_STEPS_S = [1, 2, 5, 10, 15, 30, 60, 90, 120, 180, 300, 600]
const COARSEST_PACE_STEP_S = 600
const TARGET_PACE_TICKS = 6

/**
 * Below this, "pace" has stopped being a useful unit - 1000 / 0.05 is a
 * 5:33:20 kilometre - so no pace-labelled gridline is generated at all; the
 * only thing that can appear is the zero/stop tick, if `scaleMin` put one
 * there. A single sample at 0.001 m/s reproduced the original
 * absurd-label pathology (a `firstPaceS` in the hundreds of thousands of
 * seconds) before this guard existed.
 */
const MIN_SCALE_MAX_FOR_PACE_TICKS_MPS = 0.05

/**
 * Where to draw the pace axis's gridlines, in speed units (the scale's own
 * domain), chosen so the *labels* land on round pace numbers and, just as
 * importantly, land where the run actually is.
 *
 * uPlot's default `incrs`-based split picker works in the scale's own
 * linear units, which would place ticks at round speeds (1, 2, 3 m/s) and
 * label them with whatever ugly pace that converts to. This instead picks a
 * round pace step and converts each candidate back to its speed position
 * with `speedFromPaceSeconds`, so the *ticks* land at uneven speed
 * intervals but the numbers a reader sees are round.
 *
 * The step is derived differently depending on whether the axis is
 * zero-anchored (see `paceYRange`):
 *
 * - Zero-anchored (`scaleMin <= 0`): the step is based on `scaleMax` alone.
 *   "The slowest visible pace" would otherwise mean the pace of whatever is
 *   nearest zero, which diverges towards infinity and is not a useful basis
 *   for a step - an earlier version derived the step from a 0.1 m/s clamp
 *   there instead (10000 s/km) and put nearly every gridline in the
 *   standstill band. Anchoring purely at the fast end and stepping outward
 *   avoids that.
 * - Cropped (`scaleMin > 0`): the step is the pace difference across *one
 *   tick's worth of the displayed speed range*, measured at the fast end.
 *   The panel is linear in speed, so that is the pace gap between two
 *   evenly spaced gridlines - which is what a step has to be if the ticks
 *   are to land evenly across the panel rather than pile up at one end.
 *
 * Deriving the cropped step from the *pace* span between `scaleMin` and
 * `scaleMax` was the previous formulation, and it fails the same way the
 * zero-anchored formula failed before it: pace diverges as speed falls, so
 * a range whose bottom is a walk is dominated by its slow end. A run with a
 * 0.8 m/s walked recovery and a 4.5 m/s stride gives a 0.5-4.87 m/s scale,
 * a 1795 s pace span, a saturated 600 s step and three gridlines all below
 * 1.7 m/s - none anywhere in the 1.7-4.87 m/s band the athlete ran, which
 * is precisely the reading the cropped branch was measured into existence
 * to give. The one-tick-of-speed step puts six gridlines between 1.85 and
 * 4.17 m/s on that same trace. On the narrow even-paced range that
 * motivated the cropped branch (a 1473-sample run spanning 2.547-2.855
 * m/s) both formulations pick a step fine enough to place several
 * gridlines inside the band, so this does not undo that fix - it
 * generalises it.
 *
 * `NICE_PACE_STEPS_S` reaches down to 1 s/km because the raw step is
 * rounded *up* onto that ladder, and a rung coarser than the whole
 * displayed band overshoots it: the first candidate is
 * `Math.ceil(fastestPaceS / step) * step`, at most one step slower than
 * the fastest visible pace, so once the step exceeds the band every
 * candidate falls out the bottom of the range and the axis comes back
 * with no gridlines at all. A ladder starting at 15 s/km did exactly that
 * to a near-constant-pace run spanning 3.1 s/km (2.78-2.80 m/s), and it
 * did it silently: no labels, no gridlines, nothing thrown.
 *
 * A band narrower than the finest rung can still land no candidate inside
 * itself - 2.7999-2.8001 m/s spans 0.03 s/km and contains no whole second
 * of pace - as can a degenerate range whose ends are equal. Both fall
 * back to a single gridline at the range's own midpoint, and that
 * fallback is what makes the return value non-empty for a range of any
 * width whenever pace is a usable unit at all: every range past the
 * `MIN_SCALE_MAX_FOR_PACE_TICKS_MPS` guard above, which is every range
 * `paceYRange` can produce. Such a tick is labelled with its own pace
 * rounded to the second, which across a band this narrow is
 * indistinguishable from any other position in it.
 *
 * `plotHeightPx` is the plot's height in **CSS** pixels, which is the unit
 * `MIN_TICK_SEPARATION_PX` is expressed in. uPlot reports `bbox` in canvas
 * pixels, so the caller divides the device pixel ratio out before handing
 * it over - see `StreamPanel.tsx`'s pace-axis `splits` callback.
 */
export function paceAxisSplits(scaleMin: number, scaleMax: number, plotHeightPx?: number): number[] {
  const splits: number[] = []
  if (scaleMin <= 0) splits.push(0)
  if (scaleMax < MIN_SCALE_MAX_FOR_PACE_TICKS_MPS) return splits

  const isCropped = scaleMin > 0
  const fastestPaceS = paceSecondsPerKm(scaleMax)
  const oneTickOfSpeed = (scaleMax - scaleMin) / (TARGET_PACE_TICKS - 1)
  const rawStep = isCropped
    ? Math.max(paceSecondsPerKm(scaleMax - oneTickOfSpeed) - fastestPaceS, 1)
    : Math.max(fastestPaceS / (TARGET_PACE_TICKS - 1), 1)
  const step = NICE_PACE_STEPS_S.find((candidate) => candidate >= rawStep) ?? COARSEST_PACE_STEP_S
  const firstPaceS = Math.ceil(fastestPaceS / step) * step

  const paceSplits: number[] = []
  for (let i = 0; i < TARGET_PACE_TICKS; i++) {
    const speed = speedFromPaceSeconds(firstPaceS + i * step)
    if (speed > scaleMin && speed <= scaleMax) paceSplits.push(speed)
  }
  if (paceSplits.length === 0) paceSplits.push((Math.max(scaleMin, 0) + scaleMax) / 2)

  const spaced =
    plotHeightPx === undefined
      ? paceSplits
      : thinToUniformStride(paceSplits, scaleMin, scaleMax, plotHeightPx)

  return [...splits, ...spaced].sort((a, b) => a - b)
}

/**
 * uPlot's default axis font is 12px (`node_modules/uplot/dist/uPlot.esm.js`,
 * the module-level `font` constant), so two tick labels need roughly one em
 * box plus a little air between their baselines before they read as two
 * labels rather than one smudge.
 *
 * A **CSS**-pixel quantity, because that is the unit the font size is in.
 * Every height reaching this module is therefore CSS pixels too.
 */
const MIN_TICK_SEPARATION_PX = 14

/**
 * Thins the round-pace ladder to the finest *uniform* stride that fits.
 *
 * The crowding this fixes is a consequence of the reciprocal, not of a bad
 * step: the panel is linear in speed and the labels are round paces, so
 * equal pace steps map to shrinking speed intervals as the athlete slows,
 * and the labels converge towards the slow end however good the step is.
 * Measured on `854fd775d479ca9f`, whose axis spans 1.132-3.002 m/s over a
 * 140px plot: the round-minute labels from 6:00 down to 11:00 sit at
 * successive gaps of 29.7, 22.3, 17.3, 13.8 and 11.4 px - a 2.6x
 * compression down a single axis, and the bottom two collide.
 *
 * **Why a uniform stride rather than dropping whichever labels collide.**
 * Dropping greedily was the first attempt and it works, in the sense that
 * nothing overlaps: on the run above it keeps 6:00, 7:00, 8:00, 9:00 and
 * 11:00 - legible, and a ladder that skips 10:00 for no reason a reader can
 * see. An axis whose labels step 1, 1, 1, 2 reads as an error even though
 * every label on it is true. Taking every *n*-th rung instead keeps the
 * ladder regular: the same run comes back 6:00, 8:00, 10:00, three labels
 * that are all comfortably clear of each other and step evenly.
 *
 * The tightest gap always falls at the slow end, so that is what the stride
 * is tested against. If even the coarsest stride cannot separate two
 * labels, a single tick at the fastest end is returned rather than nothing:
 * this function must never empty the axis, which is the invariant four
 * separate defects on the previous branch came from breaking.
 *
 * `plotHeightPx` is in CSS pixels, the unit `MIN_TICK_SEPARATION_PX` is
 * expressed in.
 */
function thinToUniformStride(
  paceSplits: number[],
  scaleMin: number,
  scaleMax: number,
  plotHeightPx: number,
): number[] {
  const span = scaleMax - scaleMin
  if (span <= 0 || plotHeightPx <= 0) return paceSplits

  const pxPerMps = plotHeightPx / span
  const fastestFirst = [...paceSplits].sort((a, b) => b - a)

  // Strides short of the whole list, so every candidate keeps at least two
  // labels and there is a gap to measure. A stride as long as the list
  // keeps exactly one, which is what the fallback below returns anyway.
  for (let stride = 1; stride < fastestFirst.length; stride++) {
    const kept: number[] = []
    for (let i = 0; i < fastestFirst.length; i += stride) {
      const speed = fastestFirst[i]
      if (speed !== undefined) kept.push(speed)
    }
    if (tightestGapPx(kept, pxPerMps) >= MIN_TICK_SEPARATION_PX) return kept
  }

  return fastestFirst.slice(0, 1)
}

/** The smallest pixel distance between two adjacent ticks in a descending list. */
function tightestGapPx(descendingSpeeds: number[], pxPerMps: number): number {
  let tightest = Number.POSITIVE_INFINITY
  for (let i = 1; i < descendingSpeeds.length; i++) {
    const faster = descendingSpeeds[i - 1]
    const slower = descendingSpeeds[i]
    if (faster === undefined || slower === undefined) continue
    tightest = Math.min(tightest, (faster - slower) * pxPerMps)
  }
  return tightest
}

/**
 * The project's own stop threshold (see docs/reference/derived-layer.md
 * and CLAUDE.md): a gap over 15 s across which the implied speed is under
 * 0.5 m/s is a stop. This borrows only the speed half of that rule - a
 * single sample this slow is evidence enough of a genuine near-standstill
 * moment without re-deriving the derived layer's own 15 s gap detection
 * here.
 */
export const STOP_SPEED_MPS = 0.5

/**
 * Whether this stream shows any evidence of a genuine stop: a paused
 * stretch, an outage, or a raw sample at or below the project's stop
 * threshold. Deliberately reads the *raw* `paused`/`outage` flags rather
 * than the already-masked series: a paused stretch is nulled out of what
 * uPlot draws, but the pause itself is still a real stop that happened,
 * and the axis should say so by reaching zero.
 */
export function containsNearZeroSpeed(
  values: (number | null)[],
  paused: (boolean | null)[],
  outage: (boolean | null)[],
): boolean {
  if (paused.some((p) => p === true)) return true
  if (outage.some((o) => o === true)) return true
  return values.some((v) => v !== null && v < STOP_SPEED_MPS)
}

const CROPPED_PAD_FRACTION = 0.1

/**
 * The pace panel's y-scale range: zero-anchored when the run actually
 * touches a near-zero speed, so a stop still reads as a stop exactly where
 * there is a stop to read, and otherwise cropped to a symmetrically padded
 * band around the visible data.
 *
 * Forcing every pace panel to zero regardless of the run's own shape was
 * an earlier version's mistake, caught by measurement: a genuinely
 * even-paced real run (speed coefficient of variation 1.5%) has its
 * 5th-to-95th-percentile band in about 4% of a zero-anchored panel's
 * height, worse than the 21.9% figure that motivated plotting speed
 * rather than pace in the first place. A run with no stop has no zero to
 * show, and nothing is lost by cropping to its own data.
 *
 * The 10% pad on each side is symmetric: speed cannot go negative, but the
 * padding exists to keep the plotted line clear of the panel's own top and
 * bottom edges, which is a concern on both sides equally.
 *
 * The cropped bottom is floored at `STOP_SPEED_MPS`. The symmetric pad is
 * a fraction of the *span*, so on a wide range (`dataMax > 11 * dataMin`,
 * which an interval session with a walked segment reaches) it exceeds
 * `dataMin` and the padded bottom goes negative. That is not merely a
 * meaningless negative speed: `paceAxisSplits` takes its `scaleMin <= 0`
 * branch on it and pushes a gridline at zero, which `paceTick` labels
 * `stop` - a standstill drawn onto the one run this branch has already
 * established never stopped. Flooring at the project's own stop threshold
 * keeps the bottom both positive and above the speed that would have made
 * this the anchored branch instead.
 */
export function paceYRange(
  values: (number | null)[],
  paused: (boolean | null)[],
  outage: (boolean | null)[],
  dataMin: number,
  dataMax: number,
): [number, number] {
  if (containsNearZeroSpeed(values, paused, outage)) return [0, dataMax]
  const pad = (dataMax - dataMin) * CROPPED_PAD_FRACTION
  return [Math.max(dataMin - pad, STOP_SPEED_MPS), dataMax + pad]
}

/**
 * The elevation panel's y-scale range: cropped to the run's own band with
 * symmetric padding, never zero-anchored, and never narrower than
 * `MIN_ELEVATION_BAND_M`.
 *
 * Altitude is a position on a scale with an arbitrary origin, not a
 * magnitude measured from zero, so there is nothing for a zero anchor to
 * mean here - unlike speed, where zero is a genuine standstill the reader
 * needs to see. Anchoring at sea level would also destroy the signal on
 * exactly the runs that have any: the reference activity climbs 56 m in
 * total and its samples span a 24.6 m band, which on a 0-40 m axis is
 * readable and on a 0-2900 m one is a flat line.
 *
 * **The minimum band is a floor on the whole range, not a special case for
 * the exactly-flat run.** Guarding only the degenerate `span === 0` left
 * every merely-narrow band to round its own gridlines into the same
 * number, because the non-pace axis formatter renders a tick as
 * `String(Math.round(s))`: three real activities have an altitude band
 * under 3 m, and measured in Chromium at this panel's 142 CSS px plot
 * height, the narrowest, 0.6 m, drew four labels of which three were the
 * same integer, and a 1 m band drew three of which two were. That is the
 * axis-legibility fault this branch exists to fix, produced silently.
 *
 * Widening is the fix rather than a decimal tick format, and the reason is
 * semantic rather than cheapness: a run whose altitude moved 0.6 m should
 * *look* like a run whose altitude did not move, and spreading 0.6 m of
 * barometric jitter across a full panel height would amplify noise into
 * apparent terrain. It is the pace axis's zero-anchoring argument running
 * the other way - crop to the data unless cropping misrepresents it.
 *
 * Taken as the wider of the padded band and the floor, symmetrically about
 * the data's own midpoint, so there is no step in behaviour where the two
 * meet: an 8.5 m band pads to 10.2 m and is returned untouched, and the
 * degenerate band falls out of the same expression rather than out of a
 * branch of its own.
 */
export function elevationYRange(dataMin: number, dataMax: number): [number, number] {
  const span = dataMax - dataMin
  const midpoint = (dataMin + dataMax) / 2
  const half = Math.max(span / 2 + span * CROPPED_PAD_FRACTION, MIN_ELEVATION_BAND_M / 2)
  return [midpoint - half, midpoint + half]
}

/**
 * The narrowest elevation axis this panel ever draws, and so the full
 * height of the axis drawn for a run whose altitude never moves.
 *
 * 10 m is wide enough that uPlot cannot choose a sub-metre tick increment
 * on this panel - its y axis wants `space: 30` CSS px between ticks, which
 * over a 142 px plot forces an increment of at least 2.1 m - so whole-metre
 * labels are always distinct. Measured: the floored 0.6 m band draws four
 * distinct labels, two or three metres apart.
 */
export const MIN_ELEVATION_BAND_M = 10

/** Inclusive elapsed-time bounds of one contiguous run of `true`. */
export interface PauseBand {
  startT: number
  endT: number
}

function isMasked(paused: (boolean | null)[], outage: (boolean | null)[], index: number): boolean {
  return paused[index] === true || outage[index] === true
}

function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index]
  if (value === undefined) {
    throw new Error(`index ${index} out of bounds`)
  }
  return value
}

/**
 * One band per contiguous run of `paused` or `outage` being true, in
 * elapsed-time coordinates. Computed once from the flag arrays rather than
 * inside the draw hook, which would otherwise redo this scan on every
 * redraw (pan, zoom, resize).
 */
export function computePauseBands(
  t: number[],
  paused: (boolean | null)[],
  outage: (boolean | null)[],
): PauseBand[] {
  const bands: PauseBand[] = []
  let startIndex: number | null = null

  for (let i = 0; i < t.length; i++) {
    if (isMasked(paused, outage, i)) {
      startIndex ??= i
    } else if (startIndex !== null) {
      bands.push({ startT: at(t, startIndex), endT: at(t, i - 1) })
      startIndex = null
    }
  }
  if (startIndex !== null) {
    bands.push({ startT: at(t, startIndex), endT: at(t, t.length - 1) })
  }
  return bands
}

/**
 * Whether a channel has anything to draw once its stops are masked - the
 * same test as `maskSeries` followed by looking for a non-null, without
 * building the masked copy. `StreamPanel` draws its "no X recorded" state
 * from exactly this, and the activity view picks the bottom panel that
 * carries the shared time axis from it, so the two cannot disagree about
 * which panels have a chart.
 */
export function hasChartableValue(
  values: (number | null)[],
  paused: (boolean | null)[],
  outage: (boolean | null)[],
): boolean {
  return values.some((v, i) => v !== null && !isMasked(paused, outage, i))
}

/**
 * Nulls the channel's values across every paused or outage second. The
 * derived layer already nulls the sensor channels there, but this masks
 * again defensively rather than trusting the caller, because a broken line
 * is the one thing that must never silently regress into a straight line
 * drawn through a stop.
 */
export function maskSeries(
  values: (number | null)[],
  paused: (boolean | null)[],
  outage: (boolean | null)[],
): (number | null)[] {
  return values.map((v, i) => (isMasked(paused, outage, i) ? null : v))
}

/**
 * The mean of what the panel draws: the channel's values over the seconds
 * `maskSeries` leaves non-null. Null when there are none.
 *
 * This is the panel's dashed line. It used to be the activity summary's
 * average, which on the pace panel is the run's distance over its moving
 * time while the trace is the watch's speed reading, and the two differ:
 * measured on 2026-10-04 the speed reading adds up to a median 2.0% less
 * ground than the distance outdoors, and on a treadmill the distance is
 * Strava's corrected session total while the stream is the watch's own.
 * See docs/reference/frontend.md, "A panel's dashed line is the mean of the
 * trace it is drawn over".
 */
export function traceMean(
  values: (number | null)[],
  paused: (boolean | null)[],
  outage: (boolean | null)[],
): number | null {
  let sum = 0
  let count = 0
  values.forEach((v, i) => {
    if (v === null || isMasked(paused, outage, i)) return
    sum += v
    count += 1
  })
  return count === 0 ? null : sum / count
}

/** What `paceLineNote` needs, all from the activity page's own responses. */
export interface PaceLineNoteFacts {
  /** `traceMean` of the pace panel's `speed_mps`. */
  traceSpeedMps: number | null
  /** `summary.avg_speed_mps`, the header's Pace. */
  summarySpeedMps: number | null
  /** `summary.distance_m`, the distance that Pace is taken from. */
  distanceM: number | null
  /** `summary.moving_time_s`; null when the derived layer has no row. */
  movingTimeS: number | null
  /** `derived.metrics.is_indoor`; null when not known. */
  isIndoor: boolean | null
}

function isPositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0
}

/**
 * The sentence under the pace panel that reconciles its line with the
 * header's Pace, or null when the two format the same or a figure is
 * missing.
 *
 * Both paces divide by the same moving time, so the sentence states the
 * two distances: the trace's mean speed over that moving time, and the
 * distance the header's Pace uses. A null moving time means no derived
 * row, where the summary's speed is the device's own average, so there is
 * nothing comparable to say.
 */
export function paceLineNote({
  traceSpeedMps,
  summarySpeedMps,
  distanceM,
  movingTimeS,
  isIndoor,
}: PaceLineNoteFacts): string | null {
  if (!isPositive(traceSpeedMps) || !isPositive(summarySpeedMps) || !isPositive(distanceM) || !isPositive(movingTimeS)) {
    return null
  }
  if (formatAverage('pace', traceSpeedMps) === formatAverage('pace', summarySpeedMps)) return null
  const source =
    isIndoor === true ? `Strava's ${distance(distanceM)} session total` : `the run's ${distance(distanceM)}`
  return (
    `The line averages the watch's speed reading, which covers ${distance(traceSpeedMps * movingTimeS)} ` +
    `in the moving time; the ${pace(summarySpeedMps)} pace above uses ${source}.`
  )
}

/**
 * The dash pattern of the average reference line, in **CSS** pixels.
 *
 * Scaled by `scaleDash` (see `canvasPixels.ts`) at the point it reaches
 * the context, because
 * a canvas draws in its backing store's pixels and uPlot sizes that store
 * at the device ratio. Measured before the fix, by intercepting
 * `setLineDash` in a real browser: `[6, 4]` arrived unchanged at both
 * devicePixelRatio 1 and 2, so on a HiDPI display the dashes rendered 3 CSS
 * pixels on and 2 off instead of 6 and 4 - close enough to solid to
 * undermine the one thing the maintainer asked this line to be.
 *
 * Kept in CSS pixels rather than pre-scaled so it stays comparable with the
 * font sizes and separations the rest of this module is expressed in. uPlot
 * itself takes the same convention for everything it is handed - it
 * multiplies `series.width`, `points.width` and the axis font size by the
 * ratio internally - so this matches the library rather than fighting it.
 */
export const AVERAGE_DASH = [6, 4]

/** The pause band's boundary dashes, in CSS pixels. Same scaling as above. */
export const PAUSE_BAND_DASH = [4, 3]

/**
 * The stroke width of every line this module draws itself, in CSS pixels,
 * scaled the same way the dash patterns above are.
 *
 * Stated rather than inherited, which is the whole point of the constant.
 * `ctx.save()` preserves the context's state, it does not reset it, and
 * uPlot fires the `drawAxes` hook immediately after drawing each axis's
 * grid - `drawOrthoLines(..., roundDec(grid.width * pxRatio, 3), ...)`,
 * with `grid.width` defaulting to 2. So both the pause boundaries and the
 * average line used to stroke at whatever the last axis had left on the
 * context: 2 CSS px, heavier than the 1.5 px series they annotate, and
 * ratio-correct only by uPlot's accident rather than by this module's
 * choice. 1 CSS px is lighter than the series on purpose - an annotation
 * should not out-weigh the data it marks.
 */
export const ANNOTATION_LINE_WIDTH_PX = 1

/**
 * The average, formatted for the panel's own HTML legend.
 *
 * It is deliberately not drawn on the canvas any more. It used to be, at
 * the plot's right edge two pixels above the line, which collided with the
 * trace on every run whose finish is near its own average - which is most
 * of them, since that is what an average is. Text in the DOM cannot
 * collide with a canvas stroke at all, and it is selectable and readable
 * by a screen reader into the bargain.
 *
 * Rendering it as a sibling of the chart container rather than inside it is
 * safe here for the reason `StreamPanel.module.css` documents: `.panel`
 * carries an externally imposed height, so the observed box `setSize` is
 * fed never grows with the panel's own content. See `UPlot.tsx` on why that
 * distinction is load-bearing.
 */
export function formatAverage(channel: StreamChannel, average: number): string {
  switch (channel) {
    case 'pace':
      return average > 0 ? pace(average) : PACE_TICK_STOP_LABEL
    case 'hr':
      return heartRate(average)
    case 'cadence':
      return cadence(average)
    case 'elevation':
      return altitude(average)
  }
}

/**
 * Draws the pause/outage bands and the average reference line, in that
 * order, so both sit behind the series stroke drawn immediately after this
 * hook fires (`drawAxes` runs before `series` in uPlot's default draw
 * order).
 */
export function backgroundHook(params: {
  bands: PauseBand[]
  average: number | null
  accentColor: string
  inkDimColor: string
}) {
  const { bands, average, accentColor, inkDimColor } = params
  return (u: uPlot) => {
    const ctx = u.ctx
    const top = u.bbox.top
    const height = u.bbox.height

    ctx.save()
    ctx.lineWidth = ANNOTATION_LINE_WIDTH_PX * cssPixelRatio()
    bands.forEach((band) => {
      const x0 = u.valToPos(band.startT, 'x', true)
      const x1 = u.valToPos(band.endT, 'x', true)
      ctx.globalAlpha = 0.12
      ctx.fillStyle = accentColor
      ctx.fillRect(x0, top, x1 - x0, height)
      ctx.globalAlpha = 1
      ctx.setLineDash(scaleDash(PAUSE_BAND_DASH))
      ctx.strokeStyle = accentColor
      ctx.beginPath()
      ctx.moveTo(x0, top)
      ctx.lineTo(x0, top + height)
      ctx.moveTo(x1, top)
      ctx.lineTo(x1, top + height)
      ctx.stroke()
      ctx.setLineDash([])
    })

    if (average !== null) {
      const y = u.valToPos(average, 'y', true)
      // Dashed, so the reference line reads as an annotation rather than as
      // a second data series drawn flat.
      ctx.setLineDash(scaleDash(AVERAGE_DASH))
      ctx.strokeStyle = inkDimColor
      ctx.beginPath()
      ctx.moveTo(u.bbox.left, y)
      ctx.lineTo(u.bbox.left + u.bbox.width, y)
      ctx.stroke()
      ctx.setLineDash([])
    }
    ctx.restore()
  }
}

/**
 * uPlot draws an axis label as its own rotated text at a fixed gutter it
 * reserves from the canvas, sized by `labelSize`. 22px is enough for one
 * line of `StreamPanel`'s 11px label font and no more, because every pixel
 * of it comes off the plot area of a panel that is only 200px tall to
 * begin with.
 */
export const AXIS_LABEL_SIZE = 22

/**
 * The time axis's own height above its title, ticks and labels: uPlot's
 * default for an x axis, stated in `StreamPanel`'s options rather than
 * inherited, because `chartFurniturePx` adds it up and a default that moved
 * underneath would leave the sum wrong.
 */
export const TIME_AXIS_SIZE = 50

/** The gap `StreamPanel` leaves above the plot, so a line along its top is not clipped. */
export const PLOT_PADDING_TOP = 8

/**
 * The gap below the plot of a panel with no time axis under it. A y label
 * is centred on its gridline, so the one on the floor gridline hangs half
 * of uPlot's 12px axis font below the plot, and without this the canvas
 * edge cut it in half - the cadence panel's `0`, seen at 1280x800.
 */
export const BARE_PLOT_PADDING_BOTTOM = 8

/** The time axis with its title, which the axis's own `size` and `labelSize` reserve below the plot. */
const TIME_AXIS_HEIGHT = TIME_AXIS_SIZE + AXIS_LABEL_SIZE

/**
 * How much of a stream panel's canvas is not plot: the top padding, and
 * below the plot either the time axis with its title or the bare panel's
 * bottom padding - 80px with the axis and 16px without, so a full 200px
 * panel has a 120px plot.
 *
 * `StreamPanel.module.css` adds this to `--stream-plot-height`, which is
 * how the activity view's compact desktop charts give four panels equal
 * plots though only the bottom one carries the axis.
 */
export function chartFurniturePx(timeAxis: boolean): number {
  return PLOT_PADDING_TOP + (timeAxis ? TIME_AXIS_HEIGHT : BARE_PLOT_PADDING_BOTTOM)
}
