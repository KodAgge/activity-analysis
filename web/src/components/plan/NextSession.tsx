import { PlanCard } from './PlanCard'
import { PlanProse } from './PlanProse'
import { SessionDetail, StepTable } from './SessionDetail'
import type { SessionDetailProps } from './SessionDetail'
import type { ActivitySummary, Outcome, SessionEntry } from './planMath'
import styles from './NextSession.module.css'

export interface NextSessionProps extends Pick<SessionDetailProps, 'zoneBoundaries' | 'runLoads'> {
  /** From `nextSession` and `sessionEntry`: the first running session today or later, or null. */
  entry: SessionEntry | null
  /** Claude's verdict on it, which a session today can already have. */
  outcome: Outcome | null
  /** From `runsByLocalDay`, for the runs already done on its day. */
  runsByDay: Map<number, ActivitySummary[]>
  today: Date
}

/**
 * The one session to do next, written out in full: the calendar below
 * gives every day a line, and this is the day the athlete is about to run.
 *
 * Its body is `SessionDetail`, the calendar's detail and the print
 * appendix's, so the three never say a session differently. Its card is
 * the workout card, the head and the profile, as Runna's ends at its
 * stats; the steps and Claude's description follow on cards of their own,
 * as the dialog sets them, so the page and the dialog are one layout.
 */
export function NextSession({ entry, outcome, runsByDay, today, ...hr }: NextSessionProps) {
  const description = entry?.session.description.trim() ?? ''
  const hasSteps = entry !== null && entry.session.steps.length > 0
  return (
    <>
      <PlanCard title="Next session">
        {entry === null ? (
          <p className={styles.none}>No session is left in this plan.</p>
        ) : (
          <SessionDetail
            entry={entry}
            outcome={outcome}
            runsByDay={runsByDay}
            today={today}
            withDescription={false}
            withSteps={false}
            {...hr}
          />
        )}
      </PlanCard>
      {hasSteps && (
        <PlanCard title="Steps">
          <StepTable
            session={entry.session}
            easyMps={entry.profile?.easyMps ?? null}
            zoneBoundaries={hr.zoneBoundaries ?? null}
          />
        </PlanCard>
      )}
      {entry !== null && description !== '' && (
        <PlanCard title="Description" note={`${entry.session.title}, as Claude wrote it.`}>
          <PlanProse text={entry.session.description} variant="notes" />
        </PlanCard>
      )}
    </>
  )
}
