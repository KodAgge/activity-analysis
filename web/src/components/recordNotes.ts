import type { components } from '../api/schema'
import { distanceKeyLabel } from '../format'

type BestEffort = components['schemas']['BestEffort']

/**
 * What an eligible effort that holds a jump in the recorded distance says.
 * The progression chart's readout and this activity note share it, so the
 * two surfaces describe one effort in one sentence.
 */
export const CONFIRMED_JUMP_NOTE = 'the recorded distance jumped, but the measured speed confirms it'

/**
 * The sentences an activity shows about which of its best efforts do not
 * count towards records, and why, in the order the efforts are served.
 *
 * Only composition: whether an effort is eligible and the words for why not
 * are the API's own `is_eligible` and `ineligible_reason`, the columns the
 * progression chart reads for the same effort, so nothing here decides
 * eligibility. Efforts sharing a reason are listed in one sentence, since a
 * single jump usually disqualifies every window that contains it; when every
 * effort shares one reason, as on a treadmill, the distances are left out
 * because the list would be the whole ladder.
 */
export function recordNotes(efforts: BestEffort[]): string[] {
  const excluded = efforts.filter((effort) => !effort.is_eligible)
  const byReason = new Map<string, string[]>()
  for (const effort of excluded) {
    const reason = effort.ineligible_reason ?? 'no reason recorded'
    byReason.set(reason, [...(byReason.get(reason) ?? []), distanceKeyLabel(effort.distance_key)])
  }

  const notes: string[] = []
  if (excluded.length > 0 && excluded.length === efforts.length && byReason.size === 1) {
    const [reason] = byReason.keys()
    notes.push(`No effort on this run counts towards records: ${reason}.`)
  } else {
    for (const [reason, labels] of byReason) {
      notes.push(`Not counted towards records at ${labels.join(', ')}: ${reason}.`)
    }
  }

  const confirmed = efforts.filter((effort) => effort.is_eligible && effort.contains_jump === true)
  if (confirmed.length > 0) {
    const labels = confirmed.map((effort) => distanceKeyLabel(effort.distance_key))
    notes.push(`Counted towards records at ${labels.join(', ')}: ${CONFIRMED_JUMP_NOTE}.`)
  }
  return notes
}
