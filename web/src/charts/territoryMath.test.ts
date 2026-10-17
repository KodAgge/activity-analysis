import { describe, expect, it } from 'vitest'
import type { components } from '../api/schema'
import { areasMeetingBox, chosenRegion, growthSeries, regionClaimSpan, withAlpha } from './territoryMath'

type TerritoryRegion = components['schemas']['TerritoryRegion']
type TerritoryGrowthPoint = components['schemas']['TerritoryGrowthPoint']

function region(id: string): TerritoryRegion {
  return {
    region_id: id,
    name: id,
    locality: id,
    country: 'Sweden',
    area_m2: 1,
    part_count: 1,
    claim_count: 1,
    first_claim_utc: '2025-01-01T00:00:00Z',
    last_claim_utc: '2025-01-01T00:00:00Z',
    west: 0,
    south: 0,
    east: 1,
    north: 1,
  }
}

function point(start: string, offset: number | null, cumulative: number): TerritoryGrowthPoint {
  return {
    activity_id: start,
    start_time_utc: start,
    utc_offset_s: offset,
    name: null,
    region_id: 'r',
    enclosed_m2: cumulative,
    new_m2: cumulative,
    cumulative_m2: cumulative,
  }
}

describe('areasMeetingBox', () => {
  // A region whose box lies across two fetched areas, as the largest one on a real store does.
  const jonkoping = { west: 13.75, south: 57.65, east: 14.35, north: 57.8 }
  const west = { id: 'west', west: 13.7, south: 57.7, east: 14.0, north: 57.85 }
  const east = { id: 'east', west: 14.1, south: 57.62, east: 14.4, north: 57.76 }
  const lakeside = { id: 'lakeside', west: 14.55, south: 56.95, east: 14.72, north: 57.05 }

  it('keeps every area the box meets, in the manifest order, and none it does not', () => {
    expect(areasMeetingBox([lakeside, west, east], jonkoping).map((a) => a.id)).toEqual(['west', 'east'])
  })

  it('counts boxes that only touch at an edge', () => {
    const touching = { id: 't', west: 14.35, south: 57.4, east: 14.5, north: 57.65 }
    expect(areasMeetingBox([touching], jonkoping)).toHaveLength(1)
  })

  it('is empty with no areas fetched', () => {
    expect(areasMeetingBox([], jonkoping)).toEqual([])
  })
})

describe('chosenRegion', () => {
  const regions = [region('largest'), region('second')]

  it('picks the region the id names', () => {
    expect(chosenRegion(regions, 'second')?.region_id).toBe('second')
  })

  it('falls back to the first, the largest, for no id or an unknown one', () => {
    expect(chosenRegion(regions, undefined)?.region_id).toBe('largest')
    expect(chosenRegion(regions, 'retired-by-a-recompute')?.region_id).toBe('largest')
  })

  it('is undefined with no regions', () => {
    expect(chosenRegion([], 'x')).toBeUndefined()
  })
})

describe('growthSeries', () => {
  it('plots each run at its local wall clock with the total after it in km²', () => {
    // 2024-01-01T12:00Z is day 19723.5 in UTC; +2 h is 19723.5833...
    const series = growthSeries([
      point('2024-01-01T12:00:00Z', 7200, 250_000),
      point('2024-01-02T00:00:00Z', null, 1_500_000),
    ])
    expect(series.x[0]).toBeCloseTo(19723 + 14 / 24, 9)
    expect(series.x[1]).toBeCloseTo(19724, 9)
    expect(series.y).toEqual([0.25, 1.5])
  })

  it('holds an x that local time would move backwards, so the axis stays ascending and the total never dips', () => {
    // UTC order: A at 10:00Z in UTC-5 (05:00 local), then B at 11:00Z in
    // UTC+9 (20:00 local). Then C at 12:00Z in UTC-8, 04:00 local - before B.
    const series = growthSeries([
      point('2024-03-01T10:00:00Z', -5 * 3600, 1_000_000),
      point('2024-03-01T11:00:00Z', 9 * 3600, 2_000_000),
      point('2024-03-01T12:00:00Z', -8 * 3600, 3_000_000),
    ])
    const day = 19783
    expect(series.x[0]).toBeCloseTo(day + 5 / 24, 9)
    expect(series.x[1]).toBeCloseTo(day + 20 / 24, 9)
    expect(series.x[2]).toBeCloseTo(day + 20 / 24, 9)
    expect(series.y).toEqual([1, 2, 3])
  })

  it('is empty for no claims', () => {
    expect(growthSeries([])).toEqual({ x: [], y: [] })
  })
})

describe('withAlpha', () => {
  it('adds an alpha to a six-digit hex', () => {
    expect(withAlpha('#bd1f44', 0.12)).toBe('rgb(189 31 68 / 0.12)')
  })

  it('leaves anything else unchanged', () => {
    expect(withAlpha('rgb(1 2 3)', 0.5)).toBe('rgb(1 2 3)')
  })
})

describe('regionClaimSpan', () => {
  const growth = [
    { ...point('2024-01-01T12:00:00Z', 3600, 1), region_id: 'a' },
    { ...point('2024-02-01T12:00:00Z', 3600, 2), region_id: 'b' },
    { ...point('2024-03-01T12:00:00Z', 3600, 3), region_id: 'a' },
  ]

  it("is the region's own first and last claiming runs, offsets included", () => {
    const span = regionClaimSpan(growth, 'a')
    expect(span?.first.start_time_utc).toBe('2024-01-01T12:00:00Z')
    expect(span?.last.start_time_utc).toBe('2024-03-01T12:00:00Z')
    expect(span?.last.utc_offset_s).toBe(3600)
  })

  it('is null for a region with no run in the series', () => {
    expect(regionClaimSpan(growth, 'c')).toBeNull()
  })
})
