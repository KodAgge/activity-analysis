import type { components } from '../api/schema'
import { calendarDayOfDate, perDayAsWeekly } from '../format'
import { axisScale, type AxisScale } from './trendChartMath'
import { volumeScale } from './volumeBarsMath'

/**
 * The arithmetic behind the Trends view's training load section, kept out
 * of `TrainingLoadChart.tsx` for the reason every chart's math is: a pure
 * module is testable with a synthetic payload and a known answer.
 *
 * Nothing here computes a load. TRIMP, fitness, fatigue, form and the
 * 7-day distance are stored columns of `training_load` and its weekly
 * table, served by `GET /api/training-load`; this places them on one
 * calendar axis, picks a week, and solves the ladders they are read on.
 */

type LoadDay = components['schemas']['LoadDay']
type LoadWeek = components['schemas']['LoadWeek']

/**
 * Half a week in days: a week's middle from its Monday, Thursday's middle,
 * where its bar and its weekly means sit, and half the slot its bar is
 * centred in.
 */
export const HALF_WEEK_DAYS = 3.5

/** A day's middle, where its 7-day distance sits, so a week's middle and its Thursday share one x. */
const DAY_MIDDLE = 0.5

/** Days in a week, for the axis's end and for finding the week a day falls in. */
const WEEK_DAYS = 7

/** How many intervals the short form panel's ladder may be cut into. */
const FORM_MAX_INTERVALS = 2

/**
 * Every series of the chart on one shared x: the day number of each day's
 * middle, and each week at its Thursday's middle, ascending.
 *
 * A weekly series is `undefined` on the days between its weeks, which uPlot
 * draws a line through, and a value only where its week sits; the 7-day
 * distance is daily and `undefined` only where a week sits outside the days
 * sent.
 */
export interface LoadPlot {
  x: number[]
  /** The week's summed TRIMP, drawn as a bar. */
  trimp: (number | undefined)[]
  /** The week's mean fitness (CTL), per day times seven. */
  fitness: (number | undefined)[]
  /** The week's mean fatigue (ATL), per day times seven. */
  fatigue: (number | undefined)[]
  /** The running distance over the 7 days ending that day, in metres. */
  distance: (number | undefined)[]
  /** The week's mean form, per day, as stored. */
  form: (number | undefined)[]
}

/**
 * Whether any week or day carries TRIMP: a rest week is zero, and a store
 * whose runs have no heart rate is zero throughout. The days are read too,
 * because a period shorter than a week that starts after a Monday holds
 * days and no week.
 */
export function weighsAnyRun(weeks: readonly LoadWeek[], days: readonly LoadDay[]): boolean {
  return weeks.some((w) => w.trimp > 0) || days.some((d) => d.trimp > 0)
}

/**
 * The latest week all seven of whose days are in the series and, given the
 * period's last day, inside the period, which is what the section's three
 * figures read. The current week is not over and its means are of the days
 * so far, the first week of a history can start mid-week, and the endpoint
 * serves a week by its Monday, so a week starting inside a period can end
 * past it. Picked by date, not by position: nothing in the payload's
 * contract promises an order.
 */
export function latestCompleteWeek(weeks: readonly LoadWeek[], lastDay?: string): LoadWeek | undefined {
  const last = lastDay === undefined ? Number.POSITIVE_INFINITY : calendarDayOfDate(lastDay)
  let best: LoadWeek | undefined
  for (const w of weeks) {
    if (w.days !== WEEK_DAYS) continue
    if (calendarDayOfDate(w.week_start) + WEEK_DAYS - 1 > last) continue
    if (best === undefined || w.week_start > best.week_start) best = w
  }
  return best
}

/** The chart's series on one x, see `LoadPlot`. */
export function loadPlot(days: readonly LoadDay[], weeks: readonly LoadWeek[]): LoadPlot {
  const byX = new Map<number, { day?: LoadDay; week?: LoadWeek }>()
  for (const d of days) {
    const x = calendarDayOfDate(d.local_date) + DAY_MIDDLE
    byX.set(x, { ...byX.get(x), day: d })
  }
  for (const w of weeks) {
    const x = calendarDayOfDate(w.week_start) + HALF_WEEK_DAYS
    byX.set(x, { ...byX.get(x), week: w })
  }
  const x = [...byX.keys()].sort((a, b) => a - b)
  const at = x.map((key) => byX.get(key) ?? {})
  return {
    x,
    trimp: at.map((p) => p.week?.trimp),
    fitness: at.map((p) => (p.week === undefined ? undefined : perDayAsWeekly(p.week.ctl_mean))),
    fatigue: at.map((p) => (p.week === undefined ? undefined : perDayAsWeekly(p.week.atl_mean))),
    distance: at.map((p) => p.day?.distance_7d_m),
    form: at.map((p) => p.week?.form_mean),
  }
}

/**
 * The x axis's bounds in day numbers: the first Monday or day, whichever is
 * earlier, to the end of the last week or day, so the first and last bars
 * are whole rather than cut at their middles.
 */
export function loadXRange(days: readonly LoadDay[], weeks: readonly LoadWeek[]): [number, number] {
  const starts = [...days.map((d) => calendarDayOfDate(d.local_date)), ...weeks.map((w) => calendarDayOfDate(w.week_start))]
  const ends = [
    ...days.map((d) => calendarDayOfDate(d.local_date) + 1),
    ...weeks.map((w) => calendarDayOfDate(w.week_start) + WEEK_DAYS),
  ]
  if (starts.length === 0) return [0, 1]
  return [Math.min(...starts), Math.max(...ends)]
}

/** The three ladders the chart is read on. */
export interface LoadScales {
  /** TRIMP per week, the bars and fitness and fatigue times seven. From zero. */
  load: AxisScale
  /** The 7-day distance in metres, on the right. From zero. */
  distance: AxisScale
  /** Form per day, in the panel below. Always holds zero, its line's reference. */
  form: AxisScale
}

function largest(values: readonly (number | undefined)[]): number {
  return Math.max(0, ...values.filter((v): v is number => v !== undefined && Number.isFinite(v)))
}

function fromZero(maxValue: number): AxisScale {
  const scale = volumeScale(maxValue)
  return { min: 0, max: scale.max, splits: scale.splits }
}

/**
 * The ladders, solved from what each one carries.
 *
 * **The load and distance ladders share one grid.** Both are
 * `volumeScale`'s three rungs from zero, the Overview's own weekly distance
 * ladder, so both put a rung at zero, at their middle and at their top:
 * on one plot height those land on the same three rules, and each rule
 * carries a TRIMP on the left and a distance on the right rather than the
 * plot carrying two grids.
 *
 * Form is not zero-anchored, since it goes negative, but its ladder always
 * holds zero, where the panel's zero line is drawn.
 */
export function loadScales(plot: LoadPlot): LoadScales {
  const forms = plot.form.filter((v): v is number => v !== undefined && Number.isFinite(v))
  const formLow = Math.min(0, ...forms)
  const formHigh = Math.max(0, ...forms)
  return {
    load: fromZero(Math.max(largest(plot.trimp), largest(plot.fitness), largest(plot.fatigue))),
    distance: fromZero(largest(plot.distance)),
    form: axisScale(formLow, formHigh, FORM_MAX_INTERVALS),
  }
}

/** What the hover readout names at one x: the week it falls in and that day's row, either possibly absent. */
export interface LoadReading {
  dayNumber: number
  week: LoadWeek | undefined
  /**
   * True when `week` holds `today` and is short of seven days: the week in
   * progress. A short last week that ended before today is where the stored
   * series stops, the last run's week, and is complete.
   */
  weekInProgress: boolean
  day: LoadDay | undefined
}

/**
 * The week and the day under `x`, a day number of the chart's own axis.
 * `today` is the local calendar date, `YYYY-MM-DD`.
 */
export function readingAt(
  days: readonly LoadDay[],
  weeks: readonly LoadWeek[],
  x: number,
  today: string,
): LoadReading {
  const dayNumber = Math.floor(x)
  const holds = (w: LoadWeek, n: number) => {
    const start = calendarDayOfDate(w.week_start)
    return n >= start && n < start + WEEK_DAYS
  }
  const week = weeks.find((w) => holds(w, dayNumber))
  const day = days.find((d) => calendarDayOfDate(d.local_date) === dayNumber)
  const weekInProgress = week !== undefined && week.days < WEEK_DAYS && holds(week, calendarDayOfDate(today))
  return { dayNumber, week, weekInProgress, day }
}
