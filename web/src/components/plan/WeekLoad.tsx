import { PlanFitness } from '../../charts/PlanFitness'
import { formatLoadFigure as figure } from '../../format'
import type { WeekLoadFigures, fitnessSeries } from './planLoadMath'
import styles from './WeekLoad.module.css'

export interface WeekLoadProps {
  /** From `planLoadMath.weekLoad`: the week's stamped start and end, and Claude's note. */
  figures: WeekLoadFigures
  /** From `planLoadMath.fitnessSeries`: the whole plan's weekly means, measured and expected. */
  fitness: ReturnType<typeof fitnessSeries>
  /** The week's Monday, and the day after its Sunday, or the race day in the race week. */
  weekFromDay: number
  weekToDay: number
  /** The plan's first Monday, for the chart's note on a bridged series. */
  planStartDay: number
  /** Why the chart's measured series is not drawn yet, or null once it is. */
  measuredNote: string | null
}

/**
 * The top of the week PDF: where fitness, fatigue and form start the week
 * and where the plan expects them to end it, Claude's note on how to run
 * the week, and the whole plan's fitness chart with the week shaded.
 *
 * Every figure is the version's stamp, `expected_load.weeks[].start` and
 * `.end`, so nothing is computed here. Without the stamp it shows the note
 * alone, and without either it renders nothing.
 */
export function WeekLoad({ figures, fitness, weekFromDay, weekToDay, planStartDay, measuredNote }: WeekLoadProps) {
  const { start, end, note } = figures
  const known = start !== null && end !== null
  if (!known && note === null) return null
  const rows: { label: string; pick: (p: NonNullable<typeof start>) => number; signed?: boolean }[] = [
    { label: 'Fitness (CTL)', pick: (p) => p.ctl },
    { label: 'Fatigue (ATL)', pick: (p) => p.atl },
    { label: 'Form', pick: (p) => p.form, signed: true },
  ]
  return (
    <div className={styles.load} data-part="week-load">
      {known && (
          <table className={styles.table} aria-label="Fitness and fatigue over the week">
            <thead>
              <tr>
                <td />
                <th scope="col">
                  Start
                  <span className={styles.day}>{figures.startLabel}</span>
                </th>
                <th scope="col">
                  Expected end
                  <span className={styles.day}>{figures.endLabel}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <th scope="row">{r.label}</th>
                  <td>{figure(r.pick(start), r.signed)}</td>
                  <td>{figure(r.pick(end), r.signed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
      )}
      {known && (
        <div className={styles.chart}>
          <PlanFitness
            expected={fitness.expected}
            measured={fitness.measured}
            start={fitness.start}
            raceMorning={fitness.raceMorning}
            bridgedFrom={fitness.bridgedFrom}
            planStartDay={planStartDay}
            firstDay={fitness.firstDay}
            raceDay={fitness.raceDay}
            measuredNote={measuredNote}
            week={{ fromDay: weekFromDay, toDay: weekToDay, start, end }}
            compact
          />
        </div>
      )}
      {note !== null && <p className={styles.note}>{note}</p>}
    </div>
  )
}
