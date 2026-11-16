import { Link } from '@tanstack/react-router'
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { components } from '../../api/schema'
import {
  calendarDayOfDate,
  calendarDayOfLocalDate,
  distance,
  formatLocalShort,
  heartRateRange,
  localTimeLabel,
  NO_VALUE,
  outcomeLabel,
  phaseLabel,
  sessionKindLabel,
  speedRangeAsKmh,
  speedRangeAsPace,
  stepAmount,
  stepRoleLabel,
  weekdayDayMonthNear,
} from '../../format'
import { SessionProfile } from '../../charts/SessionProfile'
import { isHard, stepSpeed } from '../../charts/sessionProfileMath'
import { PlanCard, PlanSurface } from './PlanCard'
import { PlanProse } from './PlanProse'
import type { ActivitySummary, Outcome, Session, SessionEntry, WeekEntry } from './planMath'
import { ceilingShare } from './planLoadMath'
import type { RunLoad } from './planLoadMath'
import { weekRangeLabel, weekSummary } from './weekText'
import { WeekLoad } from './WeekLoad'
import type { WeekLoadProps } from './WeekLoad'
import { KIND_MARK, VERDICT_GLYPH, kindSlotClass } from './sessionMarks'
import styles from './SessionDetail.module.css'

type Step = components['schemas']['Step']

export interface SessionDetailProps {
  /** The session and the phase of the week that lists it. */
  entry: SessionEntry
  /** Claude's verdict on the session, once it has passed and been judged. */
  outcome: Outcome | null
  /** From `runsByLocalDay`: the runs done on the session's day, and the matched runs' dates. */
  runsByDay: Map<number, ActivitySummary[]>
  today: Date
  /** The version's zone boundaries in bpm, to label a heart rate target with its zone. */
  zoneBoundaries?: readonly number[] | null
  /** The loaded runs' heart rate histograms, for a matched run's share under the ceiling. */
  runLoads?: RunLoad[]
  /**
   * The title's heading level: 2 where the detail is a dialog of its own,
   * 3 under a section's heading. Its own sub-headings are one below it.
   */
  headingLevel?: 2 | 3
  /** The title's id, for a dialog to be labelled by it. */
  titleId?: string
  /**
   * Whether the body sits on cards of its own, as in the dialog, whose
   * ground is the page's: the head and the profile on one, the steps and
   * the description on one each. Inside a card, as the next session and the
   * print appendix are, the parts are divided by whitespace instead, since
   * a card never holds another.
   */
  framed?: boolean
  /**
   * Whether the body holds the description. The next session's card ends
   * at its steps, as Runna's workout card ends at its stats, and
   * `NextSession` gives the description a card of its own.
   */
  withDescription?: boolean
  /**
   * Whether the body holds the steps. `NextSession` sets them on a card of
   * their own, `StepTable`, as the dialog sets them on a surface of their
   * own, so the page and the dialog are one layout.
   */
  withSteps?: boolean
}

/** One figure in the stat row: its name and its value. */
interface Stat {
  label: string
  value: string
}

/**
 * One planned session written out in full: the day, the kind in its
 * calendar colour, the title, the planned distance and duration and the
 * week's phase as a row of stats, the workout profile, the steps in
 * order, each with its pace, treadmill speed and heart rate, Claude's
 * description set out as the blocks it is written in, in two columns once
 * the width holds them, and once it has
 * passed, Claude's verdict with the runs it matched and every other run
 * done that day.
 *
 * One body for the next session, the calendar's detail dialog and the
 * print appendix, so the three never say a session differently. It lays
 * itself out by its own width, a container query, so the same body sets
 * its stats under the title on a phone and beside it in a desktop's card
 * or sheet.
 */
export function SessionDetail({
  entry,
  outcome,
  runsByDay,
  today,
  zoneBoundaries = null,
  runLoads = [],
  headingLevel = 3,
  titleId,
  framed = false,
  withDescription = true,
  withSteps = true,
}: SessionDetailProps) {
  const { session, phase } = entry
  const Title = headingLevel === 2 ? 'h2' : 'h3'
  const Sub = headingLevel === 2 ? 'h3' : 'h4'
  const todayDay = calendarDayOfLocalDate(today)
  const day = calendarDayOfDate(session.date)
  const plannedDistance = stepAmount(1, session.planned_distance_m ?? null, null)
  const plannedDuration = stepAmount(1, null, session.planned_duration_s ?? null)
  const stats: Stat[] = [
    ...(plannedDistance === NO_VALUE ? [] : [{ label: 'Distance', value: plannedDistance }]),
    ...(plannedDuration === NO_VALUE ? [] : [{ label: 'Time', value: plannedDuration }]),
    { label: 'Phase', value: phaseLabel(phase) },
  ]
  // "Planned" said once for the row, under it, rather than under each figure.
  const planned = plannedFiguresNote(plannedDistance !== NO_VALUE, plannedDuration !== NO_VALUE)
  const matchedIds = outcome?.activity_ids ?? []
  const ceiling = sessionCeiling(session)
  const shares =
    ceiling === null || (session.kind !== 'easy' && session.kind !== 'long')
      ? []
      : matchedIds.flatMap((id) => {
          const load = runLoads.find((r) => r.activity_id === id)
          const share = load === undefined ? null : ceilingShare(load, ceiling)
          return share === null ? [] : [share]
        })
  const runsThatDay = (runsByDay.get(day) ?? []).filter((r) => !matchedIds.includes(r.activity_id))
  const kind = kindSlotClass(session.kind)
  const hasSteps = withSteps && session.steps.length > 0
  const hasDescription = withDescription && session.description.trim() !== ''

  const steps = hasSteps && (
    <Part framed={framed} className={styles.stepsPart}>
      <StepTable
        session={session}
        easyMps={entry.profile?.easyMps ?? null}
        zoneBoundaries={zoneBoundaries}
        heading={<Sub className={styles.sub}>Steps</Sub>}
      />
    </Part>
  )
  const description = hasDescription && (
    <Part framed={framed} className={styles.notesPart}>
      <Sub className={styles.sub}>Description</Sub>
      <PlanProse text={session.description} variant="notes" />
    </Part>
  )

  const head = (
    <div className={styles.head}>
      <div className={`${styles.hero} ${kind} ${KIND_MARK.bar}`}>
        <p className={styles.when}>
          {day === todayDay && 'Today · '}
          {weekdayDayMonthNear(day, todayDay)}
        </p>
        <Title id={titleId} className={styles.title}>
          {session.title}
        </Title>
        <p className={styles.kindLine}>
          <span className={`${styles.tag} ${KIND_MARK.tint}`}>{sessionKindLabel(session.kind)}</span>
        </p>
      </div>
      <div className={styles.statBlock}>
        <dl className={styles.stats}>
          {stats.map((s) => (
            <div key={s.label} className={styles.stat}>
              <dt className={styles.statLabel}>{s.label}</dt>
              <dd className={styles.statValue}>
                <StatValue value={s.value} />
              </dd>
            </div>
          ))}
        </dl>
        {planned !== null && <p className={styles.statNote}>{planned}</p>}
      </div>
    </div>
  )
  const profile = (
    <div className={styles.profilePart}>
      <SessionProfile session={session} size="full" {...entry.profile} zoneBoundaries={zoneBoundaries} />
    </div>
  )

  return (
    <div className={`${styles.detail} ${framed ? styles.framed : styles.inline}`}>
      {framed ? (
        // The dialog's first card is the workout card, the head and the
        // profile on one surface, as the next session's card holds them.
        <PlanSurface className={styles.workout}>
          {head}
          {profile}
        </PlanSurface>
      ) : (
        // One block on paper too, so a page never parts the head from its profile.
        <div className={styles.workout}>
          {head}
          {profile}
        </div>
      )}
      {steps}
      {description}
      {outcome !== null && (
        <Part framed={framed} className={styles.block}>
          <Sub className={styles.sub}>Claude&apos;s verdict</Sub>
          <p className={styles.verdict}>
            <span aria-hidden="true" className={styles.glyph}>
              {VERDICT_GLYPH[outcome.verdict]}
            </span>{' '}
            {outcomeLabel(outcome.verdict)}
          </p>
          {outcome.note !== '' && <p className={styles.note}>{outcome.note}</p>}
          {shares.map((share, i) => (
            <p key={i} className={styles.note}>
              {`${String(Math.round(share * 100))}% of the run at or under ${String(Math.round(ceiling ?? 0))} bpm`}
            </p>
          ))}
          {matchedIds.length > 0 && (
            <ul className={styles.runs}>
              {matchedIds.map((id) => (
                <li key={id}>
                  <MatchedRun id={id} runsByDay={runsByDay} />
                </li>
              ))}
            </ul>
          )}
        </Part>
      )}
      {runsThatDay.length > 0 && (
        <Part framed={framed} className={styles.block}>
          <Sub className={styles.sub}>{matchedIds.length > 0 ? 'Other runs on this day' : 'Runs on this day'}</Sub>
          <ul className={styles.runs}>
            {runsThatDay.map((r) => (
              <li key={r.activity_id}>
                <Link to="/activities/$activityId" params={{ activityId: r.activity_id }} className={styles.run}>
                  {localTimeLabel(r.start_time_utc, r.utc_offset_s)} · {distance(r.distance_m, 1)}
                </Link>
              </li>
            ))}
          </ul>
        </Part>
      )}
    </div>
  )
}

/** The line under the stat row that says which of its figures are the plan's, or null for none. */
function plannedFiguresNote(hasDistance: boolean, hasDuration: boolean): string | null {
  if (hasDistance && hasDuration) return 'Planned distance and time'
  if (hasDistance) return 'Planned distance'
  if (hasDuration) return 'Planned time'
  return null
}

/** A part of the body: a card of its own in the dialog, a divided block inside a card. */
function Part({ framed, className, children }: { framed: boolean; className?: string; children: ReactNode }) {
  const name = className === undefined ? styles.part : `${styles.part} ${className}`
  return framed ? <PlanSurface className={name}>{children}</PlanSurface> : <div className={name}>{children}</div>
}

/**
 * A stat's value with its unit set smaller, as Runna sets `4.52KM`: `10 km`
 * is the number, then the unit. A value with no unit after a space, a
 * phase or `1:30`, is set whole.
 */
function StatValue({ value }: { value: string }) {
  const match = /^(.*\d)\s+([A-Za-z/]+)$/.exec(value)
  if (match === null) return <span className={styles.statNumber}>{value}</span>
  return (
    <>
      <span className={styles.statNumber}>{match[1]}</span>
      <span className={styles.statUnit}> {match[2]}</span>
    </>
  )
}

/** The ceiling the session writes: its highest heart rate step with no floor, or null. */
function sessionCeiling(session: Session): number | null {
  const ceilings = session.steps.flatMap((st) =>
    st.heart_rate != null && st.heart_rate.low_bpm == null ? [st.heart_rate.high_bpm] : [],
  )
  return ceilings.length === 0 ? null : Math.max(...ceilings)
}

/**
 * The three targets a step can set, in column order, each with the unit
 * its column header names on a phone, where the cells drop it.
 */
const TARGET_COLUMNS = [
  { name: 'Pace', unit: '/km' },
  { name: 'Treadmill', unit: 'km/h' },
  { name: 'Heart rate', unit: 'bpm' },
] as const

export interface StepTableProps {
  session: Session
  /** The athlete's easy speed, from the session's profile, which tells hard steps from easy ones. */
  easyMps: number | null
  zoneBoundaries?: readonly number[] | null
  /** The table's own heading, in its name column; none where a card's title names it. */
  heading?: ReactNode
}

/**
 * A session's steps as one table: a heading row naming the pace, treadmill
 * and heart rate columns once, then a row per step. Its own container, so
 * it lays itself out by its width inside `SessionDetail` and on the next
 * session's Steps card alike.
 */
export function StepTable({ session, easyMps, zoneBoundaries = null, heading }: StepTableProps) {
  return (
    <div className={styles.table}>
      {/* The heading in the name column; the target columns' names stand
          beside it from 44rem, under it on a phone, said once for every
          row under them. On a phone the unit stands under the name, since
          the cells there drop it. */}
      <div className={styles.stepsHead}>
        {heading}
        {TARGET_COLUMNS.map(({ name, unit }) => (
          <span key={name} aria-hidden="true" className={styles.columnName}>
            {name}
            <span className={styles.columnUnit}> {unit}</span>
          </span>
        ))}
      </div>
      <ol className={`${styles.steps} ${kindSlotClass(session.kind)}`} aria-label="Steps">
        {session.steps.map((step, i) => (
          <StepRow
            key={i}
            step={step}
            kind={session.kind}
            hard={isHard(step.role, stepSpeed(session, step, easyMps), easyMps)}
            boundaries={zoneBoundaries}
          />
        ))}
      </ol>
    </div>
  )
}

/** A step's targets, each named, in column order: the pace, the treadmill's km/h and the heart rate, null where unset. */
function stepTargets(step: Step, boundaries: readonly number[] | null): { name: string; value: string | null }[] {
  const speed = step.speed ?? null
  const hr = step.heart_rate ?? null
  return [
    { name: 'Pace', value: speed === null ? null : speedRangeAsPace(speed.low_mps, speed.high_mps) },
    { name: 'Treadmill', value: speed === null ? null : speedRangeAsKmh(speed) },
    { name: 'Heart rate', value: hr === null ? null : heartRateRange(hr.low_bpm, hr.high_bpm, boundaries) },
  ]
}

/**
 * A step's swatch is the kind of effort it is, as the full profile above
 * colours it (`SessionProfile`'s `effortSlot`): the work in the session's
 * kind, the strides in theirs, and the easy running around them in the
 * easy kind. Hard running is the solid square; easy running the tint
 * under a cap, as the profile's key draws it. Every step has one, so the
 * names start on one edge.
 */
function stepSlot(role: Step['role'], kind: Session['kind']): string {
  if (role === 'strides') return kindSlotClass('strides')
  if (role === 'work') return kindSlotClass(kind)
  return kindSlotClass('easy')
}

/**
 * One step, a row of the session's table: a swatch in the colour of its
 * kind of effort (`stepSlot`), the role and the amount with the note after
 * them, then the pace, the km/h and the heart rate in their columns, a
 * dash where the step sets none. On a phone the name runs across the width
 * over the three columns, and a step that sets only a heart rate puts it
 * on the name line; from 44rem the name is the first column, on the
 * columns the head's stats stand on.
 *
 * The work is the session's reason, so it is the list's hero, Runna's lap
 * card: the row on the kind's tint, its targets one size up.
 *
 * A note that only repeats the role, `Strides` under strides, is not said
 * twice.
 */
function StepRow({
  step,
  kind,
  hard,
  boundaries,
}: {
  step: Step
  kind: Session['kind']
  hard: boolean
  boundaries: readonly number[] | null
}) {
  const role = stepRoleLabel(step.role)
  const written = (step.note ?? '').trim()
  const note = written.toLowerCase() === role.toLowerCase() ? '' : written
  const amount = stepAmount(step.repeat, step.distance_m ?? null, step.duration_s ?? null)
  const targets = stepTargets(step, boundaries)
  const work = step.role === 'work'
  // Only a heart rate set: a phone puts it on the name line.
  const hrOnly = targets.every((t) => (t.name === 'Heart rate') === (t.value !== null))
  return (
    <li
      className={`${styles.step} ${work ? `${styles.work} ${KIND_MARK.tint}` : styles.line}`}
      data-role={step.role}
      data-hr-only={hrOnly ? '' : undefined}
    >
      <div className={styles.name}>
        <span
          aria-hidden="true"
          className={`${styles.mark} ${KIND_MARK.swatch} ${stepSlot(step.role, kind)} ${hard ? '' : (styles.markEasy ?? '')}`}
        />
        <span className={styles.nameText}>
          <span className={styles.role}>{role}</span> <span className={styles.amount}>{amount}</span>
          {note !== '' && <span className={styles.stepNote}>{note}</span>}
        </span>
      </div>
      <dl className={styles.targets} data-none={targets.every((t) => t.value === null) ? '' : undefined}>
        {targets.map((t) => (
          <div key={t.name} className={styles.target} data-empty={t.value === null ? '' : undefined}>
            <dt>{t.name}</dt>
            <dd>{t.value === null ? NO_VALUE : <TargetValue value={t.value} />}</dd>
          </div>
        ))}
      </dl>
    </li>
  )
}

/**
 * A target's value with its unit apart, `4:15-4:20` then `/km`, and a
 * heart rate's zone apart after its unit, `185-196`, ` bpm`, ` (Z5)`. On a
 * phone the column's header names the unit, so the cell hides it from
 * sight and keeps it for a screen reader and the text; the work row sets
 * the unit, or the zone, smaller, as the head's stats set their units.
 */
function TargetValue({ value }: { value: string }) {
  const match = /^(.*\d)(\/km| km\/h| bpm)(.*)$/.exec(value)
  if (match === null) return <>{value}</>
  return (
    <>
      {match[1]}
      <span className={styles.unit}>{match[2]}</span>
      {match[3] !== '' && <span className={styles.zone}>{match[3]}</span>}
    </>
  )
}

/**
 * A run Claude matched to the session, named by its day, time and distance
 * when the page has it. A matched run can lie outside the runs loaded, a
 * session moved past the plan's span for one, so it is then named by id;
 * the link works either way.
 */
function MatchedRun({ id, runsByDay }: { id: string; runsByDay: Map<number, ActivitySummary[]> }) {
  let run: ActivitySummary | undefined
  for (const runs of runsByDay.values()) {
    run = runs.find((r) => r.activity_id === id)
    if (run !== undefined) break
  }
  return (
    <Link to="/activities/$activityId" params={{ activityId: id }} className={styles.run}>
      {run === undefined
        ? `Activity ${id}`
        : `${formatLocalShort(run.start_time_utc, run.utc_offset_s)} · ${distance(run.distance_m, 1)}`}
    </Link>
  )
}

export interface SessionDialogProps extends Omit<SessionDetailProps, 'headingLevel' | 'titleId'> {
  /** The dialog has closed, by Escape, its close button or a click outside the sheet. */
  onClose: () => void
}

/**
 * A session's detail over the page: a native modal `<dialog>`, so the
 * browser traps focus in it, makes the page behind inert and closes it on
 * Escape. On a desktop a sheet over the whole content column, the rail
 * beside it under a dark scrim, and the whole screen on a phone. Its ground is the page's: Close on the
 * ground, the head and the profile on one card, the steps and the
 * description each on a card of their own under it.
 *
 * Mounted only while a session is open, and opened as it mounts. Every way
 * it closes goes through the element's own `close` event, which calls
 * `onClose` once; the view then drops `?session=` and unmounts it, and
 * focus goes back to the session's button in the calendar, the one that
 * opened it, or the one a shared link names. The browser's back button
 * removes it without a `close` event, so it is unmounted all the same.
 */
export function SessionDialog({ onClose, ...detail }: SessionDialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const id = detail.entry.session.id
  const [keyboard, setKeyboard] = useState(() => keyboardLast)

  useEffect(() => {
    const dialog = ref.current
    if (dialog !== null && !dialog.open) {
      dialog.showModal()
      // The sheet scrolls once a session is long, and Chromium makes a
      // scroller focusable, so the dialog's own first focus lands on the
      // sheet and rings it. Close is where a keyboard wants to start.
      closeRef.current?.focus()
    }
    return () => focusSessionButton(id)
  }, [id])

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      data-keyboard={keyboard ? '' : undefined}
      onClose={onClose}
      onKeyDown={() => setKeyboard(true)}
      onPointerDown={() => setKeyboard(false)}
      // The sheet fills the dialog, so a click on the dialog itself is a
      // click on the backdrop beside the sheet.
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close()
      }}
    >
      <div className={styles.sheet}>
        <div className={styles.bar}>
          <button ref={closeRef} type="button" className={styles.close} onClick={() => ref.current?.close()}>
            <svg aria-hidden="true" className={styles.closeIcon} viewBox="0 0 20 20">
              <path d="M16 10H4M9 5l-5 5 5 5" />
            </svg>
            Close
          </button>
        </div>
        <SessionDetail {...detail} headingLevel={2} titleId={titleId} framed />
      </div>
    </dialog>
  )
}

/**
 * Whether the page's last input was a key rather than a pointer. The
 * dialog focuses Close as it opens, and Chromium rings a focus a script
 * moves when no pointer has been used, so a session opened from a shared
 * link drew a ring round Close on its first paint. The dialog draws Close's
 * ring only once a key has been pressed, before it opened or in it.
 */
let keyboardLast = false
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', () => (keyboardLast = true), true)
  document.addEventListener('pointerdown', () => (keyboardLast = false), true)
}

/** Focuses the calendar's button for a session, if the calendar draws one. */
function focusSessionButton(id: string): void {
  const buttons = Array.from(document.querySelectorAll<HTMLElement>('[data-session-id]'))
  buttons.find((b) => b.dataset.sessionId === id)?.focus()
}

export interface SessionAppendixProps extends Pick<SessionDetailProps, 'zoneBoundaries' | 'runLoads'> {
  entries: SessionEntry[]
  outcomes: Map<string, Outcome>
  runsByDay: Map<number, ActivitySummary[]>
  today: Date
}

/**
 * Every written-out session's detail in date order, after the calendar,
 * in the long PDF only (`printPlan`'s `full` mode): that PDF, carried on
 * a phone, then holds each session's instructions, which the calendar's
 * one line cannot. Hidden on screen, where the calendar opens each one
 * instead, and in the short PDF, which prints the page as it is shown.
 */
export function SessionAppendix({ entries, outcomes, runsByDay, today, ...hr }: SessionAppendixProps) {
  if (entries.length === 0) return null
  return (
    <div className={styles.appendix}>
      <PlanCard title="Session details">
        {entries.map((entry) => (
          <article key={entry.session.id} className={styles.appendixSession}>
            <SessionDetail
              entry={entry}
              outcome={outcomes.get(entry.session.id) ?? null}
              runsByDay={runsByDay}
              today={today}
              {...hr}
            />
          </article>
        ))}
      </PlanCard>
    </div>
  )
}

export interface WeekAppendixProps extends Pick<SessionDetailProps, 'zoneBoundaries' | 'runLoads'> {
  entry: WeekEntry
  outcomes: Map<string, Outcome>
  runsByDay: Map<number, ActivitySummary[]>
  today: Date
  /** The week's load block, which opens the card; omitted, the card opens on the sessions. */
  load?: WeekLoadProps | null
}

/**
 * The next week's sessions written out in full, in the week PDF only
 * (`printPlan`'s `week` mode), which prints the header and this and
 * nothing else. Hidden on screen and in the other two PDFs. The section is
 * marked `data-plan-week`, the attribute `Plan.module.css` keeps in that
 * mode.
 */
export function WeekAppendix({ entry, outcomes, runsByDay, today, load = null, ...hr }: WeekAppendixProps) {
  return (
    <div className={styles.week} data-plan-week="">
      <PlanCard title={`Week of ${weekRangeLabel(entry)}`} note={weekSummary(entry)}>
        {load !== null && <WeekLoad {...load} />}
        {entry.sessions.map((e) => (
          <article key={e.session.id} className={styles.appendixSession}>
            <SessionDetail
              entry={e}
              outcome={outcomes.get(e.session.id) ?? null}
              runsByDay={runsByDay}
              today={today}
              {...hr}
            />
          </article>
        ))}
      </PlanCard>
    </div>
  )
}
