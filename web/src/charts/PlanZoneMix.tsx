import { Absent } from '../components/Absent'
import { PREDATES_HR_PLANNING } from '../components/plan/planLoadMath'
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
import styles from './PlanZoneMix.module.css'

type Triple = [number, number, number]

/** One plan week, as `planLoadMath.weeklyZoneMix` gives it: minutes in zones 1-2, 3 and 4-5. */
export interface PlanZoneMixWeek {
  start: string
  /** Null for a week the version planned no zone minutes for. */
  planned: Triple | null
  /** Null for a week that has not begun. */
  run: Triple | null
}

export interface PlanZoneMixProps {
  /** In date order; the first is `W1`. */
  weeks: PlanZoneMixWeek[]
  /** As `PlanLoad`'s: while set, no run bar is drawn, and the line says why. */
  runsNote: string | null
}

type Band = 'z12' | 'z3' | 'z45'

/**
 * The three bands, bottom up, each with its class in
 * `PlanZoneMix.module.css`: a step of grey for the plan, the weekly
 * distance chart's planned tone darkening with the zone, and a step of the
 * app's heart-rate zone ramp (`--zone-*`) for the run. Never a workout
 * kind's colour: a zone is not a kind, and green here would say "easy run"
 * as it does in the lead-in and the intensity mix.
 */
const BANDS: readonly { band: Band; label: string; slot: string; index: 0 | 1 | 2 }[] = [
  { band: 'z12', label: 'Zones 1-2', slot: styles.z12 ?? '', index: 0 },
  { band: 'z3', label: 'Zone 3', slot: styles.z3 ?? '', index: 1 },
  { band: 'z45', label: 'Zones 4-5', slot: styles.z45 ?? '', index: 2 },
]

const WEEK_LABEL_DY = 16
const LADDER_LABEL_DX = 6

/**
 * A key swatch drawn as the bars are: the three bands bottom up, in the
 * plan's greys or the run's zone colours.
 */
function StackSwatch({ planned }: { planned: boolean }) {
  return (
    <svg className={styles.stackSwatch} viewBox="0 0 10 12" width="10" height="12" data-swatch={planned ? 'planned' : 'run'}>
      {BANDS.map((b, i) => (
        <rect
          key={b.band}
          className={`${planned ? styles.plannedBand : styles.runBand} ${b.slot}`}
          x="0"
          y={8 - 4 * i}
          width="10"
          height="4"
        />
      ))}
    </svg>
  )
}

function total(t: Triple): number {
  return t[0] + t[1] + t[2]
}

/** A share of a whole, as a whole percentage. */
function percent(part: number, whole: number): string {
  return whole > 0 ? String(Math.round((100 * part) / whole)) : '0'
}

/**
 * The stat row over the bars: the plan's minutes in all, and the share of
 * them in zones 1-2 and in zones 4-5, the two ends a reader weighs.
 */
function zoneStats(weeks: PlanZoneMixWeek[]): PlanChartStat[] {
  const planned = weeks.flatMap((w) => (w.planned === null ? [] : [w.planned]))
  if (planned.length === 0) return []
  const sum = planned.reduce<Triple>((acc, t) => [acc[0] + t[0], acc[1] + t[1], acc[2] + t[2]], [0, 0, 0])
  const all = total(sum)
  return [
    { label: 'Planned', value: String(Math.round(all)), unit: 'min' },
    { label: 'In zones 1-2', value: percent(sum[0], all), unit: '%' },
    { label: 'In zones 4-5', value: percent(sum[2], all), unit: '%' },
  ]
}

function minutes(t: Triple): string {
  return `${t.map((m) => String(Math.round(m))).join(', ').replace(/, (\d+)$/, ' and $1')} min`
}

/**
 * Minutes per week in the estimated heart-rate zones 1-2, 3 and 4-5,
 * planned against run: per week two stacked bars on `PlanVolume`'s slots,
 * the planned one left of the week's centre in steps of grey, the run one
 * right of it in the heart-rate zone colours, as the weekly distance
 * chart's grey planned bar beside its run bar, each stack's top band
 * rounded. A stat row over the bars gives the plan's minutes and the
 * shares in zones 1-2 and 4-5. A bar without its
 * partner stands on the week's label. A week without zone minutes has no
 * planned bar and a week not begun no run bar; a band of no minutes is
 * not drawn.
 *
 * The run's minutes are the API's estimated zone seconds over the zones the
 * threshold in force at each run gave (`GET /api/training-load`), not the
 * device's zones. The ladder is whole minutes, `wholeLadder`, unlabelled
 * since the section's note says minutes.
 */
export function PlanZoneMix({ weeks, runsNote }: PlanZoneMixProps) {
  const [panelRef, measured] = usePanelWidth<HTMLDivElement>()
  if (weeks.length === 0) return <Absent reason="This plan has no weeks to chart." />
  const anyPlanned = weeks.some((w) => w.planned !== null)
  const showRuns = runsNote === null
  // Without a plan to measure against, a run bar is worth drawing only above zero.
  const anyRun = showRuns && weeks.some((w) => w.run !== null && total(w.run) > 0)
  const notes = [anyPlanned ? null : PREDATES_HR_PLANNING, runsNote].filter((n) => n !== null)
  if (!anyPlanned && !anyRun) return <Absent reason={notes.join(' ')} />

  const width = measured > 0 ? measured : PLAN_CHART_FALLBACK_WIDTH_PX
  const height = PLAN_CHART_HEIGHT_PX
  const plot = plotBox(width, height)
  const largest = Math.max(
    ...weeks.map((w) =>
      Math.max(w.planned === null ? 0 : total(w.planned), showRuns && w.run !== null ? total(w.run) : 0),
    ),
  )
  const ladder = wholeLadder(largest)
  const y = linearScale(ladder.min, ladder.max, plot.bottom, plot.top)
  const slots = volumeSlots(weeks.length, plot.left, plot.right)
  const weekLabels = weekStride(slots.map((s) => s.centre))

  const described = weeks.map((w, i) => {
    const parts = [
      w.planned === null ? null : `planned ${minutes(w.planned)}`,
      showRuns && w.run !== null ? `run ${minutes(w.run)}` : null,
    ].filter((p) => p !== null)
    return `W${String(i + 1)}: ${parts.length === 0 ? 'nothing planned' : parts.join(', ')}.`
  })
  const label = [
    'Heart-rate mix, minutes in zones 1-2, 3 and 4-5 per week, planned against run.',
    ...notes,
    ...described,
  ].join(' ')

  /** One week's stack, bottom up, at `x`. */
  const stack = (bar: 'planned' | 'run', week: string, t: Triple, x: number, w: number) => {
    let base = 0
    const last = BANDS.filter((b) => t[b.index] > 0).at(-1)?.band
    return BANDS.map((b) => {
      const m = t[b.index]
      if (m <= 0) return null
      const top = y(base + m)
      const bottom = y(base)
      base += m
      const className = `${bar === 'planned' ? styles.plannedBand : styles.runBand} ${b.slot}`
      if (b.band === last) {
        return (
          <path
            key={`${bar}-${b.band}`}
            className={className}
            data-bar={bar}
            data-week={week}
            data-segment={b.band}
            d={roundedTopBar(x, top, w, bottom)}
          />
        )
      }
      return (
        <rect
          key={`${bar}-${b.band}`}
          className={className}
          data-bar={bar}
          data-week={week}
          data-segment={b.band}
          x={x}
          y={top}
          width={w}
          height={bottom - top}
        />
      )
    })
  }

  return (
    <div className={styles.chart} data-chart="">
      <PlanChartStats stats={zoneStats(weeks)} />
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
            const paired = w.planned !== null && total(w.planned) > 0 && hasRun
            const lone = slot.centre - slot.barWidth / 2
            return (
              <g key={w.start}>
                {w.planned !== null &&
                  stack('planned', week, w.planned, paired ? slot.plannedX : lone, slot.barWidth)}
                {hasRun && w.run !== null && stack('run', week, w.run, paired ? slot.runX : lone, slot.barWidth)}
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
        {BANDS.map((b) => (
          <li key={b.band}>
            {/* The zone as each bar draws it: the plan's grey beside the run's colour. */}
            <span className={`${styles.pairSwatch} ${b.slot}`}>
              <span className={styles.swatchPlanned} />
              {showRuns && <span className={styles.swatchRun} />}
            </span>
            {b.label}
          </li>
        ))}
        {anyPlanned && (
          <li>
            <StackSwatch planned />
            Planned
          </li>
        )}
        {showRuns && (
          <li>
            <StackSwatch planned={false} />
            Run
          </li>
        )}
      </ul>
    </div>
  )
}
