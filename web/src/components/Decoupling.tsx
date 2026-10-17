import { Link } from '@tanstack/react-router'
import type { components } from '../api/schema'
import { formatDecoupling, heartRate, pace } from '../format'
import { Absent } from './Absent'
import { durabilityReading } from './decouplingMath'
import styles from './Decoupling.module.css'

type DecouplingOut = components['schemas']['DecouplingOut']

export interface DecouplingProps {
  /** The served block, or null when the run has no value. */
  decoupling: DecouplingOut | null
  /** The API's own reason when `decoupling` is null, rendered verbatim. */
  absentReason: string | null
}

/**
 * One run's aerobic decoupling, the body of the activity page's section of
 * that name; docs/reference/frontend.md, "The decoupling section always
 * shows the halves beside the number".
 *
 * The halves are always shown beside the number, because the number alone
 * cannot say which of pace and heart rate moved. A run outside the
 * population the 5% line is read over carries the API's reason as visible
 * text in place of the reading: it is what makes the number honest, so by
 * docs/reference/frontend.md's rule it may not fold into a disclosure.
 */
export function Decoupling({ decoupling, absentReason }: DecouplingProps) {
  if (decoupling === null) {
    return <Absent reason={absentReason ?? 'This run has no decoupling value.'} />
  }
  const inPopulation = decoupling.outside_population_reason === null
  return (
    <div className={styles.decoupling}>
      <p className={styles.note}>Heart rate against pace, the first half of the moving time against the second</p>
      <p className={styles.headline}>
        <span className={styles.value}>{formatDecoupling(decoupling.decoupling_pct)}</span>
        {inPopulation && (
          <span className={styles.reading}>
            {durabilityReading(decoupling.decoupling_pct)}
            {/* The separator and the link wrap together, so a narrow screen
                never leaves `Trend` alone on a line under a dangling dot. */}
            <span className={styles.trend}>
              <span aria-hidden="true"> · </span>
              <Link to="/trends" hash="decoupling">
                Decoupling trend
              </Link>
            </span>
          </span>
        )}
      </p>
      <table className={styles.halves}>
        <thead>
          <tr>
            <td />
            <th scope="col">First half</th>
            <th scope="col">Second half</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Pace</th>
            <td>{pace(decoupling.first_half_speed_mps)}</td>
            <td>{pace(decoupling.second_half_speed_mps)}</td>
          </tr>
          <tr>
            <th scope="row">Heart rate</th>
            <td>{heartRate(decoupling.first_half_hr_bpm)}</td>
            <td>{heartRate(decoupling.second_half_hr_bpm)}</td>
          </tr>
        </tbody>
      </table>
      {!inPopulation && <p className={styles.caveat}>{decoupling.outside_population_reason}</p>}
    </div>
  )
}
