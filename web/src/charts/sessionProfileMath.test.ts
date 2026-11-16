import { describe, expect, it } from 'vitest'
import type { components } from '../api/schema'
import {
  DEFAULT_EASY_MPS,
  DEFAULT_STRIDE_MPS,
  RECOVERY_FACTOR,
  STRIDE_FACTOR,
  STRIDE_GAP_S,
  isHard,
  planEasySpeed,
  planProfileScale,
  profileDescription,
  profilePieces,
  readoutBeside,
  segmentAt,
  segmentReadout,
  sessionProfile,
  timeTicks,
} from './sessionProfileMath'

type S = components['schemas']
type Step = S['Step']

/* Synthetic sessions only, every figure made up. */
function session(steps: Step[], over: Partial<S['Session']> = {}): S['Session'] {
  return { id: 's', date: '2026-03-04', kind: 'intervals', title: 's', description: '', steps, ...over }
}

function step(role: Step['role'], over: Partial<Step> = {}): Step {
  return { role, repeat: 1, ...over }
}

const speed = (low: number, high: number) => ({ low_mps: low, high_mps: high })

function plan(sessions: S['Session'][]): S['PlanVersion'] {
  return {
    goal: { goal_id: 'g', distance_m: 5000, target_time_s: 1500, race_date: '2026-03-21', surface: 'road' },
    constraints: { runs_per_week: 3 },
    assessment: { summary: '', estimate_reasoning: '', verdict: 'possible', citations: [] },
    weeks: [{ start_date: '2026-03-02', phase: 'build', focus: '', planned_distance_m: 20000, detailed: true, sessions }],
    changes: [],
    outcomes: [],
    checkpoints: [],
    result: null,
    provenance: { number: 1, revises: null, created_at: '2026-02-28T12:00:00Z', data_through: null, snapshot: [] },
  }
}

describe('profilePieces', () => {
  it('interleaves a work step with the recovery after it that has the same repeats, ending on work', () => {
    const pieces = profilePieces(
      session([
        step('warmup', { duration_s: 900 }),
        step('work', { repeat: 3, distance_m: 800, speed: speed(4.0, 4.0) }),
        step('recovery', { repeat: 3, duration_s: 90 }),
        step('cooldown', { duration_s: 600 }),
      ]),
      null,
    )
    expect(pieces.map((p) => p.role)).toEqual(['warmup', 'work', 'recovery', 'work', 'recovery', 'work', 'cooldown'])
    expect(pieces.filter((p) => p.role === 'work').map((p) => p.rep)).toEqual([1, 2, 3])
    expect(pieces.filter((p) => p.role === 'recovery').map((p) => p.stepIndex)).toEqual([2, 2])
    // The interleaved pair is one group, so the label and the words read it as one set.
    expect(new Set(pieces.slice(1, 6).map((p) => p.group)).size).toBe(1)
  })

  it('interleaves two reps with one recovery between them', () => {
    const pieces = profilePieces(
      session([step('work', { repeat: 2, duration_s: 600 }), step('recovery', { repeat: 1, duration_s: 120 })]),
      null,
    )
    expect(pieces.map((p) => p.role)).toEqual(['work', 'recovery', 'work'])
  })

  it('interleaves a recovery written with one repeat fewer than the work, dropping none', () => {
    const pieces = profilePieces(
      session([step('work', { repeat: 3, distance_m: 400 }), step('recovery', { repeat: 2, duration_s: 60 })]),
      null,
    )
    expect(pieces.map((p) => p.role)).toEqual(['work', 'recovery', 'work', 'recovery', 'work'])
  })

  it('repeats any other step in place, a single work and recovery among them', () => {
    const pieces = profilePieces(
      session([
        step('work', { repeat: 3, duration_s: 600 }),
        step('recovery', { repeat: 1, duration_s: 120 }),
        step('work', { repeat: 1, duration_s: 300 }),
        step('recovery', { repeat: 1, duration_s: 60 }),
      ]),
      null,
    )
    expect(pieces.map((p) => p.role)).toEqual(['work', 'work', 'work', 'recovery', 'work', 'recovery'])
  })

  it('puts a 45 s walk, drawn as recovery, between strides and none after the last', () => {
    const pieces = profilePieces(
      session([step('work', { distance_m: 5000, speed: speed(2.8, 3.0) }), step('strides', { repeat: 4, duration_s: 20 })], {
        kind: 'easy',
      }),
      null,
    )
    expect(pieces.map((p) => p.role)).toEqual(['work', 'strides', 'recovery', 'strides', 'recovery', 'strides', 'recovery', 'strides'])
    const gaps = pieces.filter((p) => p.gap)
    expect(gaps).toHaveLength(3)
    expect(gaps.every((g) => g.durationS === STRIDE_GAP_S && g.stepIndex === 1)).toBe(true)
  })

  it('takes a duration as written, else the distance over the middle of the speed range, else over 2.7 m/s', () => {
    const [timed, ranged, bare] = profilePieces(
      session([
        step('warmup', { duration_s: 900, speed: speed(2.0, 3.0) }),
        step('work', { distance_m: 1000, speed: speed(4.0, 6.0) }),
        step('cooldown', { distance_m: 2700 }),
      ]),
      null,
    )
    expect(timed?.durationS).toBe(900)
    expect(ranged?.durationS).toBeCloseTo(200)
    expect(bare?.durationS).toBeCloseTo(1000)
    expect(DEFAULT_EASY_MPS).toBe(2.7)
  })

  it('times a distance step without a speed at the speed its role is drawn at', () => {
    const [strides] = profilePieces(session([step('strides', { repeat: 6, distance_m: 100 })], { kind: 'easy' }), null)
    expect(strides?.durationS).toBeCloseTo(100 / DEFAULT_STRIDE_MPS, 9)
    const [, recovery] = profilePieces(
      session([step('work', { distance_m: 1000, speed: speed(4.0, 4.0) }), step('recovery', { distance_m: 400 })]),
      null,
    )
    expect(recovery?.durationS).toBeCloseTo(400 / (DEFAULT_EASY_MPS * RECOVERY_FACTOR), 9)
  })

  it('gives a step without a speed an intensity by its role', () => {
    const pieces = profilePieces(
      session([
        step('warmup', { duration_s: 600 }),
        step('work', { repeat: 2, distance_m: 400, speed: speed(4.8, 5.2) }),
        step('recovery', { repeat: 2, duration_s: 60 }),
        step('strides', { repeat: 2, duration_s: 20 }),
        step('cooldown', { duration_s: 600 }),
      ]),
      3.0,
    )
    const by = (role: Step['role']) => pieces.find((p) => p.role === role && !p.gap)
    expect(by('warmup')?.speedMps).toBe(3.0)
    expect(by('warmup')?.speedSet).toBe(false)
    expect(by('recovery')?.speedMps).toBeCloseTo(3.0 * RECOVERY_FACTOR)
    expect(by('work')?.speedMps).toBe(5.0)
    expect(by('work')?.speedSet).toBe(true)
    expect(by('strides')?.speedMps).toBeCloseTo(5.0 * STRIDE_FACTOR)
    expect(by('cooldown')?.speedMps).toBe(3.0)
  })

  it("draws a quality session's work without a pace as work, beside work that names one", () => {
    const steps = [
      step('work', { repeat: 3, duration_s: 600, heart_rate: { low_bpm: 165, high_bpm: 172 } }),
      step('work', { distance_m: 1000, speed: speed(4.0, 4.2) }),
    ]
    const [rep] = profilePieces(session(steps, { kind: 'threshold' }), 2.7)
    expect(rep?.speedMps).toBeCloseTo(2.7 * 1.2)
    expect(isHard('work', rep?.speedMps ?? 0, 2.7)).toBe(true)
    // A long run's work without a pace is its easy running, steady block or not.
    const [easy] = profilePieces(session(steps, { kind: 'long' }), 2.7)
    expect(easy?.speedMps).toBe(2.7)
    expect(isHard('work', easy?.speedMps ?? 0, 2.7)).toBe(false)
  })

  it('runs strides no slower than 4.5 m/s when the session has no fast work', () => {
    const [, stride] = profilePieces(
      session([step('work', { distance_m: 6000, speed: speed(2.6, 2.8) }), step('strides', { repeat: 1, duration_s: 20 })], {
        kind: 'easy',
      }),
      null,
    )
    expect(stride?.speedMps).toBe(DEFAULT_STRIDE_MPS)
  })

  it('gives a session with no steps one piece of its planned distance at the easy speed', () => {
    const pieces = profilePieces(session([], { kind: 'easy', planned_distance_m: 8100 }), 2.7)
    expect(pieces).toHaveLength(1)
    expect(pieces[0]).toMatchObject({ role: 'work', stepIndex: null, speedMps: 2.7, speedSet: false })
    expect(pieces[0]?.durationS).toBeCloseTo(3000)
  })

  it('gives a session with no steps and only a planned duration that duration', () => {
    const pieces = profilePieces(session([], { kind: 'long', planned_duration_s: 4200 }), null)
    expect(pieces[0]?.durationS).toBe(4200)
  })

  it('gives a rest day and a session with nothing to draw no pieces', () => {
    expect(profilePieces(session([], { kind: 'rest', planned_duration_s: 1800 }), null)).toEqual([])
    expect(profilePieces(session([], { kind: 'cross_training', planned_duration_s: 1800 }), null)).toEqual([])
    expect(profilePieces(session([], { kind: 'easy' }), null)).toEqual([])
  })
})

describe('sessionProfile', () => {
  const intervals = session([
    step('warmup', { duration_s: 600 }),
    step('work', { repeat: 2, duration_s: 300, speed: speed(4.5, 4.5) }),
    step('recovery', { repeat: 2, duration_s: 300 }),
    step('cooldown', { duration_s: 600 }),
  ])

  it('lays the segments end to end as fractions of the session time', () => {
    const profile = sessionProfile(intervals, { easyMps: 3.0 })
    expect(profile?.totalS).toBe(2100)
    const xs = profile?.segments.map((s) => s.x) ?? []
    expect(xs[0]).toBe(0)
    expect(profile?.segments.at(-1)?.x).toBeCloseTo(1 - 600 / 2100)
    const widths = profile?.segments.reduce((sum, s) => sum + s.width, 0)
    expect(widths).toBeCloseTo(1)
  })

  it('scales heights from below recovery to the fastest segment, so a hard rep stands tallest', () => {
    const profile = sessionProfile(intervals, { easyMps: 3.0 })
    const segments = profile?.segments ?? []
    const height = (role: Step['role']) => segments.find((s) => s.role === role)?.height ?? NaN
    expect(height('work')).toBe(1)
    expect(height('warmup')).toBeLessThan(height('work'))
    expect(height('recovery')).toBeLessThan(height('warmup'))
    expect(height('recovery')).toBeGreaterThan(0)
    expect(profile?.scale.floorMps).toBeLessThan(3.0 * RECOVERY_FACTOR)
    expect(profile?.scale.topMps).toBe(4.5)
  })

  it('draws on a scale it is given, so sessions of one plan compare', () => {
    const easy = session([step('work', { distance_m: 6000, speed: speed(3.0, 3.0) })], { kind: 'easy' })
    const own = sessionProfile(easy, { easyMps: 3.0 })
    const shared = sessionProfile(easy, { easyMps: 3.0, scale: { floorMps: 2.0, topMps: 5.0 } })
    expect(own?.segments[0]?.height).toBe(1)
    expect(shared?.segments[0]?.height).toBeCloseTo(1 / 3)
  })

  it('groups a work step and its interleaved recoveries for a label', () => {
    const profile = sessionProfile(intervals, { easyMps: 3.0 })
    const work = profile?.groups.filter((g) => g.role === 'work') ?? []
    expect(work).toHaveLength(1)
    expect(work[0]?.x).toBeCloseTo(600 / 2100)
    expect(work[0]?.width).toBeCloseTo(900 / 2100)
    expect(work[0]?.stepIndex).toBe(1)
    expect(work[0]?.recoveryStepIndex).toBe(2)
  })

  it('is null for a session with nothing to draw', () => {
    expect(sessionProfile(session([], { kind: 'rest' }), {})).toBeNull()
  })
})

describe('planEasySpeed and planProfileScale', () => {
  const easy = session([step('work', { distance_m: 6000, speed: speed(2.8, 3.0) })], { kind: 'easy', id: 'e1' })
  const easy2 = session([step('work', { distance_m: 6000, speed: speed(3.0, 3.2) })], { kind: 'easy', id: 'e2' })
  const reps = session([step('work', { repeat: 4, distance_m: 400, speed: speed(5.0, 5.0) })], { id: 'i' })

  it('reads the easy speed from the easy sessions, and is null without one', () => {
    expect(planEasySpeed(plan([easy, easy2, reps]))).toBeCloseTo(3.0)
    expect(planEasySpeed(plan([reps]))).toBeNull()
  })

  it('spans every session of the plan, top at the fastest segment', () => {
    const scale = planProfileScale(plan([easy, reps]))
    expect(scale?.topMps).toBe(5.0)
    expect(scale?.floorMps).toBeLessThan(2.9 * RECOVERY_FACTOR)
    expect(planProfileScale(plan([]))).toBeNull()
  })
})

describe('profileDescription', () => {
  it('says the session in words, grouped as it is drawn', () => {
    const s = session([
      step('warmup', { duration_s: 900 }),
      step('strides', { repeat: 4, duration_s: 20 }),
      step('work', { repeat: 6, distance_m: 800, speed: speed(3.8462, 3.9216) }),
      step('recovery', { repeat: 6, distance_m: 400 }),
      step('cooldown', { duration_s: 540 }),
    ])
    const profile = sessionProfile(s, {})
    expect(profile && profileDescription(s, profile)).toBe(
      'warm-up 15 min, 4 × 20 s strides, 6 × 800 m at 4:15-4:20/km with 400 m recoveries, cool-down 9 min',
    )
  })

  it('says a session with no steps is one run of its planned distance', () => {
    const s = session([], { kind: 'easy', planned_distance_m: 8000 })
    const profile = sessionProfile(s, {})
    expect(profile && profileDescription(s, profile)).toBe('one run of 8 km')
  })
})

describe('timeTicks', () => {
  it('steps whole minutes far enough apart for their labels', () => {
    expect(timeTicks(3600, 600)).toEqual([0, 600, 1200, 1800, 2400, 3000, 3600])
    expect(timeTicks(3600, 300)).toEqual([0, 1200, 2400, 3600])
    expect(timeTicks(600, 600)).toEqual([0, 120, 240, 360, 480, 600])
  })

  it('has no ticks for a session with no time', () => {
    expect(timeTicks(0, 600)).toEqual([])
  })
})

describe('segmentReadout', () => {
  const s = session([
    step('work', { repeat: 2, distance_m: 800, speed: speed(3.8462, 3.9216), heart_rate: { low_bpm: 170, high_bpm: 178 }, note: '8/10' }),
    step('recovery', { repeat: 2, duration_s: 90 }),
    step('strides', { repeat: 2, duration_s: 20 }),
  ])
  const segments = sessionProfile(s, {})?.segments ?? []

  it('heads a rep with its role and its place in the set, then its length, pace, heart rate and note', () => {
    expect(segmentReadout(s, segments[0]!)).toEqual({
      heading: 'Work 1 of 2',
      rows: ['800 m', '4:15-4:20/km', '170-178 bpm', '8/10'],
    })
  })

  it('labels the heart rate with the zone of its top when given the zone boundaries', () => {
    expect(segmentReadout(s, segments[0]!, [150, 160, 170, 180]).rows).toContain('170-178 bpm (Z4)')
  })

  it('says a step without a pace has none', () => {
    expect(segmentReadout(s, segments[1]!)).toEqual({ heading: 'Recovery', rows: ['1:30', 'No pace set'] })
  })

  it('calls the gap between strides a walk', () => {
    const gap = segments.find((g) => g.gap)
    expect(gap && segmentReadout(s, gap)).toEqual({ heading: 'Walk', rows: ['45 s', 'Between strides'] })
  })

  it('reads a session with no steps as one run of its planned extent', () => {
    const run = session([], { kind: 'easy', planned_distance_m: 8000 })
    const [only] = sessionProfile(run, {})?.segments ?? []
    expect(only && segmentReadout(run, only)).toEqual({ heading: 'Easy run', rows: ['8 km', 'No pace set'] })
  })
})

describe('segmentAt', () => {
  const profile = sessionProfile(
    session([step('warmup', { duration_s: 600 }), step('work', { duration_s: 300, speed: speed(4.5, 4.5) })]),
    { easyMps: 3.0 },
  )
  const segments = profile?.segments ?? []

  it('finds the segment at a fraction of the session time', () => {
    expect(segmentAt(segments, 0)).toBe(0)
    expect(segmentAt(segments, 0.7)).toBe(1)
    expect(segmentAt(segments, 0.999)).toBe(1)
  })

  it('finds none outside the session, so the readout does not fall back on the last segment', () => {
    expect(segmentAt(segments, -0.01)).toBeNull()
    expect(segmentAt(segments, 1)).toBeNull()
    expect(segmentAt(segments, 1.2)).toBeNull()
  })
})

describe('readoutBeside', () => {
  it('sits right of the anchor with a gap, inside the panel', () => {
    expect(readoutBeside(100, 120, 600)).toBe(112)
  })

  it('goes left of the anchor when the right side has no room', () => {
    expect(readoutBeside(550, 120, 600)).toBe(550 - 12 - 120)
  })

  it('keeps inside the panel when neither side has room', () => {
    expect(readoutBeside(60, 120, 150)).toBe(30)
  })
})
