import { isoDateOfDay } from '../components/plan/planMath'
import type { ActivitySummary, PlanVersion, Session, SpeedRange, Week } from '../components/plan/planMath'
import { calendarDayOfDate, localCalendarDay, phaseLabel } from '../format'
import { DEFAULT_EASY_MPS, planEasySpeed, stepSpeed } from './sessionProfileMath'

/**
 * The shape of a plan as the Plan view's four overview charts draw it -
 * `PlanPhases`, `PlanIntensity`, `PlanPaces` and `PlanLeadIn` - kept apart
 * from them for the reason `planChartMath.ts` is: pure, testable without
 * rendering, and a file mixing components with plain functions cannot be
 * Fast-Refreshed.
 *
 * Dates are day numbers from `format.calendarDayOfDate`, the athlete's own
 * calendar, and a run is filed by `format.localCalendarDay`, never by a
 * `Date` in the machine's timezone. Lengths named `*Px` are CSS pixels, as
 * in `planChartMath.ts`.
 */

const DAYS_PER_WEEK = 7

/** One phase of the plan: adjacent weeks with the same phase, as one band. */
export interface PhaseBand {
  /** As `format.phaseLabel` reads it, so `build` and `Build` are one phase. */
  phase: string
  startDay: number
  /** The day after the band's last week ends: exclusive. */
  endDay: number
  /** 1-based week numbers, as the calendar counts them. */
  firstWeek: number
  lastWeek: number
}

function byStart(weeks: Week[]): Week[] {
  return [...weeks].sort((a, b) => calendarDayOfDate(a.start_date) - calendarDayOfDate(b.start_date))
}

/**
 * The plan's phases in date order, each run of adjacent weeks with one
 * phase merged into one band. A phase that comes back after another, base
 * then build then base, is two bands, since the reader sees two stretches.
 */
export function phaseBands(weeks: Week[]): PhaseBand[] {
  const bands: PhaseBand[] = []
  byStart(weeks).forEach((w, i) => {
    const phase = phaseLabel(w.phase)
    const start = calendarDayOfDate(w.start_date)
    const last = bands[bands.length - 1]
    if (last !== undefined && last.phase === phase) {
      last.endDay = start + DAYS_PER_WEEK
      last.lastWeek = i + 1
      return
    }
    bands.push({ phase, startDay: start, endDay: start + DAYS_PER_WEEK, firstWeek: i + 1, lastWeek: i + 1 })
  })
  return bands
}

/**
 * The plan's span in day numbers, `[start, end)`: its first Monday to the
 * day after its last week, or after the race when a hand-edited file puts
 * the race past the weeks. A version with no weeks spans its race day.
 */
export function planDays(version: PlanVersion): [number, number] {
  const race = calendarDayOfDate(version.goal.race_date)
  if (version.weeks.length === 0) return [race, race + 1]
  const starts = version.weeks.map((w) => calendarDayOfDate(w.start_date))
  return [Math.min(...starts), Math.max(Math.max(...starts) + DAYS_PER_WEEK, race + 1)]
}

/** Today's day number when it falls inside `[start, end)`, else null: a marker off the strip says nothing. */
export function todayInPlan(today: number, [start, end]: [number, number]): number | null {
  return today >= start && today < end ? today : null
}

type Step = Session['steps'][number]

/**
 * How far a step of a session goes, in metres: its distance times its
 * repeats, or for a timed step its duration times its repeats times the
 * speed the workout profile draws it at, `sessionProfileMath.stepSpeed`:
 * the middle of its speed range, else its role's speed, so a tempo's
 * 20 minutes held by heart rate alone still count. `easyMps` is the plan's
 * easy speed, `planEasySpeed`. A step with neither counts nothing.
 */
export function stepDistance(session: Session, step: Step, easyMps: number | null): number {
  const distance = step.distance_m ?? null
  if (distance !== null) return distance * step.repeat
  const duration = step.duration_s ?? null
  if (duration !== null) return duration * step.repeat * stepSpeed(session, step, easyMps)
  return 0
}

/** Planned distance of one session or week, by intensity. */
export interface Mix {
  easyM: number
  qualityM: number
  raceM: number
}

const QUALITY_KINDS: ReadonlySet<string> = new Set(['intervals', 'tempo', 'threshold'])
const RACE_KINDS: ReadonlySet<string> = new Set(['time_trial', 'race'])
const NOT_RUNNING: ReadonlySet<string> = new Set(['rest', 'cross_training'])

/**
 * A session's planned distance split by intensity. The work steps of an
 * intervals, tempo or threshold session are quality, those of a time
 * trial or race are race, and everything else - an easy, long or strides
 * session whole, and every warm-up, recovery and cool-down - is easy.
 * What of the planned extent the steps do not cover counts as easy: the
 * session's `planned_distance_m`, else its `planned_duration_s` at the
 * plan's easy speed, else `DEFAULT_EASY_MPS`. When
 * the steps run past it, nothing is taken away. Rest and cross-training
 * are not running and count nothing. `easyMps` is as `stepDistance` takes it.
 */
export function sessionMix(session: Session, easyMps: number | null): Mix {
  const mix: Mix = { easyM: 0, qualityM: 0, raceM: 0 }
  if (NOT_RUNNING.has(session.kind)) return mix
  let covered = 0
  for (const step of session.steps) {
    const metres = stepDistance(session, step, easyMps)
    covered += metres
    if (step.role === 'work' && QUALITY_KINDS.has(session.kind)) mix.qualityM += metres
    else if (step.role === 'work' && RACE_KINDS.has(session.kind)) mix.raceM += metres
    else mix.easyM += metres
  }
  const plannedM = session.planned_distance_m ?? (session.planned_duration_s ?? 0) * (easyMps ?? DEFAULT_EASY_MPS)
  mix.easyM += Math.max(0, plannedM - covered)
  return mix
}

/** One plan week as the intensity chart stacks it. */
export interface MixWeek extends Mix {
  startDate: string
  /** An outline week's planned distance, drawn as not yet detailed; null for a detailed week. */
  outlineM: number | null
}

/**
 * Each plan week's planned distance by intensity, in date order: a
 * detailed week the sum of its sessions' `sessionMix`, an outline week its
 * `planned_distance_m` alone, since it has no sessions to split.
 */
export function weeklyMix(version: PlanVersion): MixWeek[] {
  const easyMps = planEasySpeed(version)
  return byStart(version.weeks).map((w) => {
    if (!w.detailed) return { startDate: w.start_date, easyM: 0, qualityM: 0, raceM: 0, outlineM: w.planned_distance_m }
    const sum: Mix = { easyM: 0, qualityM: 0, raceM: 0 }
    for (const s of w.sessions) {
      const m = sessionMix(s, easyMps)
      sum.easyM += m.easyM
      sum.qualityM += m.qualityM
      sum.raceM += m.raceM
    }
    return { startDate: w.start_date, ...sum, outlineM: null }
  })
}

/** One target pace range of a quality, trial or race session's work step. */
export interface PaceMark {
  sessionId: string
  kind: Session['kind']
  day: number
  speed: SpeedRange
  /** The range's faster end, in seconds per kilometre. */
  fastS: number
  slowS: number
  /** Its place among the day's marks, and how many the day has: they stand side by side. */
  index: number
  count: number
}

const SECONDS_PER_KM_AT_1_MPS = 1000

/**
 * Every work step with a speed in the detailed quality, trial and race
 * sessions, in date order, each a range from its slower to its faster
 * pace. An outline week has no sessions, so it gives none.
 */
export function paceMarks(version: PlanVersion): PaceMark[] {
  const sessions = byStart(version.weeks)
    .filter((w) => w.detailed)
    .flatMap((w) => w.sessions)
    .filter((s) => QUALITY_KINDS.has(s.kind) || RACE_KINDS.has(s.kind))
    .map((s, i) => ({ s, i, day: calendarDayOfDate(s.date) }))
    .sort((a, b) => a.day - b.day || a.i - b.i)
  const marks: PaceMark[] = []
  for (const { s, day } of sessions) {
    for (const step of s.steps) {
      const speed = step.speed ?? null
      if (step.role !== 'work' || speed === null) continue
      marks.push({
        sessionId: s.id,
        kind: s.kind,
        day,
        speed,
        fastS: SECONDS_PER_KM_AT_1_MPS / speed.high_mps,
        slowS: SECONDS_PER_KM_AT_1_MPS / speed.low_mps,
        index: 0,
        count: 0,
      })
    }
  }
  const perDay = new Map<number, number>()
  for (const m of marks) {
    m.index = perDay.get(m.day) ?? 0
    perDay.set(m.day, m.index + 1)
  }
  for (const m of marks) m.count = perDay.get(m.day) ?? 1
  return marks
}

/**
 * The easy range the plan asks for, in seconds per kilometre: the fastest
 * and the slowest end of every work step with a speed in its `easy`
 * sessions. Only `easy`: a long run's faster finish or a warm-up would
 * stretch the band past what easy means. Null when no easy session says.
 */
export function easyBand(version: PlanVersion): { fastS: number; slowS: number } | null {
  const ranges = version.weeks
    .flatMap((w) => w.sessions)
    .filter((s) => s.kind === 'easy')
    .flatMap((s) => s.steps)
    .flatMap((step) => (step.role === 'work' && step.speed != null ? [step.speed] : []))
  if (ranges.length === 0) return null
  return {
    fastS: Math.min(...ranges.map((r) => SECONDS_PER_KM_AT_1_MPS / r.high_mps)),
    slowS: Math.max(...ranges.map((r) => SECONDS_PER_KM_AT_1_MPS / r.low_mps)),
  }
}

/** The goal's pace in seconds per kilometre: its target time over its distance. */
export function goalPaceS(goal: { distance_m: number; target_time_s: number }): number {
  return (goal.target_time_s / goal.distance_m) * 1000
}

/** The widest a bar draws, as `planChartMath`'s weekly distance bars. */
const MAX_BAR_PX = 32

/** Where one week's single bar stands. */
export interface BarSlot {
  centre: number
  x: number
  width: number
}

/** One slot per week across `[left, right]`, a bar of at most half its slot centred in it. */
export function barSlots(count: number, left: number, right: number): BarSlot[] {
  const slot = (right - left) / Math.max(count, 1)
  const width = Math.min(MAX_BAR_PX, slot / 2)
  return Array.from({ length: count }, (_, i) => {
    const centre = left + slot * (i + 0.5)
    return { centre, x: centre - width / 2, width }
  })
}

/** The offset of the `index`th of `count` marks `width` wide and `gap` apart, centred on their day. */
export function sideBySide(count: number, index: number, width: number, gap: number): number {
  return (index - (count - 1) / 2) * (width + gap)
}

/** How many weeks before the plan the lead-in chart covers. */
export const LEAD_IN_WEEKS = 8

/**
 * The span the lead-in chart asks `/api/activities` for: the
 * `LEAD_IN_WEEKS` Monday weeks before the plan's first week, with `to` the
 * first week's Monday since the endpoint's `to` is exclusive. Null for a
 * version with no weeks.
 */
export function leadInSpan(version: PlanVersion): { from: string; to: string; startDay: number } | null {
  if (version.weeks.length === 0) return null
  const first = Math.min(...version.weeks.map((w) => calendarDayOfDate(w.start_date)))
  const startDay = first - LEAD_IN_WEEKS * DAYS_PER_WEEK
  return { from: isoDateOfDay(startDay), to: isoDateOfDay(first), startDay }
}

/** What a run before the plan was, from the app's tags, on the calendar's palette. */
export type RunCategory = 'easy' | 'long' | 'intervals' | 'all_out' | 'unclassified'

/** Every category in stacking order, bottom first. */
export const RUN_CATEGORIES: readonly RunCategory[] = ['easy', 'long', 'intervals', 'all_out', 'unclassified']

/**
 * A run's category from its tags, the first of: a long run, all-out,
 * intervals, then steady or easy. Long first because a long run is the
 * week's anchor whatever its effort; a run with no effort tag, as one
 * without heart rate has, is unclassified.
 */
export function runCategory(tags: readonly string[]): RunCategory {
  if (tags.includes('long_run')) return 'long'
  if (tags.includes('all_out')) return 'all_out'
  if (tags.includes('intervals')) return 'intervals'
  if (tags.includes('steady') || tags.includes('easy')) return 'easy'
  return 'unclassified'
}

/** A run that set a record, as the lead-in chart marks its week. */
export interface RecordRun {
  activityId: string
  distanceM: number | null
  distanceKeys: string[]
}

/** One week before the plan. */
export interface LeadInWeek {
  startDay: number
  byCategory: Record<RunCategory, number>
  totalM: number
  runCount: number
  /** The intervals and all-out runs. */
  qualityCount: number
  longestM: number | null
  /** The week's runs that set a record, in start order. */
  records: RecordRun[]
}

function emptyCategories(): Record<RunCategory, number> {
  return { easy: 0, long: 0, intervals: 0, all_out: 0, unclassified: 0 }
}

/**
 * The `LEAD_IN_WEEKS` weeks from `startDay`, every run filed under the
 * week of its local calendar day. A week with no run is kept, empty, since
 * a week off is part of what the chart shows. A run outside the weeks is
 * left out. Each run's category is `runCategory` of its `effort_tags`,
 * the analysis layer's tags as the list endpoint serves them. A record is a
 * run with `pr_distance_keys`, the list endpoint's form of the `pr` tag.
 */
export function leadInWeeks(runs: ActivitySummary[], startDay: number): LeadInWeek[] {
  const weeks: LeadInWeek[] = Array.from({ length: LEAD_IN_WEEKS }, (_, i) => ({
    startDay: startDay + i * DAYS_PER_WEEK,
    byCategory: emptyCategories(),
    totalM: 0,
    runCount: 0,
    qualityCount: 0,
    longestM: null,
    records: [],
  }))
  const sorted = [...runs].sort((a, b) => Date.parse(a.start_time_utc) - Date.parse(b.start_time_utc))
  for (const r of sorted) {
    const index = Math.floor((localCalendarDay(r.start_time_utc, r.utc_offset_s) - startDay) / DAYS_PER_WEEK)
    const week = weeks[index]
    if (week === undefined) continue
    const metres = r.distance_m ?? 0
    const category = runCategory(r.effort_tags)
    week.byCategory[category] += metres
    week.totalM += metres
    week.runCount += 1
    if (category === 'intervals' || category === 'all_out') week.qualityCount += 1
    if (r.distance_m !== null) week.longestM = Math.max(week.longestM ?? 0, r.distance_m)
    if (r.pr_distance_keys.length > 0) {
      week.records.push({ activityId: r.activity_id, distanceM: r.distance_m, distanceKeys: r.pr_distance_keys })
    }
  }
  return weeks
}

/** The lead-in's one summary line, as numbers. */
export interface LeadInSummary {
  avgWeeklyM: number
  runsPerWeek: number
  longestM: number | null
  qualityCount: number
}

/** Averages over every one of the weeks, the empty ones included, since a week off lowers the average. */
export function leadInSummary(weeks: LeadInWeek[]): LeadInSummary {
  const n = Math.max(weeks.length, 1)
  const longest = weeks.flatMap((w) => (w.longestM === null ? [] : [w.longestM]))
  return {
    avgWeeklyM: weeks.reduce((sum, w) => sum + w.totalM, 0) / n,
    runsPerWeek: weeks.reduce((sum, w) => sum + w.runCount, 0) / n,
    longestM: longest.length === 0 ? null : Math.max(...longest),
    qualityCount: weeks.reduce((sum, w) => sum + w.qualityCount, 0),
  }
}
