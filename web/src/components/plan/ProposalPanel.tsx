import { Fragment } from 'react'
import { changeCount } from '../../format'
import { PlanCard } from './PlanCard'
import { PlanProse } from './PlanProse'
import { goalChangesFirst } from './planMath'
import type { PlanVersionEntry } from './planMath'
import styles from './ProposalPanel.module.css'
import marks from './proseMarks.module.css'

export interface ProposalPanelProps {
  /** The pending version. */
  entry: PlanVersionEntry
  goalId: string
  /**
   * The active goal that accepting this proposal would archive, from
   * `archivedByAccepting`, or null when it replaces nothing.
   */
  archives: string | null
}

/**
 * A pending version: what it changes at a glance, how to decide on it,
 * then each change and why.
 *
 * The view never accepts or rejects anything - the server is read-only and
 * the decision belongs to the conversation with Claude - so the panel
 * names the command that does it rather than offering a button.
 *
 * The headline comes first, as Runna leads a card with short bold rows
 * (`plan-home-flat`) before any detail: every change's title in a
 * numbered row, the goal change marked. On a phone that list sits under
 * the title, then the command, then the changes in full; on a desktop the
 * changes take the card's main column and the command and the list a rail
 * beside them, which stays in view while they scroll.
 *
 * Each change in full is numbered in the same round badge, its title bold
 * over its reason. A goal change comes first and is marked: a new target
 * time or race date changes what every other entry is for.
 */
export function ProposalPanel({ entry, goalId, archives }: ProposalPanelProps) {
  const { changes, provenance } = entry.plan
  const ordered = goalChangesFirst(changes)
  const note = changes.length > 0 ? changeCount(changes.length) : provenance.revises === null ? 'A first plan' : undefined
  return (
    <PlanCard title={`Proposed: version ${String(entry.number)}`} note={note}>
      <div className={styles.panel}>
        <div className={styles.rail}>
          {changes.length > 0 && (
            // The titles again, for the eye: each is the heading of its
            // change below, where a screen reader meets it once.
            <ol className={styles.glance} aria-hidden="true">
              {ordered.map((change, i) => (
                <li key={i} className={styles.glanceRow}>
                  <span className={styles.number}>{i + 1}</span>
                  <span className={styles.glanceTitle}>{change.title}</span>
                  {change.goal_change && <span className={styles.goalPill}>Goal change</span>}
                </li>
              ))}
            </ol>
          )}
          <div className={styles.decide}>
            <p className={styles.how}>
              Accept or reject in Claude Code, or run{' '}
              <Command text={`uv run activity-analysis plan accept ${goalId}`} />
            </p>
            {archives !== null && <p className={styles.archives}>Accepting it archives {archives}.</p>}
          </div>
        </div>
        {changes.length > 0 && (
          <ol className={styles.changes}>
            {ordered.map((change, i) => (
              <li key={i} className={styles.change}>
                <span className={styles.number} aria-hidden="true">
                  {i + 1}
                </span>
                <div className={styles.changeBody}>
                  <div className={styles.changeHead}>
                    <h3 className={styles.changeTitle}>{change.title}</h3>
                    {change.goal_change && <span className={styles.goalPill}>Goal change</span>}
                  </div>
                  <PlanProse text={change.reason} className={`${styles.reason} ${marks.marked}`} />
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </PlanCard>
  )
}

/**
 * A shell command on a line of its own that breaks only between its
 * words. Left to the browser it broke at the hyphens inside the goal id,
 * which reads as two arguments.
 */
function Command({ text }: { text: string }) {
  return (
    <code className={`mono ${styles.command}`}>
      {text.split(' ').map((word, i) => (
        <Fragment key={i}>
          {i > 0 && ' '}
          <span className={styles.word}>{word}</span>
        </Fragment>
      ))}
    </code>
  )
}
