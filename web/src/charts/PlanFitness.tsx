import { Absent } from '../components/Absent'
import type { FitnessWeek } from '../components/plan/planLoadMath'
import type { components } from '../api/schema'
import { calendarDayOfDate, dayMonthLabel, formatLoadFigure as figure } from '../format'
import { PLAN_CHART_FALLBACK_WIDTH_PX, linearScale, plotBox, signedLadder, wholeLadder } from './planChartMath'
import type { Ladder, Plot } from './planChartMath'
import { PlanChartStats } from './PlanChartStats'
import type { PlanChartStat } from './PlanChartStats'
import { usePanelWidth } from './usePanelWidth'
import styles from './PlanFitness.module.css'

type LoadPoint = components['schemas']['LoadPoint']

export interface PlanFitnessProps {
  /** From `planLoadMath.fitnessSeries`: the version's expected weekly means. */
  expected: FitnessWeek[]
  /** From `fitnessSeries`: the measured weekly means inside the span. */
  measured: FitnessWeek[]
  /** The last measured day the expected series starts from, or null without one. */
  start: LoadPoint | null
  /** The end of the day before the race, or null without an expected series. */
  raceMorning: LoadPoint | null
  /** Goals whose plans the expected series runs before this plan's first week. */
  bridgedFrom: string[]
  /** The plan's first Monday, the day the bridge ends. */
  planStartDay: number
  firstDay: number
  raceDay: number
  /** Why the measured series is not drawn yet, or null once it is. */
  measuredNote?: string | null
  /**
   * A week to shade, from its Monday to the day after its Sunday (or the
   * race day), with the values it starts from and is expected to end on
   * marked at its edges; the week PDF draws one.
   */
  week?: PlanFitnessWeek | null
  /** Shorter panels and no stat row, for the week PDF, whose table gives the figures. */
  compact?: boolean
}

export interface PlanFitnessWeek {
  fromDay: number
  toDay: number
  start: LoadPoint | null
  end: LoadPoint | null
}

export const NO_EXPECTED_LOAD =
  'This version carries no expected fitness and fatigue: it was proposed before they were projected, or without the planned load to project.'
const NOTHING_TO_DRAW = 'No measured or expected fitness and fatigue over this plan.'

const LOAD_PLOT_PX = 120
const FORM_PLOT_PX = 64
const COMPACT_LOAD_PLOT_PX = 84
const COMPACT_FORM_PLOT_PX = 44
/** Above each plot: its caption and the top rule's label. */
const PANEL_TOP_PX = 22
const PANEL_GAP_PX = 14
const AXIS_PX = 24
const CAPTION_DY = -10
const DATE_LABEL_DY = 16
const LADDER_LABEL_DX = 6
const RACE_LABEL_DX = -4
const DOT_RADIUS_PX = 3
const WEEK_POINT_RADIUS_PX = 3.5

/** Class names, the missing ones left out. */
function classes(...names: (string | undefined)[]): string {
  return names.filter((n) => n !== undefined).join(' ')
}

function points(weeks: FitnessWeek[], x: (d: number) => number, y: (v: number) => number, pick: (w: FitnessWeek) => number): string {
  return weeks.map((w) => `${String(x(w.day))},${String(y(pick(w)))}`).join(' ')
}

/**
 * Fitness, fatigue and form over the plan: the weekly means measured, as
 * the Trends view draws them, and the weekly means `plan propose` expected
 * from the planned load, on one date axis from six weeks before the plan to
 * the race.
 *
 * The upper panel holds fitness (CTL) and fatigue (ATL), each in the
 * colour the Trends view gives it, solid where measured and dashed where
 * expected; the lower holds form, their difference, around a zero rule.
 * A rule marks the race. The stat row leads with what a taper is for: the
 * form and fitness expected on race morning, from the stamp's daily
 * values rather than a weekly mean, against the fitness it started from.
 *
 * Plain SVG, its viewBox the panel's measured width, as `PlanOutlook`.
 */
export function PlanFitness({
  expected,
  measured,
  start,
  raceMorning,
  bridgedFrom,
  planStartDay,
  firstDay,
  raceDay,
  measuredNote = null,
  week = null,
  compact = false,
}: PlanFitnessProps) {
  const [panelRef, measuredWidth] = usePanelWidth<HTMLDivElement>()
  const notes = [
    expected.length === 0 ? NO_EXPECTED_LOAD : null,
    bridgedFrom.length === 0
      ? null
      : `Until ${dayMonthLabel(planStartDay)} the expected line runs the plan of ${bridgedFrom.join(' and ')}.`,
    measuredNote,
  ].filter((n) => n !== null)
  if (expected.length === 0 && measured.length === 0) {
    return <Absent reason={[NOTHING_TO_DRAW, ...notes.filter((n) => n !== NO_EXPECTED_LOAD)].join(' ')} />
  }

  const width = measuredWidth > 0 ? measuredWidth : PLAN_CHART_FALLBACK_WIDTH_PX
  const box = plotBox(width, 0)
  const x = linearScale(firstDay, raceDay, box.left, box.right)
  const all = [...measured, ...expected]

  const loadHeight = compact ? COMPACT_LOAD_PLOT_PX : LOAD_PLOT_PX
  const formHeight = compact ? COMPACT_FORM_PLOT_PX : FORM_PLOT_PX
  const loadPlot: Plot = { left: box.left, right: box.right, top: PANEL_TOP_PX, bottom: PANEL_TOP_PX + loadHeight }
  const formTop = loadPlot.bottom + PANEL_GAP_PX + PANEL_TOP_PX
  const formPlot: Plot = { left: box.left, right: box.right, top: formTop, bottom: formTop + formHeight }
  const height = formPlot.bottom + AXIS_PX

  // The week's edges at the days their values are at, each point a day
  // value where the lines are weekly means.
  const weekPoints = week === null ? [] : [
    ...(week.start === null ? [] : [{ day: week.fromDay, point: week.start }]),
    ...(week.end === null ? [] : [{ day: week.toDay, point: week.end }]),
  ]
  const loadLadder = wholeLadder(
    Math.max(...all.flatMap((w) => [w.ctl, w.atl]), ...weekPoints.flatMap((p) => [p.point.ctl, p.point.atl])),
  )
  const yLoad = linearScale(loadLadder.min, loadLadder.max, loadPlot.bottom, loadPlot.top)
  const formLadder = signedLadder([...all.map((w) => w.form), ...weekPoints.map((p) => p.point.form)])
  const yForm = linearScale(formLadder.min, formLadder.max, formPlot.bottom, formPlot.top)

  const stats: PlanChartStat[] = compact ? [] : [
    ...(raceMorning === null
      ? []
      : [
          { label: 'Form on race morning', value: figure(raceMorning.form, true) },
          { label: 'Fitness on race morning', value: figure(raceMorning.ctl) },
        ]),
    ...(start === null ? [] : [{ label: `Fitness on ${dayMonthLabel(calendarDayOfDate(start.local_date))}`, value: figure(start.ctl) }]),
  ]

  const describe = (name: string, weeks: FitnessWeek[]) =>
    weeks.length === 0
      ? null
      : `${name} fitness ${figure(weeks[0]?.ctl ?? 0)} to ${figure(weeks.at(-1)?.ctl ?? 0)}, fatigue ${figure(weeks[0]?.atl ?? 0)} to ${figure(weeks.at(-1)?.atl ?? 0)}`
  const label = `Fitness and fatigue: ${[
    describe('measured', measured),
    describe('expected', expected),
    raceMorning === null ? null : `form on race morning ${figure(raceMorning.form, true)}`,
  ]
    .filter((d) => d !== null)
    .join('; ')}.`

  const line = (weeks: FitnessWeek[], y: (v: number) => number, pick: (w: FitnessWeek) => number, className: string) => {
    const only = weeks.length === 1 ? weeks[0] : undefined
    // A week alone is a dot, since a polyline of one point draws nothing.
    return only === undefined ? (
      <polyline className={className} points={points(weeks, x, y, pick)} />
    ) : (
      <circle className={classes(styles.dot, className)} cx={x(only.day)} cy={y(pick(only))} r={DOT_RADIUS_PX} />
    )
  }
  // The week's shading, behind the lines, across one panel.
  const band = (plot: Plot) =>
    week === null ? null : (
      <rect
        className={styles.week}
        data-mark="week"
        x={x(week.fromDay)}
        y={plot.top}
        width={Math.max(0, x(week.toDay) - x(week.fromDay))}
        height={plot.bottom - plot.top}
      />
    )
  const series = (weeks: FitnessWeek[], kind: 'measured' | 'expected') =>
    weeks.length === 0 ? null : (
      <g data-mark={kind}>
        {line(weeks, yLoad, (w) => w.ctl, classes(styles.fitness, styles[kind]))}
        {line(weeks, yLoad, (w) => w.atl, classes(styles.fatigue, styles[kind]))}
      </g>
    )
  const formSeries = (weeks: FitnessWeek[], kind: 'measured' | 'expected') =>
    weeks.length === 0 ? null : (
      <g data-mark={kind}>{line(weeks, yForm, (w) => w.form, classes(styles.form, styles[kind]))}</g>
    )

  return (
    <div className={styles.chart} data-chart="">
      <PlanChartStats stats={stats} />
      <div className={styles.body} data-part="panel">
        {notes.length > 0 && (
          <p className={styles.note} role="status">
            {notes.join(' ')}
          </p>
        )}
        <div className={styles.panel} ref={panelRef}>
          <svg className={styles.svg} viewBox={`0 0 ${String(width)} ${String(height)}`} role="img" aria-label={label}>
            <g data-panel="load">
              <PanelLadder plot={loadPlot} ladder={loadLadder} y={yLoad} caption="Fitness and fatigue, weekly means" />
              {band(loadPlot)}
              {series(measured, 'measured')}
              {series(expected, 'expected')}
              {weekPoints.flatMap((p) => [
                <circle
                  key={`ctl-${String(p.day)}`}
                  className={classes(styles.weekPoint, styles.fitness)}
                  data-mark="week-point"
                  cx={x(p.day)}
                  cy={yLoad(p.point.ctl)}
                  r={WEEK_POINT_RADIUS_PX}
                />,
                <circle
                  key={`atl-${String(p.day)}`}
                  className={classes(styles.weekPoint, styles.fatigue)}
                  data-mark="week-point"
                  cx={x(p.day)}
                  cy={yLoad(p.point.atl)}
                  r={WEEK_POINT_RADIUS_PX}
                />,
              ])}
            </g>
            <g data-panel="form">
              <PanelLadder plot={formPlot} ladder={formLadder} y={yForm} caption="Form" />
              {band(formPlot)}
              <line className={styles.zero} x1={formPlot.left} x2={formPlot.right} y1={yForm(0)} y2={yForm(0)} />
              {formSeries(measured, 'measured')}
              {formSeries(expected, 'expected')}
              {weekPoints.map((p) => (
                <circle
                  key={`form-${String(p.day)}`}
                  className={classes(styles.weekPoint, styles.form)}
                  data-mark="week-point"
                  cx={x(p.day)}
                  cy={yForm(p.point.form)}
                  r={WEEK_POINT_RADIUS_PX}
                />
              ))}
            </g>
            <line
              className={styles.race}
              data-mark="race"
              x1={x(raceDay)}
              x2={x(raceDay)}
              y1={loadPlot.top}
              y2={formPlot.bottom}
            />
            <text className={styles.raceLabel} x={x(raceDay) + RACE_LABEL_DX} y={loadPlot.top + 10} textAnchor="end">
              Race
            </text>
            <text className={styles.axisLabel} x={box.left} y={formPlot.bottom + DATE_LABEL_DY} textAnchor="start">
              {dayMonthLabel(firstDay)}
            </text>
            <text className={styles.axisLabel} x={box.right} y={formPlot.bottom + DATE_LABEL_DY} textAnchor="end">
              {dayMonthLabel(raceDay)}
            </text>
          </svg>
        </div>
      </div>
      <ul className={styles.key} aria-hidden="true" data-part="key">
        <li>
          <Swatch className={styles.fitness} />
          Fitness (CTL)
        </li>
        <li>
          <Swatch className={styles.fatigue} />
          Fatigue (ATL)
        </li>
        <li>
          <Swatch className={styles.form} />
          Form
        </li>
        {measured.length > 0 && (
          <li>
            <Swatch className={classes(styles.neutral, styles.measured)} />
            Measured
          </li>
        )}
        {expected.length > 0 && (
          <li>
            <Swatch className={classes(styles.neutral, styles.expected)} />
            Expected from the plan
          </li>
        )}
      </ul>
    </div>
  )
}

function Swatch({ className }: { className: string | undefined }) {
  return (
    <svg className={styles.swatch} viewBox="0 0 16 12" width="16" height="12">
      <line className={className} x1="0" x2="16" y1="6" y2="6" />
    </svg>
  )
}

/** A panel's rules, their labels in the right gutter, and its caption over the top-left corner. */
function PanelLadder({ plot, ladder, y, caption }: { plot: Plot; ladder: Ladder; y: (v: number) => number; caption: string }) {
  return (
    <>
      <text className={styles.caption} x={plot.left} y={plot.top + CAPTION_DY}>
        {caption}
      </text>
      {ladder.ticks.map((t) => (
        <g key={t}>
          <line className={styles.rule} data-rule="" x1={plot.left} x2={plot.right} y1={y(t)} y2={y(t)} />
          <text className={styles.axisLabel} x={plot.right + LADDER_LABEL_DX} y={y(t)} dominantBaseline="middle">
            {t > 0 && ladder.min < 0 ? `+${String(t)}` : String(t)}
          </text>
        </g>
      ))}
    </>
  )
}
