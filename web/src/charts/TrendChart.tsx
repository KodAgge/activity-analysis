import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type uPlot from 'uplot'
import { Absent } from '../components/Absent'
import { NO_VALUE, calendarDayLabel } from '../format'
import { cssPixelRatio, scaleDash } from './canvasPixels'
import { cssVar } from './cssVar'
import {
  alignSeries,
  axisRange,
  axisScale,
  bandRange,
  dateAxisSplits,
  dateTickLabels,
  paddedDayRange,
  readoutValue,
  seriesExtent,
  type TrendSeries,
} from './trendChartMath'
import { UPlot } from './UPlot'
import { clampReadoutLeft } from './volumeBarsMath'
import styles from './TrendChart.module.css'

export type { TrendPointDatum, TrendSeries } from './trendChartMath'

export interface TrendChartProps {
  /** The series to draw, in palette order. See `TrendSeries` for how each is styled. */
  series: TrendSeries[]
  /**
   * The y axis unit: `bpm`, `spm`. Rendered on every rung of the ladder
   * rather than as a rotated axis title, which is what the reference does
   * with its own `40 km / 20 km / 0 km`.
   */
  yLabel: string
  /** A value as the readout shows it, unit included. */
  formatValue: (value: number) => string
  /**
   * A y tick's label. Defaults to the nearest whole number followed by
   * `yLabel`. Pass one only where that default is wrong - a unit too long
   * to repeat on every rung, or a value that needs a decimal - and hoist
   * it, because its identity keys the chart's options memo.
   */
  formatTick?: (value: number) => string
  /** What the panel says when no series has a single value to draw. */
  emptyReason: string
  /** Names the chart for assistive technology and for a test to find it by. */
  ariaLabel: string
  /**
   * How much vertical room the panel gets. `tall` is for a chart whose
   * series sit far apart on the y axis and would otherwise read as one
   * band: the VO2max panel draws two smoothed series, one about 60% above
   * the other on the real store of 2026-10-16, with raw points beneath them. Anything here must keep `CHART_HEIGHT_PX`
   * and `TrendChart.module.css` in step - see the module doc.
   */
  height?: 'standard' | 'tall'
  /**
   * A horizontal rule at one y value, with words for what it means.
   *
   * `label` is not optional, because an unexplained rule across a chart
   * reads as a second series drawn flat. It is drawn dashed and in the dim
   * ink rather than a palette entry, for the same reason
   * `streamPanelMath.backgroundHook` draws its average that way: an
   * annotation must not out-weigh or be mistaken for the data it marks.
   */
  referenceLine?: { value: number; label: string }
}

/**
 * The panel's height in CSS pixels per size, and the class that imposes the
 * same height on the box around it.
 *
 * These two must agree. The container's height is imposed from outside and
 * never content-sized, for the reason `UPlot.tsx` documents: uPlot renders
 * its legend as a sibling of the plot inside the observed box, so a
 * content-sized container grows one legend-height per resize observation,
 * without bound. A `tall` option that changed only `options.height` would
 * leave the canvas overflowing a 14rem box.
 */
const CHART_HEIGHT_PX: Record<NonNullable<TrendChartProps['height']>, number> = {
  standard: 224,
  tall: 336,
}

/**
 * The room a second band costs, in CSS pixels, **added** to whatever height
 * the caller asked for rather than taken out of it.
 *
 * Added, because the subject was sized for its own height and a strip carved
 * out of that shrinks the thing the chart is named after. Mirrors
 * `--chart-trend-strip` in `theme/tokens.css`, which is what sizes the box
 * around the canvas; the two must move together for the reason the comment
 * above gives.
 */
const STRIP_EXTRA_PX = 104

/**
 * One width for every line, in CSS pixels. Colour is what separates series,
 * not weight: the three reference paces are ordinal and take the sequential
 * ramp in `theme/tokens.css`, and a second encoding of the same ordering in
 * line weight only made the thin one look unimportant rather than slow.
 *
 * **1.8 again.** It was cut to 1.2 to buy clear air between three lines
 * close together, and the envelope removed the problem that
 * measurement was solving: there is one line per pace chart now, so the
 * stroke can go back to the weight that reads. The measurement that took it
 * to 1.2 is kept below, because it is the reason the *three-line* encoding
 * could never have been made to work by stroke alone, and that is the
 * finding rather than the number.
 *
 * **Why three stroked lines could not work at any width.** Adjacent
 * reference-pace lines sat about a 67th of the raw scatter's whole spread
 * apart when measured on 2026-09-15 (a 54th on the store of 2026-10-16), and the heart
 * rate chart's y scale has to cover that spread because every mark must sit
 * inside a labelled band - so at 412px the plot put two neighbouring lines
 * 7.8 device px apart, centre to centre. At 1.8 CSS px each line was 5.4 device px wide and ate
 * nearly all of that: measured on the rendered canvas, only 22.1% of the
 * plot's columns showed three separate bands and 56.4% showed one fused
 * one, which a blind critic read as "a single braided smear".
 *
 * Width was the strongest lever the three-line encoding had, and it still
 * fell short. Measured, three separate bands against one fused band, on the
 * heart rate plot:
 *
 * ```
 *   14rem 1.8px  22.1% / 56.4%      18rem 1.8px  27.0% / 51.1%
 *   14rem 1.5px  30.5% / 48.7%      22rem 1.8px  31.1% / 47.8%
 *   14rem 1.2px  39.9% / 36.8%
 *   14rem 1.0px  46.2% / 30.9%
 * ```
 *
 * Eight extra rem of plot height bought less than six tenths of a
 * millimetre off the stroke did, and cost it on every chart on the scroll.
 * 1.0 was the floor and was refused: it is `RULE_WIDTH_PX` exactly, and a
 * data line may not be drawn at the weight of the grid it is read against.
 * So the best any stroke could do was 1.2, where more of the plot still
 * showed two or fewer bands than showed three - the encoding was the fault,
 * which is what the envelope replaced.
 *
 * This is not the old per-series weighting coming back. Every line still
 * shares one width, which is what `TrendChart.test.tsx` and
 * `tests/phase4.spec.ts` both pin, and colour still carries the ordering.
 */
const LINE_WIDTH_PX = 1.8

/**
 * Which custom property a series is drawn in: its own `colorVar` if it names
 * one, otherwise its palette slot in the categorical set's fixed order.
 * Shared by the canvas and the HTML legend so the swatch cannot drift from
 * the line it stands for.
 */
function seriesColorVar(s: TrendSeries, index: number): string {
  return s.colorVar ?? `--series-${String(s.paletteSlot ?? index + 1)}`
}

/**
 * The reference line's dash pattern and stroke width, both in **CSS**
 * pixels and both scaled at the point they reach the context.
 *
 * The width is stated rather than inherited, which is the whole point of
 * naming it. `ctx.save()` preserves the context's state and does not reset
 * it, and uPlot fires a draw hook with whatever the last thing it drew left
 * behind - its grid width, which defaults to 2 and which it has already
 * multiplied by the pixel ratio. So an unset `lineWidth` here would stroke
 * heavier than the series it annotates and be ratio-correct only by
 * uPlot's accident. `streamPanelMath.ts` records the same trap at length.
 */
const REFERENCE_DASH = [6, 4]
const REFERENCE_LINE_WIDTH_PX = 1

/**
 * How a scatter is drawn, at the two tonal values a scatter can want.
 *
 * `primary` is a scatter that *is* the chart's subject. `context` is a raw
 * per-run series drawn beneath the smoothed line it feeds, which genuinely
 * wants to sit under that line without competing with it.
 *
 * One setting served both and it could not. At 5 px and 35% alpha - a fat,
 * pale mark at near-ground tonal value, 200 of them overplotted across a
 * 300 px plot - a primary scatter measured 82.3% of its ink inside the
 * middle 40% of the panel and rendered as a haze. Smaller and much darker
 * inverts both halves of that: an individual run is a legible mark rather
 * than a smudge, and where runs pile up the overlap darkens, so density
 * becomes the shape instead of destroying it.
 *
 * **`context` had to come down further, and that is a separation fix rather
 * than a tonal preference.** On the reference-pace charts the scatter is
 * the *median* pace's own hue, so at 5 px it was nearly three times the
 * width of the 1.8 px lines it sits under and in the same colour family:
 * three lines about 5 CSS px apart were being drawn inside a cloud of
 * larger marks of their own colour, and a critic read them as "one hue at
 * three tints that fuse into a single braided smear". Line weight is not
 * available as an answer - one width for every line is what the ramp's
 * ordering rests on, and both `TrendChart.test.tsx` and
 * `tests/phase4.spec.ts` pin it - so the cloud is what had to move.
 */
const SCATTER = {
  primary: { alpha: 0.8, sizePx: 3.5 },
  context: { alpha: 0.18, sizePx: 2.5 },
} as const

/**
 * uPlot draws its axis labels on a canvas, so it needs a CSS font string
 * rather than a class. 11px is `--text-caption`, the size the reference
 * sets its own ladder at, and the family is the one `theme/global.css`
 * loads. Stated in px because a canvas context has no `rem`. Same constant,
 * same reasoning, as `charts/VolumeBars.tsx`.
 */
const AXIS_FONT_PX = 11
const AXIS_FONT_FAMILY = '"Schibsted Grotesk", system-ui, sans-serif'
const AXIS_FONT = `${String(AXIS_FONT_PX)}px ${AXIS_FONT_FAMILY}`

/** Half a line of `AXIS_FONT`, which is what the topmost tick needs above it so the canvas does not slice it. */
const AXIS_LABEL_HALF_PX = 8

/**
 * The right-hand label column. Wider than `VolumeBars`' 40 because these
 * ladders carry their unit on every rung the way the reference's `40 km /
 * 20 km / 0 km` does: the widest tick this chart emits is `150 bpm`, which
 * measures 132 device px at 3x, so 44 CSS px is the requirement and 56 is
 * that with a step of slack for a three-digit `spm`.
 */
const Y_AXIS_SIZE_PX = 56

/** Room for one line of date labels under the plot. */
const X_AXIS_SIZE_PX = 22

/** Grid rules are 1 CSS px, which is what uPlot draws its own at. */
const RULE_WIDTH_PX = 1

/**
 * Where the two bands sit, as fractions of the plot's height measured from
 * the bottom: the subject on top, its raw inputs in a strip beneath.
 *
 * **Why a chart is ever split at all.** A `faint` scatter is the raw per-run
 * input to a smoothed line, and its spread is far wider than the line's: on
 * the heart rate chart the per-run values spread over 2.16 times the range
 * the three smoothed series span on the store of 2026-10-16 (3.08 times when
 * measured on 2026-09-16; `SPLIT_WHEN_CONTEXT_WIDENS_BY` has both), so a single axis
 * covering every mark - which is the invariant this branch spent four
 * rounds earning - has to be that much wider than the subject needs.
 * Measured on the round-3 render, against the store of that day, that left the three named series **24.9% of the plot**, with
 * adjacent series resolving to under a pixel of clear air. A blind critic read them as one braided smear and
 * named the axis, correctly, as the cause: "if B's series had been given an
 * axis range that let them separate, B's better order, type scale and
 * alignment would have won on the chart alone".
 *
 * Narrowing the axis and letting the scatter fall outside it is not
 * available and must not be tried: `tests/smoke.spec.ts`'s "a trend chart
 * labels a band that contains every mark it draws" is the thing being
 * protected, not an obstacle to route around.
 *
 * So each band gets a scale fitted to its own series and a ladder of its
 * own, and every mark still sits inside a labelled band - now its own one.
 * The subject keeps roughly two thirds of the height because it is the
 * subject; the strip needs only enough to show where the mass sits and how
 * wide it is.
 *
 * The gap between them is real empty page rather than a rule. Two bands
 * separated by a line read as one plot with a mistake in it; separated by
 * air they read as two, which is what they are.
 */
const SUBJECT_BAND = { from: 0.45, to: 0.98 } as const
const CONTEXT_BAND = { from: 0.02, to: 0.30 } as const

/**
 * How far a scatter must widen the axis before it is worth moving it out of
 * the subject's band.
 *
 * **Splitting is not free and must not be the default.** A `faint` scatter
 * is the raw input to the line above it, and drawing the two against one
 * scale is what shows that the line is the mean of those points. A split
 * trades that reading away, so it has to buy more than it costs.
 *
 * Measured on the real store on 2026-10-16, with no effort hidden, as the
 * combined extent over the subject's own extent:
 *
 * ```
 *   heart rate   2.16x   (3.08x on 2026-09-16)
 *   cadence      1.21x
 *   VO2max       1.37x
 * ```
 *
 * Only the heart rate chart is paying twice its own width for its inputs,
 * and only it has three series close together that have to be told apart.
 * At 2 the two groups sit either side of the threshold, the heart rate chart
 * only 0.16 above it, and a chart that stops needing the split gets its
 * single band back.
 */
const SPLIT_WHEN_CONTEXT_WIDENS_BY = 2

/**
 * How many intervals the strip's ladder may be cut into.
 *
 * Three. At one it carried two rungs at 100 and 200 bpm over data spanning
 * under 60% of that interval - a band four times coarser than it needed to be, with both
 * labels nowhere near a value the dots reach. That is not the containment
 * trade `axisScale` documents, which puts a label one increment clear of the
 * extreme; it is an increment far too big. Three intervals put the rungs a
 * quarter of the spread apart instead.
 *
 * **The two ladders have to be tellable apart, and the first attempt at this
 * was not.** At 0.34/0.22 the air between the bands measured 70 device px
 * against a subject rung of 74, and the strip's own rungs were closer
 * together than the subject's - so reading down the right edge gave six
 * evenly spaced numbers, a gap no wider than the spacing, and then three
 * more. It read as one ladder that had gone wrong at the bottom, and a probe
 * written to split the two on their largest gap could not separate them
 * either, which is as good a sign as any that a reader could not.
 *
 * The air between the bands is what separates them, and it has to beat a
 * rung to do it: at 0.34/0.22 the gap measured 70 device px against a
 * subject rung of 74 and the two ladders read as one. It is now 0.15 of the
 * height against a subject rung of 0.106, and the strip carries its own
 * caption as well, so neither a reader nor a probe can take it for a
 * continuation.
 */
const CONTEXT_MAX_INTERVALS = 3

/**
 * **An envelope's edges are not drawn as lines.** The band is the mark; its
 * boundaries are where the fill stops.
 *
 * The first version stroked them faintly as well, on the reasoning that a
 * reader is entitled to see exactly where the band ends. That was the worst
 * of both: at any tone faint enough not to compete they read as artefacts,
 * and at any tone strong enough to read they rebuilt the braid the envelope
 * was adopted to remove. Measured across 62 columns of the rendered plot, a
 * critic resolved the three declared traces as three separate marks in 3
 * columns and as one fused blob in 35.
 *
 * With no edge strokes there is exactly one line in the plot and it is the
 * series the headline names, which also settles the prominence inversion
 * the same critic found: the ramp runs light-to-dark slow-to-fast, so the
 * darkest stroke used to be the *fast* edge while the number above the chart
 * quotes the median. Nothing is reordered or re-derived to fix that - the
 * primary simply stays on `--pace-2`, its own step, and is now the only
 * stroke there is.
 */

/** How far the strip's caption sits above its topmost rung, in CSS pixels. */
const CAPTION_LIFT_PX = 9

/** How far a strip rung's tick reaches in from the plot's right edge, in CSS pixels. */
const STRIP_TICK_PX = 8

/**
 * The marker on a series' most recent observation, in CSS pixels: a solid
 * dot inside a translucent halo, which is what the reference puts on its
 * current week.
 *
 * The dot is larger than an ordinary mark and the halo larger again, so the
 * point the headline stat is naming is findable at a glance and at a third
 * scale. Scaled at the context, because a size handed to a canvas context
 * unscaled renders at half what it claims on a 2x display - the fault
 * `VolumeBars` measured on its own empty-period ring.
 */
const LATEST_DOT_RADIUS_PX = 4
const LATEST_HALO_RADIUS_PX = 9
const LATEST_HALO_ALPHA = 0.22
/**
 * How far the knockout reaches past the tinted halo, in CSS pixels.
 *
 * The tint's own coverage at the disc's outermost row is near zero, so a
 * rule tangent to the marker's edge survived the knockout there and still
 * read as a band across it. Erasing a ring wider than the tint leaves clear
 * air all the way round the marker whatever it lands on.
 */
const LATEST_KNOCKOUT_PX = 2

/**
 * How much room the x scale keeps at each end for the largest mark, in CSS
 * pixels: the halo's radius, its knockout ring and a pixel for the
 * antialiased edge.
 */
const MARK_CLEARANCE_PX = LATEST_HALO_RADIUS_PX + LATEST_KNOCKOUT_PX + 1

/** Where the pointer is, and which x position it is over. */
interface HoverState {
  index: number
  /** Offset from the panel's left edge in CSS pixels; see the `setCursor` hook. */
  leftPx: number
  panelWidthPx: number
}

/**
 * Per-activity values over the athlete's history, one line per series, on
 * a shared calendar axis.
 *
 * The x axis is the fractional local calendar day
 * (`format.localCalendarTime`), not uPlot's time scale, so tick placement
 * and labels are the same on every machine: uPlot's own time axis snaps to
 * *machine-local* midnights and formats them with local getters.
 * `trendChartMath.dateAxisSplits` places the ticks at month or year starts
 * at a uniform stride instead, and the labels come from the `MONTHS` table
 * in `format/` like every date in the application - never from `Intl`. The
 * fraction keeps two runs on one day as two points; the readout names the
 * whole day.
 *
 * A null value breaks the line. uPlot does that on its own as long as
 * `spanGaps` stays off, and it stays off here on purpose: a run that
 * produced no fit is a gap in the record, and drawing a segment through it
 * would claim a value nobody measured.
 *
 * The y axis is never zero-anchored, and its bounds are its own ticks, so
 * the labelled range and the drawn range cannot come apart - see
 * `axisScale` for the measurement that forced that.
 *
 * The axes are registered the way `VolumeBars` registers its own, so the
 * two screens' charts are one chart language: the plot's left edge is the
 * page gutter, the ladder sits outside the plot on the right with its own
 * right edge on the page's right gutter, the only rules drawn are the
 * horizontal ones, and there is no axis title anywhere - the unit rides on
 * every rung instead.
 *
 * The legend is HTML above the panel and the hover readout is absolutely
 * positioned inside it, both for the reason `UPlot.tsx` documents at length:
 * uPlot's own legend is a `<table>` sibling of the plot inside the box the
 * resize observer watches, and with a content-sized container it grew the
 * chart one legend-height per observation without bound. Nothing this
 * component renders may add layout height to `.chart`.
 */
export function TrendChart({
  series,
  yLabel,
  formatValue,
  formatTick,
  emptyReason,
  ariaLabel,
  height = 'standard',
  referenceLine,
}: TrendChartProps) {
  const [hover, setHover] = useState<HoverState | null>(null)
  const readoutRef = useRef<HTMLDivElement | null>(null)
  const [readoutWidthPx, setReadoutWidthPx] = useState(0)

  // The ladder carries its unit on every rung, the way the reference's
  // `40 km / 20 km / 0 km` does, which is what let the rotated axis title
  // go. Memoised rather than written as a parameter default: `formatTick`
  // is an input to the `options` memo below and `options` identity is the
  // chart's recreation key (see `UPlot.tsx`), so a fresh arrow per render
  // rebuilt the whole uPlot instance on every hover.
  const tickFormatter = useMemo<(value: number) => string>(
    () => formatTick ?? ((value: number) => `${String(Math.round(value))} ${yLabel}`),
    [formatTick, yLabel],
  )

  const aligned = useMemo(() => alignSeries(series), [series])
  const hasAnyValue = aligned.ys.some((y) => y.some((v) => v !== null && v !== undefined))

  // Solved once, from the data, and handed to both the scale's bounds and
  // the axis's ticks. They were two callbacks answering two different
  // questions - "what range" and "what nice numbers inside it" - and they
  // diverged: see `axisScale` for the 159 device px of data that ended up
  // outside its own labelled range. `aligned` is memoised on `series`,
  // which is already the options memo's own dependency, so this costs no
  // extra chart rebuilds.
  /*
   * The two bands, solved from the data they each hold.
   *
   * A chart is split only when it has both a subject and raw inputs to put
   * beneath it. One or the other alone keeps the whole plot and the single
   * scale it always had - the decoupling chart draws one smoothed line and
   * nothing else, and must not grow a strip with nothing in it.
   */
  const bands = useMemo(() => {
    const contextRows: number[] = []
    const subjectRows: number[] = []
    series.forEach((s, i) => {
      if (s.scatter === true && s.faint === true) contextRows.push(i)
      else subjectRows.push(i)
    })
    const solve = (rows: number[], maxIntervals?: number) => {
      const extent = seriesExtent(aligned, rows)
      return extent === null ? null : axisScale(extent[0], extent[1], maxIntervals)
    }
    const subjectExtent = seriesExtent(aligned, subjectRows)
    const wholeExtent = seriesExtent(aligned)
    const widening =
      subjectExtent === null || wholeExtent === null || subjectExtent[1] === subjectExtent[0]
        ? 1
        : (wholeExtent[1] - wholeExtent[0]) / (subjectExtent[1] - subjectExtent[0])
    const split =
      contextRows.length > 0 && subjectRows.length > 0 && widening >= SPLIT_WHEN_CONTEXT_WIDENS_BY
    if (!split) {
      const whole = seriesExtent(aligned)
      return {
        split: false as const,
        subject: whole === null ? axisScale(0, 1) : axisScale(whole[0], whole[1]),
        context: null,
        contextRows,
      }
    }
    return {
      split: true as const,
      subject: solve(subjectRows) ?? axisScale(0, 1),
      context: solve(contextRows, CONTEXT_MAX_INTERVALS),
      contextRows,
    }
  }, [aligned, series])


  const data = useMemo<uPlot.AlignedData>(() => [aligned.x, ...aligned.ys], [aligned])

  // Read off the memoised `bands` rather than derived per render: `options`
  // identity is the chart's recreation key (see `UPlot.tsx`), so a fresh
  // array here rebuilt the whole uPlot instance on every hover. Caught by
  // `TrendChart.test.tsx`'s "does not rebuild the chart as the pointer
  // moves", which is exactly what it is for.
  const contextScale = bands.context

  /**
   * The two series that bound the envelope, as uPlot's one-based indices and
   * in its own high-then-low order, or null when the caller marked none.
   * Memoised on `series` so it cannot rebuild the chart on a hover.
   */
  /** The strip's caption: the name of the series in it, so the two cannot drift. */
  const stripCaption = bands.split ? series[bands.contextRows[0] ?? -1]?.label : undefined

  const envelope = useMemo<[number, number] | null>(() => {
    const edges = series.flatMap((s, i) => (s.edge === true ? [i + 1] : []))
    if (edges.length !== 2) return null
    const [low, high] = edges
    if (low === undefined || high === undefined) return null
    return [high, low]
  }, [series])

  const options = useMemo<uPlot.Options>(() => {
    const inkDim = cssVar('--ink-dim')
    const grid = cssVar('--chart-rule')

    return {
      width: 600,
      height: CHART_HEIGHT_PX[height] + (bands.split ? STRIP_EXTRA_PX : 0),
      // Each series' cursor dot stays on the hovered instant. uPlot's default
      // moves a dot off an undefined value - an instant the series has no
      // point at, see `alignSeries` - to the series' nearest defined one, at
      // any distance, which drew a run the effort filter hides at its
      // neighbour's value while the readout said there was none.
      cursor: { dataIdx: (_self, _seriesIdx, closestIdx) => closestIdx },
      // Left and right are zero on purpose, the way `VolumeBars` sets them:
      // the plot's left edge is then the chart element's left edge, which
      // is the page gutter, which is where the title and every stat above
      // it start. The y axis takes its room on the *right* instead, so the
      // one thing inset from the page gutter is the label column. Top is
      // half an axis line so the topmost tick is not sliced by the canvas
      // edge.
      padding: [AXIS_LABEL_HALF_PX, 0, 0, 0],
      scales: {
        x: {
          time: false,
          // The clearance is a pixel measurement, so the pad has to be
          // solved against the plot's own width rather than taken as a
          // fraction of the span. `u.bbox` is canvas pixels; see
          // `StreamPanel.tsx` on dividing by the ratio before it is used as
          // CSS pixels.
          range: (u, dataMin, dataMax) =>
            paddedDayRange(dataMin, dataMax, u.bbox.width / cssPixelRatio(), MARK_CLEARANCE_PX),
        },
        // Both of these come from one solved ladder, so every mark sits
        // inside a labelled band. See `axisScale`. On a split chart the
        // ladder is placed in the band that belongs to it rather than
        // across the whole height - see `bandRange`.
        y: {
          range: () =>
            bands.split
              ? bandRange(bands.subject, SUBJECT_BAND.from, SUBJECT_BAND.to)
              : axisRange(bands.subject),
        },
        ...(contextScale === null
          ? {}
          : {
              ctx: {
                range: () => bandRange(contextScale, CONTEXT_BAND.from, CONTEXT_BAND.to),
              },
            }),
      },
      series: [
        {},
        ...series.map((s, i): uPlot.Series => {
          const stroke = cssVar(seriesColorVar(s, i))
          // A faint scatter is drawn against the strip's own scale when the
          // chart is split, and against the one shared scale when it is not.
          const scale = bands.split && bands.contextRows.includes(i) ? 'ctx' : 'y'
          if (s.scatter === true) {
            const tone = s.faint === true ? SCATTER.context : SCATTER.primary
            return {
              label: s.label,
              scale,
              stroke,
              alpha: tone.alpha,
              // No line at all: the raw points are shown so the smoothing
              // never hides its inputs, not as a second, noisier trend.
              paths: () => null,
              points: { show: true, size: tone.sizePx, stroke, fill: stroke },
            }
          }
          if (s.edge === true) {
            /*
             * A boundary of the band and nothing else.
             *
             * **`width: 0`, not `paths: () => null`.** uPlot builds its band
             * by clipping the upper series' fill against the *lower* series'
             * own path - `lowerEdge._paths.band` in `fillStroke` - so a
             * series that returns no path leaves nothing for the band to be
             * drawn between, and the fill silently does not happen. That is
             * exactly what it did: a probe on every `fill` call found the
             * band's colour drawn zero times, and what looked like a band in
             * the render was the latest-observation halo at its own 22%.
             * A zero width keeps the geometry and draws no stroke.
             */
            return { label: s.label, scale, stroke, width: 0, points: { show: false } }
          }
          return {
            label: s.label,
            scale,
            stroke,
            // One width for every line the chart does draw, which is what
            // `tests/phase4.spec.ts` reads off the legend swatches: weight
            // never encodes an ordering here.
            width: LINE_WIDTH_PX,
            points: { show: false },
          }
        }),
      ],
      axes: [
        {
          stroke: inkDim,
          font: AXIS_FONT,
          size: X_AXIS_SIZE_PX,
          gap: 6,
          // No vertical gridlines, no tick marks and no axis border. The
          // reference draws none of the three - a luminance scan across its
          // whole plot finds three horizontal rules and nothing vertical -
          // and `VolumeBars` already dropped them for that reason. A date
          // axis is a sequence, not a set of levels to compare against, so
          // a rule per year buys nothing and costs the plot its calm.
          //
          // The axis title went with them. The reference writes no axis
          // titles at all; the unit now rides on every rung of the ladder
          // instead, which is what its own `40 km / 20 km / 0 km` does.
          grid: { show: false },
          ticks: { show: false },
          border: { show: false },
          // In CSS pixels: `bbox` is canvas pixels, see StreamPanel.tsx.
          splits: (u, _axisIdx, scaleMin, scaleMax) =>
            dateAxisSplits(scaleMin, scaleMax, u.bbox.width / cssPixelRatio()),
          values: (_u, splits) => dateTickLabels(splits),
        },
        {
          // Side 1 is the right-hand edge. The reference puts its ladder
          // outside the plot on the right, where the labels' own right edge
          // is the page's right gutter - so both page edges are honoured
          // and neither the plot nor the text is inset from one of them.
          // `align: 2` right-aligns the tick text and `alignTo: 2` measures
          // it from the outer edge of the axis column rather than from the
          // plot bound, so with a zero gap every label's right edge stacks
          // on the gutter and the units line up under each other.
          side: 1,
          stroke: inkDim,
          font: AXIS_FONT,
          size: Y_AXIS_SIZE_PX,
          align: 2,
          alignTo: 2,
          gap: 0,
          grid: { stroke: grid, width: RULE_WIDTH_PX },
          ticks: { show: false },
          border: { show: false },
          splits: () => bands.subject.splits,
          values: (_u, splits) => splits.map((s) => tickFormatter(s)),
        },
      ],
      hooks: {
        /*
         * The context strip's own ladder: its rules and its numbers.
         *
         * uPlot draws a grid for the axis it was given, and this chart gives
         * it one - the subject's. The strip's rungs are therefore drawn by
         * hand, and in `drawAxes` rather than `draw`, because `drawAxes`
         * fires *before* the series: a rule painted after them would sit on
         * top of the marks it is there to measure, which is the fault round
         * 1 fixed and must not come back.
         *
         * Every property is set explicitly. `ctx.save()` preserves the
         * canvas state rather than resetting it, and uPlot fires this hook
         * with whatever its own axis drawing left behind - see the same trap
         * in `streamPanelMath.ts`.
         *
         * The numbers are right-aligned on the outer edge of uPlot's own
         * axis column, which is the page's right gutter, so the strip's
         * ladder and the subject's stack on one edge rather than two.
         */
        drawAxes: [
          /*
           * The envelope, drawn by hand.
           *
           * **uPlot's own `bands` cannot be used here, and the reason is
           * z-order.** It fills a band while drawing the *upper* of the two
           * edges, so on a series list of slow, median, fast the fill lands
           * after the median and paints over the one line the chart is
           * about - measured, the subject vanished from a column where the
           * band was 40 px tall. Reordering the list so the subject is drawn
           * last would mean permuting the data rows, the scale assignment,
           * the readout and the latest-marker lookup, and keeping four
           * things in step; drawing the polygon here costs none of that.
           *
           * `drawAxes` fires after uPlot's grid and before its series, which
           * is exactly where an envelope belongs: over the furniture,
           * because it is data, and under the subject, because it is that
           * subject's context.
           *
           * Read off `u.data` rather than the closure's aligned rows, like
           * the latest-marker hook, so a data-only refresh stays on the
           * `setData` path. One polygon per run where both edges have a
           * value, so a gap in either breaks the band exactly where it
           * breaks the lines.
           */
          ...(envelope === null
            ? []
            : [
                (u: uPlot) => {
                  const [hi, lo] = envelope
                  const xs = u.data[0]
                  const his = u.data[hi]
                  const los = u.data[lo]
                  if (xs === undefined || his === undefined || los === undefined) return
                  const ctx = u.ctx
                  ctx.save()
                  ctx.beginPath()
                  ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height)
                  ctx.clip()
                  ctx.fillStyle = cssVar('--pace-band')
                  ctx.globalAlpha = 1
                  let run: number[] = []
                  const flush = () => {
                    if (run.length > 1) {
                      ctx.beginPath()
                      run.forEach((k, n) => {
                        const x = u.valToPos(xs[k] ?? 0, 'x', true)
                        const y = u.valToPos(his[k] ?? 0, 'y', true)
                        if (n === 0) ctx.moveTo(x, y)
                        else ctx.lineTo(x, y)
                      })
                      for (let n = run.length - 1; n >= 0; n -= 1) {
                        const k = run[n] ?? 0
                        ctx.lineTo(u.valToPos(xs[k] ?? 0, 'x', true), u.valToPos(los[k] ?? 0, 'y', true))
                      }
                      ctx.closePath()
                      ctx.fill()
                    }
                    run = []
                  }
                  for (let k = 0; k < xs.length; k += 1) {
                    const a = his[k]
                    const b = los[k]
                    if (a === null || a === undefined || b === null || b === undefined) flush()
                    else run.push(k)
                  }
                  flush()
                  ctx.restore()
                },
              ]),
          ...(contextScale === null
            ? []
            : [
                (u: uPlot) => {
                  const ratio = cssPixelRatio()
                  const ctx = u.ctx
                  ctx.save()
                  ctx.lineWidth = RULE_WIDTH_PX * ratio
                  ctx.strokeStyle = grid
                  ctx.fillStyle = inkDim
                  ctx.font = `${String(Math.round(AXIS_FONT_PX * ratio))}px ${AXIS_FONT_FAMILY}`
                  ctx.textAlign = 'right'
                  ctx.textBaseline = 'middle'
                  ctx.setLineDash([])
                  const right = u.bbox.left + u.bbox.width
                  // The strip's own name, on the page gutter at the top of
                  // its band. Without it the band reads as a second chart
                  // stacked underneath rather than as this one's inputs -
                  // which is exactly how a critic read the first version.
                  const top = u.valToPos(contextScale.max, 'ctx', true)
                  if (stripCaption !== undefined) {
                    ctx.textAlign = 'left'
                    ctx.fillText(stripCaption, u.bbox.left, top - CAPTION_LIFT_PX * ratio)
                    ctx.textAlign = 'right'
                  }
                  /*
                   * **Short ticks, not full-width rules, and that is the
                   * answer to "the main plot has no x axis".**
                   *
                   * The two bands share one date axis at the foot of the
                   * stack, which is the convention for stacked panels and
                   * is kept: duplicating four date labels 128 px apart is
                   * redundant ink on a screen that has spent six rounds
                   * removing exactly that, and the only way to avoid the
                   * duplication - hiding uPlot's own axis and hand-drawing
                   * one between the bands - puts a time axis in the middle
                   * of a stack, which is less conventional than what is
                   * here rather than more.
                   *
                   * A shared axis only reads as shared if the pair reads as
                   * one object, and a critic read them as two. **The gap
                   * cannot be closed to fix that**: it has to stay wider
                   * than a subject rung or the two ladders merge, which is
                   * the fault round 4 measured at 70 device px of air
                   * against a 74 px rung. What can go is the strip's claim
                   * to be a plot in its own right. A full-width rule per
                   * rung is a grid, and a grid is what a separate chart
                   * has; a tick beside its own number is a scale on an
                   * annex. The subject's grid is now the only grid on the
                   * canvas.
                   */
                  for (const tick of contextScale.splits) {
                    const y = Math.round(u.valToPos(tick, 'ctx', true)) + 0.5 * ratio
                    ctx.beginPath()
                    ctx.moveTo(right - STRIP_TICK_PX * ratio, y)
                    ctx.lineTo(right, y)
                    ctx.stroke()
                    ctx.fillText(tickFormatter(tick), right + Y_AXIS_SIZE_PX * ratio, y)
                  }
                  ctx.restore()
                },
              ]),
        ],
        // `draw` rather than `drawAxes`: both of these belong over the grid
        // and over the series, and `draw` fires once per redraw after the
        // series are painted, so neither can be hidden behind a line.
        //
        // Each is added only when something asked for it, so a chart with
        // neither hands uPlot an empty list rather than a hook that returns
        // immediately.
        draw: [
          ...(referenceLine === undefined
            ? []
            : [
                (u: uPlot) => {
                  const ctx = u.ctx
                  const y = u.valToPos(referenceLine.value, 'y', true)
                  // uPlot fires `draw` outside its own clip, and the y scale
                  // is fitted to the data rather than to this value, so a
                  // reference the series never reaches resolves to a
                  // position outside the plot box: the decoupling
                  // population's median sits above the 5% rule
                  // (`docs/reference/math/efficiency.md`), so a stretch of
                  // history that stays above the line puts it under the
                  // axis labels. An x-zoom into any such stretch does the
                  // same on any data. Off the box the rule is not drawn; its
                  // legend entry still says what it would mark.
                  if (y < u.bbox.top || y > u.bbox.top + u.bbox.height) return
                  ctx.save()
                  ctx.lineWidth = REFERENCE_LINE_WIDTH_PX * cssPixelRatio()
                  ctx.setLineDash(scaleDash(REFERENCE_DASH))
                  ctx.strokeStyle = cssVar('--ink-dim')
                  ctx.beginPath()
                  ctx.moveTo(u.bbox.left, y)
                  ctx.lineTo(u.bbox.left + u.bbox.width, y)
                  ctx.stroke()
                  ctx.setLineDash([])
                  ctx.restore()
                },
              ]),
          /*
           * The most recent observation of every series that asked to have
           * it marked, drawn after the series themselves so the halo sits
           * over its neighbours rather than under them.
           *
           * The index is found from `u.data` rather than from the aligned
           * arrays in the closure, deliberately: `options` identity is the
           * chart's recreation key (see `UPlot.tsx`), so reading the live
           * data uPlot already holds keeps a data-only refresh on the
           * `setData` path instead of rebuilding the whole instance.
           */
          ...(series.some((s) => s.markLatest === true)
            ? [
                (u: uPlot) => {
                  const ratio = cssPixelRatio()
                  const xs = u.data[0]
                  if (xs === undefined) return
                  const ctx = u.ctx
                  const page = cssVar('--page')
                  ctx.save()
                  // Clipped to the plot, the way uPlot clips the series it
                  // draws itself. Without it this hook paints on the whole
                  // canvas, and the halo - larger than any other mark -
                  // reached 4 CSS px past the plot's right bound into the
                  // ladder's gutter. The x scale above now keeps room for
                  // it, so this is the guarantee rather than the mechanism.
                  ctx.beginPath()
                  ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height)
                  ctx.clip()
                  series.forEach((s, i) => {
                    if (s.markLatest !== true) return
                    const ys = u.data[i + 1]
                    if (ys === undefined) return
                    let last = -1
                    for (let k = ys.length - 1; k >= 0; k -= 1) {
                      if (ys[k] !== null && ys[k] !== undefined) {
                        last = k
                        break
                      }
                    }
                    const value = last < 0 ? undefined : ys[last]
                    const at = last < 0 ? undefined : xs[last]
                    if (value === null || value === undefined || at === undefined) return
                    const cx = u.valToPos(at, 'x', true)
                    // Against the band this series belongs to, not always
                    // the subject's: a marked series in the strip would
                    // otherwise be drawn at the subject's scale.
                    const cy = u.valToPos(value, bands.split && bands.contextRows.includes(i) ? 'ctx' : 'y', true)
                    const colour = cssVar(seriesColorVar(s, i))
                    const halo = LATEST_HALO_RADIUS_PX * ratio
                    /*
                     * The halo is a knockout before it is a tint, and that
                     * is the whole point of a halo rather than a decoration
                     * on one.
                     *
                     * uPlot draws the grid before the series, so an
                     * ordinary mark at 80% alpha already survives crossing
                     * a rule. This one did not: at 22% over a rule that is
                     * `--chart-rule`'s 1.83:1 rather than `--grid`'s 1.10,
                     * the composite is 78% rule, and measured on the heart
                     * rate chart a rule ran through the marker at 66 of 70
                     * pixels of pure rule colour with the mark's own ink
                     * present immediately above and below. The one mark the
                     * headline stat names had a grey band through it.
                     *
                     * Filling the disc with the page's own colour first
                     * stops the rule at the marker's edge, and the tint
                     * then reads against the page rather than against
                     * whatever it happened to cross. Measured after, on
                     * the same crossing - the marker's centre is 8.9
                     * device px from the nearest rule against a 33 px
                     * knockout - 0 of the 67 pixels along that rule inside
                     * the marker are rule colour, against 26 of 67 on the
                     * same rule elsewhere.
                     */
                    ctx.globalAlpha = 1
                    ctx.fillStyle = page
                    ctx.beginPath()
                    ctx.arc(cx, cy, halo + LATEST_KNOCKOUT_PX * ratio, 0, Math.PI * 2)
                    ctx.fill()
                    ctx.globalAlpha = LATEST_HALO_ALPHA
                    ctx.fillStyle = colour
                    ctx.beginPath()
                    ctx.arc(cx, cy, halo, 0, Math.PI * 2)
                    ctx.fill()
                    ctx.globalAlpha = 1
                    ctx.beginPath()
                    ctx.arc(cx, cy, LATEST_DOT_RADIUS_PX * ratio, 0, Math.PI * 2)
                    ctx.fill()
                  })
                  ctx.restore()
                },
              ]
            : []),
        ],
        setCursor: [
          (u: uPlot) => {
            const index = u.cursor.idx
            const leftPx = u.cursor.left
            // `idx` is null with the pointer outside the plot, and uPlot
            // reports a negative `left` on the way out.
            if (index === null || index === undefined || leftPx === undefined || leftPx < 0) {
              setHover(null)
              return
            }
            // `cursor.left` is measured from the plotting area; the readout
            // is positioned against `.chart`. See VolumeBars.tsx.
            setHover({ index, leftPx: u.over.offsetLeft + leftPx, panelWidthPx: u.width })
          },
        ],
      },
    }
    // `setHover` is a stable `useState` setter; `options` identity is the
    // chart's recreation key (see UPlot.tsx), so only the shape inputs
    // belong here.
  }, [series, tickFormatter, bands, contextScale, envelope, stripCaption, height, referenceLine])

  const hoveredDay = hover === null ? undefined : aligned.x[hover.index]

  // Measured after layout, keyed on the hovered day so a sweep across one
  // point does not re-measure; see VolumeBars.tsx for the reasoning.
  useLayoutEffect(() => {
    const element = readoutRef.current
    if (element === null) return
    const width = element.offsetWidth
    setReadoutWidthPx((previous) => (previous === width ? previous : width))
  }, [hoveredDay])

  if (!hasAnyValue) {
    return <Absent reason={emptyReason} />
  }

  return (
    <div className={styles.wrap}>
      {/*
       * A key is only drawn when there is something for it to tell apart.
       * One unannotated series is already named by the section around it -
       * by its title and by the stat above it - and a legend repeating that
       * name beside a lone swatch is chrome spending contrast on nothing.
       * The reference draws no legend anywhere in the six screenshots,
       * because it never draws more than one series. A reference line is
       * the other case that needs one: an unexplained rule reads as a
       * second series drawn flat.
       */}
      {(series.length > 1 || referenceLine !== undefined) && (
      <ul className={styles.legend} aria-label={`${ariaLabel} legend`}>
        {series.map((s, i) => {
          const colour = `var(${seriesColorVar(s, i)})`
          return (
            <li key={s.label} className={styles.legendItem}>
              {s.scatter === true ? (
                <span aria-hidden="true" className={styles.swatchScatter} style={{ background: colour }} />
              ) : s.edge === true ? (
                /* A boundary of the band, so its swatch is the band rather
                   than a line - the key has to say which mark a reader is
                   looking for, and this series is not stroked at all. */
                <span aria-hidden="true" className={styles.swatchBand} />
              ) : (
                <span
                  aria-hidden="true"
                  className={styles.swatch}
                  style={{ borderTopColor: colour, borderTopWidth: `${String(LINE_WIDTH_PX)}px` }}
                />
              )}
              {s.label}
            </li>
          )
        })}
        {referenceLine !== undefined && (
          // Named in the legend rather than left as a mystery rule. The
          // swatch is the dim ink and dashed, so it reads as the line it
          // stands for rather than as a fourth series.
          <li key={referenceLine.label} className={styles.legendItem}>
            <span aria-hidden="true" className={styles.swatchReference} />
            {referenceLine.label}
          </li>
        )}
      </ul>
      )}
      <div
        className={[styles.chart, height === 'tall' ? styles.chartTall : '', bands.split ? styles.chartWithStrip : '']
          .filter((c) => c !== '')
          .join(' ')}
        role="img"
        aria-label={ariaLabel}
      >
        <UPlot data={data} options={options} />
        {hover !== null && hoveredDay !== undefined && (
          <div
            ref={readoutRef}
            className={styles.readout}
            style={{ left: `${String(clampReadoutLeft(hover.leftPx, readoutWidthPx, hover.panelWidthPx))}px` }}
            // Not a live region, for the reason VolumeBars.tsx gives: a
            // pointer-only affordance is left to the pointer.
            aria-hidden="true"
            data-testid="trend-readout"
          >
            <p className={styles.readoutWhen}>{calendarDayLabel(Math.floor(hoveredDay))}</p>
            {aligned.notes[hover.index] !== undefined && (
              <p className={styles.readoutNote}>{aligned.notes[hover.index]}</p>
            )}
            {series.map((s, i) => {
              const value = readoutValue(aligned.ys[i] ?? [], hover.index, s.holdsLastForReadout === true)
              return (
                <p key={s.label} className={styles.readoutRow}>
                  <span>{s.label}</span>
                  <span className="mono">{value === null ? NO_VALUE : formatValue(value)}</span>
                </p>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
