import type { components } from '../api/schema'
import { pace } from '../format'
import styles from './RecordNote.module.css'

type Reclassification = components['schemas']['Reclassification']

/** The noun a sport value reads as in a sentence; the raw value otherwise. */
const SPORT_NOUNS: Record<string, string> = { running: 'a run', walking: 'a walk' }

function noun(sport: string): string {
  return SPORT_NOUNS[sport] ?? sport
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export interface ReclassificationNoteProps {
  /** `ActivityDetail.reclassification`, verbatim. */
  reclassification: Reclassification | null
}

/**
 * Why an activity recorded as a run is counted as a walk, under the header
 * where `RecordNote` explains a missing record: the same question, why this
 * activity is absent from the running analyses, asked one level up. Both
 * speeds arrive in m/s and are formatted as pace here, the frontend's job.
 * Renders nothing for an activity counted as what it was recorded as.
 */
export function ReclassificationNote({ reclassification }: ReclassificationNoteProps) {
  if (reclassification === null) return null
  const { recorded_sport, sport, avg_speed_mps, threshold_mps } = reclassification
  return (
    <p className={styles.note}>
      {capitalised(
        `recorded as ${noun(recorded_sport)}, counted as ${noun(sport)}: its moving pace of ` +
          `${pace(avg_speed_mps)} is slower than ${pace(threshold_mps)}.`,
      )}
    </p>
  )
}
