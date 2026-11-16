import { Absent } from '../components/Absent'
import { calendarDayOfDate, dayMonthLabel } from '../format'
import { PLAN_CHART_FALLBACK_WIDTH_PX, linearScale, plotBox, spanEndLabels, vo2maxLadder } from './planChartMath'
import type { Ladder, Plot } from './planChartMath'
import { PlanChartStats } from './PlanChartStats'
import type { PlanChartStat } from './PlanChartStats'
import { usePanelWidth } from './usePanelWidth'
import styles from './PlanOutlook.module.css'

export interface PlanOutlookProps {
  /** From `planLoadMath.outlookSeries`: what the shown version expects, per week. */
  expected: { date: string; vdot: number; garmin: number | null }[]
  /**
   * From `outlookSeries`: the best-efforts series' VDOT at each run since
   * the plan's first week, in unbroken runs, each drawn as its own line.
   */
  measured: { date: string; vdot: number }[][]
  /** The shown version's `target_vdot`, or null. */
  targetVdot: number | null
  /**
   * Garmin's own VO2max by day, `GET /api/fitness`'s `device` unrounded
   * (the watch shows it as a whole number), any span: days outside the chart's are left out.
   */
  garmin: { date: string; vo2max: number }[]
  /** The plan's first Monday and the race, the date axis's span at least. */
  startDate: string
  raceDate: string
  /** Why Garmin's own values are not known yet, or null once they are. */
  deviceNote?: string | null
  /** Why the measured VDOT is missing, while the prediction history loads or after it failed; null once it is in. */
  measuredNote?: string | null
}

/** The outlook's line when no version carries an expected or measured VO2max. */
const NOTHING_STAMPED = 'No version of this plan carries a VO2max outlook.'
const VERSION_PREDATES = 'This version predates the VO2max outlook.'
const NO_GARMIN = 'No Garmin VO2max over this span, and this version expects none.'

/** The VDOT panel's plot height; Garmin's is shorter, since its whole numbers move less. */
const VDOT_PLOT_PX = 96
const GARMIN_PLOT_PX = 64
/** Above each plot: its caption and the top rule's label. */
const PANEL_TOP_PX = 22
/** Under the last plot: the date labels. */
const AXIS_PX = 24
/** Between the first plot's bottom and the second's caption. */
const PANEL_GAP_PX = 14
const MEASURED_RADIUS_PX = 4.5
const EXPECTED_RADIUS_PX = 3
const CAPTION_DY = -10
const TARGET_LABEL_DY = -6
const DATE_LABEL_DY = 16
const LADDER_LABEL_DX = 6

/** A VDOT or a Garmin VO2max to one decimal, as the context prints it. */
function vdotLabel(v: number): string {
  return v.toFixed(1)
}

/** A ladder value: whole where it is, else to half a unit. */
function tickLabel(t: number): string {
  return Number.isInteger(t) ? String(t) : t.toFixed(1)
}

/**
 * A polyline's points that hold each value until the next day's, as the
 * watch holds its number, rather than sloping between two days.
 */
function stepPoints(points: { cx: number; cy: number }[]): string {
  return points
    .flatMap((p, i) => {
      const before = points[i - 1]
      return before === undefined ? [p] : [{ cx: p.cx, cy: before.cy }, p]
    })
    .map((p) => `${String(p.cx)},${String(p.cy)}`)
    .join(' ')
}

/**
 * Garmin's days inside `[firstDay, lastDay]`, oldest first, led by the
 * last value before the span carried to its first day: the watch holds
 * its number between readings, so that value is in force when the axis
 * starts.
 */
function deviceInSpan(
  garmin: { date: string; vo2max: number }[],
  firstDay: number,
  lastDay: number,
): { day: number; value: number }[] {
  const days = garmin
    .map((g) => ({ day: calendarDayOfDate(g.date), value: g.vo2max }))
    .sort((a, b) => a.day - b.day)
  const inside = days.filter((g) => g.day >= firstDay && g.day <= lastDay)
  const before = days.filter((g) => g.day < firstDay).at(-1)
  return before === undefined || inside[0]?.day === firstDay ? inside : [{ day: firstDay, value: before.value }, ...inside]
}

/**
 * Garmin's days as runs of one label to a decimal: `51.4 from 20 Nov, 51.7
 * from 27 Nov`. The values are unrounded and move a little most days, so a
 * run is a stretch whose one-decimal label holds, not whose value does.
 */
function deviceRuns(points: { day: number; value: number }[]): string {
  const labelled = points.map((p) => ({ day: p.day, label: vdotLabel(p.value) }))
  return labelled
    .filter((p, i) => i === 0 || labelled[i - 1]?.label !== p.label)
    .map((p) => `${p.label} from ${dayMonthLabel(p.day)}`)
    .join(', ')
}

/**
 * The VO2max outlook: what Claude expects the athlete's VO2max to be at the
 * end of each week, against what was measured, in two panels on one date
 * axis, each panel on its own ladder (`vo2maxLadder`), since VDOT and
 * Garmin's number sit apart.
 *
 * The upper panel is VDOT, the race-time equivalent: the version's
 * `expected_vdot` per week as a dashed line with hollow points, the
 * best-efforts series' VDOT at each run since the first week as a solid
 * line, the one the trajectory draws as a time, and the goal's `target_vdot` as the ink line `PlanTrajectory` draws its
 * target in. The lower is Garmin's own: `expected_garmin_vo2max` per
 * week the same way, and the watch's daily number as a thin solid line
 * that holds each value until the next, since the watch's number is a step.
 *
 * The date axis runs from the plan's first Monday, or an earlier measured
 * or expected point, to the race; Garmin's days outside it are left out
 * rather than widening it, since the watch has a value for years; the
 * last one before the span is carried to its left edge.
 *
 * A stat row over the panels gives the VDOT expected by the race, the
 * target and the latest measured.
 *
 * Plain SVG, its viewBox the panel's measured width, as `PlanVolume`.
 */
export function PlanOutlook({
  expected,
  measured,
  targetVdot,
  garmin,
  startDate,
  raceDate,
  deviceNote = null,
  measuredNote = null,
}: PlanOutlookProps) {
  const [panelRef, measuredWidth] = usePanelWidth<HTMLDivElement>()
  // With nothing to draw while the history is not in, that is the reason, not the absence of an outlook.
  if (expected.length === 0 && measured.length === 0) return <Absent reason={measuredNote ?? NOTHING_STAMPED} />

  const width = measuredWidth > 0 ? measuredWidth : PLAN_CHART_FALLBACK_WIDTH_PX
  const box = plotBox(width, 0)

  const exp = expected.map((e) => ({ ...e, day: calendarDayOfDate(e.date) }))
  const measuredRuns = measured.map((run) => run.map((m) => ({ ...m, day: calendarDayOfDate(m.date) })))
  const meas = measuredRuns.flat()
  const datedDays = [
    calendarDayOfDate(startDate),
    calendarDayOfDate(raceDate),
    ...exp.map((e) => e.day),
    ...meas.map((m) => m.day),
  ]
  const firstDay = Math.min(...datedDays)
  const lastDay = Math.max(...datedDays)
  const x = linearScale(firstDay, lastDay, box.left, box.right)
  const [firstLabel, lastLabel] = spanEndLabels(firstDay, lastDay)

  const expGarmin = exp.flatMap((e) => (e.garmin === null ? [] : [{ day: e.day, value: e.garmin }]))
  const device = deviceNote !== null ? [] : deviceInSpan(garmin, firstDay, lastDay)
  const withGarmin = expGarmin.length > 0 || device.length > 0

  const vdotPlot: Plot = { left: box.left, right: box.right, top: PANEL_TOP_PX, bottom: PANEL_TOP_PX + VDOT_PLOT_PX }
  const garminTop = vdotPlot.bottom + PANEL_GAP_PX + PANEL_TOP_PX
  const garminPlot: Plot = { left: box.left, right: box.right, top: garminTop, bottom: garminTop + GARMIN_PLOT_PX }
  const axisBottom = withGarmin ? garminPlot.bottom : vdotPlot.bottom
  const height = axisBottom + AXIS_PX

  const vdotLadder = vo2maxLadder([
    ...(targetVdot === null ? [] : [targetVdot]),
    ...exp.map((e) => e.vdot),
    ...meas.map((m) => m.vdot),
  ])
  const yVdot = linearScale(vdotLadder.min, vdotLadder.max, vdotPlot.bottom, vdotPlot.top)
  const garminLadder = withGarmin
    ? vo2maxLadder([...expGarmin.map((g) => g.value), ...device.map((d) => d.value)])
    : null
  const yGarmin =
    garminLadder === null ? null : linearScale(garminLadder.min, garminLadder.max, garminPlot.bottom, garminPlot.top)

  const notes = [
    expected.length === 0 ? VERSION_PREDATES : null,
    withGarmin ? null : NO_GARMIN,
    deviceNote,
    measuredNote,
  ].filter((n) => n !== null)

  const described = [
    exp.length === 0
      ? null
      : `expected VDOT ${exp.map((e) => `${vdotLabel(e.vdot)} by ${dayMonthLabel(e.day)}`).join(', ')}`,
    meas.length === 0
      ? null
      : `measured VDOT ${[meas[0], meas.length > 1 ? meas.at(-1) : undefined]
          .filter((m) => m !== undefined)
          .map((m) => `${vdotLabel(m.vdot)} on ${dayMonthLabel(m.day)}`)
          .join(' to ')}`,
    targetVdot === null ? null : `target VDOT ${vdotLabel(targetVdot)}`,
    expGarmin.length === 0
      ? null
      : `expected Garmin VO2max ${expGarmin.map((g) => `${vdotLabel(g.value)} by ${dayMonthLabel(g.day)}`).join(', ')}`,
    device.length === 0 ? null : `Garmin's own ${deviceRuns(device)}`,
  ].filter((d) => d !== null)
  const label = `VO2max outlook: ${described.join('; ')}.`

  // The stat row: the VDOT the version expects by the race against the
  // target it was written toward, and the latest measured, oldest first.
  const atRace = [...exp].sort((a, b) => a.day - b.day).at(-1) ?? null
  const latest = [...meas].sort((a, b) => a.day - b.day).at(-1) ?? null
  const stats: PlanChartStat[] = [
    ...(atRace === null ? [] : [{ label: 'VDOT at the race', value: vdotLabel(atRace.vdot) }]),
    ...(targetVdot === null ? [] : [{ label: 'Target', value: vdotLabel(targetVdot) }]),
    ...(latest === null ? [] : [{ label: 'Latest measured', value: vdotLabel(latest.vdot) }]),
  ]

  return (
    <div className={styles.chart} data-chart="">
      <PlanChartStats stats={stats} />
      {/* The status line rides with the plot, in the card's plot row. */}
      <div className={styles.body} data-part="panel">
      {notes.length > 0 && (
        <p className={styles.note} role="status">
          {notes.join(' ')}
        </p>
      )}
      <div className={styles.panel} ref={panelRef}>
        <svg className={styles.svg} viewBox={`0 0 ${String(width)} ${String(height)}`} role="img" aria-label={label}>
          <g data-panel="vdot">
            <PanelLadder plot={vdotPlot} ladder={vdotLadder} y={yVdot} caption="VDOT" />
            {targetVdot !== null && (
              <>
                <line
                  className={styles.target}
                  data-mark="target"
                  x1={vdotPlot.left}
                  x2={vdotPlot.right}
                  y1={yVdot(targetVdot)}
                  y2={yVdot(targetVdot)}
                />
                <text
                  className={styles.targetLabel}
                  x={vdotPlot.right}
                  y={yVdot(targetVdot) + TARGET_LABEL_DY}
                  textAnchor="end"
                >
                  Target {vdotLabel(targetVdot)}
                </text>
              </>
            )}
            <Expected points={exp.map((e) => ({ cx: x(e.day), cy: yVdot(e.vdot) }))} />
            {measuredRuns.map((run) =>
              run.length > 1 ? (
                <polyline
                  key={run[0]?.date}
                  className={styles.measured}
                  data-mark="measured"
                  points={run.map((m) => `${String(x(m.day))},${String(yVdot(m.vdot))}`).join(' ')}
                />
              ) : (
                <circle
                  key={run[0]?.date}
                  className={styles.measuredDot}
                  data-mark="measured"
                  cx={x(run[0]?.day ?? firstDay)}
                  cy={yVdot(run[0]?.vdot ?? vdotLadder.min)}
                  r={MEASURED_RADIUS_PX}
                />
              ),
            )}
          </g>
          {garminLadder !== null && yGarmin !== null && (
            <g data-panel="garmin">
              <PanelLadder plot={garminPlot} ladder={garminLadder} y={yGarmin} caption="Garmin VO2max" />
              {device.length > 1 && (
                <polyline
                  className={styles.device}
                  data-mark="device"
                  points={stepPoints(device.map((d) => ({ cx: x(d.day), cy: yGarmin(d.value) })))}
                />
              )}
              {device.length === 1 && device[0] !== undefined && (
                <circle
                  className={styles.deviceDot}
                  data-mark="device"
                  cx={x(device[0].day)}
                  cy={yGarmin(device[0].value)}
                  r={1.5}
                />
              )}
              <Expected points={expGarmin.map((g) => ({ cx: x(g.day), cy: yGarmin(g.value) }))} />
            </g>
          )}
          <text className={styles.axisLabel} x={box.left} y={axisBottom + DATE_LABEL_DY} textAnchor="start">
            {firstLabel}
          </text>
          <text className={styles.axisLabel} x={box.right} y={axisBottom + DATE_LABEL_DY} textAnchor="end">
            {lastLabel}
          </text>
        </svg>
      </div>
      </div>
      <ul className={styles.key} aria-hidden="true" data-part="key">
        {exp.length > 0 && (
          <li>
            <svg className={styles.swatch} viewBox="0 0 16 12" width="16" height="12">
              <line className={styles.expectedLine} x1="0" x2="16" y1="6" y2="6" />
              <circle className={styles.expectedPoint} cx="8" cy="6" r={EXPECTED_RADIUS_PX} />
            </svg>
            Expected by Claude
          </li>
        )}
        {meas.length > 0 && (
          <li>
            <svg className={styles.swatch} viewBox="0 0 16 12" width="16" height="12">
              <line className={styles.measured} x1="0" x2="16" y1="6" y2="6" />
            </svg>
            Measured from best efforts
          </li>
        )}
        {targetVdot !== null && (
          <li>
            <svg className={styles.swatch} viewBox="0 0 16 12" width="16" height="12">
              <line className={styles.target} x1="0" x2="16" y1="6" y2="6" />
            </svg>
            Target
          </li>
        )}
        {device.length > 0 && (
          <li>
            <svg className={styles.swatch} viewBox="0 0 16 12" width="16" height="12">
              <line className={styles.device} x1="0" x2="16" y1="6" y2="6" />
            </svg>
            Garmin&apos;s daily value
          </li>
        )}
      </ul>
    </div>
  )
}

/** A panel's rules, their labels in the right gutter, and its caption over the top-left corner. */
function PanelLadder({
  plot,
  ladder,
  y,
  caption,
}: {
  plot: Plot
  ladder: Ladder
  y: (v: number) => number
  caption: string
}) {
  return (
    <>
      <text className={styles.caption} x={plot.left} y={plot.top + CAPTION_DY}>
        {caption}
      </text>
      {ladder.ticks.map((t) => (
        <g key={t}>
          <line className={styles.rule} data-rule="" x1={plot.left} x2={plot.right} y1={y(t)} y2={y(t)} />
          <text className={styles.axisLabel} x={plot.right + LADDER_LABEL_DX} y={y(t)} dominantBaseline="middle">
            {tickLabel(t)}
          </text>
        </g>
      ))}
    </>
  )
}

/** An expected series: a dashed line through hollow points, or one point alone. */
function Expected({ points }: { points: { cx: number; cy: number }[] }) {
  if (points.length === 0) return null
  return (
    <g data-mark="expected">
      {points.length > 1 && (
        <polyline
          className={styles.expectedLine}
          points={points.map((p) => `${String(p.cx)},${String(p.cy)}`).join(' ')}
        />
      )}
      {points.map((p, i) => (
        <circle key={i} className={styles.expectedPoint} cx={p.cx} cy={p.cy} r={EXPECTED_RADIUS_PX} />
      ))}
    </g>
  )
}
