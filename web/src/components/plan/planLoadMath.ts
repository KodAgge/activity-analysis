import type { components } from '../../api/schema'
import { calendarDayOfDate, calendarDayOfLocalDate, dateOfCalendarDay, dayMonthLabel, zoneOf } from '../../format'
import type { PlanDetail, PlanVersion } from './planMath'
import { shownVersion } from './planMath'

/**
 * The arithmetic behind the Plan view's TRIMP load, zone mix, ceiling and
 * outlook charts. Pure, like `planMath.ts`; runs are filed by their
 * `local_date`, which the API has already made a local calendar date.
 */

export type RunLoad = components['schemas']['RunLoad']
export { zoneOf }

/** The load and zone mix charts' line for a version written before plans carried zone minutes. */
export const PREDATES_HR_PLANNING = 'This version predates heart-rate planning.'

/** The load chart's line for a version with zone minutes but no `trimp_per_minute` stamp. */
export const PREDATES_PLANNED_TRIMP = 'This version predates planned TRIMP, so no planned load is drawn.'

/** The load chart's line when a week plans minutes in a zone the stamp has no TRIMP per minute for. */
export const UNFACTORED_ZONE =
  'A week planning minutes in a zone you have no recent TRIMP per minute for has no planned bar.'

/**
 * A week's planned TRIMP: its minutes in each zone times the athlete's
 * TRIMP per minute in that zone, `planned_trimp` in Python. Null when a
 * zone with minutes above 0 has no TRIMP per minute.
 */
export function plannedTrimp(minutes: readonly number[], perMinute: readonly (number | null)[]): number | null {
  let total = 0
  for (const [i, m] of minutes.entries()) {
    if (m > 0) {
      const p = perMinute[i] ?? null
      if (p === null) return null
      total += m * p
    }
  }
  return total
}

/** A week's planned TRIMP, or null without zone minutes or the version's stamp. */
function weekPlannedTrimp(plan: PlanVersion, week: PlanVersion['weeks'][number]): number | null {
  const perMinute = plan.provenance.trimp_per_minute
  if (week.planned_zone_minutes == null || perMinute == null) return null
  return plannedTrimp(week.planned_zone_minutes, perMinute)
}

/**
 * Why the weekly load chart draws fewer planned bars than the version has
 * weeks with zone minutes, or null when it draws them all.
 */
export function plannedLoadNote(plan: PlanVersion): string | null {
  const withMinutes = plan.weeks.filter((w) => w.planned_zone_minutes != null)
  if (withMinutes.length === 0) return PREDATES_HR_PLANNING
  if (plan.provenance.trimp_per_minute == null) return PREDATES_PLANNED_TRIMP
  if (withMinutes.some((w) => weekPlannedTrimp(plan, w) === null)) return UNFACTORED_ZONE
  return null
}

type Triple = [number, number, number]

/** Minutes in zones 1-2, 3 and 4-5. */
function mix(minutes: readonly number[]): Triple {
  const at = (i: number): number => minutes[i] ?? 0
  return [at(0) + at(1), at(2), at(3) + at(4)]
}

interface WeekRuns {
  start: string
  startDay: number
  runs: RunLoad[]
  begun: boolean
  week: PlanVersion['weeks'][number]
}

function filedByWeek(plan: PlanVersion, runs: RunLoad[], today: Date): WeekRuns[] {
  const todayDay = calendarDayOfLocalDate(today)
  return [...plan.weeks]
    .sort((a, b) => calendarDayOfDate(a.start_date) - calendarDayOfDate(b.start_date))
    .map((week) => {
      const startDay = calendarDayOfDate(week.start_date)
      return {
        start: week.start_date,
        startDay,
        week,
        begun: startDay <= todayDay,
        runs: runs.filter((r) => {
          const d = calendarDayOfDate(r.local_date)
          return d >= startDay && d < startDay + 7
        }),
      }
    })
}

/**
 * Planned against run TRIMP per plan week, as Python's `weekly_load` has
 * it. `planned` is null for a week without zone minutes, in a version
 * without the `trimp_per_minute` stamp, or with minutes in a zone the stamp
 * has no value for. `run` is null for a week that has not begun by `today`,
 * and for a begun week whose runs all lack heart rate, which is unknown
 * rather than effortless; a begun week without runs is 0.
 */
export function weeklyLoad(
  plan: PlanVersion,
  runs: RunLoad[],
  today: Date,
): { start: string; planned: number | null; run: number | null }[] {
  return filedByWeek(plan, runs, today).map(({ start, week, runs: rs, begun }) => {
    const loaded = rs.flatMap((r) => (r.trimp === null ? [] : [r.trimp]))
    const unknown = rs.length > 0 && loaded.length === 0
    return {
      start,
      planned: weekPlannedTrimp(plan, week),
      run: !begun || unknown ? null : loaded.reduce((sum, t) => sum + t, 0),
    }
  })
}

/**
 * Planned against run minutes per plan week, in zones 1-2, 3 and 4-5.
 * `run` is null for a week not begun and for a begun week whose runs all
 * lack estimated zones (no heart rate, or before the first threshold
 * estimate), and zeros for a begun week without runs. Python's
 * `weekly_load` has the same rule for its `zone_minutes`.
 */
export function weeklyZoneMix(
  plan: PlanVersion,
  runs: RunLoad[],
  today: Date,
): { start: string; planned: Triple | null; run: Triple | null }[] {
  return filedByWeek(plan, runs, today).map(({ start, week, runs: rs, begun }) => {
    const zoned = rs.filter((r) => r.zone_seconds.length > 0)
    let run: Triple | null = null
    if (begun && (rs.length === 0 || zoned.length > 0)) {
      const total = [0, 0, 0, 0, 0]
      for (const r of zoned) r.zone_seconds.forEach((s, i) => (total[i] = (total[i] ?? 0) + s / 60))
      run = mix(total)
    }
    return {
      start,
      planned: week.planned_zone_minutes == null ? null : mix(week.planned_zone_minutes),
      run,
    }
  })
}

/**
 * The share of a run's heart rate seconds at or under `ceilingBpm`, the
 * bpm the version wrote rather than any zone, or null for a run with no
 * histogram seconds.
 */
export function ceilingShare(run: RunLoad, ceilingBpm: number): number | null {
  let all = 0
  let under = 0
  run.hr_bpm.forEach((bpm, i) => {
    const s = run.hr_seconds[i] ?? 0
    all += s
    if (bpm <= ceilingBpm) under += s
  })
  return all === 0 ? null : under / all
}

/** An ISO date from a day number. */
function isoOfDay(day: number): string {
  return dateOfCalendarDay(day).toISOString().slice(0, 10)
}

/**
 * The expected VO2max outlook and the measured one. Expected: each week
 * of `version` (default the shown one) that carries a stamp, at its
 * Sunday, the last week at the race date. Measured: each version not
 * withdrawn or rejected that carries `estimate_vdot`, at its
 * `data_through`.
 */
export function outlookSeries(
  detail: PlanDetail,
  version?: PlanVersion,
): {
  expected: { date: string; vdot: number; garmin: number | null }[]
  measured: { date: string; vdot: number }[]
  targetVdot: number | null
} {
  const shown = version ?? shownVersion(detail, undefined)?.plan ?? null
  const weeks =
    shown === null
      ? []
      : [...shown.weeks].sort((a, b) => calendarDayOfDate(a.start_date) - calendarDayOfDate(b.start_date))
  const last = weeks.length - 1
  const expected = weeks.flatMap((w, i) => {
    if (w.expected_vdot == null || shown === null) return []
    const date = i === last ? shown.goal.race_date : isoOfDay(calendarDayOfDate(w.start_date) + 6)
    return [{ date, vdot: w.expected_vdot, garmin: w.expected_garmin_vo2max ?? null }]
  })
  const measured = detail.versions
    .filter((v) => v.status !== 'withdrawn' && v.status !== 'rejected')
    .sort((a, b) => a.number - b.number)
    .flatMap((v) => {
      const p = v.plan.provenance
      return p.estimate_vdot == null || p.data_through === null ? [] : [{ date: p.data_through, vdot: p.estimate_vdot }]
    })
  return { expected, measured, targetVdot: shown?.provenance.target_vdot ?? null }
}

type LoadWeek = components['schemas']['LoadWeek']
type LoadPoint = components['schemas']['LoadPoint']

/** How far before the plan's first week the fitness chart reaches: one fitness time constant. */
export const FITNESS_LEAD_DAYS = 42

/** One week of fitness, fatigue and form means, at the week's middle day. */
export interface FitnessWeek {
  day: number
  ctl: number
  atl: number
  form: number
}

/**
 * The day a week's means are drawn at: the middle of the days they average,
 * counted from its Monday. A full week's is its Thursday; a race week that
 * ends on race day, or the week still running, sits earlier.
 */
function weekMiddle(week: { week_start: string; days: number }): number {
  return calendarDayOfDate(week.week_start) + (week.days - 1) / 2
}

/**
 * The fitness chart's first day: `FITNESS_LEAD_DAYS` before the plan's
 * first week, or the expected series' first week when that is earlier. The
 * measured weeks are asked for from this day too, so every expected week
 * has its measured one beside it once run.
 */
export function fitnessFirstDay(plan: PlanVersion): number {
  const raceDay = calendarDayOfDate(plan.goal.race_date)
  const planFirst = Math.min(raceDay, ...plan.weeks.map((w) => calendarDayOfDate(w.start_date)))
  const firstWeek = plan.provenance.expected_load?.weeks[0]
  return Math.min(
    planFirst - FITNESS_LEAD_DAYS,
    firstWeek === undefined ? Infinity : calendarDayOfDate(firstWeek.week_start),
  )
}

/**
 * The fitness chart's series: the version's stamped `expected_load` weeks,
 * and the measured weekly means from `GET /api/training-load` that fall in
 * the chart's span, from `fitnessFirstDay` to the race. A measured week
 * whose days run past race day is left out: its mean holds days after the
 * race, which the expected race week does not. Nothing is computed here but
 * where to draw.
 */
export function fitnessSeries(
  plan: PlanVersion,
  measuredWeeks: readonly LoadWeek[],
): {
  expected: FitnessWeek[]
  measured: FitnessWeek[]
  start: LoadPoint | null
  raceMorning: LoadPoint | null
  bridgedFrom: string[]
  firstDay: number
  raceDay: number
} {
  const stamp = plan.provenance.expected_load ?? null
  const raceDay = calendarDayOfDate(plan.goal.race_date)
  const expected = (stamp?.weeks ?? []).map((w) => ({
    day: weekMiddle(w),
    ctl: w.ctl_mean,
    atl: w.atl_mean,
    form: w.form_mean,
  }))
  const firstDay = fitnessFirstDay(plan)
  const measured = measuredWeeks
    .filter((w) => {
      const start = calendarDayOfDate(w.week_start)
      return start >= firstDay && start + w.days - 1 <= raceDay
    })
    .map((w) => ({
      day: weekMiddle(w),
      ctl: w.ctl_mean,
      atl: w.atl_mean,
      form: w.form_mean,
    }))
    .sort((a, b) => a.day - b.day)
  return {
    expected,
    measured,
    start: stamp?.start ?? null,
    raceMorning: stamp?.race_morning ?? null,
    bridgedFrom: stamp?.bridged_from ?? [],
    firstDay,
    raceDay,
  }
}

/** A week's load as the week PDF and the copied text state it. */
export interface WeekLoadFigures {
  /** The stamped values at the end of the Sunday before the week, or null. */
  start: LoadPoint | null
  /** The stamped values at the end of the week's Sunday, or race morning in the race week, or null. */
  end: LoadPoint | null
  /** The day `start` is at, as `Sun 22 Nov`. */
  startLabel: string
  /** The day `end` is at: `Sun 29 Nov`, or `Race morning`. */
  endLabel: string
  /** Claude's note on running the week, or null. */
  note: string | null
}

/**
 * The week's stamped start and end and its note, read from the version.
 * Both points are null without an `expected_load` stamp, and on a stamp
 * written before weeks carried them.
 */
export function weekLoad(plan: PlanVersion, week: PlanVersion['weeks'][number]): WeekLoadFigures {
  const monday = calendarDayOfDate(week.start_date)
  const stamped = plan.provenance.expected_load?.weeks.find((w) => w.week_start === week.start_date)
  const raceDay = calendarDayOfDate(plan.goal.race_date)
  const raceWeek = raceDay >= monday && raceDay < monday + 7
  return {
    start: stamped?.start ?? null,
    end: stamped?.end ?? null,
    startLabel: `Sun ${dayMonthLabel(monday - 1)}`,
    endLabel: raceWeek ? 'Race morning' : `Sun ${dayMonthLabel(monday + 6)}`,
    note: week.load_note?.trim() || null,
  }
}
