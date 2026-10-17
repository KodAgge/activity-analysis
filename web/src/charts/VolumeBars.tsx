import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import { distance, duration, shortCalendarDate, shortCalendarMonth } from '../format'
import { cssPixelRatio } from './canvasPixels'
import { cssVar } from './cssVar'
import { UPlot } from './UPlot'
import {
  barGeometry,
  barScaleRange,
  emptyMarkGeometry,
  bucketHeading,
  clampReadoutLeft,
  periodTickIndices,
  trailingMean,
  volumeScale,
  type VolumeBucket,
} from './volumeBarsMath'
import styles from './VolumeBars.module.css'

export interface VolumePeriod {
  period_start: string
  runs: number
  distance_m: number
  moving_time_s: number
}

export type VolumeMetric = 'distance' | 'moving_time' | 'runs'

export interface VolumeBarsProps {
  /**
   * A dense series - one entry per calendar period in the window, zeros
   * included. See docs/reference/api.md, "GET /api/overview": before
   * 2026-08-30 the weekly series held only weeks with a run, and a client
   * drawing them index by index closed the gaps and showed a training
   * history with no weeks off in it. This component must never filter
   * `periods` to reintroduce that fault.
   */
  periods: VolumePeriod[]
  metric: VolumeMetric
  /**
   * Which calendar period one bar covers. Required, because the hover
   * readout names the period and nothing in `periods` says which series
   * this is - see `bucketHeading` in `volumeBarsMath.ts`.
   */
  bucket: VolumeBucket
  /**
   * Mark every period whose `runs` is 0 with an open ring on the baseline,
   * in the accent colour, so a week off reads as a deliberate "no runs"
   * rather than as a bar too short to see - and, being a circle, cannot be
   * read as a small bar either. See `emptyMarkGeometry`.
   */
  markEmpty?: boolean
  /**
   * How the x axis labels a tick. `dayMonth` (the default) is `4 Aug`,
   * which is right for the twelve-week chart, where every tick is inside
   * one or two months and the year is never in doubt.
   *
   * `monthYear` is `Aug 2026`, for the full-history strip: 148 weekly bars
   * of bare day and month repeat the same twelve names over three years
   * without saying which year one of them is. It is opt-in rather than
   * chosen from `bucket`, because both charts are weekly and it is the
   * span rather than the bucket that decides which form reads.
   */
  axisLabel?: 'dayMonth' | 'monthYear'
  /**
   * Draw at the strip height rather than the full chart height. For a
   * series long enough that the bars are a texture rather than twelve
   * individually readable quantities - the Overview's full history is 148
   * weeks - where the same height as the hero chart claims the same
   * importance.
   */
  compact?: boolean
  /**
   * Draw a trailing average of the metric as a line over the bars: the mean
   * of each period and the `window - 1` before it, up to `lastIndex`, the
   * last period the store knows about. See `trailingMean` and
   * `trendLastIndex`, which the caller uses to find `lastIndex`.
   */
  trend?: { window: number; lastIndex: number }
}

function metricValue(period: VolumePeriod, metric: VolumeMetric): number {
  switch (metric) {
    case 'distance':
      return period.distance_m
    case 'moving_time':
      return period.moving_time_s
    case 'runs':
      return period.runs
  }
}

function formatMetricTick(value: number, metric: VolumeMetric): string {
  switch (metric) {
    case 'distance':
      return distance(value, 0)
    case 'moving_time':
      return duration(value)
    case 'runs':
      return String(Math.round(value))
  }
}

/**
 * An average of the metric, for the readout. An average of whole runs is
 * fractional, so it keeps one decimal where a count would have none.
 */
function formatMetricAverage(value: number, metric: VolumeMetric): string {
  switch (metric) {
    case 'distance':
      return distance(value)
    case 'moving_time':
      return duration(value)
    case 'runs':
      return value.toFixed(1)
  }
}

const METRIC_LABEL: Record<VolumeMetric, string> = {
  distance: 'Distance',
  moving_time: 'Moving time',
  runs: 'Runs',
}

/**
 * The empty-period mark, in CSS pixels, scaled at the context. An open ring
 * the width of a bar, resting on the baseline - see `emptyMarkGeometry`,
 * which carries why it is a ring and not a rectangle of any size.
 *
 * 12 px is the cap on a wide desktop plot, 3 px the floor in the 148-week
 * history strip where a slot is about 2 px wide, and the 2 px stroke is
 * what keeps the ring an object rather than a hairline; at the floor the
 * stroke clamps to the radius and the ring resolves into a solid dot.
 */
const EMPTY_MARK_MAX_DIAMETER_PX = 12
const EMPTY_MARK_MIN_DIAMETER_PX = 3
const EMPTY_MARK_STROKE_PX = 2

/**
 * Bar geometry, in CSS pixels, handed to `barGeometry` scaled at the
 * context. See that function for why each one exists.
 */
const BAR_WIDTH_FACTOR = 0.62
const BAR_MAX_WIDTH_PX = 48
const BAR_MIN_HEIGHT_PX = 2
const BAR_RADIUS_FACTOR = 0.18

/**
 * The trend line, in CSS pixels. The halo is the page colour drawn under
 * it, so where the line crosses a bar it reads as one line passing in front
 * rather than as ink merging into the bar's edge.
 */
const TREND_LINE_PX = 2
const TREND_HALO_PX = 5

/** Grid rules are 1 CSS px, which is what uPlot draws its own at. */
const RULE_WIDTH_PX = 1

/**
 * The panel's height in CSS pixels, full and `compact`: `--chart-height`
 * (11rem) and `--chart-strip` (7rem) in `theme/tokens.css` at the 16px root,
 * which are what size the box around the canvas.
 *
 * These must agree with those tokens, for the reason `CHART_HEIGHT_PX` in
 * `TrendChart.tsx` gives: the box's height is imposed from outside and never
 * content-sized, and the ResizeObserver only corrects a mismatch after the
 * first paint, so a canvas constructed at any other height draws one frame
 * at the wrong size. `VolumeBars.test.tsx` pins both to the tokens file.
 */
const VOLUME_BARS_HEIGHT_PX = { full: 176, compact: 112 } as const

/**
 * A rectangle with its two top corners rounded, drawn by hand rather than
 * with `ctx.roundRect`, whose per-corner radius argument is newer than the
 * browsers this has to run in. The bottom sits flat on the baseline: a bar
 * rests on an axis, and rounding the foot lifts it off one.
 */
function fillBarPath(
  ctx: CanvasRenderingContext2D,
  bar: { x: number; y: number; width: number; height: number; radius: number },
): void {
  const { x, y, width, height, radius } = bar
  ctx.beginPath()
  ctx.moveTo(x, y + height)
  ctx.lineTo(x, y + radius)
  ctx.arcTo(x, y, x + radius, y, radius)
  ctx.lineTo(x + width - radius, y)
  ctx.arcTo(x + width, y, x + width, y + radius, radius)
  ctx.lineTo(x + width, y + height)
  ctx.closePath()
  ctx.fill()
}

/**
 * uPlot draws its axis labels on a canvas, so it needs a CSS font string
 * rather than a class. 11px is `--text-caption`, the size the reference
 * sets its own axis ladder at; the family is the one `theme/global.css`
 * loads. Stated in px because a canvas context has no `rem`.
 */
const AXIS_FONT = '11px "Schibsted Grotesk", system-ui, sans-serif'

/** Half a line of `AXIS_FONT`, which is what the topmost rule's label
 * needs above it so the canvas does not slice it in half. */
const AXIS_LABEL_HALF_PX = 8

/**
 * The right-hand label column, so the ladder's own right edge lands on the
 * page's right gutter rather than short of it. Measured on a 412px render
 * at 3x: the widest tick this chart emits, "60 km", is 90 device px and
 * the axis gap another 18, so 36 CSS px is what the labels need and 40 is
 * that with a step of slack for a three-digit kilometre. Mirrored as
 * `--chart-axis-gutter` in `theme/tokens.css` for anything that has to
 * align to the plot rather than to the chart.
 */
const Y_AXIS_SIZE_PX = 40

/** Room for one line of month-and-day labels under the plot. */
const X_AXIS_SIZE_PX = 22

/** At most this many x-axis labels, however long the series. See
 * `periodTickIndices`. */
const X_TICKS = 5

/** Where the pointer is, and which period it is over. */
interface HoverState {
  index: number
  /**
   * Cursor offset from the *panel's* left edge, in CSS pixels. uPlot
   * reports `cursor.left` relative to the plotting area instead, so the
   * plot's own origin is added at the point it is captured - see the
   * `setCursor` hook below.
   */
  leftPx: number
  /** The panel's width in CSS pixels, which is the clamp's outer bound. */
  panelWidthPx: number
}

/**
 * Weekly (or monthly) training volume as bars, with a hover readout.
 *
 * **Why the readout is absolutely positioned, and why that is not a
 * detail.** uPlot's own legend would give a hover value for free, and it
 * is switched off across this application for a measured reason: uPlot
 * renders it as a `<table>` sibling of the plot's wrapping element, both
 * inside the node `UPlot.tsx` hands to its ResizeObserver, and `setSize`
 * has no idea it is there. With a container whose height comes from its
 * content, every observation fed the legend's height back in and the chart
 * grew one legend-height per tick, without bound - see `UPlot.tsx`. This
 * readout is `position: absolute` inside `.chart`, which carries a
 * definite height of its own, so it contributes exactly zero layout height
 * and the observed box cannot move however tall the readout gets.
 *
 * The readout is also clamped so it cannot leave the panel at either edge,
 * which needs its rendered width - see `clampReadoutLeft`. That is measured
 * from the element rather than assumed, because what the readout says is
 * what decides how wide it is.
 *
 * A period with no runs reads as an explicit zero rather than showing
 * nothing, for the same reason the series is dense: a week off is a fact
 * about the training, not missing data.
 */
export function VolumeBars({
  periods,
  metric,
  bucket,
  markEmpty = false,
  axisLabel = 'dayMonth',
  compact = false,
  trend,
}: VolumeBarsProps) {
  const [hover, setHover] = useState<HoverState | null>(null)
  const readoutRef = useRef<HTMLDivElement | null>(null)
  const [readoutWidthPx, setReadoutWidthPx] = useState(0)

  const data = useMemo<uPlot.AlignedData>(() => {
    const x = periods.map((_, i) => i)
    const y = periods.map((p) => metricValue(p, metric))
    return [x, y]
  }, [periods, metric])

  const trendWindow = trend?.window
  const trendLastIndex = trend?.lastIndex
  const trendValues = useMemo(
    () =>
      trendWindow === undefined || trendLastIndex === undefined
        ? null
        : trailingMean(
            periods.map((p) => metricValue(p, metric)),
            trendWindow,
            trendLastIndex,
          ),
    [periods, metric, trendWindow, trendLastIndex],
  )

  const options = useMemo<uPlot.Options>(() => {
    const inkDim = cssVar('--ink-dim')
    const ink = cssVar('--ink')
    const page = cssVar('--page')
    const grid = cssVar('--chart-rule')
    const accent = cssVar('--accent')
    const seriesColor = cssVar('--series-1')
    const values = periods.map((p) => metricValue(p, metric))
    const scale = volumeScale(Math.max(0, ...values))
    const tickIndices = periodTickIndices(periods.length, X_TICKS)
    const xRange = barScaleRange(periods.length)

    return {
      width: 600,
      height: compact ? VOLUME_BARS_HEIGHT_PX.compact : VOLUME_BARS_HEIGHT_PX.full,
      // Left is zero on purpose: the plot's left edge is then the chart
      // element's left edge, which is the page gutter, which is where the
      // title and every stat above it start. The y axis takes its room on
      // the *right* instead (see below), so the one thing inset from the
      // page gutter is the label column, exactly as the reference has it.
      // Top is the half-height of a y-axis label, so the topmost rule's
      // label is not sliced by the canvas edge.
      padding: [AXIS_LABEL_HALF_PX, 0, 0, 0],
      scales: {
        // A linear scale over an explicitly widened range, not uPlot's
        // ordinal `distr: 2`. Ordinal ranges to the data, `[0, n - 1]`,
        // which puts the first and last bar's centre on the plot bound and
        // clips both to half width - see `barScaleRange`, which carries the
        // measurement. The x data is the index either way, and the axis
        // splits below are stated explicitly, so nothing else changes.
        x: { time: false, distr: 1, range: () => xRange },
        // Ranged to the solved top rather than to the tallest bar, so the
        // top rule is a round number. See `volumeScale`.
        y: { range: () => [0, scale.max] as [number, number] },
      },
      series: [
        {},
        {
          label: METRIC_LABEL[metric],
          stroke: seriesColor,
          fill: seriesColor,
          // The bars are drawn in the `draw` hook below rather than by
          // uPlot's own bars path builder, because the three things that
          // make a small week legible - a minimum drawn height, a corner
          // radius clamped to that height, and a width cap - are not
          // options it has. Returning null leaves uPlot nothing to paint;
          // it re-asks each frame, which costs one call.
          paths: () => null,
          points: { show: false },
        },
      ],
      axes: [
        {
          stroke: inkDim,
          font: AXIS_FONT,
          size: X_AXIS_SIZE_PX,
          gap: 6,
          // No vertical gridlines and no tick marks. The reference draws
          // neither: a luminance scan across its whole plot finds three
          // horizontal rules and nothing vertical but the current-period
          // marker. Ours drew one vertical per tick, overshooting the plot
          // 28px above the topmost horizontal and 10px below the zero axis,
          // which is the fault this removes rather than trims.
          grid: { show: false },
          ticks: { show: false },
          border: { show: false },
          splits: () => tickIndices,
          values: (_u, splits) =>
            splits.map((s) => {
              const period = periods[Math.round(s)]
              if (period === undefined) return ''
              return axisLabel === 'monthYear'
                ? shortCalendarMonth(period.period_start)
                : shortCalendarDate(period.period_start)
            }),
        },
        {
          // Side 1 is the right-hand edge. The reference puts its "40 km /
          // 20 km / 0 km" ladder outside the plot on the right, where the
          // labels' own right edge is the page's right gutter - so both
          // page edges are honoured and neither the plot nor the text is
          // inset from one of them.
          side: 1,
          stroke: inkDim,
          font: AXIS_FONT,
          size: Y_AXIS_SIZE_PX,
          // `align: 2` right-aligns the tick text and `alignTo: 2` measures
          // it from the *outer* edge of the axis column rather than from
          // the plot bound, so with a zero gap the three labels' right
          // edges stack on the page gutter and "0", "20" and "40" line up
          // on their units. Left-aligned they staggered, because "0 km" is
          // narrower than "40 km".
          align: 2,
          alignTo: 2,
          gap: 0,
          grid: { stroke: grid, width: RULE_WIDTH_PX },
          ticks: { show: false },
          border: { show: false },
          splits: () => scale.splits,
          values: (_u, splits) => splits.map((s) => formatMetricTick(s, metric)),
        },
      ],
      hooks: {
        /*
         * Everything inside the plot, drawn in one pass and in one
         * coordinate system: the bars, then the zero rule over them, then
         * the empty-period marks over that.
         *
         * `draw` rather than `drawAxes` because the zero rule has to land
         * *on top of* the bars that sit on it. Drawn underneath - which is
         * where uPlot's own y grid puts it - twelve bars and their
         * near-zero stubs occluded it: measured on the round-1 capture, the
         * 40 and 20 rules each showed 973 px of grey across x 72..1082
         * while the zero rule showed 472 px across x 100..1037, so the axis
         * looked like it claimed three levels and drew two.
         */
        draw: [
          (u: uPlot) => {
            const ctx = u.ctx
            const ratio = cssPixelRatio()
            const baselineY = u.valToPos(0, 'y', true)
            const slotWidth = u.bbox.width / Math.max(periods.length, 1)

            ctx.save()

            ctx.fillStyle = seriesColor
            values.forEach((value, i) => {
              const bar = barGeometry({
                centreX: u.valToPos(i, 'x', true),
                slotWidth,
                baselineY,
                valueY: u.valToPos(value, 'y', true),
                widthFactor: BAR_WIDTH_FACTOR,
                maxWidthPx: BAR_MAX_WIDTH_PX * ratio,
                minHeightPx: BAR_MIN_HEIGHT_PX * ratio,
                radiusFactor: BAR_RADIUS_FACTOR,
              })
              if (bar === null) return
              fillBarPath(ctx, bar)
            })

            // The zero rule, at the grid's own colour and width and across
            // the plot's own x extent, so all three rules share both edges.
            const ruleWidth = RULE_WIDTH_PX * ratio
            ctx.fillStyle = grid
            ctx.fillRect(u.bbox.left, Math.round(baselineY - ruleWidth / 2), u.bbox.width, ruleWidth)

            if (markEmpty) {
              // Every size below is in CSS pixels, scaled to the canvas
              // pixels the context actually draws in. Measured once by
              // intercepting the draw calls in a real browser: an unscaled
              // size arrives unchanged at devicePixelRatio 2 and renders at
              // half what it claims, and this mark exists precisely so a
              // week off reads as deliberate - which it stops doing at half
              // size, on exactly the displays most people have.
              ctx.strokeStyle = accent
              periods.forEach((period, i) => {
                if (period.runs !== 0) return
                const mark = emptyMarkGeometry({
                  centreX: u.valToPos(i, 'x', true),
                  slotWidth,
                  baselineY,
                  widthFactor: BAR_WIDTH_FACTOR,
                  maxWidthPx: BAR_MAX_WIDTH_PX * ratio,
                  maxDiameterPx: EMPTY_MARK_MAX_DIAMETER_PX * ratio,
                  minDiameterPx: EMPTY_MARK_MIN_DIAMETER_PX * ratio,
                  strokePx: EMPTY_MARK_STROKE_PX * ratio,
                })
                if (mark === null) return
                ctx.beginPath()
                ctx.arc(mark.cx, mark.cy, mark.radius, 0, Math.PI * 2)
                ctx.lineWidth = mark.lineWidth
                ctx.stroke()
              })
            }

            if (trendValues !== null) {
              // One path, broken wherever the trend has no value. Both
              // strokes follow the same path: the halo first, then the line.
              ctx.beginPath()
              let drawing = false
              trendValues.forEach((value, i) => {
                if (value === null) {
                  drawing = false
                  return
                }
                const x = u.valToPos(i, 'x', true)
                const y = u.valToPos(value, 'y', true)
                if (drawing) ctx.lineTo(x, y)
                else ctx.moveTo(x, y)
                drawing = true
              })
              ctx.lineJoin = 'round'
              ctx.lineCap = 'round'
              ctx.strokeStyle = page
              ctx.lineWidth = TREND_HALO_PX * ratio
              ctx.stroke()
              ctx.strokeStyle = ink
              ctx.lineWidth = TREND_LINE_PX * ratio
              ctx.stroke()
            }

            ctx.restore()
          },
        ],
        setCursor: [
          (u: uPlot) => {
            const index = u.cursor.idx
            const leftPx = u.cursor.left
            // `idx` is null with the pointer outside the plot, and uPlot
            // reports a negative `left` on the way out, which would leave a
            // readout pinned to the edge after the pointer has gone.
            if (index === null || index === undefined || leftPx === undefined || leftPx < 0) {
              setHover(null)
              return
            }
            // `cursor.left` is measured from the *plotting area* - uPlot's
            // `u.over`, which it insets from the chart's left edge by the
            // y-axis gutter - while the readout is positioned against
            // `.chart`'s own edge. Adding the plot's origin puts both in
            // one coordinate space; without it the readout sat a gutter's
            // width (about 50px with the default auto-sized axis, most of
            // a bar) to the left of the bar it was describing. The gutter
            // is zero now that the axis is on the right, but the plot
            // origin is still read rather than assumed: uPlot decides it.
            setHover({
              index,
              leftPx: u.over.offsetLeft + leftPx,
              panelWidthPx: u.width,
            })
          },
        ],
      },
    }
    // `setHover` is a `useState` setter and is stable for the component's
    // lifetime, so it is not a dependency: including it would not change
    // when this memo recomputes, and `options` identity is the recreation
    // key for the whole chart (see UPlot.tsx).
  }, [periods, metric, markEmpty, axisLabel, compact, trendValues])

  const hoveredPeriod = hover === null ? undefined : periods[hover.index]
  const hoveredTrend = hover === null || trendValues === null ? null : (trendValues[hover.index] ?? null)

  // Measured after layout rather than assumed, because what the readout
  // says is what decides how wide it is - "No runs" is a fraction of the
  // three-row form. Keyed on the period rather than run unconditionally, so
  // a pointer sweep across one bar does not re-measure, and guarded on the
  // ref because a null one means the pointer has left: zeroing the width
  // there would throw away the measurement the next hover needs before its
  // own first paint.
  useLayoutEffect(() => {
    const element = readoutRef.current
    if (element === null) return
    const width = element.offsetWidth
    setReadoutWidthPx((previous) => (previous === width ? previous : width))
  }, [hoveredPeriod])

  return (
    <div className={compact ? `${styles.chart} ${styles.compact}` : styles.chart}>
      <UPlot data={data} options={options} />
      {hover !== null && hoveredPeriod !== undefined && (
        <div
          ref={readoutRef}
          className={styles.readout}
          style={{
            left: `${String(clampReadoutLeft(hover.leftPx, readoutWidthPx, hover.panelWidthPx))}px`,
          }}
          /*
           * Deliberately not a live region. The first version gave this
           * `role="status"` and `aria-live="polite"`, which sounds helpful
           * and is the opposite: `setCursor` fires on every pointer move,
           * so a screen reader would announce a new week several times a
           * second for as long as the pointer crossed the chart. It also
           * put a second `role="status"` on the page beside the header's
           * activity count. A pointer-only affordance is left to the
           * pointer; `aria-hidden` keeps it out of the tree entirely
           * rather than leaving a stale value in it.
           */
          aria-hidden="true"
          // A stable hook that exists in every state the readout has. The
          // browser suite used to locate it by its "moving" line, which
          // only renders for a period that had runs - so the clamp
          // assertion, which hovers the *last* bar, silently found nothing
          // whenever that bar was a week off. Two of the current twelve
          // are.
          data-testid="volume-readout"
        >
          <p className={styles.readoutWhen}>{bucketHeading(bucket, hoveredPeriod.period_start)}</p>
          {hoveredPeriod.runs === 0 ? (
            <p className={styles.readoutRow}>No runs</p>
          ) : (
            <>
              <p className={styles.readoutRow}>
                <span className="mono">{distance(hoveredPeriod.distance_m)}</span>
              </p>
              <p className={styles.readoutRow}>
                <span className="mono">{duration(hoveredPeriod.moving_time_s)}</span> moving
              </p>
              <p className={styles.readoutRow}>
                <span className="mono">{hoveredPeriod.runs}</span>{' '}
                {hoveredPeriod.runs === 1 ? 'run' : 'runs'}
              </p>
            </>
          )}
          {hoveredTrend !== null && trendWindow !== undefined && (
            <p className={styles.readoutRow}>
              <span className="mono">{formatMetricAverage(hoveredTrend, metric)}</span>{' '}
              {trendWindow}-{bucket} average
            </p>
          )}
        </div>
      )}
    </div>
  )
}
