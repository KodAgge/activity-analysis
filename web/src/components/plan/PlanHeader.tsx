import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  calendarDayOfDate,
  calendarDayOfLocalDate,
  dayCount,
  dayMonthNear,
  duration,
  goalTitle,
  pace,
  planStatusLabel,
  raceDistanceLabel,
  surfaceLabel,
} from '../../format'
import { PlanPhases } from '../../charts/PlanPhases'
import { phaseBands, planDays, todayInPlan } from '../../charts/planShapeMath'
import { PlanCard, PlanGrid, PlanSurface } from './PlanCard'
import { HeaderIcon } from './PlanHeaderIcons'
import type { HeaderIconName } from './PlanHeaderIcons'
import { printPlan } from './printPlan'
import {
  STALE_AFTER_DAYS,
  checkpointSessions,
  dataAgeDays,
  daysToRace,
  raceSetsEstimate,
  snapshotPrediction,
  timeTrialDate,
} from './planMath'
import type { PlanDetail, PlanVersionEntry, RaceResult, WeekEntry } from './planMath'
import { weekLoad } from './planLoadMath'
import type { WeekLoadFigures } from './planLoadMath'
import { weekStartLabel, weekText } from './weekText'
import styles from './PlanHeader.module.css'

export interface PlanHeaderProps {
  /** The version the page shows, which need not be the accepted one. */
  entry: PlanVersionEntry
  /** The goal's own status, which decides whether the page asks for a result. */
  goalStatus: PlanDetail['status']
  /**
   * The race's result, from the shown version or else the goal's accepted
   * one, so a closed goal states it on any of its versions. Null until
   * Claude records it.
   */
  result: RaceResult | null
  /** `planMath.nextWeek`: the week the week controls take, or null to draw none. */
  week: WeekEntry | null
  today: Date
  /** The zone boundaries in bpm the copied week labels its heart rate targets with, as the session dialog does. */
  zoneBoundaries?: readonly number[] | null
}

const DAYS_PER_WEEK = 7

/**
 * The goal as the page's title, then where the athlete stands against it,
 * on three cards in the shape of Runna's plan home: the plan, the
 * estimated race time, and the actions.
 *
 * - **The plan card** holds the page's `<h1>`, the race's facts each
 *   behind an icon, the phase strip (`PlanPhases`, one dash per week) and
 *   under it the weeks completed against the countdown, Runna's
 *   `Weeks completed` and `Distance` pair: four layers, as Runna's card.
 * - **The estimate card** sets Claude's estimate beside the best-effort
 *   prediction, and at its foot who made it and from which runs: the
 *   version's provenance.
 * - **The action card** is the PDF and week buttons as Runna's round icon
 *   buttons, each with its name under it, in two pairs: the plan's PDFs
 *   under `PDF`, the next week's under its name. It is left off the paper.
 *
 * A `<header>` around the cards rather than a card of its own: the goal
 * is what the whole page is about, as a route's name is on its own page.
 * On a phone the cards stack; on a desktop the plan card runs the
 * header's whole width, the goal and its counts side by side over the
 * strip, and the estimate and action cards are two halves under it, each
 * as tall as its own content.
 *
 * **The countdown never goes below zero.** Once the race date has passed
 * the page asks an active goal for the result instead, because the plan
 * cannot know it: the result is recorded by Claude through
 * `/training-plan`. Once recorded, the result stands where the request
 * was. An archived goal was given up for another, so it says `Archived`
 * in place of the countdown and asks for nothing.
 *
 * **The estimate rests on recent best efforts only**, decided on
 * 2026-11-14, so the header sets Claude's estimate beside the best-effort
 * prediction as a pair and shows no ordinary-run prediction. A plan with
 * no recent effort to estimate from states none and schedules a time
 * trial; the header names that trial's day where the estimate would be.
 *
 * **The provenance line says how old the data is when it matters.** A
 * plan written from runs more than `STALE_AFTER_DAYS` before today was
 * written without the athlete's latest week, and says so in days.
 */
export function PlanHeader({ entry, goalStatus, result, week, today, zoneBoundaries = null }: PlanHeaderProps) {
  const { goal, provenance } = entry.plan
  const title = goalTitle(goal.distance_m, goal.target_time_s)
  const todayDay = calendarDayOfLocalDate(today)
  const days = daysToRace(goal.race_date, today)
  const best = snapshotPrediction(entry.plan, 'riegel')
  const estimate = estimateText(entry, today, todayDay)
  // A time sits beside the other; the sentence that stands in for a
  // missing one takes the card's whole width.
  const sentence = (entry.plan.assessment.estimate_s ?? null) === null
  const age = dataAgeDays(provenance.data_through, today)
  // `created_at` is an instant; the day it names is the one on the
  // reader's own wall clock, as `today` is.
  const writtenOn = dayMonthNear(calendarDayOfLocalDate(new Date(provenance.created_at)), todayDay)

  const facts: { icon: HeaderIconName; text: string }[] = [
    { icon: 'flag', text: dayMonthNear(calendarDayOfDate(goal.race_date), todayDay) },
    { icon: 'surface', text: surfaceLabel(goal.surface) },
    { icon: 'pace', text: `Target pace ${pace(goal.distance_m / goal.target_time_s)}` },
  ]
  const countdown =
    goalStatus === 'archived'
      ? { label: 'Goal', value: 'Archived' }
      : result === null && days > 0
        ? { label: 'Race day', value: `${dayCount(days)} to go` }
        : result === null && days === 0
          ? { label: 'Race day', value: 'Today' }
          : null
  const asksForResult = result === null && goalStatus === 'active' && days < 0

  const span = planDays(entry.plan)
  const bands = phaseBands(entry.plan.weeks)
  const weekStarts = entry.plan.weeks.map((w) => calendarDayOfDate(w.start_date))
  const weeksDone = weekStarts.filter((start) => start + DAYS_PER_WEEK <= todayDay).length

  return (
    // `data-plan-week`: the week PDF keeps the header (`Plan.module.css`).
    <header className={styles.header} data-plan-week="">
      <PlanGrid className={styles.grid}>
        <PlanSurface className={styles.plan}>
          <div className={styles.goal}>
            <h1 className={styles.title}>{title}</h1>
            <ul className={styles.facts}>
              {facts.map((fact) => (
                <li key={fact.icon} className={styles.fact}>
                  <HeaderIcon name={fact.icon} className={styles.factIcon} />
                  <span>{fact.text}</span>
                </li>
              ))}
            </ul>
            {asksForResult && (
              <p className={styles.passed}>Race day has passed. Record the result with /training-plan in Claude Code.</p>
            )}
            {result !== null && <ResultLine result={result} />}
          </div>

          {bands.length > 0 && (
            <div className={styles.strip}>
              <PlanPhases
                bands={bands}
                span={span}
                today={todayInPlan(todayDay, span)}
                progressDay={todayDay}
                checkpoints={checkpointSessions(entry.plan)}
                raceDate={goal.race_date}
              />
            </div>
          )}
          <dl className={styles.counts}>
            {weekStarts.length > 0 && (
              <div className={styles.count}>
                <dt className={styles.label}>Weeks completed</dt>
                <dd className={styles.value}>
                  {weeksDone}/{weekStarts.length}
                </dd>
              </div>
            )}
            {countdown !== null && (
              <div className={`${styles.count} ${styles.countEnd}`}>
                <dt className={styles.label}>{countdown.label}</dt>
                <dd className={styles.value}>{countdown.value}</dd>
              </div>
            )}
          </dl>
        </PlanSurface>

        <PlanCard title={`Estimated ${raceDistanceLabel(goal.distance_m)} time`}>
          <dl className={sentence ? `${styles.estimates} ${styles.estimatesStacked}` : styles.estimates}>
            <div className={styles.estimateItem}>
              <dt className={styles.label}>Claude&apos;s estimate</dt>
              <dd className={sentence ? `${styles.value} ${styles.valueSentence}` : styles.value}>{estimate}</dd>
            </div>
            <div className={styles.estimateItem}>
              <dt className={styles.label}>Predicted, best efforts</dt>
              <dd className={styles.value}>{duration(best?.predicted_time_s ?? null)}</dd>
            </div>
          </dl>
          <p className={styles.provenance}>
            {/* Two sentences, which a desktop sets on a line each rather
                than breaking the second anywhere. */}
            <span className={styles.sentenceLine}>
              Version {entry.number} · {planStatusLabel(entry.status)}.
            </span>{' '}
            <span className={styles.sentenceLine}>
              {provenance.data_through === null ? (
                <>Written by Claude on {writtenOn}, before any run was stored.</>
              ) : (
                <>
                  Written by Claude on {writtenOn} from runs through{' '}
                  {dayMonthNear(calendarDayOfDate(provenance.data_through), todayDay)}
                  {age !== null && age > STALE_AFTER_DAYS && (
                    <strong className={styles.stale}>, {dayCount(age)} before today</strong>
                  )}
                  .
                </>
              )}
            </span>
          </p>
        </PlanCard>

        {/* The plan is carried on a phone as a PDF the browser's print
            dialog saves, in two lengths, and the next week as a third PDF
            or as text; `printPlan` says what each PDF holds and
            `Plan.module.css`'s print rules lay them out. */}
        <PlanSurface className={styles.actionsCard}>
          <div className={styles.actions}>
            {/* Each pair under a drawn name, the plan's under `PDF` and the
                week's under its Monday, a hairline under each, so the four
                circles read as two pairs. The drawn names repeat the
                groups' accessible names, so they are hidden from a screen
                reader. */}
            <div role="group" aria-label="Print or save as PDF" className={styles.group}>
              <span className={styles.groupLabel} aria-hidden="true">
                PDF
              </span>
              <div className={styles.buttons}>
                <ActionButton icon="page" onClick={() => printPlan('shown', title)}>
                  As shown
                </ActionButton>
                <ActionButton icon="pages" onClick={() => printPlan('full', title)}>
                  With every session
                </ActionButton>
              </div>
            </div>
            {week !== null && (
              <WeekActions
                goal={title}
                week={week}
                today={today}
                zoneBoundaries={zoneBoundaries}
                load={weekLoad(entry.plan, week.week)}
              />
            )}
          </div>
        </PlanSurface>
      </PlanGrid>
    </header>
  )
}

/**
 * One of Runna's round action buttons: an icon in a circle, its name
 * under it. The name is the button's accessible name; the icon is hidden.
 */
function ActionButton({
  icon,
  onClick,
  children,
}: {
  icon: HeaderIconName
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button type="button" className={styles.action} onClick={onClick}>
      <span className={styles.circle}>
        <HeaderIcon name={icon} className={styles.actionIcon} />
      </span>
      <span className={styles.actionLabel}>{children}</span>
    </button>
  )
}

/** How long the copy button says what became of the copy before it reads `Copy as text` again. */
const COPY_STATE_MS = 3000

type CopyState = 'idle' | 'copied' | 'failed'

const COPY_LABEL: Readonly<Record<CopyState, string>> = {
  idle: 'Copy as text',
  copied: 'Copied',
  failed: 'Copy failed',
}

/**
 * The next week on its own, asked for by the maintainer on 2026-11-15 to
 * take the coming week out after the Sunday revision: as a PDF of its
 * sessions in full, or as text for a note or a message. Labelled with the
 * week's Monday, so the athlete sees which week either takes.
 *
 * The clipboard can refuse, outside a secure origin or without
 * permission; the button then says `Copy failed` rather than nothing.
 */
function WeekActions({
  goal,
  week,
  today,
  zoneBoundaries,
  load,
}: {
  goal: string
  week: WeekEntry
  today: Date
  zoneBoundaries: readonly number[] | null
  load: WeekLoadFigures
}) {
  const [copy, setCopy] = useState<CopyState>('idle')
  const start = weekStartLabel(week)
  const label = `Week of ${start}`

  useEffect(() => {
    if (copy === 'idle') return
    const timer = window.setTimeout(() => setCopy('idle'), COPY_STATE_MS)
    return () => window.clearTimeout(timer)
  }, [copy])

  const copyText = () => {
    // `navigator.clipboard` is undefined outside a secure origin, so the
    // call itself can throw before it returns a promise.
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(weekText(goal, week, today, zoneBoundaries, load)))
      .then(
        () => setCopy('copied'),
        () => setCopy('failed'),
      )
  }

  return (
    <div role="group" aria-label={label} className={styles.group}>
      <span className={styles.groupLabel} aria-hidden="true">
        {label}
      </span>
      <div className={styles.buttons}>
        <ActionButton icon="week" onClick={() => printPlan('week', goal, start)}>
          PDF
        </ActionButton>
        <ActionButton icon="copy" onClick={copyText}>
          <span aria-live="polite">{COPY_LABEL[copy]}</span>
        </ActionButton>
      </div>
    </div>
  )
}

/** The race's result: the time, whether the target was achieved, and Claude's note. */
function ResultLine({ result }: { result: RaceResult }) {
  const time = result.time_s ?? null
  const note = result.note ?? ''
  return (
    <>
      <p className={styles.passed}>
        {time === null ? 'Result' : `Result ${duration(time)}`} · {result.achieved ? 'Achieved' : 'Missed'}
      </p>
      {note !== '' && <p className={styles.passed}>{note}</p>}
    </>
  )
}

/**
 * Claude's estimate as the header states it: the time, else the day of
 * the time trial that will set it, else the race's day when the race is
 * near enough to stand in for a trial, else that there is none yet.
 */
function estimateText(entry: PlanVersionEntry, today: Date, todayDay: number): string {
  const estimate = entry.plan.assessment.estimate_s ?? null
  if (estimate !== null) return duration(estimate)
  const trial = timeTrialDate(entry.plan, today)
  if (trial !== null) return `Set by the time trial on ${dayMonthNear(calendarDayOfDate(trial), todayDay)}`
  if (raceSetsEstimate(entry.plan)) {
    return `Set by the race on ${dayMonthNear(calendarDayOfDate(entry.plan.goal.race_date), todayDay)}`
  }
  return 'No estimate yet'
}
