import { describe, expect, it } from 'vitest'
import type { components } from '../api/schema'
import { calendarDayOfDate } from '../format'
import {
  LEAD_IN_WEEKS,
  barSlots,
  easyBand,
  goalPaceS,
  leadInSpan,
  leadInSummary,
  leadInWeeks,
  paceMarks,
  phaseBands,
  planDays,
  runCategory,
  sessionMix,
  sideBySide,
  stepDistance,
  todayInPlan,
  weeklyMix,
} from './planShapeMath'
import { DEFAULT_EASY_MPS, WORK_FACTOR } from './sessionProfileMath'

type S = components['schemas']

/*
 * Synthetic plans only: three Monday weeks from 2 March 2026 to a race on
 * Saturday 21 March, every figure made up.
 */
function session(id: string, date: string, over: Partial<S['Session']> = {}): S['Session'] {
  return { id, date, kind: 'easy', title: id, description: '', steps: [], ...over }
}

function week(start: string, phase: string, over: Partial<S['Week']> = {}): S['Week'] {
  return { start_date: start, phase, focus: '', planned_distance_m: 20000, detailed: true, sessions: [], ...over }
}

function plan(weeks: S['Week'][], over: { distanceM?: number; targetS?: number; raceDate?: string } = {}): S['PlanVersion'] {
  return {
    goal: {
      goal_id: 'g',
      distance_m: over.distanceM ?? 5000,
      target_time_s: over.targetS ?? 1500,
      race_date: over.raceDate ?? '2026-03-21',
      surface: 'road',
    },
    constraints: { runs_per_week: 3 },
    assessment: { summary: '', estimate_reasoning: '', verdict: 'possible', citations: [] },
    weeks,
    changes: [],
    outcomes: [],
    checkpoints: [],
    result: null,
    provenance: { number: 1, revises: null, created_at: '2026-02-28T12:00:00Z', data_through: null, snapshot: [] },
  }
}

const day = calendarDayOfDate

describe('phaseBands', () => {
  it('merges adjacent weeks of one phase into one band, case aside, in date order', () => {
    const weeks = [
      week('2026-03-16', 'taper'),
      week('2026-03-02', 'build'),
      week('2026-03-09', 'Build'),
    ]
    expect(phaseBands(weeks)).toEqual([
      { phase: 'Build', startDay: day('2026-03-02'), endDay: day('2026-03-16'), firstWeek: 1, lastWeek: 2 },
      { phase: 'Taper', startDay: day('2026-03-16'), endDay: day('2026-03-23'), firstWeek: 3, lastWeek: 3 },
    ])
  })

  it('keeps a phase that comes back after another as a band of its own', () => {
    const bands = phaseBands([week('2026-03-02', 'base'), week('2026-03-09', 'build'), week('2026-03-16', 'base')])
    expect(bands.map((b) => b.phase)).toEqual(['Base', 'Build', 'Base'])
  })
})

describe('planDays and todayInPlan', () => {
  it('spans the first Monday to the day after the last week, or after a race past it', () => {
    const weeks = [week('2026-03-02', 'build'), week('2026-03-16', 'taper')]
    expect(planDays(plan(weeks))).toEqual([day('2026-03-02'), day('2026-03-23')])
    expect(planDays(plan(weeks, { raceDate: '2026-03-25' }))).toEqual([day('2026-03-02'), day('2026-03-26')])
  })

  it('places today only inside the plan', () => {
    const span: [number, number] = [day('2026-03-02'), day('2026-03-23')]
    expect(todayInPlan(day('2026-03-10'), span)).toBe(day('2026-03-10'))
    expect(todayInPlan(day('2026-03-02'), span)).toBe(day('2026-03-02'))
    expect(todayInPlan(day('2026-03-01'), span)).toBeNull()
    expect(todayInPlan(day('2026-03-23'), span)).toBeNull()
  })
})

describe('stepDistance', () => {
  const tempo = session('t', '2026-03-04', { kind: 'tempo' })

  it('is distance times repeats', () => {
    expect(stepDistance(tempo, { role: 'work', repeat: 6, distance_m: 800 }, null)).toBe(4800)
  })

  it('is duration times repeats times the middle of the speed range for a timed step with a speed', () => {
    expect(
      stepDistance(tempo, { role: 'work', repeat: 2, duration_s: 600, speed: { low_mps: 3.0, high_mps: 3.4 } }, null),
    ).toBeCloseTo(2 * 600 * 3.2, 9)
  })

  it('times a timed step without a speed at the speed the workout profile draws its role at', () => {
    const work = { role: 'work', repeat: 4, duration_s: 300, heart_rate: { low_bpm: 160, high_bpm: 170 } } as const
    expect(stepDistance(tempo, work, null)).toBeCloseTo(4 * 300 * DEFAULT_EASY_MPS * WORK_FACTOR, 9)
    expect(stepDistance(tempo, work, 3.0)).toBeCloseTo(4 * 300 * 3.0 * WORK_FACTOR, 9)
    // The work of an easy run is easy running, drawn at easy speed.
    expect(stepDistance(session('e', '2026-03-03'), work, 3.0)).toBeCloseTo(4 * 300 * 3.0, 9)
  })

  it('counts nothing for a step with neither a distance nor a duration', () => {
    expect(stepDistance(tempo, { role: 'recovery', repeat: 1 }, null)).toBe(0)
  })
})

function expectMix(actual: { easyM: number; qualityM: number; raceM: number }, expected: typeof actual): void {
  expect(actual.easyM).toBeCloseTo(expected.easyM, 6)
  expect(actual.qualityM).toBeCloseTo(expected.qualityM, 6)
  expect(actual.raceM).toBeCloseTo(expected.raceM, 6)
}

describe('sessionMix', () => {
  it('counts the work of a quality session as quality and its warm-up, recoveries and cool-down as easy', () => {
    const mix = sessionMix(
      session('i', '2026-03-03', {
        kind: 'intervals',
        planned_distance_m: 10000,
        steps: [
          { role: 'warmup', repeat: 1, distance_m: 2000 },
          { role: 'work', repeat: 5, distance_m: 1000, speed: { low_mps: 3.8, high_mps: 4.0 } },
          { role: 'recovery', repeat: 5, duration_s: 120 },
          { role: 'cooldown', repeat: 1, distance_m: 1500 },
        ],
      }),
      null,
    )
    // The recoveries are timed at the profile's recovery speed and the
    // planned distance they leave uncovered is easy too, so all but the
    // 5000 m of work is easy.
    expectMix(mix, { easyM: 5000, qualityM: 5000, raceM: 0 })
  })

  it('counts a tempo held by heart rate alone as quality, timed at the profile\'s work speed', () => {
    const tempo = session('t', '2026-03-04', {
      kind: 'tempo',
      planned_distance_m: 10000,
      steps: [
        { role: 'warmup', repeat: 1, distance_m: 2000 },
        { role: 'work', repeat: 1, duration_s: 1200, heart_rate: { low_bpm: 165, high_bpm: 172 } },
        { role: 'cooldown', repeat: 1, distance_m: 2000 },
      ],
    })
    const workM = 1200 * DEFAULT_EASY_MPS * WORK_FACTOR
    expectMix(sessionMix(tempo, null), { easyM: 10000 - workM, qualityM: workM, raceM: 0 })
  })

  it('counts the work of a time trial or a race as race', () => {
    const trial = session('t', '2026-03-05', {
      kind: 'time_trial',
      planned_distance_m: 7000,
      steps: [
        { role: 'warmup', repeat: 1, distance_m: 2000 },
        { role: 'work', repeat: 1, distance_m: 3000 },
        { role: 'cooldown', repeat: 1, distance_m: 2000 },
      ],
    })
    expect(sessionMix(trial, null)).toEqual({ easyM: 4000, qualityM: 0, raceM: 3000 })
  })

  it('counts every step of an easy, long or strides session as easy, and a session with no steps as its planned distance', () => {
    const long = session('l', '2026-03-08', {
      kind: 'long',
      planned_distance_m: 16000,
      steps: [
        { role: 'work', repeat: 1, distance_m: 13000 },
        { role: 'work', repeat: 1, distance_m: 3000, speed: { low_mps: 3.2, high_mps: 3.3 } },
      ],
    })
    expect(sessionMix(long, null)).toEqual({ easyM: 16000, qualityM: 0, raceM: 0 })
    expect(sessionMix(session('e', '2026-03-04', { planned_distance_m: 8000 }), null)).toEqual({
      easyM: 8000,
      qualityM: 0,
      raceM: 0,
    })
  })

  it('never takes away distance when the steps run past the planned distance', () => {
    const over = session('i', '2026-03-03', {
      kind: 'tempo',
      planned_distance_m: 5000,
      steps: [
        { role: 'warmup', repeat: 1, distance_m: 2000 },
        { role: 'work', repeat: 1, distance_m: 4000 },
      ],
    })
    expect(sessionMix(over, null)).toEqual({ easyM: 2000, qualityM: 4000, raceM: 0 })
  })

  it('counts a session planned by duration alone as that time at the easy speed', () => {
    const timed = session('e', '2026-03-04', { planned_duration_s: 2400 })
    expectMix(sessionMix(timed, null), { easyM: 2400 * DEFAULT_EASY_MPS, qualityM: 0, raceM: 0 })
    expectMix(sessionMix(timed, 3.0), { easyM: 7200, qualityM: 0, raceM: 0 })
  })

  it('counts nothing for rest and cross-training', () => {
    expect(sessionMix(session('r', '2026-03-06', { kind: 'rest', planned_distance_m: 5000 }), null)).toEqual({
      easyM: 0,
      qualityM: 0,
      raceM: 0,
    })
  })
})

describe('weeklyMix', () => {
  it('sums each detailed week and gives an outline week its planned distance as not yet detailed', () => {
    const weeks = [
      week('2026-03-09', 'build', { detailed: false, planned_distance_m: 30000 }),
      week('2026-03-02', 'build', {
        sessions: [
          session('e', '2026-03-03', { planned_distance_m: 8000 }),
          session('t', '2026-03-05', {
            kind: 'threshold',
            planned_distance_m: 9000,
            steps: [{ role: 'work', repeat: 1, duration_s: 1200, speed: { low_mps: 3.4, high_mps: 3.6 } }],
          }),
        ],
      }),
    ]
    expect(weeklyMix(plan(weeks))).toEqual([
      { startDate: '2026-03-02', easyM: 8000 + 9000 - 4200, qualityM: 4200, raceM: 0, outlineM: null },
      { startDate: '2026-03-09', easyM: 0, qualityM: 0, raceM: 0, outlineM: 30000 },
    ])
  })
})

describe('paceMarks', () => {
  it('takes every work step with a speed from the quality, trial and race sessions, side by side on a day', () => {
    const weeks = [
      week('2026-03-02', 'build', {
        sessions: [
          session('e', '2026-03-03', {
            steps: [{ role: 'work', repeat: 1, distance_m: 8000, speed: { low_mps: 2.5, high_mps: 2.8 } }],
          }),
          session('i', '2026-03-04', {
            kind: 'intervals',
            steps: [
              { role: 'warmup', repeat: 1, distance_m: 2000, speed: { low_mps: 2.5, high_mps: 2.8 } },
              { role: 'work', repeat: 4, distance_m: 1000, speed: { low_mps: 3.9, high_mps: 4.0 } },
              { role: 'work', repeat: 4, distance_m: 200, speed: { low_mps: 4.5, high_mps: 5.0 } },
              { role: 'work', repeat: 4, duration_s: 20 },
            ],
          }),
        ],
      }),
      week('2026-03-09', 'build', { detailed: false }),
      week('2026-03-16', 'taper', {
        sessions: [
          session('r', '2026-03-21', {
            kind: 'race',
            steps: [{ role: 'work', repeat: 1, distance_m: 5000, speed: { low_mps: 3.7, high_mps: 3.75 } }],
          }),
        ],
      }),
    ]
    const marks = paceMarks(plan(weeks))
    expect(marks.map((m) => [m.sessionId, m.kind, m.index, m.count])).toEqual([
      ['i', 'intervals', 0, 2],
      ['i', 'intervals', 1, 2],
      ['r', 'race', 0, 1],
    ])
    expect(marks[0]?.day).toBe(day('2026-03-04'))
    expect(marks[0]?.fastS).toBeCloseTo(250, 9)
    expect(marks[0]?.slowS).toBeCloseTo(1000 / 3.9, 9)
    expect(marks[0]?.speed).toEqual({ low_mps: 3.9, high_mps: 4.0 })
  })
})

describe('easyBand', () => {
  it("spans the easy sessions' work steps, fastest to slowest, and nothing else", () => {
    const weeks = [
      week('2026-03-02', 'build', {
        sessions: [
          session('e1', '2026-03-03', {
            steps: [
              { role: 'work', repeat: 1, distance_m: 8000, speed: { low_mps: 2.6, high_mps: 2.8 } },
              { role: 'work', repeat: 4, duration_s: 20 },
            ],
          }),
          session('e2', '2026-03-05', {
            steps: [
              { role: 'warmup', repeat: 1, distance_m: 1000, speed: { low_mps: 2.0, high_mps: 2.2 } },
              { role: 'work', repeat: 1, distance_m: 6000, speed: { low_mps: 2.5, high_mps: 2.7 } },
            ],
          }),
          // A long run's faster finish and a tempo's work are not easy.
          session('l', '2026-03-08', {
            kind: 'long',
            steps: [{ role: 'work', repeat: 1, distance_m: 3000, speed: { low_mps: 3.2, high_mps: 3.3 } }],
          }),
          session('t', '2026-03-06', {
            kind: 'tempo',
            steps: [{ role: 'work', repeat: 1, distance_m: 5000, speed: { low_mps: 3.4, high_mps: 3.5 } }],
          }),
        ],
      }),
    ]
    const band = easyBand(plan(weeks))
    expect(band?.fastS).toBeCloseTo(1000 / 2.8, 9)
    expect(band?.slowS).toBeCloseTo(1000 / 2.5, 9)
  })

  it('is null without an easy work step that has a speed', () => {
    expect(easyBand(plan([week('2026-03-02', 'build', { sessions: [session('e', '2026-03-03')] })]))).toBeNull()
  })
})

describe('goalPaceS', () => {
  it("is the goal's target time per kilometre", () => {
    expect(goalPaceS({ distance_m: 5000, target_time_s: 1500 })).toBe(300)
    expect(goalPaceS({ distance_m: 10000, target_time_s: 3000 })).toBe(300)
  })
})

describe('barSlots and sideBySide', () => {
  it('stands one bar in the middle of each slot, never wider than half of it', () => {
    const slots = barSlots(4, 0, 400)
    expect(slots.map((s) => s.centre)).toEqual([50, 150, 250, 350])
    expect(slots[0]?.width).toBeLessThanOrEqual(50)
    expect((slots[0]?.x ?? 0) + (slots[0]?.width ?? 0) / 2).toBe(50)
  })

  it('centres several marks of one day around its x', () => {
    expect(sideBySide(1, 0, 6, 2)).toBe(0)
    expect(sideBySide(2, 0, 6, 2)).toBe(-4)
    expect(sideBySide(2, 1, 6, 2)).toBe(4)
    expect(sideBySide(3, 1, 6, 2)).toBe(0)
  })
})

function run(id: string, startUtc: string, distanceM: number, over: Partial<S['ActivitySummary']> = {}): S['ActivitySummary'] {
  return {
    activity_id: id,
    start_time_utc: startUtc,
    utc_offset_s: 3600,
    sport: 'running',
    recorded_sport: 'running',
    sub_sport: null,
    name: null,
    distance_m: distanceM,
    elapsed_time_s: null,
    timer_time_s: null,
    moving_time_s: null,
    ascent_m: null,
    descent_m: null,
    avg_speed_mps: null,
    max_speed_mps: null,
    avg_hr_bpm: null,
    max_hr_bpm: null,
    avg_cadence_spm: null,
    calories: null,
    source: 'garmin_fit',
    pr_distance_keys: [],
    effort_tags: [],
    ...over,
  }
}

describe('leadInSpan', () => {
  it('is the eight Monday weeks before the first week, to as the exclusive first Monday', () => {
    const weeks = [week('2026-03-09', 'build'), week('2026-03-02', 'build')]
    expect(LEAD_IN_WEEKS).toBe(8)
    expect(leadInSpan(plan(weeks))).toEqual({ from: '2026-01-05', to: '2026-03-02', startDay: day('2026-01-05') })
    expect(leadInSpan(plan([]))).toBeNull()
  })
})

describe('runCategory', () => {
  it('takes the first of long, all-out, intervals, then steady or easy', () => {
    expect(runCategory(['easy', 'long_run', 'pr'])).toBe('long')
    expect(runCategory(['all_out', 'pr'])).toBe('all_out')
    expect(runCategory(['intervals'])).toBe('intervals')
    expect(runCategory(['steady'])).toBe('easy')
    expect(runCategory(['easy'])).toBe('easy')
    expect(runCategory(['all_out', 'long_run'])).toBe('long')
  })

  it('leaves a run with no effort tag, or whose tags are unknown, unclassified', () => {
    expect(runCategory([])).toBe('unclassified')
    expect(runCategory(['heat'])).toBe('unclassified')
  })
})

describe('leadInWeeks and leadInSummary', () => {
  const start = day('2026-01-05')
  const runs = [
    // Sunday 11 January at 23:30 local: week 1, though it is Sunday 22:30 UTC.
    run('a', '2026-01-11T22:30:00Z', 10000, { effort_tags: ['easy'] }),
    // Monday 12 January at 00:30 local, Sunday 23:30 UTC: week 2.
    run('b', '2026-01-11T23:30:00Z', 5000, { pr_distance_keys: ['5k'], effort_tags: ['all_out'] }),
    run('c', '2026-01-14T17:00:00Z', 8000, { effort_tags: ['intervals'] }),
    run('d', '2026-02-26T17:00:00Z', 16000, { pr_distance_keys: ['10k', 'half'], effort_tags: ['steady', 'long_run'] }),
    // Before the span and on the plan's first Monday: left out.
    run('x', '2026-01-04T10:00:00Z', 9000, { effort_tags: ['easy'] }),
    run('y', '2026-03-02T10:00:00Z', 9000, { effort_tags: ['easy'] }),
  ]

  it('files each run under the Monday week of its local day, eight weeks with the empty ones kept', () => {
    const weeks = leadInWeeks(runs, start)
    expect(weeks).toHaveLength(8)
    expect(weeks.map((w) => w.startDay)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => start + 7 * i))
    expect(weeks[0]?.byCategory).toEqual({ easy: 10000, long: 0, intervals: 0, all_out: 0, unclassified: 0 })
    expect(weeks[1]?.byCategory).toEqual({ easy: 0, long: 0, intervals: 8000, all_out: 5000, unclassified: 0 })
    expect(weeks[1]?.totalM).toBe(13000)
    expect(weeks[1]?.runCount).toBe(2)
    expect(weeks[2]?.totalM).toBe(0)
    expect(weeks[2]?.runCount).toBe(0)
    expect(weeks[7]?.byCategory.long).toBe(16000)
  })

  it('marks a week with its record runs, and a run with no effort tag is unclassified', () => {
    const untagged = runs.map((r) => ({ ...r, effort_tags: [] }))
    const weeks = leadInWeeks(untagged, start)
    expect(weeks[1]?.records).toEqual([{ activityId: 'b', distanceM: 5000, distanceKeys: ['5k'] }])
    expect(weeks[7]?.records).toEqual([{ activityId: 'd', distanceM: 16000, distanceKeys: ['10k', 'half'] }])
    expect(weeks[0]?.records).toEqual([])
    expect(weeks[0]?.byCategory.unclassified).toBe(10000)
  })

  it('summarises the eight weeks: the weekly average, runs a week, the longest run and the quality sessions', () => {
    const summary = leadInSummary(leadInWeeks(runs, start))
    expect(summary.avgWeeklyM).toBe(39000 / 8)
    expect(summary.runsPerWeek).toBe(4 / 8)
    expect(summary.longestM).toBe(16000)
    expect(summary.qualityCount).toBe(2)
  })

  it('has no longest run when nothing was run', () => {
    expect(leadInSummary(leadInWeeks([], start))).toEqual({
      avgWeeklyM: 0,
      runsPerWeek: 0,
      longestM: null,
      qualityCount: 0,
    })
  })
})
