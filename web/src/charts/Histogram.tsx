import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type uPlot from 'uplot'
import { cssPixelRatio } from './canvasPixels'
import { cssVar } from './cssVar'
import {
  estimateLabelWidthPx,
  histogramScale,
  medianScaleX,
  outlineSegments,
  slotCentrePx,
  stepBucket,
  xLabelIndices,
  type Bucket,
} from './histogramMath'
import { UPlot } from './UPlot'
import { barGeometry, barScaleRange, clampReadoutLeft } from './volumeBarsMath'
import styles from './Histogram.module.css'

export interface HistogramSeries {
  label: string
  /** One value per bucket: absolute in the chosen measure, or percent when comparing. */
  values: number[]
  /** Fractional bucket position of the group's median, or null. */
  medianAt: number | null
  n: number
}

export interface HistogramProps {
  buckets: Bucket[]
  /** One series draws bars; two draw the second as a stepped outline over the first. */
  series: [HistogramSeries] | [HistogramSeries, HistogramSeries]
  /**
   * Formats a y value for the axis and readout: a count, km, hours or a
   * percent. Pass a stable function (module level or memoised): it is part
   * of the chart's options, whose identity rebuilds the chart.
   */
  formatValue: (v: number) => string
  selectedKey: string | null
  onSelect: (key: string) => void
  /** Accessible name, for example "Distance, runs per bucket". */
  label: string
  /** Shorter plot for small multiples. */
  compact?: boolean
  /** Shared y maximum across small multiples, so their heights compare. */
  yMax?: number
  /** The values are counts, so the y rules land on whole numbers; see `histogramScale`. */
  wholeNumbers?: boolean
}

/**
 * The panel's height in CSS pixels, full and `compact`: `--chart-height`
 * and `--chart-strip` at the 16 px root. They must agree with the tokens
 * that size the box, for the reason `VOLUME_BARS_HEIGHT_PX` gives, and
 * `Histogram.test.tsx` pins both to `theme/tokens.css`.
 */
const HISTOGRAM_HEIGHT_PX = { full: 176, compact: 112 } as const

/**
 * Bar geometry in CSS pixels, handed to `volumeBarsMath.barGeometry`. The
 * width factor is wider than `VolumeBars`' 0.62 because a histogram's
 * buckets are contiguous ranges rather than separate weeks, so the bars sit
 * nearly edge to edge; the gap that remains is what keeps a dimmed
 * neighbour visibly apart from the selected bar.
 */
const BAR_WIDTH_FACTOR = 0.8
const BAR_MAX_WIDTH_PX = 48
const BAR_MIN_HEIGHT_PX = 2
const BAR_RADIUS_FACTOR = 0.18

/** How much of its colour an unselected bar keeps while one is selected. */
const DIMMED_ALPHA = 0.3

/** The second group's outline, 2 CSS px. */
const OUTLINE_WIDTH_PX = 2

/** A median tick: a short stub hanging below the baseline. */
const MEDIAN_TICK_WIDTH_PX = 2
const MEDIAN_TICK_LENGTH_PX = 6

/** Grid rules and the zero rule, at the 1 CSS px uPlot draws its own. */
const RULE_WIDTH_PX = 1

/** The axis font, as `VolumeBars.tsx` sets it: `--text-caption` in the loaded family. */
const AXIS_FONT = '11px "Schibsted Grotesk", system-ui, sans-serif'

/** Half a line of `AXIS_FONT`, so the topmost rule's label is not sliced by the canvas edge. */
const AXIS_LABEL_HALF_PX = 8

/** The right-hand y label column, `VolumeBars`' `Y_AXIS_SIZE_PX`. */
const Y_AXIS_SIZE_PX = 40

/**
 * The x label strip: the labels start below the median ticks rather than
 * among them, so the gap is the tick's length plus a little air, and the
 * strip is that gap plus one line of `AXIS_FONT`.
 */
const X_AXIS_GAP_PX = MEDIAN_TICK_LENGTH_PX + 3
const X_AXIS_SIZE_PX = X_AXIS_GAP_PX + 15

/**
 * The estimate `estimateLabelWidthPx` takes, per character of `AXIS_FONT`,
 * taken slightly wide (digits in that face at 11 px are about 6), and the
 * least air between two x labels.
 */
const AXIS_CHAR_PX = 6.5
const X_LABEL_GAP_PX = 8

/**
 * Which bucket the readout describes and where it sits: the one under the
 * pointer, or the keyboard cursor's.
 */
interface ReadoutAnchor {
  index: number
  /** Offset from the panel's left edge, in CSS pixels; see `setCursor` below. */
  leftPx: number
  panelWidthPx: number
}

/**
 * The keyboard cursor: the active option, whether its readout shows, and
 * whether the next arrow key steps on from it rather than showing it.
 * Neither focus nor a click shows it, because a click focuses the chart too
 * and would otherwise leave a readout behind once the pointer leaves; an
 * arrow key shows it. After focus the first arrow shows the active option,
 * which nothing on screen has named yet; after a click the pointer has
 * already shown the clicked bucket, so the first arrow steps on from it.
 */
interface KeyboardCursor extends ReadoutAnchor {
  shown: boolean
  stepsOn: boolean
}

/** The plot's placement in the panel, in CSS pixels, as last drawn. */
interface PlotGeometry {
  plotLeftPx: number
  plotWidthPx: number
  panelWidthPx: number
}

/** Top-rounded bar path; the same shape as `VolumeBars`' `fillBarPath`. */
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
 * A histogram over `buckets`: the first series as bars in `--ink`, an
 * optional second as a stepped outline in `--accent` over them, and each
 * series' median as a tick below the baseline in its own colour.
 *
 * **Selecting a bucket.** A click or tap selects the bucket under the
 * pointer through `onSelect`; which bucket that is comes from uPlot's
 * `setCursor`, which it fires synchronously on the `mousemove` a tap also
 * produces, so the ref the click reads is current by the time it lands.
 * The chart region itself is a focusable listbox. Focus makes the selected
 * option active, or the first when none is, so `aria-activedescendant`
 * names one from the start; the first arrow key after focus shows that
 * keyboard cursor with the same readout the pointer gets, later ones move
 * it, a click puts it on the clicked bucket, and Enter or Space selects it.
 * Its options are visually hidden text naming each bucket and its values,
 * which is what a screen reader walks, because the canvas says nothing to
 * one.
 *
 * **Selection repaints; it does not rebuild.** The selected bucket is held
 * in a ref the draw hook reads and handed to `UPlot` as its `redrawKey`, so
 * a new selection repaints the same instance. Had it been part of
 * `options`, every selection would destroy and rebuild each chart on the
 * page, every small multiple under `compare=years` included.
 *
 * **The legend.** With two groups, a list above the chart names the bars
 * and the outline, in the order of `series`. It sits outside the listbox,
 * whose children are its options.
 *
 * **What is drawn by hand, and why.** Everything inside the plot is drawn
 * in one `draw` hook: the bars (for the minimum height, clamped radius and
 * width cap `barGeometry` carries), the outline over them, the zero rule
 * over both, and the median ticks below it. uPlot's own series paint
 * nothing. Every size is in CSS pixels and scaled through
 * `cssPixelRatio`, and every canvas property the hook relies on is set
 * inside it, per "Traps" in `docs/reference/frontend.md`.
 *
 * The readout is out of flow and clamped inside the panel, for the reasons
 * `VolumeBars` records.
 */
export function Histogram({
  buckets,
  series,
  formatValue,
  selectedKey,
  onSelect,
  label,
  compact = false,
  yMax,
  wholeNumbers = false,
}: HistogramProps) {
  const [hover, setHover] = useState<ReadoutAnchor | null>(null)
  const [active, setActive] = useState<KeyboardCursor | null>(null)
  const hoverIndexRef = useRef<number | null>(null)
  const geometryRef = useRef<PlotGeometry>({ plotLeftPx: 0, plotWidthPx: 0, panelWidthPx: 0 })
  const readoutRef = useRef<HTMLDivElement | null>(null)
  const [readoutWidthPx, setReadoutWidthPx] = useState(0)
  const idPrefix = useId()

  const count = buckets.length
  const selectedIndex = selectedKey === null ? -1 : buckets.findIndex((bucket) => bucket.key === selectedKey)
  // Read by the draw hook, so a selection repaints rather than rebuilds.
  // Written in a layout effect, which runs before `UPlot`'s own effects
  // either build the chart or redraw it.
  const selectedIndexRef = useRef(selectedIndex)
  useLayoutEffect(() => {
    selectedIndexRef.current = selectedIndex
  }, [selectedIndex])

  const data = useMemo<uPlot.AlignedData>(
    () => [buckets.map((_, i) => i), ...series.map((s) => s.values)],
    [buckets, series],
  )

  const options = useMemo<uPlot.Options>(() => {
    const ink = cssVar('--ink')
    const inkDim = cssVar('--ink-dim')
    const accent = cssVar('--accent')
    const grid = cssVar('--chart-rule')
    const colours = [ink, accent]

    const ownMax = Math.max(0, ...series.flatMap((s) => s.values))
    const scale = histogramScale(Math.max(ownMax, yMax ?? 0), wholeNumbers)
    const xRange = barScaleRange(count)
    const labelWidthPx = estimateLabelWidthPx(
      buckets.map((bucket) => bucket.label),
      AXIS_CHAR_PX,
    )
    const [bars, outline] = series

    return {
      width: 600,
      height: compact ? HISTOGRAM_HEIGHT_PX.compact : HISTOGRAM_HEIGHT_PX.full,
      // Left is zero so the plot starts at the page gutter, with the y
      // ladder on the right, as in `VolumeBars`.
      padding: [AXIS_LABEL_HALF_PX, 0, 0, 0],
      // No drag-to-zoom: a drag across the bars would draw uPlot's
      // selection box over a chart whose x range is fixed.
      cursor: { drag: { x: false, y: false, setScale: false } },
      scales: {
        // Bucket i is centred on i, with half a slot either end so no bar is
        // clipped; see `barScaleRange`.
        x: { time: false, distr: 1, range: () => xRange },
        y: { range: () => [0, scale.max] as [number, number] },
      },
      series: [
        {},
        // Both series paint nothing through uPlot: the draw hook does it.
        { label: bars.label, stroke: ink, fill: ink, paths: () => null, points: { show: false } },
        ...(outline === undefined
          ? []
          : [{ label: outline.label, stroke: accent, paths: () => null, points: { show: false } }]),
      ],
      axes: [
        {
          stroke: inkDim,
          font: AXIS_FONT,
          size: X_AXIS_SIZE_PX,
          gap: X_AXIS_GAP_PX,
          grid: { show: false },
          ticks: { show: false },
          border: { show: false },
          // Recomputed from the plot's width on every layout, so a phone
          // gets fewer labels than a desktop rather than overlapping ones.
          splits: (u: uPlot) =>
            xLabelIndices({
              count,
              plotWidthPx: u.bbox.width / cssPixelRatio(),
              labelWidthPx,
              gapPx: X_LABEL_GAP_PX,
              rightRoomPx: Y_AXIS_SIZE_PX,
            }),
          values: (_u: uPlot, splits: number[]) => splits.map((s) => buckets[Math.round(s)]?.label ?? ''),
        },
        {
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
          splits: () => scale.splits,
          values: (_u: uPlot, splits: number[]) => splits.map((s) => formatValue(s)),
        },
      ],
      hooks: {
        draw: [
          (u: uPlot) => {
            const ctx = u.ctx
            const ratio = cssPixelRatio()
            const baselineY = u.valToPos(0, 'y', true)
            const slotWidth = u.bbox.width / Math.max(count, 1)
            geometryRef.current = {
              plotLeftPx: u.over.offsetLeft,
              plotWidthPx: u.bbox.width / ratio,
              panelWidthPx: u.width,
            }

            ctx.save()

            // The first group as bars, the unselected ones dimmed while a
            // bucket is selected.
            const selected = selectedIndexRef.current
            ctx.fillStyle = ink
            bars.values.forEach((value, i) => {
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
              ctx.globalAlpha = selected === -1 || selected === i ? 1 : DIMMED_ALPHA
              fillBarPath(ctx, bar)
            })
            ctx.globalAlpha = 1

            // The second group as a stepped outline over them.
            if (outline !== undefined) {
              ctx.strokeStyle = accent
              ctx.lineWidth = OUTLINE_WIDTH_PX * ratio
              ctx.lineJoin = 'miter'
              ctx.lineCap = 'butt'
              for (const segment of outlineSegments(outline.values)) {
                ctx.beginPath()
                segment.forEach(([x, y], i) => {
                  const px = u.valToPos(x, 'x', true)
                  const py = u.valToPos(y, 'y', true)
                  if (i === 0) ctx.moveTo(px, py)
                  else ctx.lineTo(px, py)
                })
                ctx.stroke()
              }
            }

            // The zero rule over both, so neither hides it.
            const ruleWidth = RULE_WIDTH_PX * ratio
            ctx.fillStyle = grid
            ctx.fillRect(u.bbox.left, Math.round(baselineY - ruleWidth / 2), u.bbox.width, ruleWidth)

            // Each group's median below the baseline, in its own colour.
            // Below the plot box on purpose: a `draw` hook is not clipped,
            // and the x axis leaves room for the tick above its labels.
            const tickWidth = MEDIAN_TICK_WIDTH_PX * ratio
            const tickLength = MEDIAN_TICK_LENGTH_PX * ratio
            series.forEach((s, i) => {
              const x = medianScaleX(s.medianAt, count)
              if (x === null) return
              ctx.fillStyle = colours[i] ?? ink
              ctx.fillRect(u.valToPos(x, 'x', true) - tickWidth / 2, baselineY, tickWidth, tickLength)
            })

            ctx.restore()
          },
        ],
        setCursor: [
          (u: uPlot) => {
            const index = u.cursor.idx
            const leftPx = u.cursor.left
            // Null with the pointer outside the plot, and a negative `left`
            // on the way out; either way nothing is under it.
            if (index === null || index === undefined || leftPx === undefined || leftPx < 0) {
              hoverIndexRef.current = null
              setHover(null)
              return
            }
            hoverIndexRef.current = index
            // `cursor.left` is from the plotting area; the readout is
            // positioned against the panel. See `VolumeBars`.
            setHover({ index, leftPx: u.over.offsetLeft + leftPx, panelWidthPx: u.width })
          },
        ],
      },
    }
    // State setters and refs are stable; `options` identity is the chart's
    // recreation key (see UPlot.tsx), so only what changes the chart's shape
    // is listed. The selection is not: it repaints through `redrawKey`.
  }, [buckets, series, formatValue, compact, yMax, wholeNumbers, count])

  // The pointer wins over the keyboard cursor while both exist.
  const anchor = hover ?? (active?.shown === true ? active : null)
  const shownIndex = anchor === null ? null : anchor.index
  const shownBucket = shownIndex === null ? undefined : buckets[shownIndex]

  useLayoutEffect(() => {
    const element = readoutRef.current
    if (element === null) return
    const width = element.offsetWidth
    setReadoutWidthPx((previous) => (previous === width ? previous : width))
  }, [shownBucket])

  const readoutLeftPx = anchor === null ? 0 : clampReadoutLeft(anchor.leftPx, readoutWidthPx, anchor.panelWidthPx)

  function optionId(index: number): string {
    return `${idPrefix}-bucket-${String(index)}`
  }

  /** The keyboard cursor on bucket `index`, placed from the plot as last drawn; read in a handler, not during render. */
  function cursorAt(index: number, shown: boolean, stepsOn: boolean): KeyboardCursor {
    const { plotLeftPx, plotWidthPx, panelWidthPx } = geometryRef.current
    return { index, leftPx: slotCentrePx(index, count, plotLeftPx, plotWidthPx), panelWidthPx, shown, stepsOn }
  }

  function handleClick(): void {
    const index = hoverIndexRef.current
    const bucket = index === null ? undefined : buckets[index]
    if (index === null || bucket === undefined) return
    // The keyboard carries on from the bucket just clicked.
    setActive(cursorAt(index, false, true))
    onSelect(bucket.key)
  }

  function handleFocus(): void {
    if (count === 0 || active !== null) return
    setActive(cursorAt(selectedIndex === -1 ? 0 : selectedIndex, false, false))
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      if (active !== null && !active.stepsOn) {
        setActive(cursorAt(active.index, true, true))
        return
      }
      const from = active?.index ?? (selectedIndex === -1 ? null : selectedIndex)
      const index = stepBucket(from, event.key === 'ArrowRight' ? 1 : -1, count)
      if (index === null) return
      setActive(cursorAt(index, true, true))
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const bucket = active === null ? undefined : buckets[active.index]
      if (bucket === undefined) return
      // Space would scroll the page as well.
      event.preventDefault()
      onSelect(bucket.key)
    }
  }

  const [, outlineSeries] = series

  return (
    <div className={styles.histogram}>
      {outlineSeries !== undefined && (
        <ul className={styles.legend} aria-label="Groups">
          {series.map((s, i) => (
            // By position: two groups may share a name.
            <li key={i} className={styles.legendItem}>
              <span
                className={i === 0 ? styles.swatchBars : styles.swatchOutline}
                data-swatch={i === 0 ? 'bars' : 'outline'}
                aria-hidden="true"
              />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div
        className={compact ? `${styles.chart} ${styles.compact}` : styles.chart}
        role="listbox"
        aria-label={label}
        aria-activedescendant={active === null || active.index >= count ? undefined : optionId(active.index)}
        tabIndex={0}
        onClick={handleClick}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        onBlur={() => setActive(null)}
      >
        <div className={styles.plot} aria-hidden="true">
          <UPlot data={data} options={options} redrawKey={selectedIndex} />
        </div>
        {buckets.map((bucket, i) => (
          <div
            key={bucket.key}
            id={optionId(i)}
            role="option"
            aria-selected={i === selectedIndex}
            className={styles.srOnly}
          >
            {`${bucket.label}: ${series.map((s) => `${s.label} ${formatValue(s.values[i] ?? 0)}`).join(', ')}`}
          </div>
        ))}
        {shownIndex !== null && shownBucket !== undefined && (
          <div
            ref={readoutRef}
            className={styles.readout}
            style={{ left: `${String(readoutLeftPx)}px` }}
            // Not a live region, for the reason `VolumeBars.tsx` gives; the
            // options above are what assistive technology reads.
            aria-hidden="true"
            data-testid="histogram-readout"
          >
            <p className={styles.readoutWhen}>{shownBucket.label}</p>
            {series.map((s, i) => (
              // By position: two groups may share a name.
              <p key={i} className={styles.readoutRow}>
                <span>{s.label}</span>
                <span className="mono">{formatValue(s.values[shownIndex] ?? 0)}</span>
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
