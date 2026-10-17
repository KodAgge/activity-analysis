import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import type { components } from '../api/schema'
import { area, shortLocalDate, trimmedNumber } from '../format'
import { cssPixelRatio } from './canvasPixels'
import { cssVar } from './cssVar'
import { growthSeries, withAlpha } from './territoryMath'
import { dateAxisSplits, dateTickLabels, paddedDayRange } from './trendChartMath'
import { UPlot } from './UPlot'
import { clampReadoutLeft, volumeScale } from './volumeBarsMath'
import styles from './TerritoryGrowth.module.css'

type TerritoryGrowthPoint = components['schemas']['TerritoryGrowthPoint']
type TerritoryRegion = components['schemas']['TerritoryRegion']

export interface TerritoryGrowthProps {
  /** `GET /api/territory`'s `growth`: one point per claiming run, oldest first. */
  growth: readonly TerritoryGrowthPoint[]
  /**
   * `GET /api/territory`'s `regions`, so the hover readout can say where a
   * run claimed its ground: on the real store the two largest steps are
   * runs in two different regions, and the date alone does not say which
   * is which. Optional, and a region missing from it is not named.
   */
  regions?: readonly TerritoryRegion[]
  /**
   * The place the map shows: each of its claiming runs is marked by a tick
   * at the foot of the plot, so choosing a place says when its ground was
   * claimed - on the real store 18 of one region's 19 runs fall in three
   * separate months, and one of them is the second largest step on the line.
   * Left out, nothing is marked.
   */
  markedRegionId?: string
  /**
   * Called with the hovered run's region when the plot is clicked, so a
   * step on the line opens its place on the map. The place list beside
   * the map is the keyboard's way to the same choice.
   */
  onSelectRegion?: (regionId: string) => void
}

/** `--chart-height` at the 16px root; the box is sized from outside, see `VolumeBars`' `VOLUME_BARS_HEIGHT_PX`. */
const HEIGHT_PX = 176

/** The axis furniture every chart here shares - see `VolumeBars.tsx` for each figure. */
const AXIS_FONT = '11px "Schibsted Grotesk", system-ui, sans-serif'
const AXIS_LABEL_HALF_PX = 8
const Y_AXIS_SIZE_PX = 52
const X_AXIS_SIZE_PX = 22
const RULE_WIDTH_PX = 1

/** How far the line's end sits inside the plot, so its last step is not drawn on the edge. */
const END_CLEARANCE_PX = 6

/** The fill under the line, as a share of the line's own colour. */
const FILL_ALPHA = 0.1

/**
 * The mark on the line's last point, the total the readout beside the chart
 * states, in CSS px: a dot in the line's colour inside a ring of the page,
 * so it reads as the end of the line rather than as a point among many.
 * The dot is the cursor point's 8 px, so hovering the last run lands on it.
 */
const END_DOT_RADIUS_PX = 4
const END_RING_PX = 2

/**
 * A marked run's tick at the plot's foot, in CSS px: tall enough to read
 * as a mark over the fill's tint, short enough that a run of them reads as
 * a rug under the line rather than as bars. They are drawn in the line's
 * own colour, so the ticks and the line read as one series.
 */
const MARK_HEIGHT_PX = 9
const MARK_WIDTH_PX = 1.5

function areaTick(km2: number): string {
  return `${trimmedNumber(km2)} km²`
}

interface Hover {
  index: number
  leftPx: number
  panelWidthPx: number
  /**
   * Whether the hovered total is in the upper half of the scale. The
   * readout then sits at the foot of the plot rather than its head: the
   * line only rises, so a late, high point is under a readout at the top,
   * and the ground under it is only the fill's tint.
   */
  high: boolean
}

/**
 * The claimed ground over time: the total after each claiming run, as a
 * step - the total holds between runs and rises at each one that added
 * ground, which a sloped line between runs would misstate.
 *
 * Zero-anchored, unlike the trend charts: this is a total accumulated from
 * nothing, and its question is how much of it each stretch of time added,
 * which only a scale from zero shows in proportion. The ladder is
 * `VolumeBars`' three rules for the same reason.
 *
 * A run whose ground was all claimed before still has a point and moves
 * nothing; the readout names it with `+0.00 km²` rather than hiding it.
 */
export function TerritoryGrowth({ growth, regions = [], markedRegionId, onSelectRegion }: TerritoryGrowthProps) {
  const [hover, setHover] = useState<Hover | null>(null)
  const readoutRef = useRef<HTMLDivElement | null>(null)
  const [readoutWidthPx, setReadoutWidthPx] = useState(0)

  const series = useMemo(() => growthSeries(growth), [growth])
  // Read by the draw hook rather than depended on by `options`, so choosing
  // another place repaints the ticks without rebuilding the chart. A layout
  // effect, so it is set before `UPlot`'s own effect repaints on the key.
  const markedRef = useRef(markedRegionId)
  useLayoutEffect(() => {
    markedRef.current = markedRegionId
  }, [markedRegionId])
  const data = useMemo<uPlot.AlignedData>(() => [series.x, series.y], [series])

  const options = useMemo<uPlot.Options>(() => {
    const inkDim = cssVar('--ink-dim')
    const rule = cssVar('--chart-rule')
    const line = cssVar('--series-1')
    const page = cssVar('--page')
    const scale = volumeScale(Math.max(0, ...series.y))
    const first = series.x[0] ?? 0
    const last = series.x.at(-1) ?? first
    return {
      width: 600,
      height: HEIGHT_PX,
      padding: [AXIS_LABEL_HALF_PX, 0, 0, 0],
      scales: {
        x: {
          time: false,
          range: (u) => paddedDayRange(first, last, u.bbox.width / (window.devicePixelRatio || 1), END_CLEARANCE_PX),
        },
        y: { range: () => [0, scale.max] as [number, number] },
      },
      series: [
        {},
        {
          label: 'Claimed ground',
          stroke: line,
          width: 2,
          fill: withAlpha(line, FILL_ALPHA),
          // Step after: the total after a run holds until the next one.
          paths: uPlot.paths.stepped?.({ align: 1 }),
          points: { show: false },
        },
      ],
      cursor: { y: false, points: { size: 8, width: 2, stroke: line, fill: page } },
      axes: [
        {
          stroke: inkDim,
          font: AXIS_FONT,
          size: X_AXIS_SIZE_PX,
          gap: 6,
          grid: { show: false },
          ticks: { show: false },
          border: { show: false },
          splits: (u) => {
            const [min, max] = [u.scales.x?.min ?? first, u.scales.x?.max ?? last]
            return dateAxisSplits(min, max, u.bbox.width / (window.devicePixelRatio || 1))
          },
          values: (_u, splits) => dateTickLabels(splits),
        },
        {
          side: 1,
          stroke: inkDim,
          font: AXIS_FONT,
          size: Y_AXIS_SIZE_PX,
          align: 2,
          alignTo: 2,
          gap: 0,
          grid: { stroke: rule, width: RULE_WIDTH_PX },
          ticks: { show: false },
          border: { show: false },
          splits: () => scale.splits,
          values: (_u, splits) => splits.map(areaTick),
        },
      ],
      hooks: {
        draw: [
          (u: uPlot) => {
            const x = u.data[0].at(-1)
            const y = u.data[1]?.at(-1)
            if (x === undefined || y === undefined || y === null) return
            const ratio = cssPixelRatio()
            const ctx = u.ctx
            ctx.save()
            ctx.beginPath()
            ctx.arc(u.valToPos(x, 'x', true), u.valToPos(y, 'y', true), (END_DOT_RADIUS_PX + END_RING_PX) * ratio, 0, Math.PI * 2)
            ctx.fillStyle = page
            ctx.fill()
            ctx.beginPath()
            ctx.arc(u.valToPos(x, 'x', true), u.valToPos(y, 'y', true), END_DOT_RADIUS_PX * ratio, 0, Math.PI * 2)
            ctx.fillStyle = line
            ctx.fill()
            ctx.restore()
          },
          (u: uPlot) => {
            const marked = markedRef.current
            if (marked === undefined) return
            const ratio = cssPixelRatio()
            const foot = u.bbox.top + u.bbox.height
            const width = MARK_WIDTH_PX * ratio
            const ctx = u.ctx
            ctx.save()
            ctx.fillStyle = line
            growth.forEach((point, index) => {
              const x = u.data[0][index]
              if (point.region_id !== marked || x === undefined) return
              ctx.fillRect(Math.round(u.valToPos(x, 'x', true) - width / 2), foot - MARK_HEIGHT_PX * ratio, width, MARK_HEIGHT_PX * ratio)
            })
            ctx.restore()
          },
        ],
        setCursor: [
          (u: uPlot) => {
            const index = u.cursor.idx
            const leftPx = u.cursor.left
            if (index === null || index === undefined || leftPx === undefined || leftPx < 0) {
              setHover(null)
              return
            }
            const x = u.data[0][index]
            setHover({
              index,
              leftPx: u.over.offsetLeft + (x === undefined ? leftPx : u.valToPos(x, 'x')),
              panelWidthPx: u.width,
              high: (series.y[index] ?? 0) > scale.max / 2,
            })
          },
        ],
      },
    }
  }, [series, growth])

  const point = hover === null ? undefined : growth[hover.index]
  const place = point === undefined ? undefined : regions.find((region) => region.region_id === point.region_id)

  useLayoutEffect(() => {
    const element = readoutRef.current
    if (element === null) return
    const width = element.offsetWidth
    setReadoutWidthPx((previous) => (previous === width ? previous : width))
  }, [point])

  return (
    <div
      className={onSelectRegion === undefined ? styles.chart : `${styles.chart} ${styles.choosing}`}
      // A pointer shortcut to the hovered run's place; see `onSelectRegion`.
      onClick={() => {
        if (point !== undefined && onSelectRegion !== undefined) onSelectRegion(point.region_id)
      }}
      role="img"
      aria-label={`Claimed ground after each of ${String(growth.length)} claiming runs, rising to ${area(growth.at(-1)?.cumulative_m2 ?? null)}`}
    >
      <UPlot data={data} options={options} redrawKey={markedRegionId} />
      {hover !== null && point !== undefined && (
        <div
          ref={readoutRef}
          className={hover.high ? `${styles.readout} ${styles.readoutLow}` : styles.readout}
          style={{ left: `${String(clampReadoutLeft(hover.leftPx, readoutWidthPx, hover.panelWidthPx))}px` }}
          // Pointer-only, like every chart readout here: see `VolumeBars`.
          aria-hidden="true"
          data-testid="territory-growth-readout"
        >
          <p className={styles.readoutWhen}>
            {shortLocalDate(point.start_time_utc, point.utc_offset_s)}
            {place !== undefined && `, ${place.name}`}
          </p>
          <p className={styles.readoutRow}>
            <span className="mono">{area(point.cumulative_m2)}</span> claimed
          </p>
          <p className={styles.readoutRow}>
            <span className="mono">+{area(point.new_m2)}</span> from this run
          </p>
        </div>
      )}
    </div>
  )
}
