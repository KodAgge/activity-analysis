import { describe, expect, it } from 'vitest'
import { coveringArea, hasRoute, mapScaleBar, replayControlsSide, routeBounds, routePanelRatio, toRuns } from './routeMath'

describe('toRuns', () => {
  it('breaks the trace at a null sample rather than drawing across it', () => {
    // The gap is the point: a chord drawn straight across it would assert a
    // path the recording does not have.
    const runs = toRuns([57.7, 57.71, null, 57.73, 57.74], [14.1, 14.11, null, 14.13, 14.14])

    expect(runs.map((run) => run.length)).toEqual([2, 2])
    expect(runs[0]?.[0]).toEqual({ lat: 57.7, lon: 14.1 })
    expect(runs[1]?.[0]).toEqual({ lat: 57.73, lon: 14.13 })
  })

  it('drops a sample whose longitude alone is null, never pairing it with 0', () => {
    // (lat, 0) is a real coordinate in the Gulf of Guinea, thousands of
    // kilometres from anywhere this athlete has run, so a half-null sample
    // has to be dropped whole.
    const runs = toRuns([57.7, 57.71], [14.1, null])

    expect(runs).toEqual([[{ lat: 57.7, lon: 14.1 }]])
  })

  it('returns no runs at all when every sample is null', () => {
    expect(toRuns([null, null], [null, null])).toEqual([])
  })
})

describe('hasRoute', () => {
  it('is true for streams with any position at all', () => {
    expect(hasRoute([null, 57.7, null], [null, 14.1, null])).toBe(true)
  })

  it('is false for a treadmill run, whose whole position stream is null', () => {
    expect(hasRoute([null, null, null], [null, null, null])).toBe(false)
  })

  it('is false for empty streams', () => {
    expect(hasRoute([], [])).toBe(false)
  })
})

const area = { id: 'a', west: 14.1, south: 57.7, east: 14.3, north: 57.8 }
const other = { id: 'b', west: 16.4, south: 62.3, east: 16.6, north: 62.4 }

describe('coveringArea', () => {
  it('returns the area whose box holds every sample', () => {
    expect(coveringArea([57.71, 57.75], [14.15, 14.2], [other, area])).toBe(area)
  })

  it('ignores null samples', () => {
    expect(coveringArea([57.71, null, 57.75], [14.15, 25.0, 14.2], [area])).toBe(area)
  })

  it('returns null when one sample leaves the box', () => {
    expect(coveringArea([57.71, 57.75, 57.81], [14.15, 14.2, 14.2], [area])).toBeNull()
  })

  it('returns null with no areas or no fix', () => {
    expect(coveringArea([57.71], [14.15], [])).toBeNull()
    expect(coveringArea([null], [null], [area])).toBeNull()
  })
})

describe('routeBounds', () => {
  it('spans the non-null samples', () => {
    expect(routeBounds([57.7, null, 57.8], [14.2, 30, 14.1])).toEqual({
      west: 14.1, south: 57.7, east: 14.2, north: 57.8,
    })
  })
})

describe('routePanelRatio', () => {
  it('clamps a tall route to square and a wide one to 1.8', () => {
    expect(routePanelRatio([57.4, 57.9], [14.1, 14.11])).toBe(1)
    expect(routePanelRatio([57.4, 57.401], [14.1, 15.1])).toBe(1.8)
  })
})

describe('mapScaleBar', () => {
  it('picks a round distance near a quarter of the panel and sizes the bar to it', () => {
    // At zoom 14 and 60 degrees north, one 512 px tile spans
    // 40075016.686 * 0.5 / 2^14 = 1223 m, so a pixel is 2.389 m.
    const { metres, fraction } = mapScaleBar(400, 60, 14)
    expect(metres).toBe(200)
    expect(fraction).toBeCloseTo(200 / 2.389 / 400, 3)
  })
})

describe('replayControlsSide', () => {
  it('takes the bottom left for a route starting on the right, and the bottom right otherwise', () => {
    expect(replayControlsSide([57.7, 57.71, 57.72], [14.12, 14.11, 14.1])).toBe('left')
    expect(replayControlsSide([57.7, 57.71, 57.72], [14.1, 14.11, 14.12])).toBe('right')
  })

  it('reads the first sample with a position', () => {
    expect(replayControlsSide([null, 57.7, 57.71], [null, 14.12, 14.1])).toBe('left')
  })

  it('falls back to the bottom right without a route', () => {
    expect(replayControlsSide([null], [null])).toBe('right')
  })
})
