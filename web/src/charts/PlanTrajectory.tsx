import type { components } from '../api/schema'
import { calendarDayOfDate, checkpointLabel, dayMonthLabel, duration, localCalendarDay } from '../format'
import {
  LABEL_CHAR_PX,
  PLAN_CHART_FALLBACK_WIDTH_PX,
  linearScale,
  placeStripLabels,
  spanEndLabels,
  timeLadder,
  trajectoryLayout,
  trajectoryDays,
} from './planChartMath'
import { PREDICTION_COLOR_VAR, breakAtGaps, diamondPath, splitAtNulls } from './progressionMath'
import { latestBestEffortsS } from '../components/plan/planMath'
import { PlanChartStats } from './PlanChartStats'
import type { PlanChartStat } from './PlanChartStats'
import { usePanelWidth } from './usePanelWidth'
import styles from './PlanTrajectory.module.css'

type PredictionHistoryPoint = components['schemas']['PredictionHistoryPoint']

/** A checkpoint dated by its session, as `planMath.checkpointSessions` gives it. */
export interface PlanTrajectoryCheckpoint {
  sessionId: string
  /** The session's local calendar date. */
  date: string
  /** The session's kind, `time_trial` and the rest. */
  kind: string
  /** The session's planned distance: the distance the checkpoint's target is at. */
  targetDistanceM: number | null
  description: string
  targetS: number | null
}

export interface PlanTrajectoryProps {
  /** `planMath.expectedLine`: the shown version's expected time per local date, empty for a version without one. */
  expected: { date: string; valueS: number }[]
  /** `GET /api/predictions/history` at the goal distance, oldest first. */
  history: PredictionHistoryPoint[]
  /** The goal's target time, in seconds. */
  targetS: number
  /** The race's local calendar date, the right end of the axis; nothing after it is drawn. */
  raceDate: string
  /** `planMath.measuredFrom`: the measured lines start at the first run on or after it. */
  measuredFrom: string
  checkpoints: PlanTrajectoryCheckpoint[]
  /** Why the measured lines are missing, while the history loads or after it failed; null once it is in. */
  measuredNote: string | null
}

/**
 * The two measured lines, in `PREDICTION_COLOR_VAR`; ordinary runs
 * fainter, since the plan's estimate rests on best efforts.
 */
const MEASURED_LINES = [
  {
    model: 'best_efforts',
    field: 'best_efforts_s',
    name: 'best efforts',
    key: 'Best efforts',
    color: `var(${PREDICTION_COLOR_VAR.best_efforts})`,
    opacity: 1,
  },
  {
    model: 'ordinary_runs',
    field: 'ordinary_runs_s',
    name: 'ordinary runs',
    key: 'Ordinary runs',
    color: `var(${PREDICTION_COLOR_VAR.ordinary_runs})`,
    opacity: 0.55,
  },
] as const
/** The expected line forecasts the best-efforts series, so it takes that line's colour, dashed. */
const EXPECTED_COLOR = `var(${PREDICTION_COLOR_VAR.best_efforts})`
const EXPECTED_DASH = '4 3'
/**
 * A run its neighbours do not join, drawn as a dot so the first run of a
 * plan shows; an expected line of one point is drawn the same way.
 */
const LONE_RUN_RADIUS_PX = 2.5
const CHECKPOINT_RADIUS_PX = 5
/** A checkpoint's label starts this far beside its diamond's centre. */
const CHECKPOINT_LABEL_DX = 9
/**
 * An estimate of one character's advance at `--text-label` (12 px) in
 * the sans, for telling whether two checkpoint labels collide:
 * `planChartMath.LABEL_CHAR_PX`.
 */
const CAPTION_CHAR_PX = LABEL_CHAR_PX
const CHECKPOINT_LABEL_PAD_PX = 8
const TARGET_LABEL_DY = -6
const LADDER_LABEL_DX = 6
const NO_EXPECTED = 'This version predates the expected prediction.'

/** A line's first and last value, `26:00 on 5 Feb to 25:20 on 13 Mar`, for the text alternative. */
function span(points: { t: number; v: number }[]): string {
  const first = points[0]
  const last = points.at(-1)
  if (first === undefined || last === undefined) return 'none'
  const at = (p: { t: number; v: number }) => `${duration(p.v)} on ${dayMonthLabel(Math.floor(p.t))}`
  return first === last ? at(first) : `${at(first)} to ${at(last)}`
}

/**
 * The predicted time at the goal distance against the target: what the
 * shown version expects, dashed, and what was measured, solid, from six
 * weeks before the plan (`planMath.measuredFrom`) to the race. Nothing
 * after the race is drawn, so a past goal's chart ends on its race.
 *
 * The y axis is time and inverted, faster up, on a ladder of whole half
 * minutes that brackets every value and the target (`timeLadder`). The
 * expected line is `planMath.expectedLine`. The measured lines are the
 * prediction history, one point per run on the run's own local day,
 * broken where a model had no value and where runs are more than six
 * weeks apart (`splitAtNulls`, `breakAtGaps`): best efforts and ordinary
 * runs fainter, in `PREDICTION_COLOR_VAR`. They reach
 * further right as runs come in. The target is an ink line labelled with
 * its time. A stat row over the chart gives the latest best-efforts
 * prediction (`planMath.latestBestEffortsS`, the header's number), the
 * target and the time between them.
 *
 * **Checkpoints sit in a strip of their own under the plot**, not on the
 * time axis: a checkpoint's target is usually at another distance - a
 * 3 km time trial toward a 5 km goal - so any height on this axis would
 * claim a time it does not have. A diamond at its session's date says
 * when it falls, and its label says the distance and the target, `3 km TT
 * 11:30` (`format.checkpointLabel`). See `planChartMath.trajectoryLayout`.
 *
 * Plain SVG, its viewBox the panel's measured width, as `PlanVolume`.
 */
export function PlanTrajectory({
  expected,
  history,
  targetS,
  raceDate,
  measuredFrom,
  checkpoints,
  measuredNote,
}: PlanTrajectoryProps) {
  const [panelRef, measured] = usePanelWidth<HTMLDivElement>()
  const width = measured > 0 ? measured : PLAN_CHART_FALLBACK_WIDTH_PX

  const raceDay = calendarDayOfDate(raceDate)
  const expectedPoints = expected
    .map((e) => ({ t: calendarDayOfDate(e.date), v: e.valueS }))
    .filter(({ t }) => t <= raceDay)
  const fromDay = calendarDayOfDate(measuredFrom)
  // Each run on its local day, as the expected line's dates and the race
  // are, so a race-day run sits on the race's day rather than past it.
  const runs = history
    .map((p) => ({ p, t: localCalendarDay(p.start_time_utc, p.utc_offset_s) }))
    .filter(({ t }) => t >= fromDay && t <= raceDay)
  const lines = MEASURED_LINES.map((line) => ({
    ...line,
    runs: splitAtNulls(breakAtGaps(runs.map(({ p, t }) => ({ t, v: p[line.field] })))),
  }))
  const measuredPoints = lines.flatMap((line) => line.runs.flat())

  const { plot, dateY, strip, height } = trajectoryLayout(
    width,
    expectedPoints.length + measuredPoints.length,
    checkpoints.length > 0,
  )
  const stripY = strip === null ? null : strip.markY
  const checkpointDays = checkpoints.map((c) => calendarDayOfDate(c.date))
  const [firstDay, lastDay] = trajectoryDays(
    [...expectedPoints, ...measuredPoints].map((p) => p.t),
    checkpointDays,
    raceDay,
  )
  const x = linearScale(firstDay, lastDay, plot.left, plot.right)
  const [firstLabel, lastLabel] = spanEndLabels(firstDay, lastDay)

  const ladder = timeLadder([targetS, ...expectedPoints.map((p) => p.v), ...measuredPoints.map((p) => p.v)])
  const y = linearScale(ladder.min, ladder.max, plot.top, plot.bottom)
  const xy = (points: { t: number; v: number }[]) => points.map((p) => `${String(x(p.t))},${String(y(p.v))}`).join(' ')

  const flags = checkpoints.map((c) => {
    const text = checkpointLabel(c.kind, c.targetDistanceM, c.targetS)
    return { checkpoint: c, cx: x(calendarDayOfDate(c.date)), text, width: text.length * CAPTION_CHAR_PX }
  })
  const flagSides = placeStripLabels(
    flags,
    plot.left,
    plot.right,
    CHECKPOINT_LABEL_DX,
    CHECKPOINT_RADIUS_PX,
    CHECKPOINT_LABEL_PAD_PX,
  )

  const described = [
    expectedPoints.length === 0 ? 'no expected line' : `expected ${span(expectedPoints)}`,
    ...lines.map((line) => `${line.name} ${span(line.runs.flat())}`),
    `target ${duration(targetS)} on ${dayMonthLabel(raceDay)}`,
    ...checkpoints.map((c) => {
      const base = `checkpoint ${dayMonthLabel(calendarDayOfDate(c.date))}, ${c.description}`
      return c.targetS === null ? base : `${base}, target ${duration(c.targetS)}`
    }),
  ]
  const label = `Predicted time, expected and measured, against the target: ${described.join('; ')}.`

  // The latest best-efforts prediction against the target, Runna's estimate
  // card's "current" against its goal, over the chart that traces it.
  const latest = latestBestEffortsS(history)
  const stats: PlanChartStat[] = [
    ...(latest === null ? [] : [{ label: 'Latest prediction', value: duration(latest) }]),
    { label: 'Target', value: duration(targetS) },
    ...(latest === null
      ? []
      : [
          latest > targetS
            ? { label: 'To find', value: duration(latest - targetS) }
            : { label: 'Inside target by', value: duration(targetS - latest) },
        ]),
  ]

  return (
    <div className={styles.chart} data-chart="">
      <PlanChartStats stats={stats} />
      {(expectedPoints.length === 0 || measuredNote !== null) && (
        <p className={styles.note} role="status">
          {[expectedPoints.length === 0 ? NO_EXPECTED : null, measuredNote].filter((n) => n !== null).join(' ')}
        </p>
      )}
      <div className={styles.panel} ref={panelRef} data-part="panel">
        <svg
          className={styles.svg}
          viewBox={`0 0 ${String(width)} ${String(height)}`}
          role="img"
          aria-label={label}
        >
          {ladder.ticks.map((t) => (
            <g key={t}>
              <line className={styles.rule} x1={plot.left} x2={plot.right} y1={y(t)} y2={y(t)} />
              <text className={styles.axisLabel} x={plot.right + LADDER_LABEL_DX} y={y(t)} dominantBaseline="middle">
                {duration(t)}
              </text>
            </g>
          ))}

          <line
            className={styles.target}
            data-mark="target"
            x1={plot.left}
            x2={plot.right}
            y1={y(targetS)}
            y2={y(targetS)}
          />
          <text className={styles.targetLabel} x={plot.right} y={y(targetS) + TARGET_LABEL_DY} textAnchor="end">
            Target {duration(targetS)}
          </text>

          {lines.map((line) =>
            line.runs.map((run) =>
              run.length > 1 ? (
                <polyline
                  key={`${line.model}${String(run[0]?.t)}`}
                  className={styles.line}
                  data-series={line.model}
                  stroke={line.color}
                  strokeOpacity={line.opacity}
                  points={xy(run)}
                />
              ) : (
                <circle
                  key={`${line.model}${String(run[0]?.t)}`}
                  data-series={line.model}
                  fill={line.color}
                  fillOpacity={line.opacity}
                  cx={x(run[0]?.t ?? 0)}
                  cy={y(run[0]?.v ?? 0)}
                  r={LONE_RUN_RADIUS_PX}
                />
              ),
            ),
          )}
          {expectedPoints.length > 1 && (
            <polyline
              className={styles.line}
              data-series="expected"
              stroke={EXPECTED_COLOR}
              strokeDasharray={EXPECTED_DASH}
              points={xy(expectedPoints)}
            />
          )}
          {expectedPoints.length === 1 && (
            <circle
              data-series="expected"
              fill={EXPECTED_COLOR}
              cx={x(expectedPoints[0]?.t ?? 0)}
              cy={y(expectedPoints[0]?.v ?? 0)}
              r={LONE_RUN_RADIUS_PX}
            />
          )}

          {strip !== null && (
            <g>
              <line className={styles.stripRule} x1={plot.left} x2={plot.right} y1={strip.ruleY} y2={strip.ruleY} />
              <text className={styles.stripName} x={plot.left} y={strip.nameY}>
                Checkpoints
              </text>
            </g>
          )}
          {stripY !== null &&
            flags.map((f, i) => {
              const side = flagSides[i] ?? null
              return (
                <g key={f.checkpoint.sessionId}>
                  <path
                    className={styles.checkpoint}
                    data-mark="checkpoint"
                    data-session={f.checkpoint.sessionId}
                    d={diamondPath(f.cx, stripY, CHECKPOINT_RADIUS_PX)}
                  />
                  {side !== null && (
                    <text
                      className={styles.checkpointLabel}
                      x={side === 'start' ? f.cx + CHECKPOINT_LABEL_DX : f.cx - CHECKPOINT_LABEL_DX}
                      y={stripY}
                      dominantBaseline="middle"
                      textAnchor={side}
                    >
                      {f.text}
                    </text>
                  )}
                </g>
              )
            })}

          <text className={styles.axisLabel} x={plot.left} y={dateY} textAnchor="start">
            {firstLabel}
          </text>
          <text className={styles.axisLabel} x={plot.right} y={dateY} textAnchor="end">
            {lastLabel}
          </text>
        </svg>
      </div>
      <ul className={styles.key} aria-hidden="true" data-part="key">
        {expectedPoints.length > 0 && (
          <li>
            <svg className={styles.swatch} viewBox="0 0 16 12" width="16" height="12">
              <line className={styles.line} stroke={EXPECTED_COLOR} strokeDasharray={EXPECTED_DASH} x1="0" x2="16" y1="6" y2="6" />
            </svg>
            Expected by the plan
          </li>
        )}
        {lines.map(
          (line) =>
            line.runs.length > 0 && (
              <li key={line.model}>
                <svg className={styles.swatch} viewBox="0 0 16 12" width="16" height="12">
                  <line className={styles.line} stroke={line.color} strokeOpacity={line.opacity} x1="0" x2="16" y1="6" y2="6" />
                </svg>
                {line.key}
              </li>
            ),
        )}
        <li>
          <svg className={styles.swatch} viewBox="0 0 16 12" width="16" height="12">
            <line className={styles.target} x1="0" x2="16" y1="6" y2="6" />
          </svg>
          Target
        </li>
        {checkpoints.length > 0 && (
          <li>
            <svg className={styles.swatch} viewBox="0 0 14 14" width="14" height="14">
              <path className={styles.checkpoint} d={diamondPath(7, 7, CHECKPOINT_RADIUS_PX)} />
            </svg>
            Checkpoint, target at its own distance
          </li>
        )}
      </ul>
    </div>
  )
}
