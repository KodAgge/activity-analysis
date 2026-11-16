import { Absent } from '../components/Absent'
import { distance } from '../format'
import {
  LEAD_IN_TOP_PX,
  PLAN_CHART_FALLBACK_WIDTH_PX,
  PLAN_CHART_HEIGHT_PX,
  distanceLadder,
  linearScale,
  plotBox,
  roundedTopBar,
  volumeSlots,
  weekStride,
} from './planChartMath'
import { PlanChartStats } from './PlanChartStats'
import type { PlanChartStat } from './PlanChartStats'
import { usePanelWidth } from './usePanelWidth'
import styles from './PlanVolume.module.css'

/** One plan week, as `planMath.weeklyDistance` gives it. */
export interface PlanVolumeWeek {
  startDate: string
  plannedM: number
  /** Null for a week that has not begun: zero would read as a missed week. */
  runM: number | null
}

export interface PlanVolumeProps {
  /** In date order; the first is `W1`. */
  weeks: PlanVolumeWeek[]
  /**
   * Why the runs are not known yet, or null once they are. While it is
   * set, no run bar is drawn, because a week whose runs have not arrived
   * would otherwise draw as a week with nothing run in it.
   */
  runsNote: string | null
}

/** Where a week's label sits under the baseline. */
const WEEK_LABEL_DY = 16
/** The ladder's labels, left-aligned this far right of the plot. */
const LADDER_LABEL_DX = 6

/** Kilometres to one decimal without the unit, which the stat row sets apart. */
function km(metres: number): string {
  return (metres / 1000).toFixed(1)
}

/**
 * The stat row over the bars: the plan's whole distance, its biggest week
 * and what has been run so far, the last only once the runs are known.
 */
function volumeStats(weeks: PlanVolumeWeek[], showRuns: boolean): PlanChartStat[] {
  const planned = weeks.reduce((sum, w) => sum + w.plannedM, 0)
  const peak = Math.max(...weeks.map((w) => w.plannedM))
  const run = weeks.reduce((sum, w) => sum + (w.runM ?? 0), 0)
  return [
    { label: 'Planned', value: km(planned), unit: 'km' },
    { label: 'Biggest week', value: km(peak), unit: 'km' },
    ...(showRuns ? [{ label: 'Run so far', value: km(run), unit: 'km' }] : []),
  ]
}

/**
 * Weekly distance, planned against run: per plan week a pale bar for what
 * the plan asks and an ink bar for what was run, beside it, both with
 * Runna's rounded tops, under a stat row of the plan's distance.
 *
 * Plain SVG rather than uPlot: a handful of marks, and SVG prints as
 * vectors when the page is saved as a PDF. The viewBox is the panel's
 * measured width, so a bar's width and a label's size are CSS pixels.
 *
 * The two bars are the progress dashes' two tones, todo and done: the
 * plan's grey and the ink of what was run, never a kind's colour, which
 * means a session kind everywhere else on the page. A week that has not begun has no run bar;
 * a week that has, with nothing run, has one of zero height on the
 * baseline, and the text alternative says `0.0 km run`.
 */
export function PlanVolume({ weeks, runsNote }: PlanVolumeProps) {
  const [panelRef, measured] = usePanelWidth<HTMLDivElement>()
  if (weeks.length === 0) return <Absent reason="This plan has no weeks to chart." />

  const width = measured > 0 ? measured : PLAN_CHART_FALLBACK_WIDTH_PX
  const height = PLAN_CHART_HEIGHT_PX
  // The lead-in's top, so the rules of the pair's two charts line up.
  const plot = { ...plotBox(width, height), top: LEAD_IN_TOP_PX }
  const showRuns = runsNote === null
  const largest = Math.max(...weeks.map((w) => Math.max(w.plannedM, showRuns ? (w.runM ?? 0) : 0)))
  const ladder = distanceLadder(largest)
  const y = linearScale(ladder.min, ladder.max, plot.bottom, plot.top)
  const slots = volumeSlots(weeks.length, plot.left, plot.right)
  const weekLabels = weekStride(slots.map((s) => s.centre))

  const described = weeks.map((w, i) => {
    const planned = `W${String(i + 1)}: ${distance(w.plannedM, 1)} planned`
    return showRuns && w.runM !== null ? `${planned}, ${distance(w.runM, 1)} run.` : `${planned}.`
  })
  const label = ['Weekly distance, planned against run.', runsNote ?? '', ...described].filter((s) => s !== '').join(' ')

  return (
    <div className={styles.chart} data-chart="">
      <PlanChartStats stats={volumeStats(weeks, showRuns)} />
      {/* The status line rides with the plot, in the card's plot row. */}
      <div className={styles.body} data-part="panel">
      {runsNote !== null && (
        <p className={styles.note} role="status">
          {runsNote}
        </p>
      )}
      <div className={styles.panel} ref={panelRef}>
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
                {distance(t, 0)}
              </text>
            </g>
          ))}
          {weeks.map((w, i) => {
            const slot = slots[i]
            if (slot === undefined) return null
            const week = String(i + 1)
            const hasRun = showRuns && w.runM !== null
            // A week with no run bar, not begun or its runs unknown, stands
            // its planned bar on the week's label rather than beside a gap.
            const plannedX = hasRun ? slot.plannedX : slot.centre - slot.barWidth / 2
            return (
              <g key={w.startDate}>
                <path
                  className={styles.planned}
                  data-bar="planned"
                  data-week={week}
                  d={roundedTopBar(plannedX, y(w.plannedM), slot.barWidth, plot.bottom)}
                />
                {hasRun && w.runM !== null && (
                  <path
                    className={styles.run}
                    data-bar="run"
                    data-week={week}
                    d={roundedTopBar(slot.runX, y(w.runM), slot.barWidth, plot.bottom)}
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
        <li>
          <span className={`${styles.swatch} ${styles.swatchPlanned}`} />
          Planned
        </li>
        <li>
          <span className={`${styles.swatch} ${styles.swatchRun}`} />
          Run
        </li>
      </ul>
    </div>
  )
}
