import styles from './PlanChartStats.module.css'

/** One figure of a chart card's stat row: a dim label over a bold value. */
export interface PlanChartStat {
  label: string
  value: string
  /** Set beside the value at its own weight, `km` or `/km`; omitted for a bare count. */
  unit?: string
}

/**
 * The figures a plan chart card leads with, Runna's stat row over its
 * weekly bars: a small dim label over a large bold value, side by side,
 * four of them two to a line on a phone rather than three and a
 * straggler. With no figures it draws nothing. A `<dl>`, so a screen reader hears each label with its value.
 */
export function PlanChartStats({ stats }: { stats: PlanChartStat[] }) {
  if (stats.length === 0) return null
  return (
    <dl className={styles.stats} data-count={stats.length} data-part="stats">
      {stats.map((s) => (
        <div key={s.label} className={styles.stat}>
          <dt className={styles.label}>{s.label}</dt>
          <dd className={styles.value}>
            {s.value}
            {/* `31.5 km` with a space, `4:30/km` and `77%` without, as the units are written. */}
            {s.unit !== undefined && (
              <span className={styles.unit}>
                {s.unit.startsWith('/') || s.unit === '%' ? '' : ' '}
                {s.unit}
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}
