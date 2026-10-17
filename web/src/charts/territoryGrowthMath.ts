import type { components } from '../api/schema'
import { dateOfCalendarDay, localCalendarDay } from '../format'

type TerritoryGrowthPoint = components['schemas']['TerritoryGrowthPoint']

/**
 * The smallest gain the line under the total names as the latest: half the
 * last digit `format.area` prints, 0.01 km², so it never reads `0.00 km²`.
 * On the real store the last claiming run added too little to print, and
 * the run that last moved the total by a readable amount is the one
 * before it.
 */
export const LEAST_SHOWN_GAIN_M2 = 5_000

/** How the total grew, read off the growth series. */
export interface GrowthSummary {
  /** The first claiming run. */
  first: TerritoryGrowthPoint
  /** The last run that added ground the readout can show, `new_m2` of at least `LEAST_SHOWN_GAIN_M2`. */
  latest: TerritoryGrowthPoint
  /** The local calendar year of the last claiming run. */
  year: number
  /**
   * The ground claimed in `year`, in m²: the total after the last run less
   * the total after the last run of an earlier year. Null when every claim
   * is in `year`, where it would only restate the total.
   */
  yearGainM2: number | null
}

/**
 * The growth series summarised for the line under the total, or null for
 * an empty one.
 *
 * Nothing is computed that the series does not already hold: the year's
 * gain is the difference of two stored totals, `cumulative_m2` after the
 * last run and after the last run before the year, and the latest gain is
 * a stored `new_m2`. The year is the last claim's own, in its local wall
 * clock, rather than today's: a store last fed in December would
 * otherwise report an empty January.
 */
export function growthSummary(growth: readonly TerritoryGrowthPoint[]): GrowthSummary | null {
  const first = growth[0]
  const last = growth.at(-1)
  if (first === undefined || last === undefined) return null
  const year = localYear(last)
  const before = growth.findLast((point) => localYear(point) < year)
  const latest = growth.findLast((point) => point.new_m2 >= LEAST_SHOWN_GAIN_M2) ?? last
  return {
    first,
    latest,
    year,
    yearGainM2: before === undefined ? null : last.cumulative_m2 - before.cumulative_m2,
  }
}

function localYear(point: TerritoryGrowthPoint): number {
  return dateOfCalendarDay(localCalendarDay(point.start_time_utc, point.utc_offset_s)).getUTCFullYear()
}

/** The spark's drawing box, in its own units; the SVG stretches it to the room it gets. */
export const SPARK_WIDTH = 100
export const SPARK_HEIGHT = 40

/** The step-after path of the cumulative total, in the spark's box. */
export function sparkPath(growth: readonly TerritoryGrowthPoint[]): string {
  const days = growth.map((point) => localCalendarDay(point.start_time_utc, point.utc_offset_s))
  const firstDay = days[0] ?? 0
  const span = Math.max((days.at(-1) ?? firstDay) - firstDay, 1)
  const top = Math.max(...growth.map((point) => point.cumulative_m2), 1)
  const x = (day: number) => round(((Math.max(day, firstDay) - firstDay) / span) * SPARK_WIDTH)
  const y = (m2: number) => round(SPARK_HEIGHT - (m2 / top) * SPARK_HEIGHT)
  let d = ''
  let previousX = 0
  growth.forEach((point, i) => {
    // Held, never stepping back, for the reason `territoryMath.growthSeries` gives.
    const px = Math.max(x(days[i] ?? firstDay), previousX)
    d += i === 0 ? `M ${String(px)} ${String(y(point.cumulative_m2))}` : ` H ${String(px)} V ${String(y(point.cumulative_m2))}`
    previousX = px
  })
  return `${d} H ${String(SPARK_WIDTH)}`
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
