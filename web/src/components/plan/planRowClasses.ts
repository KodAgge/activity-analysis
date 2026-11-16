import styles from './PlanRow.module.css'

/**
 * The classes around a `PlanRow`, in a module of their own so that
 * `PlanRow.tsx` exports only its component and stays Fast-Refreshable.
 */

/** The class for the `Link` around a `PlanRow`; `current` for the page on screen. */
export function rowClass(current = false): string {
  return current ? `${styles.row ?? ''} ${styles.current ?? ''}` : (styles.row ?? '')
}

/** The class for the `<ol>` or `<ul>` that holds the rows. */
export const ROW_LIST: string = styles.list ?? ''
