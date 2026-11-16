import { Absent } from '../components/Absent'
import {
  PLAN_CHART_FALLBACK_WIDTH_PX,
  PLAN_CHART_HEIGHT_PX,
  linearScale,
  plotBox,
  roundedTopBar,
  volumeSlots,
  weekStride,
  wholeLadder,
} from './planChartMath'
import { PlanChartStats } from './PlanChartStats'
import type { PlanChartStat } from './PlanChartStats'
import { usePanelWidth } from './usePanelWidth'
import styles from './PlanLoad.module.css'

/** One plan week, as `planLoadMath.weeklyLoad` gives it. */
export interface PlanLoadWeek {
  start: string
  /** Null for a week the version has no planned TRIMP for. */
  planned: number | null
  /** Null for a week that has not begun, or whose runs all lack heart rate. */
  run: number | null
}

export interface PlanLoadProps {
  /** In date order; the first is `W1`. */
  weeks: PlanLoadWeek[]
  /**
   * Why weeks lack a planned bar, as `planLoadMath.plannedLoadNote` gives
   * it, or null when every week the version planned has one.
   */
  plannedNote: string | null
  /**
   * Why the runs' TRIMP is not known, or null once it is: loading or
   * failed. While
   * it is set no run bar is drawn, since an unknown week would read as a
   * week with no load.
   */
  runsNote: string | null
}

const WEEK_LABEL_DY = 16
const LADDER_LABEL_DX = 6

/** A TRIMP total, whole, with thousands grouped as the rest of the app groups them. */
function trimp(value: number): string {
  return Math.round(value).toLocaleString('en-GB')
}

/**
 * The stat row over the bars, as `PlanVolume`'s: the plan's whole TRIMP,
 * its biggest week and what has been run so far, each only when known.
 */
function loadStats(weeks: PlanLoadWeek[], showRuns: boolean): PlanChartStat[] {
  const planned = weeks.flatMap((w) => (w.planned === null ? [] : [w.planned]))
  const run = weeks.reduce((sum, w) => sum + (w.run ?? 0), 0)
  return [
    ...(planned.length === 0
      ? []
      : [
          { label: 'Planned', value: trimp(planned.reduce((sum, v) => sum + v, 0)), unit: 'TRIMP' },
          { label: 'Biggest week', value: trimp(Math.max(...planned)), unit: 'TRIMP' },
        ]),
    ...(showRuns ? [{ label: 'Run so far', value: trimp(run), unit: 'TRIMP' }] : []),
  ]
}

/**
 * Weekly TRIMP, planned against run, in `PlanVolume`'s grammar: per plan
 * week a pale bar for the planned TRIMP and an ink bar for the TRIMP of
 * the runs done that week, both as `planLoadMath.weeklyLoad` gives them. The chart draws those numbers and
 * knows nothing of how they are computed.
 *
 * TRIMP has no unit, so the ladder is `wholeLadder`'s plain numbers. A week
 * without a planned TRIMP has no planned bar, `plannedNote` says why, and
 * what was run is drawn regardless. A week whose runs all lack heart rate
 * has no run bar, since a zero would read as an effortless week.
 */
export function PlanLoad({ weeks, plannedNote, runsNote }: PlanLoadProps) {
  const [panelRef, measured] = usePanelWidth<HTMLDivElement>()
  if (weeks.length === 0) return <Absent reason="This plan has no weeks to chart." />
  const anyPlanned = weeks.some((w) => w.planned !== null)
  const showRuns = runsNote === null
  // Without a plan to measure against, a run bar is worth drawing only above zero.
  const anyRun = showRuns && weeks.some((w) => (w.run ?? 0) > 0)
  const notes = [plannedNote, runsNote].filter((n) => n !== null)
  if (!anyPlanned && !anyRun) return <Absent reason={notes.length > 0 ? notes.join(' ') : 'Nothing planned or run yet.'} />

  const width = measured > 0 ? measured : PLAN_CHART_FALLBACK_WIDTH_PX
  const height = PLAN_CHART_HEIGHT_PX
  const plot = plotBox(width, height)
  const largest = Math.max(...weeks.map((w) => Math.max(w.planned ?? 0, showRuns ? (w.run ?? 0) : 0)))
  const ladder = wholeLadder(largest)
  const y = linearScale(ladder.min, ladder.max, plot.bottom, plot.top)
  const slots = volumeSlots(weeks.length, plot.left, plot.right)
  const weekLabels = weekStride(slots.map((s) => s.centre))

  const described = weeks.map((w, i) => {
    const parts = [
      w.planned === null ? null : `${String(Math.round(w.planned))} planned`,
      showRuns && w.run !== null ? `${String(Math.round(w.run))} run` : null,
    ].filter((p) => p !== null)
    return `W${String(i + 1)}: ${parts.length === 0 ? 'nothing planned' : parts.join(', ')}.`
  })
  const label = ['Weekly load, planned against run.', ...notes, ...described].join(' ')

  return (
    <div className={styles.chart} data-chart="">
      <PlanChartStats stats={loadStats(weeks, showRuns)} />
      {/* The status line rides with the plot, in the card's plot row. */}
      <div className={styles.body} data-part="panel">
      {notes.length > 0 && (
        <p className={styles.note} role="status">
          {notes.join(' ')}
        </p>
      )}
      <div className={styles.panel} ref={panelRef}>
        <svg className={styles.svg} viewBox={`0 0 ${String(width)} ${String(height)}`} role="img" aria-label={label}>
          {ladder.ticks.map((t) => (
            <g key={t}>
              <line className={styles.rule} x1={plot.left} x2={plot.right} y1={y(t)} y2={y(t)} />
              <text className={styles.axisLabel} x={plot.right + LADDER_LABEL_DX} y={y(t)} dominantBaseline="middle">
                {String(t)}
              </text>
            </g>
          ))}
          {weeks.map((w, i) => {
            const slot = slots[i]
            if (slot === undefined) return null
            const week = String(i + 1)
            const hasRun = showRuns && w.run !== null
            // A bar without its partner stands on the week's label.
            const lone = slot.centre - slot.barWidth / 2
            const paired = w.planned !== null && hasRun
            return (
              <g key={w.start}>
                {w.planned !== null && (
                  <path
                    className={styles.planned}
                    data-bar="planned"
                    data-week={week}
                    d={roundedTopBar(paired ? slot.plannedX : lone, y(w.planned), slot.barWidth, plot.bottom)}
                  />
                )}
                {hasRun && w.run !== null && (
                  <path
                    className={styles.run}
                    data-bar="run"
                    data-week={week}
                    d={roundedTopBar(paired ? slot.runX : lone, y(w.run), slot.barWidth, plot.bottom)}
                  />
                )}
                {weekLabels[i] === true && (
                  <text className={styles.axisLabel} x={slot.centre} y={plot.bottom + WEEK_LABEL_DY} textAnchor="middle">
                    W{week}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
      </div>
      <ul className={styles.key} aria-hidden="true" data-part="key">
        {anyPlanned && (
          <li>
            <span className={`${styles.swatch} ${styles.swatchPlanned}`} />
            Planned
          </li>
        )}
        {showRuns && (
          <li>
            <span className={`${styles.swatch} ${styles.swatchRun}`} />
            Run
          </li>
        )}
      </ul>
    </div>
  )
}
