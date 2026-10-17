import type { components } from '../api/schema'
import styles from './RecordNote.module.css'
import { recordNotes } from './recordNotes'

type BestEffort = components['schemas']['BestEffort']

export interface RecordNoteProps {
  /** `derived.best_efforts`, verbatim. */
  efforts: BestEffort[]
}

/**
 * Why some of a run's best efforts do not count towards records, under the
 * header's tags, so a fast run missing from the records ladder explains
 * itself where the reader is looking at it. Renders nothing when every
 * effort counts and none of them needed the measured speed to vouch for it.
 */
export function RecordNote({ efforts }: RecordNoteProps) {
  const notes = recordNotes(efforts)
  if (notes.length === 0) return null
  return (
    <div className={styles.notes} aria-label="Records eligibility">
      {notes.map((note) => (
        <p key={note} className={styles.note}>
          {note}
        </p>
      ))}
    </div>
  )
}
