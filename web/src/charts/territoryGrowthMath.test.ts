import { describe, expect, it } from 'vitest'
import type { components } from '../api/schema'
import { LEAST_SHOWN_GAIN_M2, SPARK_HEIGHT, SPARK_WIDTH, growthSummary, sparkPath } from './territoryGrowthMath'

type TerritoryGrowthPoint = components['schemas']['TerritoryGrowthPoint']

function point(start: string, newM2: number, cumulative: number, offset: number | null = 3600): TerritoryGrowthPoint {
  return {
    activity_id: start,
    start_time_utc: start,
    utc_offset_s: offset,
    name: null,
    region_id: 'r',
    enclosed_m2: newM2,
    new_m2: newM2,
    cumulative_m2: cumulative,
  }
}

describe('growthSummary', () => {
  it('is null for no claims', () => {
    expect(growthSummary([])).toBeNull()
  })

  it("gains the last claim year's ground: the last total less the last total of an earlier year", () => {
    const summary = growthSummary([
      point('2024-03-01T08:00:00Z', 1_000_000, 1_000_000),
      point('2025-12-30T08:00:00Z', 2_000_000, 3_000_000),
      point('2026-02-01T08:00:00Z', 500_000, 3_500_000),
      point('2026-06-01T08:00:00Z', 1_500_000, 5_000_000),
    ])
    expect(summary?.year).toBe(2026)
    expect(summary?.yearGainM2).toBe(2_000_000)
    expect(summary?.first.start_time_utc).toBe('2024-03-01T08:00:00Z')
  })

  it('reads the year in the run’s own wall clock, not in UTC', () => {
    // 23:30 UTC on 31 December is 00:30 on 1 January an hour east.
    const summary = growthSummary([
      point('2025-06-01T08:00:00Z', 1_000_000, 1_000_000),
      point('2025-12-31T23:30:00Z', 2_000_000, 3_000_000, 3600),
    ])
    expect(summary?.year).toBe(2026)
    expect(summary?.yearGainM2).toBe(2_000_000)
  })

  it('has no year gain when every claim is in the one year, where it would restate the total', () => {
    const summary = growthSummary([
      point('2026-02-01T08:00:00Z', 500_000, 500_000),
      point('2026-06-01T08:00:00Z', 1_500_000, 2_000_000),
    ])
    expect(summary?.yearGainM2).toBeNull()
  })

  it('names as the latest gain the last run whose gain shows at two decimals of a km²', () => {
    const readable = point('2026-05-03T08:00:00Z', 500_000, 2_500_000)
    const summary = growthSummary([
      point('2026-02-01T08:00:00Z', 2_000_000, 2_000_000),
      readable,
      point('2026-05-05T08:00:00Z', LEAST_SHOWN_GAIN_M2 - 1, 2_504_999),
      point('2026-05-10T08:00:00Z', 0, 2_504_999),
    ])
    expect(summary?.latest).toBe(readable)
  })
})

describe('sparkPath', () => {
  it('steps after each run across the box, zero at the foot and the total at the top', () => {
    const path = sparkPath([
      point('2024-01-01T11:00:00Z', 1_000_000, 1_000_000),
      point('2024-01-03T11:00:00Z', 1_000_000, 2_000_000),
      point('2024-01-05T11:00:00Z', 2_000_000, 4_000_000),
    ])
    const w = SPARK_WIDTH
    const h = SPARK_HEIGHT
    expect(path).toBe(`M 0 ${String(h * 0.75)} H ${String(w / 2)} V ${String(h / 2)} H ${String(w)} V 0 H ${String(w)}`)
  })

  it('never steps back when a run’s local day is before the one before it', () => {
    const path = sparkPath([
      point('2024-01-01T11:00:00Z', 1_000_000, 1_000_000),
      // Later in UTC, earlier in its own wall clock.
      point('2024-01-01T12:00:00Z', 1_000_000, 2_000_000, -86_400),
      point('2024-01-03T11:00:00Z', 1_000_000, 3_000_000),
    ])
    const xs = [...path.matchAll(/H (\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]))
    expect(xs).toEqual([...xs].sort((a, b) => a - b))
  })
})
