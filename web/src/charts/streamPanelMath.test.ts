import { describe, expect, it } from 'vitest'
import { paceLineNote, traceMean, type PaceLineNoteFacts } from './streamPanelMath'

const flat = (n: number, value = false) => Array<boolean | null>(n).fill(value)

describe('traceMean', () => {
  it('averages only the seconds the panel draws: not paused, not an outage, not missing', () => {
    const values = [2, 4, 100, null, 200, 6]
    const paused = [false, false, true, false, false, false]
    const outage = [false, false, false, false, true, false]
    expect(traceMean(values, paused, outage)).toBe(4)
  })

  it('treats a null flag as not masked, as maskSeries does', () => {
    expect(traceMean([3, 5], [null, null], [null, null])).toBe(4)
  })

  it('is null when no second is drawable', () => {
    expect(traceMean([null, null], flat(2), flat(2))).toBeNull()
    expect(traceMean([5, 6], flat(2, true), flat(2))).toBeNull()
    expect(traceMean([], [], [])).toBeNull()
  })
})

describe('paceLineNote', () => {
  const outdoor: PaceLineNoteFacts = {
    traceSpeedMps: 2.5,
    summarySpeedMps: 2.55,
    distanceM: 7480,
    movingTimeS: 2932,
    isIndoor: false,
  }

  it("names the trace's distance over the moving time and the run's own distance outdoors", () => {
    expect(paceLineNote(outdoor)).toBe(
      "The line averages the watch's speed reading, which covers 7.33 km in the moving time; the 6:32/km pace above uses the run's 7.48 km.",
    )
  })

  it("names Strava's session total on a treadmill", () => {
    expect(
      paceLineNote({ traceSpeedMps: 2.85, summarySpeedMps: 6000 / 1800, distanceM: 6000, movingTimeS: 1800, isIndoor: true }),
    ).toBe(
      "The line averages the watch's speed reading, which covers 5.13 km in the moving time; the 5:00/km pace above uses Strava's 6.00 km session total.",
    )
  })

  it('takes the outdoor wording when whether the run was indoors is not known', () => {
    expect(paceLineNote({ ...outdoor, isIndoor: null })).toMatch(/uses the run's 7\.48 km\.$/)
  })

  it('is absent when the two paces format the same', () => {
    expect(paceLineNote({ ...outdoor, traceSpeedMps: 2.769, summarySpeedMps: 2.7695 })).toBeNull()
  })

  it('is absent when any figure is missing or not positive', () => {
    expect(paceLineNote({ ...outdoor, traceSpeedMps: null })).toBeNull()
    expect(paceLineNote({ ...outdoor, traceSpeedMps: 0 })).toBeNull()
    expect(paceLineNote({ ...outdoor, summarySpeedMps: null })).toBeNull()
    expect(paceLineNote({ ...outdoor, distanceM: null })).toBeNull()
    // No derived row: moving time is null and the summary pace is the
    // device's fallback, which the note must not be built from.
    expect(paceLineNote({ ...outdoor, movingTimeS: null })).toBeNull()
    expect(paceLineNote({ ...outdoor, movingTimeS: 0 })).toBeNull()
  })
})
