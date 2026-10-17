import styles from './Absent.module.css'

export interface AbsentProps {
  /**
   * Why the thing this replaces is missing, verbatim.
   *
   * Every caller passes text that already comes from somewhere authoritative:
   * the API's own `derived_absent_reason`, a 404 body's `detail`, or a
   * domain fact this view states about the activity itself (a treadmill's
   * footpod). This component never invents wording of its own - it exists so
   * every one of those reasons is framed the same way, not so any of them
   * reads differently from how its source phrased it.
   */
  reason: string
  /** What is absent, e.g. "route", "heart rate". Optional: some callers (a whole missing derived block) have nothing narrower to name. */
  label?: string
}

/**
 * The shared shape behind a stated absence of *data a panel would
 * otherwise draw*: an absence is ordinary, so it is stated, never hidden.
 * A missing derived block, a missing stream, an
 * unrecorded channel, an empty zone distribution and an unrecorded route
 * all render through this - `views/ActivityDetail.tsx` and every chart
 * primitive in `charts/` - so that wording is consistent and every reason
 * reaches a screen reader the same way, rather than each call site
 * inventing its own sentence or its own visual language.
 *
 * Three empty states sit deliberately outside this component, all of them
 * page-level rather than panel-level: `views/Activities.tsx` and
 * `views/Overview.tsx` each hold a "this store has no activities in it
 * yet" landing state, and `views/Activities.tsx` also holds the "this
 * page starts past the end of the results" state. None of the three is
 * the absence of one panel's data - each speaks for the whole page - and
 * each carries a call to action a generic `reason` string has no place
 * for: the `ingest` command for the first two, a control back to page one
 * for the third. `docs/reference/frontend.md` names all three.
 */
export function Absent({ reason, label }: AbsentProps) {
  return (
    <div className={styles.absent} role="note">
      {label !== undefined && <p className={styles.label}>{label}</p>}
      <p className={styles.reason}>{reason}</p>
    </div>
  )
}
