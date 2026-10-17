import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { CSSProperties } from 'react'
import type uPlot from 'uplot'
import { Absent } from '../components/Absent'
import { duration, NO_VALUE } from '../format'
import { isStopped } from './replayTimeline'
import { currentMoment } from '../moment/momentStore'
import { useMomentState, useMomentStore } from '../moment/useMoment'
import { cssPixelRatio } from './canvasPixels'
import { cssVar } from './cssVar'
import {
  AVERAGE_DASH,
  AXIS_LABEL_SIZE,
  backgroundHook,
  BARE_PLOT_PADDING_BOTTOM,
  CHANNEL_IS_FILLED,
  CHANNEL_LABEL,
  CHANNEL_UNIT,
  chartFurniturePx,
  computePauseBands,
  elevationYRange,
  formatAverage,
  hasChartableValue,
  maskSeries,
  paceAxisSplits,
  paceTick,
  paceYRange,
  PLOT_PADDING_TOP,
  TIME_AXIS_SIZE,
} from './streamPanelMath'
import type { StreamChannel } from './streamPanelMath'
import { UPlot } from './UPlot'
import styles from './StreamPanel.module.css'

export type { StreamChannel } from './streamPanelMath'

export interface StreamPanelProps {
  channel: StreamChannel
  /** Elapsed seconds since the activity started, one per grid sample. */
  t: number[]
  /**
   * The channel's own values, in SI: `speed_mps` for `pace`, `hr_bpm` for
   * `hr`, `cadence_spm` for `cadence`, `altitude_m` for `elevation`. The
   * pace channel takes speed, not pace - see the module doc below.
   */
  values: (number | null)[]
  /**
   * `paused` and `outage` travel separately, per the derived layer (see
   * docs/reference/api.md): "not paused" and "not known" are different
   * facts and neither is ever coalesced into the other. This component
   * shades a stretch where *either* is true, because the derived layer
   * nulls the sensor channels across both.
   */
  paused: (boolean | null)[]
  outage: (boolean | null)[]
  average: number | null
  /** Heading level, so the page's outline stays ordered around the panel. */
  headingLevel?: 2 | 3
  /** Set when an enclosing `<section>` names itself from this heading. */
  headingId?: string
  /**
   * Whether this panel draws its own time axis: its ticks, its labels and
   * its `Elapsed time` title. `false` for a panel stacked above another that
   * draws the one axis for all of them - the activity view's compact
   * desktop charts - which keeps the vertical grid and gives the axis's
   * space to the plot. See `chartFurniturePx`.
   */
  timeAxis?: boolean
}

/**
 * The channel's value at the given moment, for the heading - `null` when
 * there is no moment, `'stopped'` for a paused or outage second (the
 * derived layer nulls the sensor channels across both, so the raw value
 * there is not a reading, it is a gap), `NO_VALUE` for a null value outside
 * a stop, and the formatted value otherwise. See docs/reference/frontend.md,
 * "Hovering a stream panel".
 */
function momentValueFor(
  channel: StreamChannel,
  values: (number | null)[],
  paused: (boolean | null)[],
  outage: (boolean | null)[],
  index: number | null,
): string | null {
  if (index === null) return null
  if (isStopped(paused, outage, index)) return 'stopped'
  const value = values[index]
  if (value === null || value === undefined) return NO_VALUE
  return formatAverage(channel, value)
}

/**
 * How far, in CSS pixels, a touch's sideways travel from its `pointerdown`
 * must exceed its vertical travel before it sets the moment. Until then the
 * gesture may still be a vertical scroll swipe, which `touch-action: pan-y`
 * hands to the browser with a `pointercancel` only after a few moves, and
 * which must neither set the moment nor pause a playing replay.
 */
const TOUCH_SIDEWAYS_SLOP_PX = 4

/**
 * The grid index under a pointer at `offsetX` on `chart`, or `null` when
 * the series is empty. uPlot 1.6.32's `posToIdx` finds the sample closest
 * to the position within the data's own index range, so off either edge
 * of the plot it reports the first or the last sample (and the first for a
 * position it cannot convert, before the chart is ready); the one index it
 * returns that is not a sample is `-1`, for a series with no samples.
 */
function pointerIndex(chart: uPlot, offsetX: number): number | null {
  const raw = chart.posToIdx(offsetX)
  return raw < 0 ? null : raw
}

/**
 * Places `chart`'s own cursor at the sample `index` (or hides it, for
 * `null`): the way a moment set elsewhere - a pointer over a different
 * panel, a replay, or this panel's own pointer once it has gone through the
 * store - reaches this chart. Passing `false` as the fire argument keeps
 * this from routing back into uPlot's own hooks (moot now that nothing here
 * reads them - see `options.hooks` in `StreamPanel` for why). Never rebuilds
 * `options` to place a cursor - that would discard the chart, which is the
 * constraint `UPlot.tsx` documents.
 *
 * **Skipped entirely before the chart is ready.** uPlot schedules its
 * first commit as a microtask at construction (`microTask(_commit)`) and
 * only that commit's own `setScales()` gives the x scale a range;
 * `chart.status` is `0` until then and `1` from the moment it fires its
 * `ready` hook (right after that first commit) onward. Calling `valToPos`
 * before that returns `Infinity` - confirmed directly against uPlot 1.6.32
 * - which uPlot then draws its cursor at, on the plot's right edge over the
 * last sample, not at the moment. The `ready` hook wired into `options` is
 * what places a moment already active on a freshly built chart, once
 * `valToPos` means something.
 */
function placeCursorAt(chart: uPlot, t: number[], index: number | null): void {
  if (chart.status !== 1) return
  if (index === null) {
    chart.setCursor({ left: -10, top: -10 }, false)
    return
  }
  const elapsed = t[index]
  if (elapsed === undefined) return
  chart.setCursor({ left: chart.valToPos(elapsed, 'x'), top: 1 }, false)
}

/**
 * One stream channel over the run's elapsed time, with its own heading and
 * legend.
 *
 * The pace channel plots speed and formats the ticks as pace. Pace is
 * 1000/speed, a reciprocal that diverges as the athlete slows, and the grid
 * genuinely contains zero-speed seconds. Measured on the 2026-08-25 activity,
 * whose moving pace spans 3:55 to 32:40 per kilometre: on a full-range pace
 * axis the 5th-to-95th-percentile band occupies 21.9% of the panel height,
 * against 55.8% on a linear speed axis. So the axis is linear in speed and
 * only the tick labels are pace.
 *
 * The y-axis's own range is not unconditionally zero-anchored. It reaches
 * down to 0 - so a stop reads as a stop - only when the run actually
 * touches a near-zero speed (a pause, an outage, or a raw sample below the
 * project's own stop threshold); otherwise it crops to a padded band
 * around the visible data. Forcing zero on every pace panel regardless of
 * the run's shape was an earlier version's mistake: a genuinely even-paced
 * real run occupies about 4% of a zero-anchored panel's height, worse than
 * the 21.9% figure that motivated plotting speed over pace to begin with.
 * The pace ticks are placed at round pace values converted back to their
 * (uneven) speed position, which is a true consequence of the reciprocal
 * rather than a defect, and the ladder is then thinned to the finest
 * *uniform* stride that fits rather than having whichever labels collide
 * dropped out of it - an axis stepping 1, 1, 1, 2 reads as an error even
 * though every label on it is true. See `streamPanelMath.ts` for the pure
 * logic behind all of this.
 *
 * The elevation channel is drawn as a filled area rather than a bare
 * stroke, because the quantity a reader wants off it is the shape of the
 * ground rather than a value at an instant, and a fill reads as terrain.
 * Its axis is never zero-anchored: altitude is a position on a scale with
 * an arbitrary origin, not a magnitude from zero.
 *
 * A paused or outage stretch is shaded and the series is broken across it -
 * for a filled series the fill breaks too, since a closed fill would paint
 * the gap as if the athlete were at ground level through it. Distance
 * still interpolates across the gap, which is the derived layer's own rule
 * and none of this component's business.
 *
 * The average is a dashed reference line, and its value is rendered in the
 * heading row as HTML rather than drawn on the canvas. See
 * `formatAverage` on why, and `UPlot.tsx` on why a sibling of the chart
 * container is a safe place to put it.
 */
export function StreamPanel({
  channel,
  t,
  values,
  paused,
  outage,
  average,
  headingLevel = 3,
  headingId,
  timeAxis = true,
}: StreamPanelProps) {
  const masked = useMemo(() => maskSeries(values, paused, outage), [values, paused, outage])
  // Computed from the *masked* series, not the raw one: a channel whose
  // only non-null samples all fall inside a pause would otherwise pass
  // this check on the caller's data and then hand uPlot an all-null series
  // - a blank chart rather than the "no X recorded" message this guards.
  const hasAnyValue = useMemo(() => hasChartableValue(values, paused, outage), [values, paused, outage])
  const bands = useMemo(() => computePauseBands(t, paused, outage), [t, paused, outage])

  const data = useMemo<uPlot.AlignedData>(() => [t, masked], [t, masked])

  // Held in a ref rather than a dependency of `options` below: `options`'s
  // identity is the chart's own recreation key (UPlot.tsx), and the store
  // is stable for the life of the activity view (one per mounted
  // MomentProvider) so it has no business forcing a rebuild.
  const store = useMomentStore()
  const storeRef = useRef(store)
  useEffect(() => {
    storeRef.current = store
  })

  const momentState = useMomentState()
  const index = currentMoment(momentState)

  const chartRef = useRef<uPlot | null>(null)
  const pointerListenersRef = useRef<{
    down: (event: PointerEvent) => void
    move: (event: PointerEvent) => void
    up: (event: PointerEvent) => void
    hoverMove: (event: PointerEvent) => void
    hoverLeave: (event: PointerEvent) => void
    restoreCursor: () => void
  } | null>(null)

  // This chart's cursor at the current moment. See `placeCursorAt`.
  const placeCursor = useCallback((chart: uPlot) => placeCursorAt(chart, t, index), [index, t])

  // Read by the `ready` hook wired into `options` below, rather than
  // depended on there directly - `options`'s identity is the chart's own
  // recreation key, and `placeCursor` changes with every `index`/`t`, which
  // has no business rebuilding the chart. Kept current the same way
  // `storeRef` is, in an effect rather than during render (a bare
  // assignment here is flagged by this project's own lint: refs are read
  // outside render, not written during it).
  const placeCursorRef = useRef(placeCursor)
  useEffect(() => {
    placeCursorRef.current = placeCursor
  })

  // The one way this panel reaches the uPlot instance: attaching pointer
  // handling to `chart.over` and remembering the instance for the cursor-
  // placement effect below. See `UPlot.tsx`'s module doc, "`onChart` is the
  // one way a caller reaches the instance itself." Placing the cursor
  // itself is not this callback's job - it always runs before the chart is
  // ready (see `placeCursorAt`) - so it is left to the `ready` hook and to
  // the effect below, both of which run at a time `chart.status` can
  // actually be `1`, and to `restoreCursor` after a leave.
  const onChart = useCallback((chart: uPlot | null) => {
    const previousChart = chartRef.current
    const previousListeners = pointerListenersRef.current
    if (previousChart !== null && previousListeners !== null) {
      previousChart.over.removeEventListener('pointerdown', previousListeners.down)
      previousChart.over.removeEventListener('pointermove', previousListeners.move)
      previousChart.over.removeEventListener('pointerup', previousListeners.up)
      previousChart.over.removeEventListener('pointercancel', previousListeners.up)
      previousChart.over.removeEventListener('pointermove', previousListeners.hoverMove)
      previousChart.over.removeEventListener('pointerleave', previousListeners.hoverLeave)
      previousChart.over.removeEventListener('mouseleave', previousListeners.restoreCursor)
    }
    chartRef.current = chart
    pointerListenersRef.current = null
    if (chart === null) return

    // Touch: dragging sideways sets the moment on a phone, which has no
    // hover; `touch-action: pan-y` in StreamPanel.module.css keeps a
    // vertical drag scrolling the page rather than being captured here. The
    // moment waits for `TOUCH_SIDEWAYS_SLOP_PX` of sideways travel, so a
    // plain tap or a scroll swipe that starts on a chart picks nothing.
    // Only the first finger down is tracked, so a second one can neither
    // take the moment over nor leave it standing once the first lifts.
    let touch: { id: number; x: number; y: number; dragging: boolean } | null = null
    const down = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return
      // Suppresses the compatibility mouse events (mousedown, mousemove,
      // mouseup) a touch browser sends after this pointer sequence - per
      // the Pointer Events spec, `preventDefault()` on `pointerdown` is
      // what does that, and `touch-action: pan-y` is what still lets a
      // vertical drag scroll regardless. Without it: uPlot binds its own
      // `mousemove` listener to this same element, a tap's compatibility
      // mousemove arrives *after* our own `pointerup` has already cleared
      // the moment, and that stray-but-real mousemove reports a pointer
      // event that sets it right back.
      event.preventDefault()
      if (touch !== null) return
      touch = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: false }
    }
    const move = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || touch === null || event.pointerId !== touch.id) return
      if (!touch.dragging) {
        const sideways = Math.abs(event.clientX - touch.x)
        const vertical = Math.abs(event.clientY - touch.y)
        if (sideways - vertical <= TOUCH_SIDEWAYS_SLOP_PX) return
        touch.dragging = true
      }
      const idx = pointerIndex(chart, event.offsetX)
      if (idx !== null) storeRef.current?.setPointer(idx)
    }
    const up = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || touch === null || event.pointerId !== touch.id) return
      const { dragging } = touch
      touch = null
      if (dragging) storeRef.current?.setPointer(null)
    }
    // Mouse and pen: read the moment straight off native pointer events on
    // this same element rather than through uPlot's own `setCursor` hook.
    // That hook is not a usable source for it - measured directly against
    // uPlot 1.6.32 across two rounds of this fix: it also fires from
    // `_commit` on construction, `setData` and a scale change (not only a
    // real pointer move), and it can replay an already-stale `cursor.event`
    // object on one of those non-interactive commits, including one from a
    // pointer sequence this hook itself never even reported the first time
    // (`mousedown`/`mouseup`/`mouseenter` set it without calling
    // `updateCursor`). A held button dragged out of the panel is the sharp
    // case native events get right and the hook could not: `pointerleave`
    // always fires and always means "gone", independent of anything else
    // happening in the same gesture.
    const hoverMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      const idx = pointerIndex(chart, event.offsetX)
      if (idx !== null) storeRef.current?.setPointer(idx)
    }
    const hoverLeave = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      storeRef.current?.setPointer(null)
    }
    // uPlot hides its own cursor on `mouseleave`, which a browser fires
    // after `pointerleave` - after `hoverLeave` has already cleared the
    // pointer and, a microtask later, the effect below has placed this
    // chart's cursor at whatever moment is left, a paused replay's head
    // among them. So the chart that was hovered lost its line while the
    // other three kept theirs. Added after uPlot's own listener on the same
    // element, so it runs after it, and reads the store directly: if the
    // moment left is the index the pointer was already on, no effect reruns
    // to put the line back.
    const restoreCursor = () => {
      const current = storeRef.current
      if (current !== null) placeCursorAt(chart, t, currentMoment(current.getSnapshot()))
    }
    chart.over.addEventListener('pointerdown', down)
    chart.over.addEventListener('pointermove', move)
    chart.over.addEventListener('pointerup', up)
    chart.over.addEventListener('pointercancel', up)
    chart.over.addEventListener('pointermove', hoverMove)
    chart.over.addEventListener('pointerleave', hoverLeave)
    chart.over.addEventListener('mouseleave', restoreCursor)
    pointerListenersRef.current = { down, move, up, hoverMove, hoverLeave, restoreCursor }
    // `t` is the only thing this closure needs from props - `onChart`'s own
    // identity changing is harmless (`UPlot.tsx` never rebuilds on it), so
    // `t` is a plain dependency rather than another ref to keep current.
  }, [t])

  // Reruns whenever the moment changes elsewhere, placing it on the chart
  // this panel already has. Also runs once on mount, alongside every other
  // effect in this same commit, which is always before the chart's first
  // `ready` - `placeCursorAt`'s own `chart.status !== 1` guard is what makes
  // that call harmless rather than a second source of the `Infinity` bug.
  useEffect(() => {
    const chart = chartRef.current
    if (chart === null) return
    placeCursor(chart)
  }, [placeCursor])

  const momentValue = momentValueFor(channel, values, paused, outage, index)

  const options = useMemo<uPlot.Options>(() => {
    const inkDim = cssVar('--ink-dim')
    // `--grid`, deliberately, where every other chart here now reads
    // `--chart-rule`. This is the one chart in the application that draws a
    // *lattice* - verticals as well as horizontals - and a lattice is twice
    // the ink of a ladder at the same value: raised to `--chart-rule`'s
    // measured weight it stopped framing the trace and started caging it,
    // captured side by side at 1.10, 1.57 and 1.83 against `--page`.
    //
    // The fix is not a third grid colour, it is the verticals: none of the
    // six reference screenshots draws one, and `VolumeBars` removed its own
    // for exactly that reason (see its `axes` comment). Once they go, this
    // should read `--chart-rule` like the rest. Left for this file's owner.
    const grid = cssVar('--grid')
    const accent = cssVar('--accent')
    const seriesColor =
      channel === 'pace'
        ? cssVar('--series-1')
        : channel === 'hr'
          ? cssVar('--series-2')
          : channel === 'cadence'
            ? cssVar('--series-3')
            : cssVar('--series-5')

    const yAxis: uPlot.Axis =
      channel === 'pace'
        ? {
            stroke: inkDim,
            grid: { stroke: grid },
            label: CHANNEL_UNIT.pace,
            labelFont: AXIS_LABEL_FONT,
            labelSize: AXIS_LABEL_SIZE,
            // The plot's own height, so a tick with no room for its label
            // is dropped. This is the one boundary the pixel unit crosses:
            // `u.bbox.height` is in *canvas* pixels (uPlot scales the plot's
            // CSS height by the device pixel ratio when it computes `bbox`,
            // which is why `backgroundHook` pairs it with
            // `valToPos(..., true)`), while the separation the thinning
            // tests against is a CSS-pixel quantity derived from uPlot's
            // 12px axis font. So the ratio is divided out here, and
            // `paceAxisSplits` works in CSS pixels throughout. Left in
            // canvas pixels, every gap on a HiDPI display measures double
            // and nothing is ever thinned.
            splits: (u, _axisIdx, scaleMin, scaleMax) =>
              paceAxisSplits(scaleMin, scaleMax, u.bbox.height / cssPixelRatio()),
            values: (_u, splits) => splits.map((s) => paceTick(s)),
          }
        : {
            stroke: inkDim,
            grid: { stroke: grid },
            label: CHANNEL_UNIT[channel],
            labelFont: AXIS_LABEL_FONT,
            labelSize: AXIS_LABEL_SIZE,
            values: (_u, splits) => splits.map((s) => String(Math.round(s))),
          }

    const yScale: uPlot.Scales =
      channel === 'pace'
        ? { y: { range: (_u, dataMin, dataMax) => paceYRange(values, paused, outage, dataMin, dataMax) } }
        : channel === 'elevation'
          ? { y: { range: (_u, dataMin, dataMax) => elevationYRange(dataMin, dataMax) } }
          : {}

    return {
      width: 600,
      height: 200,
      padding: [PLOT_PADDING_TOP, 8, timeAxis ? 0 : BARE_PLOT_PADDING_BOTTOM, 0],
      // Only the vertical cursor line: uPlot's own hover point on the
      // series stays, and the horizontal one has no channel here to track.
      //
      // No drag either. uPlot's default drag zooms the x scale to the
      // dragged span on that one chart alone, and the activity view's
      // stacked desktop charts share the bottom chart's time axis: a drag
      // across Elevation relabelled its axis to the dragged span while the
      // three charts above it still spanned the whole run.
      cursor: { y: false, drag: { x: false, y: false, setScale: false } },
      scales: { x: { time: false }, ...yScale },
      series: [
        {},
        {
          label: CHANNEL_LABEL[channel],
          stroke: seriesColor,
          width: 1.5,
          points: { show: false },
          // uPlot clips a gapped series' fill to the non-null stretches, so
          // opting into a fill does not close it across a pause.
          //
          // `fillTo` is the panel floor - the y scale's own resolved
          // minimum - and stating it is not decoration. uPlot's default
          // for a linear scale is the literal value 0 (`seriesFillTo`),
          // and zero is not a baseline any channel here measures from:
          // altitude is a position on a scale with an arbitrary origin,
          // which is the same fact that already keeps this axis from being
          // zero-anchored. Measured on the real store, 122017 samples
          // across 143 activities sit below sea level, and one activity's
          // whole range sits below zero, where the default closes the
          // polygon *above* the whole plot and fills the sky instead of the
          // ground on a panel whose reason for existing is that a fill
          // reads as terrain. A range that straddles zero, as another
          // activity's does, closes it mid-panel. A positive range renders correctly by
          // luck: the baseline lands below the plot and is clipped to the
          // floor, which is exactly what this now asks for directly.
          //
          // Read live through a function rather than computed here,
          // because the scale is resolved by the `range` callback above
          // and only the instance knows the answer at draw time.
          ...(CHANNEL_IS_FILLED[channel]
            ? {
                fill: `color-mix(in srgb, ${seriesColor} 22%, transparent)`,
                fillTo: (u: uPlot, _seriesIdx: number, dataMin: number) => u.scales.y?.min ?? dataMin,
              }
            : {}),
        },
      ],
      axes: [
        timeAxis
          ? {
              stroke: inkDim,
              grid: { stroke: grid },
              size: TIME_AXIS_SIZE,
              label: 'Elapsed time',
              labelFont: AXIS_LABEL_FONT,
              labelSize: AXIS_LABEL_SIZE,
              values: (_u, splits) => splits.map((s) => duration(s)),
            }
          : {
              // The grid only: no size reserved, no ticks, no title, and a
              // null for every label, which uPlot skips. `show: false` would
              // not do, since it drops the axis's grid with the rest.
              stroke: inkDim,
              grid: { stroke: grid },
              size: 0,
              ticks: { show: false },
              values: (_u, splits) => splits.map(() => null),
            },
        yAxis,
      ],
      hooks: {
        drawAxes: [backgroundHook({ bands, average, accentColor: accent, inkDimColor: inkDim })],
        // No `setCursor` hook here, deliberately: it is not a usable source
        // of the moment. Measured directly against uPlot 1.6.32 across two
        // rounds of this fix, it fires from `_commit` on construction, on
        // `setData` and after a scale change - not only on a real pointer
        // move - and it can replay an already-stale `cursor.event` on one
        // of those, including one it never even reported forwarding the
        // first time. The moment comes from native `pointer*` events on
        // `chart.over` instead - see `onChart`.
        //
        // Fires exactly once per chart, right after its first commit sets
        // up the x scale - see `placeCursorAt` on why placement has to wait
        // for this rather than happening the instant `onChart` receives the
        // freshly constructed instance.
        ready: [(u: uPlot) => placeCursorRef.current(u)],
      },
    }
  }, [channel, bands, average, values, paused, outage, timeAxis])

  if (!hasAnyValue) {
    return (
      <div className={styles.wrap}>
        <StreamPanelHeading channel={channel} headingLevel={headingLevel} headingId={headingId} />
        <Absent reason={`No ${CHANNEL_LABEL[channel].toLowerCase()} recorded for this activity.`} />
      </div>
    )
  }

  return (
    <div className={styles.wrap}>
      <StreamPanelHeading
        channel={channel}
        headingLevel={headingLevel}
        headingId={headingId}
        average={average}
        momentValue={momentValue}
      />
      <div
        className={styles.panel}
        style={{ '--stream-chart-furniture': `${chartFurniturePx(timeAxis)}px` } as CSSProperties}
      >
        <UPlot data={data} options={options} onChart={onChart} />
      </div>
    </div>
  )
}

export interface StreamPanelHeadingProps {
  channel: StreamChannel
  headingLevel?: 2 | 3
  headingId?: string
  /** Omitted when there is no chart to put a reference line on. */
  average?: number | null
  /**
   * The value at the hovered, dragged or replayed moment, formatted (or
   * `'stopped'`, or `NO_VALUE`) - `null` when there is none, which shows the
   * average instead. See `momentValueFor` above.
   */
  momentValue?: string | null
}

/**
 * A stream panel's heading row, and the legend for its average.
 *
 * Exported because the heading has to render in states where the chart
 * does not - a streams request that failed, or one still in flight, both of
 * which `ActivityDetail` handles by replacing the whole panel. It used to
 * live inside `StreamPanel` only, and the section around it named itself
 * `aria-labelledby` this heading's id: on a failed streams request the
 * heading was never rendered, the id pointed at nothing, and the
 * `<section>` silently stopped being a named landmark at all. A heading
 * that only exists when everything worked is not a heading.
 */
export function StreamPanelHeading({
  channel,
  headingLevel = 3,
  headingId,
  average = null,
  momentValue = null,
}: StreamPanelHeadingProps) {
  return (
    <div className={styles.head}>
      {headingLevel === 2 ? (
        <h2 className={styles.title} id={headingId}>
          {CHANNEL_LABEL[channel]}
        </h2>
      ) : (
        <h3 className={styles.title} id={headingId}>
          {CHANNEL_LABEL[channel]}
        </h3>
      )}
      <p className={styles.legend}>
        {momentValue !== null ? (
          <>
            {/* A value that changes on every pointer move is not
                something to announce (see VolumeBars' own readout), so
                it is aria-hidden - the average beside it below, hidden
                visually rather than from the tree, is what a screen
                reader keeps reading instead. No dash swatch here: the
                swatch marks the dashed *average* line, and beside a
                hovered value - on a channel with an average line or not,
                elevation has none at all - it would either mislabel the
                value as the average or, on elevation, key a dashed line
                that is never drawn. */}
            <span aria-hidden="true" className={styles.legendValue}>
              {momentValue}
            </span>
            {average !== null && (
              <span className={styles.srOnly}>average {formatAverage(channel, average)}</span>
            )}
          </>
        ) : average !== null ? (
          <>
            <span aria-hidden="true" className={styles.dash} />
            average <span className={styles.legendValue}>{formatAverage(channel, average)}</span>
          </>
        ) : null}
      </p>
    </div>
  )
}

const AXIS_LABEL_FONT = '11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

/** Re-exported so a test can assert the reference line is dashed. */
export { AVERAGE_DASH }
