import type { components } from '../api/schema'
import { localCalendarTime, squareKilometres } from '../format'

type TerritoryRegion = components['schemas']['TerritoryRegion']
type TerritoryGrowthPoint = components['schemas']['TerritoryGrowthPoint']

/** A box in degrees, the shape `GET /api/basemap` and `GET /api/territory` both give. */
export interface Box {
  west: number
  south: number
  east: number
  north: number
}

/**
 * Every fetched basemap area whose box meets `box`, in the manifest's order.
 *
 * A route needs one area that holds the whole trace (`routeMath.coveringArea`)
 * because it is drawn fixed and must never show a hole. A region is drawn
 * on a map the reader can pan, and its box is the box of ground claimed
 * over years of runs: on the real store the largest region's box is split
 * between two areas, so no single one covers it, and both are wanted.
 * Edges that merely touch count as meeting.
 */
export function areasMeetingBox<A extends Box>(areas: readonly A[], box: Box): A[] {
  return areas.filter(
    (area) => area.west <= box.east && area.east >= box.west && area.south <= box.north && area.north >= box.south,
  )
}

/** The region a view should show: the one named by `regionId`, else the largest, else none. */
export function chosenRegion(
  regions: readonly TerritoryRegion[],
  regionId: string | undefined,
): TerritoryRegion | undefined {
  // The endpoint orders regions largest first, so the first is the default.
  return regions.find((region) => region.region_id === regionId) ?? regions[0]
}

/** The growth series as the chart plots it. */
export interface GrowthSeries {
  /** Each claiming run's local wall clock as a fractional day, `format.localCalendarTime`. */
  x: number[]
  /** The claimed ground after that run, in km². */
  y: number[]
}

/**
 * One point per claiming run, in the endpoint's order, at the run's own
 * local wall clock, carrying the total after it.
 *
 * The x is the run's local time rather than its UTC instant, as on every
 * over-time chart here, so a run lands on the day the athlete saw. The
 * order stays the endpoint's, start time in UTC, because that is the
 * order the union was accumulated in and so the only order in which
 * `cumulative_m2` never falls. Two runs recorded in different offsets can
 * swap between UTC and local time, and uPlot needs x ascending, so an x
 * that would step backwards is held at the one before it: that run is
 * drawn late by at most the difference between the two offsets, hours,
 * and the total never dips.
 */
export function growthSeries(growth: readonly TerritoryGrowthPoint[]): GrowthSeries {
  const x: number[] = []
  const y: number[] = []
  for (const point of growth) {
    const local = localCalendarTime(point.start_time_utc, point.utc_offset_s)
    const previous = x.at(-1)
    x.push(previous === undefined ? local : Math.max(previous, local))
    y.push(squareKilometres(point.cumulative_m2))
  }
  return { x, y }
}

/**
 * `#rrggbb` at an alpha, as `rgb(r g b / a)`: a canvas fill takes a colour
 * rather than a CSS expression, so `color-mix` over a token is not available
 * to uPlot. The colour is still the token's - this only adds transparency.
 * Anything that is not a six-digit hex is returned unchanged.
 */
export function withAlpha(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (match === null) return hex
  const [r, g, b] = [match[1], match[2], match[3]].map((h) => parseInt(h ?? '0', 16))
  return `rgb(${String(r)} ${String(g)} ${String(b)} / ${String(alpha)})`
}

/**
 * A region's first and last claiming runs, read from the growth series
 * because its points carry each run's own offset and the region row does
 * not: `first_claim_utc` alone would put the day in UTC, which a run near
 * local midnight gets wrong.
 */
export function regionClaimSpan(
  growth: readonly TerritoryGrowthPoint[],
  regionId: string,
): { first: TerritoryGrowthPoint; last: TerritoryGrowthPoint } | null {
  const own = growth.filter((point) => point.region_id === regionId)
  const first = own[0]
  const last = own.at(-1)
  return first === undefined || last === undefined ? null : { first, last }
}
