import type { ReactNode } from 'react'
import styles from './PlanRow.module.css'

/**
 * Each status's pill, so that no two states that sit side by side look
 * alike without colour: in force is filled ink, awaiting a decision an ink
 * outline, replaced or archived a quiet fill, and withdrawn or rejected a
 * dashed outline.
 */
const PILL_BY_STATUS: Readonly<Record<string, string | undefined>> = {
  accepted: styles.inForce,
  active: styles.inForce,
  proposed: styles.pending,
  superseded: styles.past,
  archived: styles.past,
  closed: styles.past,
  withdrawn: styles.dropped,
  rejected: styles.dropped,
}

export interface PlanRowProps {
  /** A few characters in the round mark at the row's start, such as a version number or `1.5k`. */
  mark: string
  /** The row's first line, in bold. */
  title: ReactNode
  /** The quiet second line under the title. */
  detail: ReactNode
  /** The raw status, which picks the pill's fill. */
  status: string
  /** The status as words, in the pill at the row's end. */
  statusLabel: string
  /** The row is the page on screen: its mark is filled. */
  current?: boolean
}

/**
 * The inside of one row of the plan page's link lists, the history and
 * the other goals, laid out as Runna lays out a row of its estimated race
 * times: a round mark, a bold line over a quiet one, and the state at the
 * far end. The caller wraps it in its own `Link` with `rowClass` from
 * `planRowClasses`, so the route stays typed where it is named.
 *
 * The status is a word in a pill, never a colour alone, each state drawn
 * its own way (`PILL_BY_STATUS`), and a chevron at the far end says the
 * row opens something.
 */
export function PlanRow({ mark, title, detail, status, statusLabel, current = false }: PlanRowProps) {
  return (
    <>
      <span className={current ? `${styles.mark} ${styles.markCurrent}` : styles.mark} aria-hidden="true">
        {mark}
      </span>
      <span className={styles.text}>
        <span className={styles.title}>{title}</span>
        <span className={styles.detail}>{detail}</span>
      </span>
      <span className={`${styles.pill ?? ''} ${PILL_BY_STATUS[status] ?? styles.past ?? ''}`}>{statusLabel}</span>
      <span className={styles.chevron} aria-hidden="true" />
    </>
  )
}
