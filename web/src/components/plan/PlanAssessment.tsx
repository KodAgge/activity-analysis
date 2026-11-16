import { PlanCard } from './PlanCard'
import { descriptionBlocks, splitVerdict } from './descriptionBlocks'
import { PlanProse } from './PlanProse'
import { ProgressDashes } from './ProgressDashes'
import type { DashState } from './ProgressDashes'
import type { PlanVersion } from './planMath'
import { feasibilityLabel } from '../../format'
import styles from './PlanAssessment.module.css'
import marks from './proseMarks.module.css'

export interface PlanAssessmentProps {
  assessment: PlanVersion['assessment']
}

type Feasibility = PlanVersion['assessment']['verdict']

/** The verdict's step on the scale from unlikely to likely, counting from one. */
const FEASIBILITY_STEP: Readonly<Record<Feasibility, number>> = { unlikely: 1, possible: 2, likely: 3 }

/** The scale's steps in order, one name under each dash. */
const FEASIBILITY_STEPS: readonly Feasibility[] = ['unlikely', 'possible', 'likely']

/** The scale's steps, as the dashes' label words them. */
const FEASIBILITY_SCALE = 'unlikely, possible and likely'

/**
 * Claude's reading of where the athlete stands, verdict first, set out as
 * Runna sets out a verdict card (`pace-insights`): the feasibility in a
 * large word over a three-step scale, then the summary's `Verdict` block,
 * and everything behind it - the rest of the summary, the reasoning behind
 * the estimate in the header, and the labels of the figures it cites - in
 * a native `<details>`, "Why this verdict", closed by default. The
 * disclosure was asked for by the maintainer on 2026-11-15, after the
 * whole assessment read as too long above the calendar.
 *
 * The scale is the progress dashes filled to the verdict's step, each
 * step named under its dash and the verdict's own name in bold ink, so it
 * reads without colour; the dashes' label says the step in words. On a
 * desktop the feasibility and the verdict share the card in two halves,
 * the word at the display size, and the reasoning opens in two columns.
 *
 * In the long PDF, `printPlan`'s `full` mode, the disclosure's body shows
 * although it is closed, so that PDF carries the reasoning; the short one
 * prints it as the screen has it. See `PlanAssessment.module.css`.
 */
export function PlanAssessment({ assessment }: PlanAssessmentProps) {
  const { summary, verdict: feasibility, estimate_reasoning: reasoning, citations } = assessment
  const { verdict, rest } = splitVerdict(descriptionBlocks(summary))
  const reasons = descriptionBlocks(reasoning)
  const more = rest.length > 0 || reasons.length > 0 || citations.length > 0
  const step = FEASIBILITY_STEP[feasibility]
  const label = feasibilityLabel(feasibility)
  const dashes: DashState[] = [1, 2, 3].map((i) => (i <= step ? 'done' : 'todo'))
  return (
    <PlanCard title="Assessment">
      <div className={styles.assessment}>
        <div className={styles.feasibility}>
          <p className={styles.headline}>
            <span className={marks.eyebrow}>Feasibility</span> <span className={styles.word}>{label}</span>
          </p>
          <ProgressDashes
            items={dashes}
            label={`Feasibility: ${label}, step ${String(step)} of 3 on a scale of ${FEASIBILITY_SCALE}`}
            className={styles.scale}
          />
          <p className={styles.steps} aria-hidden="true">
            {FEASIBILITY_STEPS.map((f) => (
              <span key={f} className={f === feasibility ? styles.stepOn : undefined}>
                {feasibilityLabel(f)}
              </span>
            ))}
          </p>
        </div>
        <PlanProse blocks={verdict} className={`${styles.verdict} ${marks.marked}`} />
        {more && (
          <details className={styles.why}>
            <summary className={styles.summary}>Why this verdict</summary>
            <div className={styles.body}>
              <PlanProse blocks={rest} className={`${styles.prose} ${marks.marked}`} />
              <PlanProse blocks={reasons} className={`${styles.prose} ${styles.dim} ${marks.marked}`} />
              {citations.length > 0 && (
                <p className={styles.cited}>Cited: {citations.map((c) => c.label).join('; ')}</p>
              )}
            </div>
          </details>
        )}
      </div>
    </PlanCard>
  )
}
