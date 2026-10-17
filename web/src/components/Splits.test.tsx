import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { components } from '../api/schema'
import { NO_VALUE, cadence, heartRate } from '../format'
import { Splits } from './Splits'
import {
  MIN_PACE_BAR_PERCENT,
  paceBarScale,
  paceBarWidthPercent,
  perKilometreSplits,
  rolesFromPattern,
} from './splitsMath'

type Lap = components['schemas']['Lap']

function lap(overrides: Partial<Lap> & { lap_index: number }): Lap {
  return {
    start_time_utc: '2026-08-25T15:41:23Z',
    trigger: null,
    elapsed_time_s: null,
    distance_m: null,
    avg_speed_mps: null,
    avg_hr_bpm: null,
    max_hr_bpm: null,
    avg_cadence_spm: null,
    ascent_m: null,
    descent_m: null,
    calories: null,
    ...overrides,
  }
}

/**
 * The real 14 laps of `6116b2e90f551a6c` (2026-08-25), fetched from a
 * running server on 2026-09-01 after the `rep_pattern` column landed - see
 * the task report. Every field below is the value the server actually
 * sent, `start_time_utc` and the fields that once read null on all 14 rows
 * (`avg_hr_bpm`, `max_hr_bpm`, `ascent_m`, `descent_m`, `calories`)
 * included, which is the fix for the review finding that an earlier
 * version of this fixture claimed to be real and was not.
 */
const REFERENCE_INTERVAL_LAPS: Lap[] = [
  lap({ lap_index: 0, start_time_utc: '2026-08-25T15:41:23Z', trigger: 'distance', elapsed_time_s: 465.865, distance_m: 1000.0, avg_speed_mps: 2.147, avg_hr_bpm: 124.0, max_hr_bpm: 147.0, avg_cadence_spm: 148.296875, ascent_m: 6.0, descent_m: 0.0, calories: 87.0 }),
  lap({ lap_index: 1, start_time_utc: '2026-08-25T15:49:12Z', trigger: 'manual', elapsed_time_s: 257.781, distance_m: 380.86, avg_speed_mps: 1.477, avg_hr_bpm: 142.0, max_hr_bpm: 157.0, avg_cadence_spm: 98.171875, ascent_m: 2.0, descent_m: 0.0, calories: 49.0 }),
  lap({ lap_index: 2, start_time_utc: '2026-08-25T15:53:28Z', trigger: 'distance', elapsed_time_s: 252.332, distance_m: 1000.0, avg_speed_mps: 3.963, avg_hr_bpm: 171.0, max_hr_bpm: 190.0, avg_cadence_spm: 173.0625, ascent_m: 0.0, descent_m: 2.0, calories: 70.0 }),
  lap({ lap_index: 3, start_time_utc: '2026-08-25T15:57:42Z', trigger: 'manual', elapsed_time_s: 90.016, distance_m: 163.73, avg_speed_mps: 1.819, avg_hr_bpm: 171.0, max_hr_bpm: 190.0, avg_cadence_spm: 118.265625, ascent_m: 0.0, descent_m: 0.0, calories: 23.0 }),
  lap({ lap_index: 4, start_time_utc: '2026-08-25T15:59:11Z', trigger: 'distance', elapsed_time_s: 266.639, distance_m: 1000.0, avg_speed_mps: 3.75, avg_hr_bpm: 183.0, max_hr_bpm: 192.0, avg_cadence_spm: 176.421875, ascent_m: 0.0, descent_m: 0.0, calories: 79.0 }),
  lap({ lap_index: 5, start_time_utc: '2026-08-25T16:03:38Z', trigger: 'manual', elapsed_time_s: 90.414, distance_m: 153.69, avg_speed_mps: 1.7, avg_hr_bpm: 169.0, max_hr_bpm: 191.0, avg_cadence_spm: 102.671875, ascent_m: 0.0, descent_m: 0.0, calories: 23.0 }),
  lap({ lap_index: 6, start_time_utc: '2026-08-25T16:05:08Z', trigger: 'distance', elapsed_time_s: 265.744, distance_m: 1000.0, avg_speed_mps: 3.763, avg_hr_bpm: 185.0, max_hr_bpm: 192.0, avg_cadence_spm: 174.453125, ascent_m: 0.0, descent_m: 2.0, calories: 80.0 }),
  lap({ lap_index: 7, start_time_utc: '2026-08-25T16:09:34Z', trigger: 'manual', elapsed_time_s: 92.15, distance_m: 166.89, avg_speed_mps: 1.811, avg_hr_bpm: 172.0, max_hr_bpm: 191.0, avg_cadence_spm: 116.40625, ascent_m: 0.0, descent_m: 0.0, calories: 23.0 }),
  lap({ lap_index: 8, start_time_utc: '2026-08-25T16:11:06Z', trigger: 'distance', elapsed_time_s: 267.742, distance_m: 1000.0, avg_speed_mps: 3.735, avg_hr_bpm: 185.0, max_hr_bpm: 196.0, avg_cadence_spm: 175.875, ascent_m: 0.0, descent_m: 2.0, calories: 80.0 }),
  lap({ lap_index: 9, start_time_utc: '2026-08-25T16:15:34Z', trigger: 'manual', elapsed_time_s: 90.954, distance_m: 162.56, avg_speed_mps: 1.787, avg_hr_bpm: 176.0, max_hr_bpm: 193.0, avg_cadence_spm: 110.984375, ascent_m: 2.0, descent_m: 0.0, calories: 23.0 }),
  lap({ lap_index: 10, start_time_utc: '2026-08-25T16:17:04Z', trigger: 'distance', elapsed_time_s: 272.939, distance_m: 1000.0, avg_speed_mps: 3.664, avg_hr_bpm: 185.0, max_hr_bpm: 195.0, avg_cadence_spm: 176.15625, ascent_m: 0.0, descent_m: 2.0, calories: 80.0 }),
  lap({ lap_index: 11, start_time_utc: '2026-08-25T16:21:38Z', trigger: 'distance', elapsed_time_s: 816.351, distance_m: 1000.0, avg_speed_mps: 2.276, avg_hr_bpm: 166.0, max_hr_bpm: 193.0, avg_cadence_spm: 143.40625, ascent_m: 2.0, descent_m: 3.0, calories: 97.0 }),
  lap({ lap_index: 12, start_time_utc: '2026-08-25T16:35:15Z', trigger: 'distance', elapsed_time_s: 411.004, distance_m: 1000.0, avg_speed_mps: 2.433, avg_hr_bpm: 159.0, max_hr_bpm: 168.0, avg_cadence_spm: 150.265625, ascent_m: 4.0, descent_m: 15.0, calories: 87.0 }),
  lap({ lap_index: 13, start_time_utc: '2026-08-25T16:42:06Z', trigger: 'session_end', elapsed_time_s: 71.636, distance_m: 206.49, avg_speed_mps: 2.882, avg_hr_bpm: 168.0, max_hr_bpm: 174.0, avg_cadence_spm: 164.984375, ascent_m: 4.0, descent_m: 2.0, calories: 18.0 }),
]

/** The real `rep_pattern` for `6116b2e90f551a6c`, ANALYSIS_VERSION 4. See docs/reference/math/tags.md. */
const REFERENCE_INTERVAL_PATTERN = '-WRWRWRWRWR---'

/** The real 8 laps of `854fd775d479ca9f` (2026-08-28), the steady reference: seven even kilometres plus a session-end tail, no manual laps at all. */
const REFERENCE_STEADY_LAPS: Lap[] = [
  lap({ lap_index: 0, start_time_utc: '2026-08-28T18:19:14Z', trigger: 'distance', elapsed_time_s: 388.166, distance_m: 1000.0, avg_speed_mps: 2.576, avg_hr_bpm: 129.0, max_hr_bpm: 150.0, avg_cadence_spm: 162.109375, ascent_m: 2.0, descent_m: 9.0, calories: 79.0 }),
  lap({ lap_index: 1, start_time_utc: '2026-08-28T18:25:43Z', trigger: 'distance', elapsed_time_s: 384.971, distance_m: 1000.0, avg_speed_mps: 2.598, avg_hr_bpm: 149.0, max_hr_bpm: 158.0, avg_cadence_spm: 162.515625, ascent_m: 2.0, descent_m: 7.0, calories: 89.0 }),
  lap({ lap_index: 2, start_time_utc: '2026-08-28T18:32:08Z', trigger: 'distance', elapsed_time_s: 387.556, distance_m: 1000.0, avg_speed_mps: 2.58, avg_hr_bpm: 157.0, max_hr_bpm: 169.0, avg_cadence_spm: 162.75, ascent_m: 10.0, descent_m: 5.0, calories: 89.0 }),
  lap({ lap_index: 3, start_time_utc: '2026-08-28T18:38:36Z', trigger: 'distance', elapsed_time_s: 396.262, distance_m: 1000.0, avg_speed_mps: 2.524, avg_hr_bpm: 161.0, max_hr_bpm: 166.0, avg_cadence_spm: 162.296875, ascent_m: 4.0, descent_m: 4.0, calories: 91.0 }),
  lap({ lap_index: 4, start_time_utc: '2026-08-28T18:45:12Z', trigger: 'distance', elapsed_time_s: 417.89, distance_m: 1000.0, avg_speed_mps: 2.393, avg_hr_bpm: 166.0, max_hr_bpm: 172.0, avg_cadence_spm: 161.65625, ascent_m: 28.0, descent_m: 5.0, calories: 98.0 }),
  lap({ lap_index: 5, start_time_utc: '2026-08-28T18:52:10Z', trigger: 'distance', elapsed_time_s: 387.914, distance_m: 1000.0, avg_speed_mps: 2.578, avg_hr_bpm: 160.0, max_hr_bpm: 168.0, avg_cadence_spm: 164.015625, ascent_m: 0.0, descent_m: 19.0, calories: 84.0 }),
  lap({ lap_index: 6, start_time_utc: '2026-08-28T18:58:38Z', trigger: 'distance', elapsed_time_s: 396.726, distance_m: 1000.0, avg_speed_mps: 2.521, avg_hr_bpm: 165.0, max_hr_bpm: 170.0, avg_cadence_spm: 163.765625, ascent_m: 7.0, descent_m: 2.0, calories: 91.0 }),
  lap({ lap_index: 7, start_time_utc: '2026-08-28T19:05:15Z', trigger: 'session_end', elapsed_time_s: 171.72, distance_m: 456.06, avg_speed_mps: 2.656, avg_hr_bpm: 163.0, max_hr_bpm: 166.0, avg_cadence_spm: 163.1875, ascent_m: 2.0, descent_m: 2.0, calories: 39.0 }),
]

/**
 * The shape of a real lap from elsewhere in the store, fetched from a
 * running server on 2026-09-01, with only its start time made synthetic.
 * 49 of the 5172 real laps in the store carry a null `distance_m` this way
 * - a lap the watch closed essentially instantly, with nothing else
 * recorded either. This is the one lap in the whole export that exercises
 * almost every nullable `Lap` column at once: `distance_m`,
 * `avg_speed_mps`, `avg_hr_bpm`, `max_hr_bpm`, `avg_cadence_spm`,
 * `ascent_m` and `descent_m` are all null on the real lap, not only in
 * this test.
 */
const ALL_NULL_LAP: Lap = {
  lap_index: 0,
  start_time_utc: '2026-01-10T12:00:00Z',
  trigger: 'session_end',
  elapsed_time_s: 0.042,
  distance_m: null,
  avg_speed_mps: null,
  avg_hr_bpm: null,
  max_hr_bpm: null,
  avg_cadence_spm: null,
  ascent_m: null,
  descent_m: null,
  calories: null,
}

function emptyStream(t: number[]) {
  return {
    t,
    distanceM: t.map(() => null),
    hrBpm: t.map(() => null),
    cadenceSpm: t.map(() => null),
    altitudeM: t.map(() => null),
  }
}

describe('perKilometreSplits', () => {
  it('is the elapsed seconds between each 1000 m crossing on a known distance ramp', () => {
    // A flat 100 m/s ramp for 25 s: exact crossings at t=10 (1000 m) and
    // t=20 (2000 m), with 400 m of a third kilometre left over.
    const t = Array.from({ length: 25 }, (_, i) => i)
    const distanceM = t.map((ti) => ti * 100)
    const splits = perKilometreSplits(t, distanceM, emptyStream(t).hrBpm, emptyStream(t).cadenceSpm, emptyStream(t).altitudeM)

    expect(splits).toHaveLength(3)
    const [first, second, third] = splits
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('expected three splits')
    }
    expect(first).toMatchObject({ index: 1, elapsedS: 10, distanceM: 1000, partial: false })
    expect(second).toMatchObject({ index: 2, elapsedS: 10, distanceM: 1000, partial: false })
    // The remainder below a kilometre is a partial, not padded out to a
    // full 1000 m split it never covered.
    expect(third).toMatchObject({ index: 3, elapsedS: 4, distanceM: 400, partial: true })
  })

  it('changes its answer when the ramp speed changes - this is not a hardcoded result', () => {
    // Same shape, double the speed: every crossing happens in half the
    // time. A test that could not fail against this change would not be
    // testing the interpolation at all.
    const t = Array.from({ length: 25 }, (_, i) => i)
    const distanceM = t.map((ti) => ti * 200)
    const splits = perKilometreSplits(t, distanceM, emptyStream(t).hrBpm, emptyStream(t).cadenceSpm, emptyStream(t).altitudeM)
    const [first] = splits
    if (first === undefined) throw new Error('expected at least one split')
    expect(first.elapsedS).toBe(5)
  })

  it('emits no partial when the run ends exactly on a kilometre', () => {
    const t = Array.from({ length: 11 }, (_, i) => i)
    const distanceM = t.map((ti) => ti * 100)
    const splits = perKilometreSplits(t, distanceM, emptyStream(t).hrBpm, emptyStream(t).cadenceSpm, emptyStream(t).altitudeM)
    expect(splits).toHaveLength(1)
    expect(splits.some((s) => s.partial)).toBe(false)
  })

  it('is null, not a confident 0 m, for a collapsed window - two crossings landing on the same sample', () => {
    // The very first sample already carries 2500 m, so both the 1000 m and
    // the 2000 m crossings resolve to t=0: the first split has a
    // zero-length window with nothing to measure an elevation change
    // across. A version that searched outward from the same index for
    // both ends would report a confident 0 m here instead.
    const t = [0, 1, 2, 3]
    const distanceM = [2500, 2500, 2500, 2500]
    const altitudeM = [100, 110, 120, 130]
    const splits = perKilometreSplits(t, distanceM, emptyStream(t).hrBpm, emptyStream(t).cadenceSpm, altitudeM)
    const [first] = splits
    if (first === undefined) throw new Error('expected at least one split')
    expect(first.elapsedS).toBe(0)
    expect(first.elevationChangeM).toBeNull()
  })

  it('reports no heart rate and no cadence for a split when the grid carries none - the real no-heart-rate shape', () => {
    // Models a real run recorded without heart rate: `hr_bpm` is null across
    // the whole grid, `cadence_spm` and `altitude_m` are real. A split drawn
    // from a window with no recorded heart rate must read null, not 0 bpm.
    const t = Array.from({ length: 11 }, (_, i) => i)
    const distanceM = t.map((ti) => ti * 100)
    const hrBpm = t.map(() => null)
    const cadenceSpm = t.map(() => 170)
    const altitudeM = t.map((ti) => 50 + ti)
    const splits = perKilometreSplits(t, distanceM, hrBpm, cadenceSpm, altitudeM)
    const [first] = splits
    if (first === undefined) throw new Error('expected at least one split')
    expect(first.avgHrBpm).toBeNull()
    expect(first.avgCadenceSpm).toBe(170)
  })
})

describe('rolesFromPattern', () => {
  it('reproduces the real 2026-08-25 session exactly, from the real rep_pattern column', () => {
    const classified = rolesFromPattern(REFERENCE_INTERVAL_LAPS, REFERENCE_INTERVAL_PATTERN)
    const roles = classified.map((c) => c.role)
    expect(roles).toEqual([
      'plain', 'recovery', 'rep', 'recovery', 'rep', 'recovery', 'rep', 'recovery', 'rep', 'recovery', 'rep',
      'plain', 'plain', 'plain',
    ])
    // Reps are numbered chronologically, 1 through rep_count - never left
    // unnumbered, and never numbered on a non-rep lap.
    const repNumbers = classified.filter((c) => c.role === 'rep').map((c) => c.repNumber)
    expect(repNumbers).toEqual([1, 2, 3, 4, 5])
    expect(classified.every((c) => c.role === 'rep' || c.repNumber === null)).toBe(true)
  })

  it('numbers only the R laps the analysis layer counts, on a real nine-R pattern', () => {
    // The last session in the measured table in
    // docs/reference/math/tags.md: nine `R` characters at `rep_count: 7`,
    // because `interval_reps` counts an `R` only when it sits beside a
    // `W`. The `R` at index 0 has an `R` after it and nothing before it;
    // the `R` at index 16 sits between two `-`. Numbering every `R` - the
    // behaviour this replaces - renders "Rep 1" through "Rep 9" under a
    // tab reading "Laps - 7 reps", and fails here on both the role array
    // and the last rep number.
    const pattern = 'RRWRWRWRWRWRWRW-R-'
    const laps = pattern.split('').map((_, index) => lap({ lap_index: index }))

    const classified = rolesFromPattern(laps, pattern)
    const roles = classified.map((c) => c.role)

    expect(roles).toEqual([
      'plain', 'rep', 'recovery', 'rep', 'recovery', 'rep', 'recovery', 'rep', 'recovery', 'rep',
      'recovery', 'rep', 'recovery', 'rep', 'recovery', 'plain', 'plain', 'plain',
    ])
    expect(classified.filter((c) => c.role === 'rep').map((c) => c.repNumber)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it("numbers exactly rep_count laps on every one of the nine real interval sessions", () => {
    // The full measured table from docs/reference/math/tags.md's
    // "Reproduced against the real store": every session the classifier
    // fires on across the 307 real runs, with the `rep_count` and
    // `rep_pattern` the analysis layer stored for it. The tab header
    // reports that `rep_count`, so the numbered rows have to be exactly
    // that many or the panel contradicts its own heading. Two of the nine
    // carry more `R` characters than reps, which is what makes this more
    // than a restatement of "count the Rs".
    // Newest first; the first is the fixture `6116b2e90f551a6c`.
    const realSessions: { label: string; repCount: number; pattern: string }[] = [
      { label: 'session 1', repCount: 5, pattern: '-WRWRWRWRWR---' },
      { label: 'session 2', repCount: 5, pattern: '--RWRWRWRWRW--' },
      { label: 'session 3', repCount: 5, pattern: '--RWRWRWRWRW-----' },
      { label: 'session 4', repCount: 5, pattern: '--WRWRWRWRWRW-' },
      { label: 'session 5', repCount: 5, pattern: 'RWRWRWRWRW-' },
      { label: 'session 6', repCount: 5, pattern: '--RWRWRWRWR--' },
      { label: 'session 7', repCount: 5, pattern: '--WRWRWRWRWRW--' },
      { label: 'session 8', repCount: 5, pattern: '-RWRWRWRWRW-R' },
      { label: 'session 9', repCount: 7, pattern: 'RRWRWRWRWRWRWRW-R-' },
    ]
    const withUncountedReps = realSessions.filter((s) => s.pattern.split('R').length - 1 > s.repCount)
    expect(withUncountedReps.map((s) => s.label)).toEqual(['session 8', 'session 9'])

    for (const session of realSessions) {
      const laps = session.pattern.split('').map((_, index) => lap({ lap_index: index }))
      const classified = rolesFromPattern(laps, session.pattern)
      const reps = classified.filter((c) => c.role === 'rep')

      expect(reps).toHaveLength(session.repCount)
      expect(reps.map((c) => c.repNumber)).toEqual(
        Array.from({ length: session.repCount }, (_, i) => i + 1),
      )
    }
  })

  it('marks every lap plain when there is no intervals tag - a null pattern means nothing to badge', () => {
    const classified = rolesFromPattern(REFERENCE_INTERVAL_LAPS, null)
    expect(classified.every((c) => c.role === 'plain' && c.repNumber === null)).toBe(true)
  })

  it('falls back to all-plain on a length mismatch rather than misaligning roles - the length guard', () => {
    // A pattern one character short of the lap count: assigning it anyway
    // would shift every role by one lap for the rest of the array, which
    // is worse than labelling none - a confidently wrong "Recovery" badge
    // on lap 2 (really a rep) is harder to notice than no badge at all.
    const tooShort = REFERENCE_INTERVAL_PATTERN.slice(0, -1)
    expect(tooShort.length).toBe(REFERENCE_INTERVAL_LAPS.length - 1)
    const classified = rolesFromPattern(REFERENCE_INTERVAL_LAPS, tooShort)
    expect(classified.every((c) => c.role === 'plain' && c.repNumber === null)).toBe(true)
  })

  it('sorts by lap_index before indexing the pattern, so a shuffled response cannot misalign roles', () => {
    // The pattern is positional over recorded order. `docs/reference/api.md`
    // documents that the endpoint serves `laps` in `lap_index` order, and
    // `tests/test_api_activities.py` enforces it server-side, but nothing
    // on this side of the boundary depends on that structurally - one edit
    // to the query's `ORDER BY`, with no reason for anyone touching it to
    // think of this component, would silently misalign every role if this
    // function trusted array position alone. A deterministic reshuffle
    // (group by `lap_index % 5`, stable within each group) scrambles every
    // one of the 14 real laps well away from its natural position without
    // dropping or duplicating any of them.
    const shuffled = [...REFERENCE_INTERVAL_LAPS].sort((a, b) => (a.lap_index % 5) - (b.lap_index % 5))
    expect(shuffled.map((lap) => lap.lap_index)).not.toEqual(REFERENCE_INTERVAL_LAPS.map((lap) => lap.lap_index))

    const classified = rolesFromPattern(shuffled, REFERENCE_INTERVAL_PATTERN)
    const roleByLapIndex = new Map(classified.map((c) => [c.lap.lap_index, c.role]))

    expect([2, 4, 6, 8, 10].every((i) => roleByLapIndex.get(i) === 'rep')).toBe(true)
    expect([1, 3, 5, 7, 9].every((i) => roleByLapIndex.get(i) === 'recovery')).toBe(true)
    expect([0, 11, 12, 13].every((i) => roleByLapIndex.get(i) === 'plain')).toBe(true)

    // Reps are still numbered chronologically by lap_index, 1 through 5,
    // not by whatever order the shuffled input happened to hand them in.
    const repsByLapIndex = classified
      .filter((c) => c.role === 'rep')
      .sort((a, b) => a.lap.lap_index - b.lap.lap_index)
      .map((c) => c.repNumber)
    expect(repsByLapIndex).toEqual([1, 2, 3, 4, 5])
  })
})

describe('paceBarWidthPercent', () => {
  it('spreads a narrow real pace range across the whole track instead of the top tenth of it', () => {
    // The measured shape of 854fd775d479ca9f: eight laps from 6:16 to 6:57
    // per kilometre. Zero-anchored - `speed / fastestSpeed`, which is what
    // this replaced - they span 90.1% to 100.0% of the cell, a 9.9-point
    // spread the eye cannot separate.
    const fastest = 1000 / (6 * 60 + 16)
    const slowest = 1000 / (6 * 60 + 57)

    const zeroAnchoredSpread = 100 - (slowest / fastest) * 100
    expect(zeroAnchoredSpread).toBeLessThan(10)

    const widest = paceBarWidthPercent(fastest, slowest, fastest)
    const narrowest = paceBarWidthPercent(slowest, slowest, fastest)
    expect(widest).toBe(100)
    expect(narrowest).toBe(MIN_PACE_BAR_PERCENT)
    expect(widest - narrowest).toBeGreaterThan(8 * zeroAnchoredSpread)
  })

  it('leaves the slowest split a visible bar rather than nothing', () => {
    // At a true zero the slowest row would have no bar at all, which reads
    // as missing data rather than as the slowest split.
    expect(paceBarWidthPercent(2.0, 2.0, 3.0)).toBeGreaterThan(0)
  })

  it('places a middling split in the middle, not at either end', () => {
    const middle = paceBarWidthPercent(2.5, 2.0, 3.0)
    expect(middle).toBeGreaterThan(MIN_PACE_BAR_PERCENT)
    expect(middle).toBeLessThan(100)
    expect(middle).toBeCloseTo(MIN_PACE_BAR_PERCENT + 0.5 * (100 - MIN_PACE_BAR_PERCENT), 5)
  })

  it('draws every bar full when the whole table shares one pace, rather than every bar at the floor', () => {
    // A treadmill at a constant speed, or a single-lap run. They really are
    // all the same pace; scaling them all to the floor would suggest they
    // were all slow.
    expect(paceBarWidthPercent(2.5, 2.5, 2.5)).toBe(100)
  })

  it('draws no bar at all for a split with no recorded pace', () => {
    // Every lap of five of the nine real interval sessions has a null
    // `avg_speed_mps`. A zero-width bar is the honest rendering; the floor
    // would claim a measured slow lap.
    expect(paceBarWidthPercent(null, 2.0, 3.0)).toBe(0)
    expect(paceBarWidthPercent(0, 2.0, 3.0)).toBe(0)
  })
})

describe('paceBarScale', () => {
  /** Every lap speed of `6116b2e90f551a6c`, in recorded order, as the rows reach the scale. */
  const INTERVAL_ROWS = REFERENCE_INTERVAL_LAPS.map((each) => ({ avgSpeedMps: each.avg_speed_mps }))

  /** The bar width of one speed, against the range this fixture's own rows set. */
  function widthOf(speedMps: number): number {
    const scale = paceBarScale(INTERVAL_ROWS)
    return paceBarWidthPercent(speedMps, scale.slowestSpeedMps, scale.fastestSpeedMps)
  }

  it('gives every lap of a real interval session a distinct bar width', () => {
    // The range is over every row, roles included, and this is the
    // assertion that pins why. Scaling to the reps alone - tried on this
    // branch, and reverted - puts all nine non-rep laps below the range's
    // floor, so each draws at exactly `MIN_PACE_BAR_PERCENT`: one width
    // across 1.477 to 2.882 m/s. Zero-anchoring collapses the fast end
    // instead. Both fail this; the all-rows range does not.
    expect(paceBarScale(INTERVAL_ROWS)).toEqual({ slowestSpeedMps: 1.477, fastestSpeedMps: 3.963 })

    const widths = INTERVAL_ROWS.map((row) => widthOf(row.avgSpeedMps ?? 0))
    expect(widths).toHaveLength(14)
    expect(new Set(widths.map((width) => width.toFixed(1))).size).toBe(14)
  })

  it('never draws two laps a factor of 1.9 apart in speed at the same width', () => {
    // The walked recovery at 1.477 m/s (11:17/km) and the cool-down tail
    // at 2.882 (5:47/km) are the extremes of the non-rep rows, and under
    // the rep-only scale they came out pixel-identical.
    expect(2.882 / 1.477).toBeGreaterThan(1.9)
    expect(widthOf(2.882) - widthOf(1.477)).toBeGreaterThan(45)

    // And no pair anywhere in the table collapses, however close.
    for (const [slower, faster] of [
      [1.477, 1.7],
      [1.7, 2.147],
      [2.147, 2.882],
      [2.882, 3.664],
      [3.664, 3.963],
    ] as const) {
      expect(widthOf(faster)).toBeGreaterThan(widthOf(slower))
    }
  })

  it("reads the session's structure: reps near the top, recoveries near the floor, the rest between", () => {
    // What the all-rows range buys, and what the Laps tab of an interval
    // session is actually asked - were the reps consistent, and was there
    // a recovery. The finer rep-to-rep question is the Pace column's.
    const reps = [3.963, 3.75, 3.763, 3.735, 3.664].map(widthOf)
    const recoveries = [1.477, 1.819, 1.7, 1.811, 1.787].map(widthOf)
    expect(Math.min(...reps)).toBeGreaterThan(85)
    expect(Math.max(...recoveries)).toBeLessThan(30)

    for (const between of [2.147, 2.276, 2.433, 2.882].map(widthOf)) {
      expect(between).toBeGreaterThan(Math.max(...recoveries))
      expect(between).toBeLessThan(Math.min(...reps))
    }
  })

  it('takes the range over the rows of a steady table just the same', () => {
    // The per-kilometre tab, and any run that is not an interval session:
    // one rule, with no special case to get wrong.
    const kmRows = [2.576, 2.598, 2.58, 2.395].map((avgSpeedMps) => ({ avgSpeedMps }))
    expect(paceBarScale(kmRows)).toEqual({ slowestSpeedMps: 2.395, fastestSpeedMps: 2.598 })
  })

  it('ignores rows with no recorded pace', () => {
    // Every lap of five of the nine real interval sessions has a null
    // `avg_speed_mps`; counted, they would drag the slow end to zero.
    const rows = [{ avgSpeedMps: null }, { avgSpeedMps: 0 }, { avgSpeedMps: 2.5 }, { avgSpeedMps: 3.0 }]
    expect(paceBarScale(rows)).toEqual({ slowestSpeedMps: 2.5, fastestSpeedMps: 3.0 })
  })

  it('has no range to offer for a table where nothing has a pace', () => {
    expect(paceBarScale([{ avgSpeedMps: null }, { avgSpeedMps: null }])).toEqual({
      slowestSpeedMps: 0,
      fastestSpeedMps: 0,
    })
  })
})

describe('Splits', () => {
  it('leads with the Laps tab and names the rep count when an intervals tag is present', () => {
    render(
      <Splits
        activityId="fixture-activity"
        laps={REFERENCE_INTERVAL_LAPS}
        isIntervalsSession
        repCount={5}
        repPattern={REFERENCE_INTERVAL_PATTERN}
        streams={null}
        streamsAbsentReason="no grid for this fixture"
        streamsFailureReason={null}
      />,
    )

    const lapsTab = screen.getByRole('tab', { name: 'Laps · 5 reps' })
    const kmTab = screen.getByRole('tab', { name: /Per km/ })
    expect(lapsTab).toHaveAttribute('aria-selected', 'true')
    expect(kmTab).toHaveAttribute('aria-selected', 'false')

    // The other tab is still reachable.
    fireEvent.click(kmTab)
    expect(kmTab).toHaveAttribute('aria-selected', 'true')
  })

  it('leads with the per-kilometre tab when there is no intervals tag, and the Laps tab is still reachable', () => {
    render(
      <Splits
        activityId="fixture-activity"
        laps={REFERENCE_STEADY_LAPS}
        isIntervalsSession={false}
        repCount={null}
        repPattern={null}
        streams={null}
        streamsAbsentReason={null}
        streamsFailureReason={null}
      />,
    )

    const lapsTab = screen.getByRole('tab', { name: 'Laps · 8 laps' })
    const kmTab = screen.getByRole('tab', { name: /Per km/ })
    expect(kmTab).toHaveAttribute('aria-selected', 'true')
    expect(lapsTab).toHaveAttribute('aria-selected', 'false')

    fireEvent.click(lapsTab)
    expect(lapsTab).toHaveAttribute('aria-selected', 'true')
  })

  it('is not decided by the manual lap count: an activity with five manual-looking laps but isIntervalsSession false still leads with per km', () => {
    // This is the exact fixture the intervals-tag rule exists for: laps
    // that look like an interval session by trigger count (5 manual) must
    // not flip the leading tab in the absence of the tag.
    render(
      <Splits
        activityId="fixture-activity"
        laps={REFERENCE_INTERVAL_LAPS}
        isIntervalsSession={false}
        repCount={null}
        repPattern={null}
        streams={null}
        streamsAbsentReason={null}
        streamsFailureReason={null}
      />,
    )

    const kmTab = screen.getByRole('tab', { name: /Per km/ })
    expect(kmTab).toHaveAttribute('aria-selected', 'true')
  })

  it('is not decided by a non-null rep_count either: only tag === "intervals" leads with Laps', () => {
    // The minor finding this pins: a predicate reading "rep_count is
    // non-null" is equivalent to the intervals-tag rule only by accident, because no
    // other effort tag happens to carry a rep count today. This fixture
    // is the case that would tell the two predicates apart if one were
    // ever wired up wrong.
    render(
      <Splits
        activityId="fixture-activity"
        laps={REFERENCE_STEADY_LAPS}
        isIntervalsSession={false}
        repCount={3}
        repPattern={null}
        streams={null}
        streamsAbsentReason={null}
        streamsFailureReason={null}
      />,
    )

    const kmTab = screen.getByRole('tab', { name: /Per km/ })
    expect(kmTab).toHaveAttribute('aria-selected', 'true')
  })

  it('gives a recovery lap and a rep lap different visual treatment, and leaves an unnumbered plain lap unlabelled as a rep', () => {
    render(
      <Splits
        activityId="fixture-activity"
        laps={REFERENCE_INTERVAL_LAPS}
        isIntervalsSession
        repCount={5}
        repPattern={REFERENCE_INTERVAL_PATTERN}
        streams={null}
        streamsAbsentReason={null}
        streamsFailureReason={null}
      />,
    )

    const table = screen.getByRole('table')
    const rows = within(table).getAllByRole('row')

    function rowFor(text: string): HTMLElement {
      const row = rows.find((r) => within(r).queryByText(text) !== null)
      if (row === undefined) throw new Error(`no row for "${text}"`)
      return row
    }

    const rep = rowFor('Rep 1')
    const recovery = rowFor('Recovery')
    const plain = rowFor('Lap 1')

    expect(rep.getAttribute('data-role')).toBe('rep')
    expect(recovery.getAttribute('data-role')).toBe('recovery')
    expect(plain.getAttribute('data-role')).toBe('plain')
    // The classes actually differ, not just the data attribute.
    expect(rep.className).not.toBe(recovery.className)
    expect(recovery.className).not.toBe(plain.className)

    // "Lap 1" (the unnumbered plain lap, lap_index 0) never carries a rep
    // number anywhere in its row.
    expect(within(plain).queryByText(/^Rep \d/)).toBeNull()
  })

  it('signs a lap elevation change correctly - lap 13 (lap_index 12) of the real session, an 11 m net descent', () => {
    // ascent_m 4, descent_m 15: a `+` mutation (ascent + descent) would
    // misreport this as +19 m instead of the true -11 m net descent.
    render(
      <Splits
        activityId="fixture-activity"
        laps={REFERENCE_INTERVAL_LAPS}
        isIntervalsSession
        repCount={5}
        repPattern={REFERENCE_INTERVAL_PATTERN}
        streams={null}
        streamsAbsentReason={null}
        streamsFailureReason={null}
      />,
    )
    const table = screen.getByRole('table')
    const rows = within(table).getAllByRole('row')
    const row = rows.find((r) => within(r).queryByText('Lap 13') !== null)
    if (row === undefined) throw new Error('expected lap 13 (lap_index 12)')
    expect(within(row).getByText('-11 m')).toBeInTheDocument()
    expect(within(row).queryByText('+19 m')).toBeNull()
  })

  it('renders every nullable Lap column as the no-value glyph, not a 0-shaped default, for a real all-null lap', () => {
    render(
      <Splits
        activityId="fixture-activity"
        laps={[ALL_NULL_LAP]}
        isIntervalsSession={false}
        repCount={null}
        repPattern={null}
        streams={null}
        streamsAbsentReason={null}
        streamsFailureReason={null}
      />,
    )
    fireEvent.click(screen.getByRole('tab', { name: /Laps/ }))
    const table = screen.getByRole('table')
    const row = within(table).getAllByRole('row')[1]
    if (row === undefined) throw new Error('expected one data row')
    // Looked up by header rather than by position. Positional
    // destructuring here broke the moment the pace bar moved into a column
    // of its own, and it broke *silently* in the sense that the assertions
    // then read the wrong cells - which is the same header-and-cell drift
    // the `SPLIT_COLUMNS` single-list refactor exists to prevent.
    const cellUnder = (header: string): HTMLElement => {
      const headers = within(table).getAllByRole('columnheader')
      const index = headers.findIndex((th) => th.textContent?.trim() === header)
      if (index === -1) throw new Error(`no column headed "${header}"`)
      const cell = within(row).getAllByRole('cell')[index]
      if (cell === undefined) throw new Error(`no cell under "${header}"`)
      return cell
    }
    const distanceCell = cellUnder('Distance')
    const paceCellEl = cellUnder('Pace')
    const hrCell = cellUnder('Heart rate')
    const cadenceCell = cellUnder('Cadence')
    const elevationCell = cellUnder('Elevation')

    // Distance: the no-value glyph, never "0.00 km".
    expect(distanceCell.textContent).toBe(NO_VALUE)
    // Pace, heart rate and cadence each carry their own no-value
    // rendering - never a bare 0 or a unit stapled onto nothing.
    expect(paceCellEl.textContent).toBe(NO_VALUE)
    expect(hrCell.textContent).toBe(NO_VALUE)
    expect(cadenceCell.textContent).toBe(NO_VALUE)
    // Elevation: null ascent/descent must not compute a change at all -
    // never a confident "+0 m" or "-0 m".
    expect(elevationCell.textContent).toBe(NO_VALUE)
  })

  it('renders the no-value glyph in the Time column for a null elapsed_time_s, never a fabricated 0:00', () => {
    // Not observed on any real lap - 0 of 5172 in the store carry a null
    // `elapsed_time_s` - but the field is nullable per the schema, the
    // same reasoning that justifies the constructed `distance_m: null`
    // header-stat fixture in ActivityDetail.test.tsx rather than declining
    // to test it. `duration(null)` already renders the bare glyph; this
    // pins that `Splits` actually calls it with the real value rather
    // than a `?? 0` that would silently turn a missing lap time into
    // "0:00".
    const noElapsedTime = lap({ lap_index: 0, elapsed_time_s: null, distance_m: 1000 })
    render(
      <Splits
        activityId="fixture-activity"
        laps={[noElapsedTime]}
        isIntervalsSession={false}
        repCount={null}
        repPattern={null}
        streams={null}
        streamsAbsentReason={null}
        streamsFailureReason={null}
      />,
    )
    fireEvent.click(screen.getByRole('tab', { name: /Laps/ }))
    const table = screen.getByRole('table')
    const row = within(table).getAllByRole('row')[1]
    if (row === undefined) throw new Error('expected one data row')
    const cells = within(row).getAllByRole('cell')
    const timeCell = cells[2]
    if (timeCell === undefined) throw new Error('expected a Time column')
    expect(timeCell.textContent).toBe(NO_VALUE)
    expect(timeCell.textContent).not.toBe('0:00')
  })

  it('shows the leftover distance below a kilometre as a partial, not as a full split', () => {
    const t = Array.from({ length: 15 }, (_, i) => i)
    const distanceM = t.map((ti) => ti * 100) // 1000 m at t=10, 400 m left over by t=14
    render(
      <Splits
        activityId="fixture-activity"
        laps={[]}
        isIntervalsSession={false}
        repCount={null}
        repPattern={null}
        streams={{ t, distanceM, hrBpm: emptyStream(t).hrBpm, cadenceSpm: emptyStream(t).cadenceSpm, altitudeM: emptyStream(t).altitudeM }}
        streamsAbsentReason={null}
        streamsFailureReason={null}
      />,
    )

    const table = screen.getByRole('table')
    const rows = within(table).getAllByRole('row')
    const partialRow = rows.find((r) => within(r).queryByText('Partial') !== null)
    if (partialRow === undefined) throw new Error('expected a partial row')
    expect(within(partialRow).getByText('partial')).toBeInTheDocument()
    // 400 m, not padded out to a full "1.00 km".
    expect(within(partialRow).getByText('0.40 km')).toBeInTheDocument()
    expect(within(partialRow).queryByText('1.00 km')).toBeNull()
  })

  it('states the reason instead of a blank panel when there is no 1 Hz grid, on the per-km tab', () => {
    render(
      <Splits
        activityId="fixture-activity"
        laps={REFERENCE_STEADY_LAPS}
        isIntervalsSession={false}
        repCount={null}
        repPattern={null}
        streams={null}
        streamsAbsentReason="no 1 Hz grid for this activity: it has not been recomputed yet"
        streamsFailureReason={null}
      />,
    )
    expect(screen.getByText(/has not been recomputed yet/)).toBeInTheDocument()
    // A 404 is a stated absence, never a failure - see M9 below.
    expect(screen.getByRole('note')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('states the failure as an alert, not a stated absence, when streams could not be loaded at all (M9)', () => {
    render(
      <Splits
        activityId="fixture-activity"
        laps={REFERENCE_STEADY_LAPS}
        isIntervalsSession={false}
        repCount={null}
        repPattern={null}
        streams={null}
        streamsAbsentReason={null}
        streamsFailureReason="DuckDB: file not found, run 'recompute'"
      />,
    )
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(/file not found/)
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('pairs each header to the field its own cells render, so a column cannot silently drift from its header (I5)', () => {
    // Real numbers from lap_index 2 ("Rep 1") of the reference interval
    // session: avg_hr_bpm 171, avg_cadence_spm 173.0625. A swap of the
    // Heart rate and Cadence `<td>`s - the exact mutation the branch's
    // final review applied to prove `SplitTable` had no test catching this -
    // would put 173 spm under the Heart rate header and fail this.
    render(
      <Splits
        activityId="fixture-activity"
        laps={REFERENCE_INTERVAL_LAPS}
        isIntervalsSession
        repCount={5}
        repPattern={REFERENCE_INTERVAL_PATTERN}
        streams={null}
        streamsAbsentReason={null}
        streamsFailureReason={null}
      />,
    )
    const table = screen.getByRole('table')
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent)
    const hrIndex = headers.findIndex((text) => text?.includes('Heart rate') ?? false)
    const cadenceIndex = headers.findIndex((text) => text?.includes('Cadence') ?? false)
    expect(hrIndex).toBeGreaterThanOrEqual(0)
    expect(cadenceIndex).toBeGreaterThanOrEqual(0)

    const rows = within(table).getAllByRole('row')
    const repRow = rows.find((r) => within(r).queryByText('Rep 1') !== null)
    if (repRow === undefined) throw new Error('expected the Rep 1 row')
    const cells = within(repRow).getAllByRole('cell')
    const hrCell = cells[hrIndex]
    const cadenceCell = cells[cadenceIndex]
    if (hrCell === undefined || cadenceCell === undefined) throw new Error('expected both columns to have a cell')

    expect(hrCell).toHaveTextContent(heartRate(171))
    expect(cadenceCell).toHaveTextContent(cadence(173.0625))
  })

  it('draws a distinct bar for every lap of a real interval session, reps and recoveries alike', () => {
    // The end-to-end version of `paceBarScale`'s own tests, through the
    // rendered table, on the real 14 laps of 6116b2e90f551a6c: 35.7, 12.0,
    // 100.0, 24.1, 92.5, 19.9, 92.9, 23.8, 91.9, 23.0, 89.4, 40.3, 45.8
    // and 61.7 percent of their cell. The reps span 89.4 to 100.0 - about
    // as tight as the 9.9 points the maintainer reported - but that compression is
    // inherent to a bimodal table, and the alternative this branch tried
    // (the reps alone setting the range) collapsed nine of these fourteen
    // rows onto one width.
    const { container } = render(
      <Splits
        activityId="fixture-activity"
        laps={REFERENCE_INTERVAL_LAPS}
        isIntervalsSession
        repCount={5}
        repPattern={REFERENCE_INTERVAL_PATTERN}
        streams={null}
        streamsAbsentReason="no grid for this fixture"
        streamsFailureReason={null}
      />,
    )

    /** The inline bar widths, as percentages, for every row of one role. */
    function barPercents(role: 'rep' | 'recovery' | 'plain' | ''): number[] {
      const scope = role === '' ? 'tr' : `tr[data-role="${role}"]`
      return Array.from(
        container.querySelectorAll<HTMLElement>(`${scope} [data-testid="pace-bar"]`),
        (bar) => Number.parseFloat(bar.style.width),
      )
    }

    const all = barPercents('')
    expect(all).toHaveLength(14)
    expect(new Set(all.map((width) => width.toFixed(1))).size).toBe(14)

    // The reps read as the fast cluster and the walked recoveries as the
    // slow one, and no recovery is confused with the cool-down that is
    // nearly twice its speed.
    const reps = barPercents('rep')
    const recoveries = barPercents('recovery')
    expect(reps).toHaveLength(5)
    expect(recoveries).toHaveLength(5)
    expect(Math.min(...reps)).toBeGreaterThan(Math.max(...recoveries) + 45)
    expect(Math.min(...recoveries)).toBeCloseTo(MIN_PACE_BAR_PERCENT, 5)
    expect(Math.max(...reps)).toBeCloseTo(100, 5)
    expect(new Set(recoveries.map((width) => width.toFixed(1))).size).toBe(5)
  })
})

describe('Splits - the leading tab tracks the activity (I1)', () => {
  const intervalsProps = {
    laps: REFERENCE_INTERVAL_LAPS,
    isIntervalsSession: true,
    repCount: 5,
    repPattern: REFERENCE_INTERVAL_PATTERN,
    streams: null,
    streamsAbsentReason: null,
    streamsFailureReason: null,
  } as const

  const steadyProps = {
    laps: REFERENCE_STEADY_LAPS,
    isIntervalsSession: false,
    repCount: null,
    repPattern: null,
    streams: null,
    streamsAbsentReason: null,
    streamsFailureReason: null,
  } as const

  it('resets to the leading tab for the new activity when activityId changes, even though both activities lead with Laps', () => {
    // The exact fault the final review proved against the real route tree:
    // a reader parks activity A on "Per km", then visits a *different*
    // interval activity B. B must lead with Laps regardless of what tab A
    // was left on - a version that only reads `isIntervalsSession` once
    // (in a `useState` initialiser, say) would leave B on "Per km" too,
    // since both activities pass `isIntervalsSession: true` and only the
    // `activityId` actually changes here.
    const { rerender } = render(<Splits activityId="activity-a" {...intervalsProps} />)

    fireEvent.click(screen.getByRole('tab', { name: /Per km/ }))
    expect(screen.getByRole('tab', { name: /Per km/ })).toHaveAttribute('aria-selected', 'true')

    rerender(<Splits activityId="activity-b" {...intervalsProps} />)

    expect(screen.getByRole('tab', { name: /^Laps/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /Per km/ })).toHaveAttribute('aria-selected', 'false')
  })

  it('keeps a chosen tab across a re-render for the same activity', () => {
    // The other half of the leading-tab fix: resetting on every render, not just
    // when activityId changes, would make switching tabs impossible to
    // keep - a re-render with the very same activityId (new data for the
    // activity already on screen, say) must not snap back to the default.
    const { rerender } = render(<Splits activityId="activity-a" {...intervalsProps} />)

    fireEvent.click(screen.getByRole('tab', { name: /Per km/ }))
    expect(screen.getByRole('tab', { name: /Per km/ })).toHaveAttribute('aria-selected', 'true')

    rerender(<Splits activityId="activity-a" {...intervalsProps} repCount={6} />)

    expect(screen.getByRole('tab', { name: /Per km/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('resets to Per km when the new activity is not an intervals session', () => {
    const { rerender } = render(<Splits activityId="activity-a" {...intervalsProps} />)
    expect(screen.getByRole('tab', { name: /^Laps/ })).toHaveAttribute('aria-selected', 'true')

    rerender(<Splits activityId="activity-c" {...steadyProps} />)

    expect(screen.getByRole('tab', { name: /Per km/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /^Laps/ })).toHaveAttribute('aria-selected', 'false')
  })
})
