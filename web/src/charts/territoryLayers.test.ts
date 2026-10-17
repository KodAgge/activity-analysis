import type { StyleSpecification } from 'maplibre-gl'
import { describe, expect, it } from 'vitest'
import type { components } from '../api/schema'
import { buildAreasStyle } from './basemapStyle'
import {
  UNDERLAY_MAXZOOMS,
  boxCentre,
  claimCore,
  placeMarks,
  ringContains,
  territoryAnchors,
  tilesMeetingBox,
  unclaimedGround,
  withCoarseUnderlay,
} from './territoryLayers'

type TerritoryFeatureCollection = components['schemas']['TerritoryFeatureCollection']

/** A closed square ring, anticlockwise, from its south-west corner and side. */
function square(west: number, south: number, side: number): number[][] {
  return [
    [west, south],
    [west + side, south],
    [west + side, south + side],
    [west, south + side],
    [west, south],
  ]
}

function collection(...geometries: TerritoryFeatureCollection['features'][number]['geometry'][]): TerritoryFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: geometries.map((geometry, index) => ({
      type: 'Feature',
      properties: { region_id: 'r', part_index: index, area_m2: 1 },
      geometry,
    })),
  }
}

describe('unclaimedGround', () => {
  it('is the world with each part cut out', () => {
    const a = square(0, 0, 1)
    const b = square(5, 5, 1)
    const ground = unclaimedGround(collection({ type: 'Polygon', coordinates: [a] }, { type: 'Polygon', coordinates: [b] }))
    expect(ground.geometry.coordinates).toHaveLength(1)
    const [world, ...cuts] = ground.geometry.coordinates[0] ?? []
    expect(world?.[0]).toEqual([-180, -85.06])
    expect(cuts).toEqual([a, b])
  })

  it('puts a part’s unclaimed hole back, and cuts an island in it from the hole alone', () => {
    const outer = square(0, 0, 10)
    const hole = square(2, 2, 6)
    const island = square(4, 4, 2)
    const ground = unclaimedGround(
      collection({ type: 'Polygon', coordinates: [outer, hole] }, { type: 'Polygon', coordinates: [island] }),
    )
    expect(ground.geometry.coordinates).toEqual([[ground.geometry.coordinates[0]?.[0], outer], [hole, island]])
  })

  it('reads every polygon of a MultiPolygon part', () => {
    const a = square(0, 0, 1)
    const b = square(3, 0, 1)
    const ground = unclaimedGround(collection({ type: 'MultiPolygon', coordinates: [[a], [b]] }))
    expect(ground.geometry.coordinates[0]?.slice(1)).toEqual([a, b])
  })

  it('is the world alone with no territory', () => {
    expect(unclaimedGround(collection()).geometry.coordinates).toHaveLength(1)
  })
})

describe('ringContains', () => {
  it('tells inside from outside', () => {
    expect(ringContains(square(0, 0, 2), [1, 1])).toBe(true)
    expect(ringContains(square(0, 0, 2), [3, 1])).toBe(false)
  })
})

describe('territoryAnchors', () => {
  it('puts the knockout under the first detailed water, the tint over the last, and the rest under the first label', () => {
    const ids = [
      'background',
      'earth--underlay-z6-a',
      'water--underlay-z6-a',
      'earth--a',
      'landcover--a',
      'water--a',
      'water--b',
      'buildings--a',
      'roads_minor--a',
      'address_label--a',
      'places_locality--a',
    ]
    expect(territoryAnchors(ids)).toEqual({
      groundBefore: 'water--a',
      tintBefore: 'buildings--a',
      overlayBefore: 'address_label--a',
    })
  })

  it('falls back to the first label, then to the top', () => {
    expect(territoryAnchors(['background', 'earth', 'pois'])).toEqual({
      groundBefore: 'pois',
      tintBefore: 'pois',
      overlayBefore: 'pois',
    })
    expect(territoryAnchors(['background'])).toEqual({
      groundBefore: undefined,
      tintBefore: undefined,
      overlayBefore: undefined,
    })
  })

  it('finds both in a real two-area style with its underlay', () => {
    const areas = [
      { id: 'a', west: 13.7, south: 57.7, east: 14.0, north: 57.85 },
      { id: 'b', west: 14.1, south: 57.62, east: 14.4, north: 57.76 },
    ]
    const style = withCoarseUnderlay(
      buildAreasStyle(['a', 'b'], 'light', 'http://x', 'attr', '#fff'),
      areas,
      'light',
      'http://x',
    )
    const ids = style.layers.map((l) => l.id)
    const { groundBefore, tintBefore, overlayBefore } = territoryAnchors(ids)
    expect(groundBefore).toBe('water--a')
    expect(overlayBefore).toBe('address_label--a')
    expect(ids.indexOf('landcover--b')).toBeLessThan(ids.indexOf(groundBefore ?? ''))
    expect(ids.indexOf('buildings--a')).toBeGreaterThan(ids.indexOf(groundBefore ?? ''))
    // The tint goes over every detailed water line and fill, and under the buildings and roads.
    const tint = ids.indexOf(tintBefore ?? '')
    for (const water of ['water--a', 'water--b', 'water_stream--b', 'water_river--b']) {
      expect(ids.indexOf(water)).toBeLessThan(tint)
    }
    expect(ids.indexOf('buildings--a')).toBeGreaterThan(tint)
    expect(ids.indexOf('roads_minor--a')).toBeGreaterThan(tint)
  })
})

describe('withCoarseUnderlay', () => {
  // Two neighbouring areas: they share their coarse tiles and part at zoom 9, columns 275 and 276.
  const a = { id: 'a', west: 13.7, south: 57.7, east: 14.0, north: 57.85 }
  const b = { id: 'b', west: 14.1, south: 57.62, east: 14.4, north: 57.76 }
  const style = buildAreasStyle(['a', 'b'], 'light', 'http://x', 'attr', '#fff')

  it('reads each tile once per capped zoom, under every detailed layer', () => {
    const out = withCoarseUnderlay(style, [a, b], 'light', 'http://x')
    const capped = Object.entries(out.sources).filter(([id]) => id.startsWith('underlay-'))
    expect(capped.map(([id, s]) => [id, (s as { maxzoom?: number }).maxzoom])).toEqual([
      ['underlay-z0-a', 0],
      ['underlay-z3-a', 3],
      ['underlay-z6-a', 6],
      ['underlay-z9-a', 9],
      ['underlay-z9-b', 9],
    ])
    expect(UNDERLAY_MAXZOOMS).toEqual([0, 3, 6, 9])
    // The archive's own box would keep MapLibre from asking outside it.
    expect((out.sources['underlay-z6-a'] as { bounds?: number[] }).bounds).toEqual([-180, -85.0511, 180, 85.0511])
    const ids = out.layers.map((l) => l.id)
    expect(ids[0]).toBe('background')
    const lastUnderlay = Math.max(...ids.map((id, i) => (id.includes('--underlay-') ? i : -1)))
    expect(lastUnderlay).toBeLessThan(ids.indexOf('earth--a'))
    // Only the ground and its main roads: no labels, no buildings.
    const kept = new Set(ids.filter((id) => id.includes('--underlay-')).map((id) => id.split('--')[0]))
    expect(kept.has('earth')).toBe(true)
    expect(kept.has('water')).toBe(true)
    expect(kept.has('roads_major')).toBe(true)
    expect(kept.has('buildings')).toBe(false)
    expect([...kept].some((id) => id?.startsWith('places_'))).toBe(false)
  })

  it('leaves a style with no areas alone', () => {
    const bare: StyleSpecification = buildAreasStyle([], 'light', 'http://x', '', '#fff')
    expect(withCoarseUnderlay(bare, [], 'light', 'http://x')).toBe(bare)
  })
})

describe('tilesMeetingBox', () => {
  it('is the one world tile at zoom 0 and the tiles a box spans at a finer zoom', () => {
    expect(tilesMeetingBox({ west: -170, south: -80, east: 170, north: 80 }, 0)).toEqual(['0/0'])
    // Zoom 2 columns are 90 degrees wide: 1 to 100 east is columns 2 and 3, all in the row above the equator.
    expect(tilesMeetingBox({ west: 1, south: 1, east: 100, north: 40 }, 2)).toEqual(['2/1', '3/1'])
  })
})

describe('placeMarks', () => {
  const place = (id: string, x: number, y: number, size = 10) => ({ id, x, y, size, label: 'Somewhere 1.00 km²' })

  it('marks only the places too small to see', () => {
    expect([...placeMarks([place('big', 0, 0, 200), place('small', 500, 500)], 36)]).toEqual([['small', 'named']])
  })

  it('names the larger of two places whose names would overlap and leaves the other a dot', () => {
    const marks = placeMarks([place('first', 100, 100), place('near', 140, 110), place('far', 100, 300)], 36)
    expect(Object.fromEntries(marks)).toEqual({ first: 'named', near: 'dot', far: 'named' })
  })
})

describe('boxCentre', () => {
  it('is the middle of the box', () => {
    expect(boxCentre({ west: 10, south: 50, east: 12, north: 51 })).toEqual([11, 50.5])
  })
})

describe('claimCore', () => {
  // At the equator, so a degree is a degree both ways and the reach is plain arithmetic.
  const region = { region_id: 'r', west: 0, south: 0, east: 20, north: 2 }
  function parts(...list: [west: number, side: number, area: number][]): TerritoryFeatureCollection {
    return {
      type: 'FeatureCollection',
      features: list.map(([west, side, area], index) => ({
        type: 'Feature',
        properties: { region_id: 'r', part_index: index, area_m2: area },
        geometry: { type: 'Polygon', coordinates: [square(west, 0, side)] },
      })),
    }
  }

  it("is the largest part's box with the parts within a quarter of its longer side", () => {
    // Largest 0..2; reach 0.5, so the part at 2.4 joins and the box grows to 2.8, reach 0.7,
    // which the part at 3.6 is still past.
    expect(claimCore(parts([0, 2, 10], [2.4, 0.4, 1], [3.6, 0.4, 1]), region)).toEqual({
      west: 0,
      south: 0,
      east: 2.8,
      north: 2,
    })
  })

  it('grows as it takes parts in, so a chain of near parts joins whole', () => {
    // 0..2 takes 2.4..2.8 (reach 0.5), then reach 0.7 takes 3.4..3.8.
    expect(claimCore(parts([0, 2, 10], [2.4, 0.4, 1], [3.4, 0.4, 1]), region).east).toBeCloseTo(3.8)
  })

  it('is not widened by a near part too small to matter', () => {
    // 0.4 is within reach of 0..2 but holds 0.3 of 10, under 5%: the box stays the largest part's.
    expect(claimCore(parts([0, 2, 10], [2.4, 0.4, 0.3]), region).east).toBe(2)
  })

  it("is the region's own box when the core holds under half its ground", () => {
    expect(claimCore(parts([0, 2, 10], [15, 2, 9], [18, 1, 2]), region)).toEqual({
      west: 0,
      south: 0,
      east: 20,
      north: 2,
    })
  })

  it("is the region's own box when none of its ground is in the collection", () => {
    expect(claimCore(parts(), region)).toEqual({ west: 0, south: 0, east: 20, north: 2 })
  })

  it("leaves out another region's parts", () => {
    const collection = parts([0, 2, 10])
    collection.features.push({
      type: 'Feature',
      properties: { region_id: 'other', part_index: 0, area_m2: 100 },
      geometry: { type: 'Polygon', coordinates: [square(2.1, 0, 5)] },
    })
    expect(claimCore(collection, region)).toEqual({ west: 0, south: 0, east: 2, north: 2 })
  })
})
