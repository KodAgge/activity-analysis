import { describe, expect, it } from 'vitest'
import { BASE_SPEEDUP, buildTimeline, headAt, replayTimes, speedupLabel, STOP_REPLAY_S } from './replayTimeline'

const f = (n: number) => Array.from({ length: n }, () => false)

describe('replayTimes', () => {
  it('plays a moving second in 1 / 120 s at 1x', () => {
    const tl = buildTimeline([0, 1, 2, 3], f(4), f(4))
    expect(replayTimes(tl, 1)).toEqual([0, 1 / BASE_SPEEDUP, 2 / BASE_SPEEDUP, 3 / BASE_SPEEDUP])
  })

  it('halves and doubles with the speed switch', () => {
    const tl = buildTimeline([0, 120], f(2), f(2))
    expect(replayTimes(tl, 2).at(-1)).toBeCloseTo(0.5)
    expect(replayTimes(tl, 0.5).at(-1)).toBeCloseTo(2)
  })

  it('gives a stop half a second however long it lasted, at every speed', () => {
    // An hour standing still, longer than the real store's longest stop.
    const t = [0, 1, 3601, 3602]
    const paused = [false, false, true, false]
    for (const speed of [0.5, 1, 2] as const) {
      const times = replayTimes(buildTimeline(t, paused, f(4)), speed)
      const moving = 2 / (BASE_SPEEDUP * speed)
      expect(times.at(-1)).toBeCloseTo(moving + STOP_REPLAY_S)
    }
  })

  it('shares the half second across a multi-sample stop and stays monotonic', () => {
    const t = [0, 1, 2, 3, 4]
    const paused = [false, true, true, true, false]
    const times = replayTimes(buildTimeline(t, paused, f(5)), 1)
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!)
    expect(times[3]! - times[0]!).toBeCloseTo(STOP_REPLAY_S)
  })

  it('counts an outage like a pause', () => {
    const t = [0, 1, 500, 501]
    const outage = [false, false, true, false]
    expect(replayTimes(buildTimeline(t, f(4), outage), 1).at(-1)).toBeCloseTo(2 / BASE_SPEEDUP + STOP_REPLAY_S)
  })

  it('handles a run that starts and ends stopped', () => {
    const t = [0, 1, 2, 3]
    const paused = [true, false, false, true]
    const times = replayTimes(buildTimeline(t, paused, f(4)), 1)
    expect(times[0]).toBe(0)
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!)
  })
})

describe('headAt', () => {
  const times = [0, 1, 2, 3]
  it('is the last sample reached', () => {
    expect(headAt(times, 1.5)).toBe(1)
    expect(headAt(times, 2)).toBe(2)
  })
  it('clamps before the start and after the end', () => {
    expect(headAt(times, -1)).toBe(0)
    expect(headAt(times, 99)).toBe(3)
  })
})

describe('speedupLabel', () => {
  it('names the speed-up', () => {
    expect([0.5, 1, 2].map((s) => speedupLabel(s as 0.5 | 1 | 2))).toEqual(['60x', '120x', '240x'])
  })
})
