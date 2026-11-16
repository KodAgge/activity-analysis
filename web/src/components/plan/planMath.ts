import type { components } from '../../api/schema'
import {
  NO_VALUE,
  calendarDayOfDate,
  calendarDayOfLocalDate,
  dateOfCalendarDay,
  localCalendarDay,
  paceFromSpeed,
  stepAmount,
} from '../../format'
import { planEasySpeed, planProfileScale } from '../../charts/sessionProfileMath'
import type { SessionProfileOptions } from '../../charts/sessionProfileMath'

/**
 * The pure logic behind the Plan view, kept apart from its components for
 * the reason `volumeBarsMath.ts` is: it is testable without rendering, and
 * a file mixing components with plain functions cannot be Fast-Refreshed.
 *
 * Session and week dates are the athlete's local calendar dates, so every
 * comparison with a run goes through the day number `localCalendarDay`
 * produces, never through a `Date` and the machine's timezone.
 */

type Schemas = components['schemas']
export type PlanSummary = Schemas['PlanSummary']
export type PlanDetail = Schemas['PlanDetail']
export type PlanVersion = Schemas['PlanVersion']
export type Session = Schemas['Session']
export type Week = Schemas['Week']
export type Outcome = Schemas['Outcome']
export type SpeedRange = Schemas['SpeedRange']
export type PlanVersionEntry = Schemas['PlanVersionEntry']
export type ChangeEntry = Schemas['ChangeEntry']
export type SnapshotPrediction = Schemas['SnapshotPrediction']
export type RaceResult = Schemas['RaceResult']
export type ActivitySummary = Schemas['ActivitySummary']

/**
 * The goal the view opens on. A pending version comes first because a new
 * goal's proposal has to be seen before it is accepted, even while another
 * goal is active; then the active goal; then the newest, which is first in
 * the list because `/api/plans` is newest first.
 */
export function displayedGoal(plans: PlanSummary[]): PlanSummary | null {
  return (
    plans.find((p) => p.pending_version !== null) ??
    plans.find((p) => p.status === 'active') ??
    plans[0] ??
    null
  )
}

/** The accepted version and the one awaiting a decision, either may be absent. */
export function currentAndPending(detail: PlanDetail): {
  accepted: PlanVersion | null
  pending: PlanVersion | null
} {
  const accepted = detail.versions.find((v) => v.status === 'accepted')
  const pending = detail.versions.find((v) => v.status === 'proposed')
  return { accepted: accepted?.plan ?? null, pending: pending?.plan ?? null }
}

/**
 * The version the page shows: the one `?version=N` names when the goal has
 * it, else the pending one, since a proposal is what awaits a decision,
 * else the accepted one, else the newest. A number no version has falls
 * back rather than failing, because a link to a version is still a link
 * to its goal.
 */
export function shownVersion(detail: PlanDetail, requested: number | undefined): PlanVersionEntry | null {
  const versions = detail.versions
  return (
    versions.find((v) => v.number === requested) ??
    versions.find((v) => v.status === 'proposed') ??
    versions.find((v) => v.status === 'accepted') ??
    versions.reduce<PlanVersionEntry | null>((newest, v) => (newest === null || v.number > newest.number ? v : newest), null)
  )
}

/**
 * A change summary with goal changes first and the rest in Claude's order:
 * a new target or race date changes what every other entry is for.
 */
export function goalChangesFirst(changes: ChangeEntry[]): ChangeEntry[] {
  return [...changes.filter((c) => c.goal_change), ...changes.filter((c) => !c.goal_change)]
}

/**
 * What the calendar and the weekly distance chart say while the runs are
 * on their way: neither may draw a day or a week as empty until they are
 * in.
 */
export const RUNS_LOADING = 'Loading the runs done on these days.'

/** Data older than this many days is flagged in the provenance line. */
export const STALE_AFTER_DAYS = 7

/**
 * Whole days from the newest run a version was written from to today, or
 * null for a version written before any run was stored.
 */
export function dataAgeDays(dataThrough: string | null, today: Date): number | null {
  if (dataThrough === null) return null
  return calendarDayOfLocalDate(today) - calendarDayOfDate(dataThrough)
}

/**
 * The active goal that accepting `goalId`'s proposal would archive, or
 * null. Only a goal that was never accepted replaces another: a revision
 * of the active goal archives nothing, and the store keeps one active goal.
 */
export function archivedByAccepting(plans: PlanSummary[], goalId: string): string | null {
  const goal = plans.find((p) => p.goal_id === goalId)
  if (goal === undefined || goal.accepted_version !== null) return null
  return plans.find((p) => p.status === 'active' && p.goal_id !== goalId)?.goal_id ?? null
}

/** How far a prediction's distance may lie from the goal's and still be the goal's: 0.5%. */
const GOAL_DISTANCE_TOLERANCE = 0.005

/**
 * Whether a prediction's distance is the goal's own. Within a tolerance
 * rather than equal: a half marathon goal written as 21100 m is the
 * prediction's 21097.5 m.
 */
export function atGoalDistance(distanceM: number, goalM: number): boolean {
  return Math.abs(distanceM - goalM) <= GOAL_DISTANCE_TOLERANCE * goalM
}

/**
 * One model's prediction at the goal's own distance from the version's
 * snapshot, or null when the context had none there. `riegel` is the
 * best-effort model, the one `trajectory` reads.
 */
export function snapshotPrediction(version: PlanVersion, model: string): SnapshotPrediction | null {
  return (
    version.provenance.snapshot.find((p) => atGoalDistance(p.distance_m, version.goal.distance_m) && p.model === model) ??
    null
  )
}

/** Deep equality that ignores object key order, for JSON-shaped values. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => sameValue(x, b[i]))
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  const rb = b as Record<string, unknown>
  return ka.every((k) => k in rb && sameValue((a as Record<string, unknown>)[k], rb[k]))
}

function sessionsById(version: PlanVersion): Map<string, Session> {
  return new Map(version.weeks.flatMap((w) => w.sessions).map((s) => [s.id, s]))
}

/**
 * Ids of sessions a proposal changes: edited ones, added ones and removed
 * ones. Empty without an accepted version, since a first proposal has
 * nothing to differ from.
 */
export function changedSessionIds(accepted: PlanVersion | null, pending: PlanVersion): Set<string> {
  const changed = new Set<string>()
  if (accepted === null) return changed
  const before = sessionsById(accepted)
  const after = sessionsById(pending)
  for (const [id, s] of after) {
    const old = before.get(id)
    if (old === undefined || !sameValue(old, s)) changed.add(id)
  }
  for (const id of before.keys()) if (!after.has(id)) changed.add(id)
  return changed
}

/**
 * Runs filed under the athlete's local calendar day, each day's runs in
 * start order. A day can hold several, and an unplanned run on a rest day
 * still shows.
 */
export function runsByLocalDay(runs: ActivitySummary[]): Map<number, ActivitySummary[]> {
  const sorted = [...runs].sort((a, b) => Date.parse(a.start_time_utc) - Date.parse(b.start_time_utc))
  const byDay = new Map<number, ActivitySummary[]>()
  for (const r of sorted) {
    const day = localCalendarDay(r.start_time_utc, r.utc_offset_s)
    const list = byDay.get(day)
    if (list === undefined) byDay.set(day, [r])
    else list.push(r)
  }
  return byDay
}

/** A version's outcomes keyed by the session they judge. */
export function outcomeBySession(version: PlanVersion): Map<string, Outcome> {
  return new Map(version.outcomes.map((o) => [o.session_id, o]))
}

/**
 * Planned against run distance per plan week, in date order as the
 * calendar numbers them. `runM` is null for a week
 * that starts after today: zero would read as a missed week rather than
 * one that has not happened.
 */
export function weeklyDistance(
  version: PlanVersion,
  runsByDay: Map<number, ActivitySummary[]>,
  today: Date,
): { startDate: string; plannedM: number; runM: number | null }[] {
  const todayDay = calendarDayOfLocalDate(today)
  const weeks = [...version.weeks].sort((a, b) => calendarDayOfDate(a.start_date) - calendarDayOfDate(b.start_date))
  return weeks.map((w) => {
    const start = calendarDayOfDate(w.start_date)
    let runM: number | null = null
    if (start <= todayDay) {
      runM = 0
      for (let d = start; d < start + 7; d++) {
        for (const r of runsByDay.get(d) ?? []) runM += r.distance_m ?? 0
      }
    }
    return { startDate: w.start_date, plannedM: w.planned_distance_m, runM }
  })
}

/** A planned session with the phase of the week that lists it, as the session detail states it. */
export interface SessionEntry {
  session: Session
  phase: string
  /**
   * The plan's easy speed and profile scale, so the session's workout
   * profile is drawn on the scale every session of the plan shares. A
   * session's own scale without it.
   */
  profile?: SessionProfileOptions
}

/** One plan's basis for drawing its sessions' profiles: see `SessionEntry.profile`. */
export function profileBasis(version: PlanVersion): SessionProfileOptions {
  return { easyMps: planEasySpeed(version), scale: planProfileScale(version) }
}

/**
 * Every session of the version in date order, each with its week's phase:
 * the print appendix's order, and where the detail looks a session up.
 * Sessions on one day keep the order the file lists them in.
 */
export function sessionEntries(version: PlanVersion): SessionEntry[] {
  const profile = profileBasis(version)
  const entries = version.weeks.flatMap((w) => w.sessions.map((session) => ({ session, phase: w.phase, profile })))
  return entries
    .map((entry, i) => ({ entry, i, day: calendarDayOfDate(entry.session.date) }))
    .sort((a, b) => a.day - b.day || a.i - b.i)
    .map(({ entry }) => entry)
}

/** The session the version has under `id`, or null for an id it has none for. */
export function sessionEntry(version: PlanVersion, id: string | undefined): SessionEntry | null {
  if (id === undefined) return null
  return sessionEntries(version).find((e) => e.session.id === id) ?? null
}

/** A plan week with its sessions written out, in date order. */
export interface WeekEntry {
  week: Week
  sessions: SessionEntry[]
}

/**
 * The week the athlete takes out of the plan on a Sunday: the first week
 * that starts after today, so on a Sunday the one starting the next day.
 * Null when that week is an outline, or when no week starts after today,
 * since either would print an empty page.
 *
 * Its sessions are those dated inside its seven days, placed by their own
 * date as `calendarWeeks` places them, whichever week the file lists them
 * under.
 */
export function nextWeek(version: PlanVersion, today: Date): WeekEntry | null {
  const todayDay = calendarDayOfLocalDate(today)
  const week = [...version.weeks]
    .sort((a, b) => calendarDayOfDate(a.start_date) - calendarDayOfDate(b.start_date))
    .find((w) => calendarDayOfDate(w.start_date) > todayDay)
  if (week === undefined || !week.detailed) return null
  const start = calendarDayOfDate(week.start_date)
  const sessions = sessionEntries(version).filter((e) => {
    const day = calendarDayOfDate(e.session.date)
    return day >= start && day < start + 7
  })
  return sessions.length === 0 ? null : { week, sessions }
}

/** The first session dated today or later that is not a rest day. */
export function nextSession(version: PlanVersion, today: Date): Session | null {
  const todayDay = calendarDayOfLocalDate(today)
  const upcoming = version.weeks
    .flatMap((w) => w.sessions)
    .filter((s) => s.kind !== 'rest' && calendarDayOfDate(s.date) >= todayDay)
    .sort((a, b) => calendarDayOfDate(a.date) - calendarDayOfDate(b.date))
  return upcoming[0] ?? null
}

/** Whole days from today to the race, negative once it has passed. */
export function daysToRace(raceDate: string, today: Date): number {
  return calendarDayOfDate(raceDate) - calendarDayOfLocalDate(today)
}

/**
 * Each live version's best-effort prediction at the goal distance, the
 * `riegel` model, in version order. Withdrawn and rejected versions never
 * described the athlete's plan, so they are left out.
 *
 * The ordinary-run prediction is not read: the plan's estimate rests on
 * recent best efforts only, decided on 2026-11-14, so the Plan view shows
 * no other prediction.
 */
export function trajectory(
  detail: PlanDetail,
  goalDistanceM: number,
): { number: number; createdAt: string; bestEffortS: number | null }[] {
  return detail.versions
    .filter((v) => v.status !== 'withdrawn' && v.status !== 'rejected')
    .sort((a, b) => a.number - b.number)
    .map((v) => ({
      number: v.number,
      createdAt: v.plan.provenance.created_at,
      bestEffortS:
        v.plan.provenance.snapshot.find((p) => atGoalDistance(p.distance_m, goalDistanceM) && p.model === 'riegel')
          ?.predicted_time_s ?? null,
    }))
}

/** A checkpoint with the session it names resolved to that session's date and kind. */
export interface CheckpointSession {
  sessionId: string
  date: string
  kind: Session['kind']
  /**
   * The distance the target is for. A time trial's is its work step's: the
   * session's own planned distance also holds the warm-up and cool-down.
   * Null for a time trial without a single work step of one repeat with a
   * distance, and for a session with no planned distance.
   */
  targetDistanceM: number | null
  description: string
  targetS: number | null
}

/** The distance a checkpoint's target is at: see `CheckpointSession.targetDistanceM`. */
function targetDistance(s: Session): number | null {
  if (s.kind !== 'time_trial') return s.planned_distance_m ?? null
  const work = s.steps.filter((step) => step.role === 'work')
  const only = work.length === 1 ? work[0] : undefined
  return only !== undefined && only.repeat === 1 ? (only.distance_m ?? null) : null
}

/**
 * A version's checkpoints dated by their sessions, in date order. A
 * checkpoint naming a session the version does not have is left out, as
 * there is no day to put it on; `propose` refuses such a plan, so only a
 * hand-edited file, or a version stored before that check, holds one.
 */
export function checkpointSessions(version: PlanVersion): CheckpointSession[] {
  const sessions = sessionsById(version)
  return version.checkpoints
    .flatMap((c) => {
      const s = sessions.get(c.session_id)
      if (s === undefined) return []
      return [
        {
          sessionId: s.id,
          date: s.date,
          kind: s.kind,
          targetDistanceM: targetDistance(s),
          description: c.description,
          targetS: c.target_time_s ?? null,
        },
      ]
    })
    .sort((a, b) => calendarDayOfDate(a.date) - calendarDayOfDate(b.date))
}

/**
 * The date of the time trial the header points at, or null when no
 * checkpoint names one the version has yet to judge. A plan with no
 * estimate schedules a trial, and the revision after it sets the estimate
 * from its result, so the header names the first trial dated today or
 * later; once every trial has passed and no revision has followed, the
 * latest one. A trial on or before the version's `data_through` is left
 * out: the version was written knowing how it went, and kept no estimate.
 */
export function timeTrialDate(version: PlanVersion, today: Date): string | null {
  const todayDay = calendarDayOfLocalDate(today)
  const dataThrough = version.provenance.data_through ?? null
  const judgedTo = dataThrough === null ? -Infinity : calendarDayOfDate(dataThrough)
  const trials = checkpointSessions(version).filter(
    (c) => c.kind === 'time_trial' && calendarDayOfDate(c.date) > judgedTo,
  )
  const upcoming = trials.find((c) => calendarDayOfDate(c.date) >= todayDay)
  return (upcoming ?? trials[trials.length - 1])?.date ?? null
}

/**
 * Whether the race falls within two weeks of the version's start, the
 * window in which `plan propose` lets the race stand in for a time trial
 * when there is no estimate: from the first week's start, or the day
 * after `data_through` when that is later, to 13 days after it.
 */
export function raceSetsEstimate(version: PlanVersion): boolean {
  const starts = version.weeks.map((w) => calendarDayOfDate(w.start_date))
  if (starts.length === 0) return false
  const dataThrough = version.provenance.data_through ?? null
  const start = Math.max(Math.min(...starts), dataThrough === null ? -Infinity : calendarDayOfDate(dataThrough) + 1)
  const race = calendarDayOfDate(version.goal.race_date)
  return start <= race && race <= start + 13
}

/** A target pace band as `4:15-4:20`, the faster end first. */
export function paceRange(speed: SpeedRange): string {
  return `${paceFromSpeed(speed.high_mps)}-${paceFromSpeed(speed.low_mps)}`
}

/** A day number as the `YYYY-MM-DD` the API's date parameters take. */
export function isoDateOfDay(day: number): string {
  return dateOfCalendarDay(day).toISOString().slice(0, 10)
}

/**
 * The dates to ask `/api/activities` for: the first week's Monday, and the
 * day after the last week's Sunday, because the endpoint's `to` is
 * exclusive. Null for a version with no weeks, which has no runs to show.
 */
export function planSpan(version: PlanVersion): { from: string; to: string } | null {
  if (version.weeks.length === 0) return null
  const starts = version.weeks.map((w) => calendarDayOfDate(w.start_date))
  return { from: isoDateOfDay(Math.min(...starts)), to: isoDateOfDay(Math.max(...starts) + 7) }
}

/** One day of a detailed calendar week: what was planned on it and what was run. */
export interface CalendarDay {
  day: number
  sessions: Session[]
  runs: ActivitySummary[]
}

/** One row of the calendar. */
export interface CalendarWeek {
  /** 1 for the plan's first week, counted in date order. */
  number: number
  week: Week
  /** Monday to Sunday for a detailed week; empty for an outline week. */
  days: CalendarDay[]
  /**
   * The runs done in an outline week, in date order. An outline week has
   * no days to file them under, and a week left an outline after it began
   * still has to show what was run in it.
   */
  outlineRuns: ActivitySummary[]
}

/**
 * The plan as calendar rows, Monday to Sunday. Sessions are placed by
 * their own date rather than by the week that lists them, so a session
 * the file lists under a neighbouring week still lands on its day.
 */
export function calendarWeeks(version: PlanVersion, runsByDay: Map<number, ActivitySummary[]>): CalendarWeek[] {
  const sessionsByDay = new Map<number, Session[]>()
  for (const s of version.weeks.flatMap((w) => w.sessions)) {
    const day = calendarDayOfDate(s.date)
    sessionsByDay.set(day, [...(sessionsByDay.get(day) ?? []), s])
  }
  const weeks = [...version.weeks].sort((a, b) => calendarDayOfDate(a.start_date) - calendarDayOfDate(b.start_date))
  return weeks.map((week, i) => {
    const start = calendarDayOfDate(week.start_date)
    const span = [0, 1, 2, 3, 4, 5, 6].map((offset) => start + offset)
    if (!week.detailed) {
      return { number: i + 1, week, days: [], outlineRuns: span.flatMap((day) => runsByDay.get(day) ?? []) }
    }
    const days = span.map((day) => ({ day, sessions: sessionsByDay.get(day) ?? [], runs: runsByDay.get(day) ?? [] }))
    return { number: i + 1, week, days, outlineRuns: [] }
  })
}

/**
 * What a calendar cell says under a session's title: the first work
 * step's pace range, else that step's length, else the session's own
 * planned distance or duration, else nothing, as for a rest day.
 */
export function sessionTarget(session: Session): string | null {
  const work = session.steps.find((s) => s.role === 'work')
  if (work !== undefined) {
    const speed = work.speed ?? null
    if (speed !== null) return paceRange(speed)
    const amount = stepAmount(work.repeat, work.distance_m ?? null, work.duration_s ?? null)
    if (amount !== NO_VALUE) return amount
  }
  const planned = stepAmount(1, session.planned_distance_m ?? null, session.planned_duration_s ?? null)
  return planned === NO_VALUE ? null : planned
}
