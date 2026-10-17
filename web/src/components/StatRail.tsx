import { calendarDate, distanceMeasure, weeksMeasure } from '../format'
import { Stat, StatGroup } from './Stat'

/**
 * Own minimal shapes rather than the generated `Overview` schema types
 * directly, matching `VolumeBars.VolumePeriod` and `ZoneBar.ZoneBucket`:
 * this component only needs a handful of fields, and pinning its own shape
 * keeps it decoupled from schema fields it never reads.
 */
export interface StatRailWeek {
  distance_m: number
}

export interface StatRailStreak {
  current_weeks: number
  longest_weeks: number
  /** The Monday of the last week of the longest streak; null only when there is no streak at all. */
  longest_ended_week: string | null
}

export interface StatRailConsistency {
  weeks_considered: number
  weeks_with_a_run: number
}

export interface StatRailProps {
  /**
   * The dense weekly series, ascending by `period_start`, exactly as
   * `Overview.weeks` arrives - so the last entry is the current week and
   * the last four are the last four weeks. Never filtered: a current week
   * with no run yet is a real, countable 0, not a missing entry (see
   * docs/reference/api.md, "GET /api/overview").
   */
  weeks: StatRailWeek[]
  streak: StatRailStreak
  consistency: StatRailConsistency
}

/**
 * The five numbers that answer "what has my training looked like lately"
 * before any chart has to: this week's distance, the last four weeks',
 * the current and longest streaks, and consistency.
 *
 * The composition is the overview's (see `views/Overview.tsx`) and not this
 * component's to reorder. What *is* this component's is the shape they are drawn in: five
 * bare label-over-value pairs on the page rather than five boxes, laid out
 * as two full rows of two and one summary line.
 *
 * Three thirds on the first row, then two thirds and a third on the
 * second, which fills both rows exactly *on the same three columns*. Five
 * stats in a fixed three-wide grid leave a sixth cell empty, and both
 * round-1 critics read that as an empty quadrant rather than as a line of
 * text ending early; the halves that replaced it filled the row but did
 * not share the first row's columns, so "Consistency" started 65px from
 * "Last 4 weeks" and the block read as two grids stacked (round-3 critic).
 * Two thirds is also what the long caption needs: a third is about 111px,
 * which is narrower than "through 10 November 2025" and wraps it mid-date.
 * Which of the two carries the wide cell is decided by that - "30 weeks
 * through 10 November 2025" is the one that does not fit a third.
 *
 * The rows are homogeneous as well as full, which is what stops two cells
 * beside each other coming out different heights: the three on the first
 * row all carry a bare value, and the two on the second both carry a
 * qualifier. Every `Stat` reserves a caption line either way, so that
 * holds for a group whose rows are mixed too.
 *
 * Consistency is rendered as a count out of a count, never a percentage -
 * see `Overview.md.consistency` in `docs/reference/api.md`'s schema and
 * `docs/reference/math/consistency.md`: 48 of 52 is a fact, 92% is a
 * rounding of it that invites comparison against a target nobody set.
 */
export function StatRail({ weeks, streak, consistency }: StatRailProps) {
  const thisWeek = weeks.at(-1)
  const lastFourWeeks = weeks.slice(-4)
  const lastFourDistanceM = lastFourWeeks.reduce((sum, week) => sum + week.distance_m, 0)

  return (
    <StatGroup>
      <Stat label="This week" value={distanceMeasure(thisWeek?.distance_m ?? null)} />
      <Stat
        label="Last 4 weeks"
        value={distanceMeasure(lastFourWeeks.length > 0 ? lastFourDistanceM : null)}
      />
      <Stat label="Current streak" value={weeksMeasure(streak.current_weeks)} />
      <Stat
        label="Longest streak"
        share="two-thirds"
        value={weeksMeasure(streak.longest_weeks)}
        detail={
          streak.longest_ended_week === null
            ? undefined
            : `through ${calendarDate(streak.longest_ended_week)}`
        }
      />
      <Stat
        label="Consistency"
        value={`${consistency.weeks_with_a_run} of ${consistency.weeks_considered}`}
        detail="weeks with a run"
      />
    </StatGroup>
  )
}
