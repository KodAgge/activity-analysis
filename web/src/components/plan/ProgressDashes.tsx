import styles from './ProgressDashes.module.css'

/** Where one item stands: passed, the one under way, or still to come. */
export type DashState = 'done' | 'current' | 'todo'

export interface ProgressDashesProps {
  /** One entry per item, in order: a week of the plan, a session of a week. */
  items: readonly DashState[]
  /**
   * What the row says in words, such as `Week 1 of 5, none done yet`. The
   * dashes are drawn for the eye and hidden from a screen reader, which
   * reads this instead, so it must state every count the dashes show.
   */
  label: string
  /** The caller's own class on the row: its margin, or `--dash-*` overrides. */
  className?: string
}

const STATE_CLASS: Readonly<Record<DashState, string | undefined>> = {
  done: styles.done,
  current: styles.current,
  todo: undefined,
}

/**
 * Progress as a row of short rounded dashes, one per item, the way Runna
 * draws the weeks of a plan and the workouts of a week: done filled in
 * ink, the current one in dim ink, the rest a light rule. The dashes share
 * the row's width equally, so twelve weeks and five sessions fill the same
 * line.
 */
export function ProgressDashes({ items, label, className }: ProgressDashesProps) {
  const classes = className === undefined ? styles.dashes : `${styles.dashes} ${className}`
  return (
    <div role="img" aria-label={label} className={classes}>
      {items.map((state, i) => {
        const dash = [styles.dash, STATE_CLASS[state]].filter((c) => c !== undefined).join(' ')
        return <span key={i} className={dash} data-state={state} />
      })}
    </div>
  )
}
