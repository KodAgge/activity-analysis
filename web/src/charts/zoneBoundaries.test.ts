import { describe, expect, it } from 'vitest'
import { zoneEdgesFromBoundaries } from './zoneBoundaries'

describe('zoneEdgesFromBoundaries', () => {
  it('pairs n boundaries into n + 1 zones, zone 0 below the first and the last zone at or above the last boundary', () => {
    // The real device's six configured boundaries (see
    // docs/reference/derived-layer.md), giving seven zones - the same
    // shape `ZoneBar` always renders.
    const boundaries = [104, 124, 145, 166, 186, 207]

    const edges = zoneEdgesFromBoundaries(boundaries)

    expect(edges).toHaveLength(7)
    expect(edges[0]).toEqual({ zone_index: 0, low_bpm: null, high_bpm: 104 })
    expect(edges[6]).toEqual({ zone_index: 6, low_bpm: 207, high_bpm: null })
  })

  it('makes each interior boundary the low edge of the zone above it and the high edge of the zone below it', () => {
    const boundaries = [104, 124, 145, 166, 186, 207]

    const edges = zoneEdgesFromBoundaries(boundaries)

    expect(edges[3]).toEqual({ zone_index: 3, low_bpm: 145, high_bpm: 166 })
    expect(edges[4]).toEqual({ zone_index: 4, low_bpm: 166, high_bpm: 186 })
  })
})
