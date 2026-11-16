import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import type { components } from '../api/schema'
import { calendarDayOfDate, dayCount, dayMonthLabel, distance, formLabel, loadLabel, perDayAsWeekly } from '../format'
import { fillBarPath } from './barPath'
import { cssPixelRatio } from './canvasPixels'
import { cssVar } from './cssVar'
import { bandRange, dateAxisSplits, dateTickLabels, indicesWithin } from './trendChartMath'
import { HALF_WEEK_DAYS, loadPlot, loadScales, loadXRange, readingAt, type LoadReading } from './trainingLoadMath'
import { UPlot } from './UPlot'
import { barGeometry, bucketHeading, clampReadoutLeft } from './volumeBarsMath'
import styles from './TrainingLoadChart.module.css'

type LoadDay = components['schemas']['LoadDay']
type LoadWeek = components['schemas']['LoadWeek']

export interface TrainingLoadChartProps {
  /** The daily series, for the 7-day distance line and the readout's day. */
  days: LoadDay[]
  /** The weekly series: TRIMP bars, fitness and fatigue lines, and form. */
  weeks: LoadWeek[]
  /** Names the chart for assistive technology, and its key as `<ariaLabel> legend`. */
  ariaLabel: string
  /** The local calendar date, `YYYY-MM-DD`: only the week holding it reads `so far`. */
  today: string
}

/**
 * The placeholder canvas height in CSS pixels, used only until `UPlot.tsx`
 * measures the box `--chart-load-height` in `theme/tokens.css` sizes; the
 * canvas is then built and resized at the box's own height.
 * `web/tests/phase4.spec.ts` checks in a browser that the canvas fills the box.
 */
const TRAINING_LOAD_HEIGHT_PX = 288

/**
 * The two panels on one plot, as fractions of its height from the bottom:
 * the weekly load above, form below.
 *
 * One uPlot instance rather than two, so the date axis at the foot is
 * shared by construction and one pointer reads both. The air between them
 * holds the form panel's caption and is wider than a rung of either ladder,
 * so the two read as two panels rather than as one plot with a gap.
 */
const LOAD_BAND = { from: 0.39, to: 0.97 } as const
const FORM_BAND = { from: 0.03, to: 0.22 } as const

/** One width for every line, `TrendChart`'s, which `tests/phase4.spec.ts` pins across the page's legends. */
const LINE_WIDTH_PX = 1.8

/**
 * The bars' tone. Below full strength so the three lines over them stay
 * legible where they cross a bar: at full `--series-1` the fitness line,
 * the next slot, is a purple across a crimson.
 */
const BAR_ALPHA = 0.5

/** Bar geometry in CSS pixels, `VolumeBars`' own: a week is one slot. */
const BAR_WIDTH_FACTOR = 0.62
const BAR_MAX_WIDTH_PX = 48
const BAR_MIN_HEIGHT_PX = 2
const BAR_RADIUS_FACTOR = 0.18

/** Grid rules and the zero line are 1 CSS px, what uPlot draws its own at. */
const RULE_WIDTH_PX = 1

const AXIS_FONT_PX = 11
const AXIS_FONT_FAMILY = '"Schibsted Grotesk", system-ui, sans-serif'
const AXIS_FONT = `${String(AXIS_FONT_PX)}px ${AXIS_FONT_FAMILY}`

/** Half a line of `AXIS_FONT`, so the topmost rung is not sliced by the canvas edge. */
const AXIS_LABEL_HALF_PX = 8

/**
 * The left label column, for the TRIMP ladder and the form ladder under it.
 * The widest rung is a four-digit TRIMP, about 26 CSS px at 11 px.
 */
const LEFT_AXIS_SIZE_PX = 34

/** The right label column, for the distance ladder: `100 km` is about 38 CSS px. */
const RIGHT_AXIS_SIZE_PX = 44

/** One line of date labels under the plot. */
const X_AXIS_SIZE_PX = 22

/**
 * How far the form panel's caption sits above its top rung, in CSS pixels:
 * clear of that rung's own label, which is centred on the rule and so
 * reaches about 6 px above it.
 */
const CAPTION_LIFT_PX = 16

/**
 * The distance line's tone. Drawn at the lines' one width, which the page's
 * legends pin, but quieter and before the two weekly lines: it is daily and
 * moves on every run, and at full strength on a phone plot it hid the
 * fatigue line beneath it.
 */
const DISTANCE_ALPHA = 0.7

/**
 * The 7-day distance holds its value until the next day's, since it changes
 * only on the day a run enters or leaves the seven days. Built once: the
 * builder is a factory uPlot calls per draw.
 */
const STEPPED = uPlot.paths.stepped?.({ align: 1 })

/**
 * The series in the key's order, slot order: the bars, then the lines.
 * uPlot draws them in another, which is also the data rows' order: the
 * bars, the distance line, so it passes under the two weekly lines, then
 * fitness, fatigue and form. See `options.series` and `data`.
 */
const SERIES = [
  { label: 'TRIMP per week', key: 'TRIMP per week', slot: 1 },
  { label: 'Fitness (CTL) × 7', key: 'Fitness (CTL) × 7', slot: 2 },
  { label: 'Fatigue (ATL) × 7', key: 'Fatigue (ATL) × 7', slot: 3 },
  { label: '7-day distance', key: '7-day distance (right)', slot: 4 },
  { label: 'Form', key: 'Form (below)', slot: 5 },
] as const

/** The readout's heading: the week, `so far` while it holds today, and its days when it is otherwise short. */
function readoutHeading(reading: LoadReading & { week: LoadWeek }): string {
  const heading = bucketHeading('week', reading.week.week_start)
  if (reading.weekInProgress) return `${heading}, so far`
  if (reading.week.days < 7) return `${heading}, ${dayCount(reading.week.days)}`
  return heading
}

/** uPlot's `points.filter` for a line: the one point of a line that has exactly one, since uPlot draws no path through it. */
function lonePoint(u: uPlot, seriesIdx: number): number[] | null {
  const valued = indicesWithin(u.data[seriesIdx] ?? [], Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)
  return valued.length === 1 ? valued : null
}

interface HoverState {
  index: number
  leftPx: number
  panelWidthPx: number
}

/**
 * The Trends view's training load: weekly heart-rate TRIMP as bars, with
 * fitness (CTL) and fatigue (ATL) as weekly means times seven on the bars'
 * own ladder, the running distance over the 7 days ending each day as a line
 * on a right-hand ladder, and the weekly mean of form in a short panel
 * below on the same date axis, with a zero line.
 *
 * Every value is a stored column from `GET /api/training-load`; the times
 * seven is `format.perDayAsWeekly`, a unit change from per day to per week.
 *
 * **Two ladders, one grid.** The TRIMP ladder is on the left and the
 * distance ladder on the right, both three rungs from zero
 * (`trainingLoadMath.loadScales`), so the rules uPlot draws for the TRIMP
 * ladder are the distance ladder's too, and the plot carries one grid. It
 * is the one chart on the page with a ladder on the left, because it is the
 * one with two quantities on one plot; the left column is the narrowest that
 * holds a four-digit TRIMP.
 *
 * The bars are drawn by hand in a `drawAxes` hook, after uPlot's grid and
 * before its series, so the lines pass over them, with `VolumeBars`' own
 * geometry and path. The form panel's ladder and zero line are drawn there
 * too, since uPlot has one axis column a side and the form ladder shares the
 * left one with TRIMP's.
 *
 * The legend and hover readout are HTML outside and absolutely inside the
 * chart's box, for the reason `UPlot.tsx` documents: nothing may add
 * layout height to the box its resize observer watches.
 */
export function TrainingLoadChart({ days, weeks, ariaLabel, today }: TrainingLoadChartProps) {
  const [hover, setHover] = useState<HoverState | null>(null)
  const readoutRef = useRef<HTMLDivElement | null>(null)
  const [readoutWidthPx, setReadoutWidthPx] = useState(0)

  const plot = useMemo(() => loadPlot(days, weeks), [days, weeks])
  const scales = useMemo(() => loadScales(plot), [plot])
  const xRange = useMemo(() => loadXRange(days, weeks), [days, weeks])
  const data = useMemo<uPlot.AlignedData>(
    () =>
      [plot.x, plot.trimp, plot.distance, plot.fitness, plot.fatigue, plot.form] as unknown as uPlot.AlignedData,
    [plot],
  )

  const options = useMemo<uPlot.Options>(() => {
    const inkDim = cssVar('--ink-dim')
    const grid = cssVar('--chart-rule')
    const colours = SERIES.map((s) => cssVar(`--series-${String(s.slot)}`))
    const barColour = colours[0] ?? ''
    const { load, distance: distanceScale, form } = scales

    const line = (i: number, scale: string): uPlot.Series => {
      const stroke = colours[i] ?? ''
      return {
        label: SERIES[i]?.label,
        scale,
        stroke,
        width: LINE_WIDTH_PX,
        points: { show: false, filter: lonePoint, stroke, fill: stroke },
      }
    }

    return {
      width: 600,
      height: TRAINING_LOAD_HEIGHT_PX,
      padding: [AXIS_LABEL_HALF_PX, 0, 0, 0],
      // Each series' dot stays on the hovered day, for the reason
      // `TrendChart` gives: a weekly series has no value on most days.
      cursor: { dataIdx: (_self, _seriesIdx, closestIdx) => closestIdx },
      scales: {
        x: { time: false, range: () => xRange },
        y: { range: () => bandRange(load, LOAD_BAND.from, LOAD_BAND.to) },
        km: { range: () => bandRange(distanceScale, LOAD_BAND.from, LOAD_BAND.to) },
        form: { range: () => bandRange(form, FORM_BAND.from, FORM_BAND.to) },
      },
      series: [
        {},
        {
          // Drawn by hand, see `drawAxes` below; uPlot paints nothing for it.
          label: SERIES[0].label,
          scale: 'y',
          stroke: barColour,
          fill: barColour,
          paths: () => null,
          points: { show: false },
        },
        { ...line(3, 'km'), alpha: DISTANCE_ALPHA, ...(STEPPED === undefined ? {} : { paths: STEPPED }) },
        line(1, 'y'),
        line(2, 'y'),
        line(4, 'form'),
      ],
      axes: [
        {
          stroke: inkDim,
          font: AXIS_FONT,
          size: X_AXIS_SIZE_PX,
          gap: 6,
          grid: { show: false },
          ticks: { show: false },
          border: { show: false },
          splits: (u, _axisIdx, scaleMin, scaleMax) =>
            dateAxisSplits(scaleMin, scaleMax, u.bbox.width / cssPixelRatio()),
          values: (_u, splits) => dateTickLabels(splits),
        },
        {
          // The TRIMP ladder, left-aligned on the page gutter. Its rules are
          // the plot's only grid, and the distance ladder's rungs sit on them.
          scale: 'y',
          side: 3,
          stroke: inkDim,
          font: AXIS_FONT,
          size: LEFT_AXIS_SIZE_PX,
          align: 1,
          alignTo: 2,
          gap: 0,
          grid: { stroke: grid, width: RULE_WIDTH_PX },
          ticks: { show: false },
          border: { show: false },
          splits: () => load.splits,
          values: (_u, splits) => splits.map((s) => loadLabel(s)),
        },
        {
          scale: 'km',
          side: 1,
          stroke: inkDim,
          font: AXIS_FONT,
          size: RIGHT_AXIS_SIZE_PX,
          align: 2,
          alignTo: 2,
          gap: 0,
          grid: { show: false },
          ticks: { show: false },
          border: { show: false },
          splits: () => distanceScale.splits,
          values: (_u, splits) => splits.map((s) => distance(s, 0)),
        },
      ],
      hooks: {
        drawAxes: [
          (u: uPlot) => {
            const ctx = u.ctx
            const ratio = cssPixelRatio()
            const xs = u.data[0]
            const trimp = u.data[1]
            if (xs === undefined || trimp === undefined) return
            ctx.save()
            ctx.beginPath()
            ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height)
            ctx.clip()

            // The bars: one week a slot, centred on its Thursday.
            const baselineY = u.valToPos(0, 'y', true)
            ctx.globalAlpha = BAR_ALPHA
            ctx.fillStyle = barColour
            for (let k = 0; k < xs.length; k += 1) {
              const value = trimp[k]
              const x = xs[k]
              if (value === null || value === undefined || x === undefined) continue
              const bar = barGeometry({
                centreX: u.valToPos(x, 'x', true),
                slotWidth: u.valToPos(x + HALF_WEEK_DAYS, 'x', true) - u.valToPos(x - HALF_WEEK_DAYS, 'x', true),
                baselineY,
                valueY: u.valToPos(value, 'y', true),
                widthFactor: BAR_WIDTH_FACTOR,
                maxWidthPx: BAR_MAX_WIDTH_PX * ratio,
                minHeightPx: BAR_MIN_HEIGHT_PX * ratio,
                radiusFactor: BAR_RADIUS_FACTOR,
              })
              if (bar !== null) fillBarPath(ctx, bar)
            }
            ctx.globalAlpha = 1
            // The load panel's zero rule again, over the bars that sit on it.
            const ruleWidth = RULE_WIDTH_PX * ratio
            ctx.fillStyle = grid
            ctx.fillRect(u.bbox.left, Math.round(baselineY - ruleWidth / 2), u.bbox.width, ruleWidth)
            ctx.restore()

            // The form panel: its rungs as rules, zero in the dim ink so the
            // line's side of it reads, and its ladder and caption in the
            // left column uPlot gave the TRIMP ladder.
            ctx.save()
            ctx.lineWidth = ruleWidth
            ctx.setLineDash([])
            ctx.font = `${String(Math.round(AXIS_FONT_PX * ratio))}px ${AXIS_FONT_FAMILY}`
            ctx.textAlign = 'left'
            ctx.textBaseline = 'middle'
            const labelX = u.bbox.left - LEFT_AXIS_SIZE_PX * ratio
            for (const tick of form.splits) {
              const y = Math.round(u.valToPos(tick, 'form', true)) + 0.5 * ratio
              ctx.strokeStyle = tick === 0 ? inkDim : grid
              ctx.beginPath()
              ctx.moveTo(u.bbox.left, y)
              ctx.lineTo(u.bbox.left + u.bbox.width, y)
              ctx.stroke()
              ctx.fillStyle = inkDim
              ctx.fillText(formLabel(tick), labelX, y)
            }
            ctx.textBaseline = 'alphabetic'
            ctx.fillText('Form', labelX, u.valToPos(form.max, 'form', true) - CAPTION_LIFT_PX * ratio)
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
            setHover({ index, leftPx: u.over.offsetLeft + leftPx, panelWidthPx: u.width })
          },
        ],
      },
    }
  }, [scales, xRange])

  const hoveredX = hover === null ? undefined : plot.x[hover.index]
  const reading = hoveredX === undefined ? undefined : readingAt(days, weeks, hoveredX, today)

  useLayoutEffect(() => {
    const element = readoutRef.current
    if (element === null) return
    const width = element.offsetWidth
    setReadoutWidthPx((previous) => (previous === width ? previous : width))
  }, [hoveredX])

  return (
    <div className={styles.wrap}>
      <ul className={styles.legend} aria-label={`${ariaLabel} legend`}>
        {SERIES.map((s, i) => {
          const colour = `var(--series-${String(s.slot)})`
          return (
            <li key={s.key} className={styles.legendItem}>
              {i === 0 ? (
                <span aria-hidden="true" className={styles.swatchBar} style={{ background: colour }} />
              ) : (
                <span
                  aria-hidden="true"
                  className={styles.swatch}
                  style={{ borderTopColor: colour, borderTopWidth: `${String(LINE_WIDTH_PX)}px` }}
                />
              )}
              {s.key}
            </li>
          )
        })}
      </ul>
      <div className={styles.chart} role="img" aria-label={ariaLabel}>
        <UPlot data={data} options={options} />
        {hover !== null && reading !== undefined && (
          <div
            ref={readoutRef}
            className={styles.readout}
            style={{ left: `${String(clampReadoutLeft(hover.leftPx, readoutWidthPx, hover.panelWidthPx))}px` }}
            // A pointer-only affordance, left to the pointer, as in `VolumeBars`.
            aria-hidden="true"
            data-testid="load-readout"
          >
            {reading.week !== undefined && (
              <>
                <p className={styles.readoutWhen}>{readoutHeading({ ...reading, week: reading.week })}</p>
                <p className={styles.readoutRow}>
                  <span>TRIMP</span>
                  <span className={styles.readoutValue}>{loadLabel(reading.week.trimp)}</span>
                </p>
                <p className={styles.readoutRow}>
                  <span>Fitness × 7</span>
                  <span className={styles.readoutValue}>{loadLabel(perDayAsWeekly(reading.week.ctl_mean))}</span>
                </p>
                <p className={styles.readoutRow}>
                  <span>Fatigue × 7</span>
                  <span className={styles.readoutValue}>{loadLabel(perDayAsWeekly(reading.week.atl_mean))}</span>
                </p>
                <p className={styles.readoutRow}>
                  <span>Form</span>
                  <span className={styles.readoutValue}>{formLabel(reading.week.form_mean)}</span>
                </p>
              </>
            )}
            {reading.day !== undefined && (
              <p className={styles.readoutRow}>
                <span>7 days to {dayMonthLabel(calendarDayOfDate(reading.day.local_date))}</span>
                <span className={styles.readoutValue}>{distance(reading.day.distance_7d_m, 1)}</span>
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
