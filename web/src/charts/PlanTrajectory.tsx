import { calendarDayOfDate, calendarDayOfLocalDate, checkpointLabel, dayMonthLabel, duration } from '../format'
import {
  LABEL_CHAR_PX,
  PLAN_CHART_FALLBACK_WIDTH_PX,
  POINT_LABEL_BELOW_DY,
  linearScale,
  placeStripLabels,
  pointLabelPlacement,
  thinLabels,
  timeLadder,
  trajectoryLayout,
  trajectoryDays,
} from './planChartMath'
import { diamondPath } from './progressionMath'
import { PlanChartStats } from './PlanChartStats'
import type { PlanChartStat } from './PlanChartStats'
import { usePanelWidth } from './usePanelWidth'
import styles from './PlanTrajectory.module.css'

/** One live version, as `planMath.trajectory` gives it. */
export interface PlanTrajectoryPoint {
  number: number
  /** When the version was written, an instant. */
  createdAt: string
  /** The best-effort prediction at the goal distance then, or null when the context had none. */
  bestEffortS: number | null
}

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
  /** In version order. */
  points: PlanTrajectoryPoint[]
  /** The goal's target time, in seconds. */
  targetS: number
  /** The race's local calendar date, the right end of the axis. */
  raceDate: string
  checkpoints: PlanTrajectoryCheckpoint[]
}

const POINT_RADIUS_PX = 4.5
const CHECKPOINT_RADIUS_PX = 5
/** A point's label baseline sits this far above it; `POINT_LABEL_BELOW_DY` is the other side. */
const POINT_LABEL_ABOVE_DY = -9
/** A checkpoint's label starts this far beside its diamond's centre. */
const CHECKPOINT_LABEL_DX = 9
/**
 * An estimate of one character's advance at `--text-label` (12 px) in
 * the sans, for telling whether two checkpoint labels collide:
 * `planChartMath.LABEL_CHAR_PX`.
 */
const CAPTION_CHAR_PX = LABEL_CHAR_PX
const CHECKPOINT_LABEL_PAD_PX = 8
/** Point labels closer than this to the next one are dropped; `v2 23:18` is about 50 px at `--text-caption`. */
const POINT_LABEL_GAP_PX = 64
const TARGET_LABEL_DY = -6
const LADDER_LABEL_DX = 6

/**
 * The best-effort prediction at the goal distance when each version was
 * written, against the target, from the first version to the race.
 *
 * The y axis is time and inverted, faster up, on a ladder of whole half
 * minutes that brackets every point and the target (`timeLadder`). One
 * filled point per accepted, superseded or pending version, joined in
 * version order; the target is an ink line labelled with its time. A
 * stat row over the chart gives the latest prediction, the target and the
 * time between them.
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
export function PlanTrajectory({ points, targetS, raceDate, checkpoints }: PlanTrajectoryProps) {
  const [panelRef, measured] = usePanelWidth<HTMLDivElement>()
  const width = measured > 0 ? measured : PLAN_CHART_FALLBACK_WIDTH_PX
  const drawnCount = points.filter((p) => p.bestEffortS !== null).length
  const { plot, dateY, strip, height } = trajectoryLayout(width, drawnCount, checkpoints.length > 0)
  const stripY = strip === null ? null : strip.markY

  const drawn = points.flatMap((p) =>
    p.bestEffortS === null
      ? []
      : [{ number: p.number, day: calendarDayOfLocalDate(new Date(p.createdAt)), valueS: p.bestEffortS }],
  )
  // `created_at` is an instant; its day is the one on the reader's own
  // wall clock, as the header's "Written by Claude on" reads it.
  const versionDays = points.map((p) => calendarDayOfLocalDate(new Date(p.createdAt)))
  const checkpointDays = checkpoints.map((c) => calendarDayOfDate(c.date))
  const raceDay = calendarDayOfDate(raceDate)
  const [firstDay, lastDay] = trajectoryDays(versionDays, checkpointDays, raceDay)
  const x = linearScale(firstDay, lastDay, plot.left, plot.right)

  const ladder = timeLadder([targetS, ...drawn.map((d) => d.valueS)])
  const y = linearScale(ladder.min, ladder.max, plot.top, plot.bottom)
  const middle = (plot.left + plot.right) / 2

  const marks = drawn.map((d) => ({ ...d, cx: x(d.day), cy: y(d.valueS) }))
  const labelled = thinLabels(
    marks.map((m) => m.cx),
    POINT_LABEL_GAP_PX,
  )
  const placement = pointLabelPlacement(marks, middle, plot.bottom)

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
    ...points.map((p, i) => {
      const day = dayMonthLabel(versionDays[i] ?? raceDay)
      return `version ${String(p.number)}, ${day}: ${p.bestEffortS === null ? 'no prediction' : duration(p.bestEffortS)}`
    }),
    `target ${duration(targetS)} on ${dayMonthLabel(raceDay)}`,
    ...checkpoints.map((c) => {
      const base = `checkpoint ${dayMonthLabel(calendarDayOfDate(c.date))}, ${c.description}`
      return c.targetS === null ? base : `${base}, target ${duration(c.targetS)}`
    }),
  ]
  const label = `Best-effort prediction per plan version, against the target: ${described.join('; ')}.`

  // The latest version's prediction against the target, Runna's estimate
  // card's "current" against its goal, over the chart that traces it.
  const latest = drawn.at(-1) ?? null
  const stats: PlanChartStat[] = [
    ...(latest === null ? [] : [{ label: 'Latest prediction', value: duration(latest.valueS) }]),
    { label: 'Target', value: duration(targetS) },
    ...(latest === null
      ? []
      : [
          latest.valueS > targetS
            ? { label: 'To find', value: duration(latest.valueS - targetS) }
            : { label: 'Inside target by', value: duration(targetS - latest.valueS) },
        ]),
  ]

  return (
    <div className={styles.chart} data-chart="">
      <PlanChartStats stats={stats} />
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

          {marks.length > 1 && (
            <polyline
              className={styles.joint}
              data-mark="trajectory"
              points={marks.map((m) => `${String(m.cx)},${String(m.cy)}`).join(' ')}
            />
          )}
          {marks.map((m, i) => (
            <g key={m.number}>
              <circle
                className={styles.point}
                data-mark="prediction"
                data-version={m.number}
                cx={m.cx}
                cy={m.cy}
                r={POINT_RADIUS_PX}
              />
              {labelled[i] === true && (
                <text
                  className={styles.pointLabel}
                  x={m.cx}
                  y={m.cy + (placement[i]?.below === true ? POINT_LABEL_BELOW_DY : POINT_LABEL_ABOVE_DY)}
                  textAnchor={placement[i]?.anchor ?? 'start'}
                >
                  v{m.number} {duration(m.valueS)}
                </text>
              )}
            </g>
          ))}

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
            {dayMonthLabel(firstDay)}
          </text>
          {/* The race's day, at the right end unless a version written
              after it carried the axis further. */}
          <text
            className={styles.axisLabel}
            x={x(raceDay)}
            y={dateY}
            textAnchor={raceDay === lastDay ? 'end' : 'middle'}
          >
            {dayMonthLabel(raceDay)}
          </text>
          {/* A version written after the race carried the axis past it:
              its far end gets its own date, or the last point has none,
              unless that date would run into the race's. */}
          {lastDay > raceDay &&
            plot.right - x(raceDay) >=
              (dayMonthLabel(raceDay).length / 2 + dayMonthLabel(lastDay).length) * CAPTION_CHAR_PX +
                CHECKPOINT_LABEL_PAD_PX && (
            <text className={styles.axisLabel} x={plot.right} y={dateY} textAnchor="end">
              {dayMonthLabel(lastDay)}
            </text>
          )}
        </svg>
      </div>
      <ul className={styles.key} aria-hidden="true" data-part="key">
        <li>
          <svg className={styles.swatch} viewBox="0 0 12 12" width="12" height="12">
            <circle className={styles.point} cx="6" cy="6" r={POINT_RADIUS_PX} />
          </svg>
          Predicted from best efforts when the version was written
        </li>
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
