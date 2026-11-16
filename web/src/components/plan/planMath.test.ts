import { describe, expect, it } from 'vitest'
import type { components } from '../../api/schema'
import {
  archivedByAccepting,
  calendarWeeks,
  changedSessionIds,
  checkpointSessions,
  currentAndPending,
  dataAgeDays,
  daysToRace,
  displayedGoal,
  goalChangesFirst,
  nextSession,
  nextWeek,
  outcomeBySession,
  paceRange,
  planSpan,
  raceSetsEstimate,
  runsByLocalDay,
  sessionEntries,
  sessionEntry,
  sessionTarget,
  shownVersion,
  snapshotPrediction,
  timeTrialDate,
  trajectory,
  weeklyDistance,
} from './planMath'

type S = components['schemas']
type Session = S['Session']
type PlanVersion = S['PlanVersion']
type PlanSummary = S['PlanSummary']
type PlanDetail = S['PlanDetail']
type ActivitySummary = S['ActivitySummary']

function session(id: string, date: string, over: Partial<Session> = {}): Session {
  return { id, date, kind: 'easy', title: id, description: '', steps: [], ...over }
}

function version(
  sessions: Session[],
  over: {
    weeks?: S['Week'][]
    snapshot?: S['SnapshotPrediction'][]
    number?: number
    checkpoints?: S['Checkpoint'][]
    dataThrough?: string | null
  } = {},
): PlanVersion {
  return {
    goal: { distance_m: 10000, target_time_s: 3000, race_date: '2027-03-13' },
    weeks: over.weeks ?? [
      { start_date: '2027-02-01', phase: 'build', focus: '', planned_distance_m: 30000, detailed: true, sessions },
    ],
    changes: [],
    outcomes: [],
    checkpoints: over.checkpoints ?? [],
    provenance: {
      number: over.number ?? 1,
      revises: null,
      created_at: '2027-01-24T10:00:00Z',
      data_through: over.dataThrough === undefined ? '2027-01-23' : over.dataThrough,
      snapshot: over.snapshot ?? [],
    },
  } as unknown as PlanVersion
}

function summary(over: Partial<PlanSummary>): PlanSummary {
  return {
    goal_id: 'g',
    status: 'active',
    distance_m: 10000,
    target_time_s: 3000,
    race_date: '2027-03-13',
    accepted_version: 1,
    pending_version: null,
    ...over,
  }
}

function run(id: string, start: string, offset: number | null, distance: number): ActivitySummary {
  return { activity_id: id, start_time_utc: start, utc_offset_s: offset, distance_m: distance } as unknown as ActivitySummary
}

describe('displayedGoal', () => {
  it('prefers a pending proposal over the active goal', () => {
    const active = summary({ goal_id: 'a' })
    const proposed = summary({ goal_id: 'b', status: 'proposed', accepted_version: null, pending_version: 1 })
    expect(displayedGoal([active, proposed])?.goal_id).toBe('b')
  })

  it('falls back to the active goal, then the newest', () => {
    const archived = summary({ goal_id: 'x', status: 'archived' })
    const active = summary({ goal_id: 'a' })
    expect(displayedGoal([archived, active])?.goal_id).toBe('a')
    expect(displayedGoal([archived, summary({ goal_id: 'y', status: 'closed' })])?.goal_id).toBe('x')
    expect(displayedGoal([])).toBeNull()
  })
})

describe('currentAndPending', () => {
  it('picks the accepted and the proposed version', () => {
    const detail = {
      goal_id: 'g',
      status: 'active',
      versions: [
        { number: 1, status: 'superseded', plan: version([], { number: 1 }) },
        { number: 2, status: 'accepted', plan: version([], { number: 2 }) },
        { number: 3, status: 'proposed', plan: version([], { number: 3 }) },
      ],
    } as PlanDetail
    const { accepted, pending } = currentAndPending(detail)
    expect(accepted?.provenance.number).toBe(2)
    expect(pending?.provenance.number).toBe(3)
  })
})

describe('changedSessionIds', () => {
  const a = session('a', '2027-02-01', {
    steps: [{ kind: 'work', repeat: 1 } as unknown as S['Step']],
  })
  const b = session('b', '2027-02-02')
  const c = session('c', '2027-02-03')

  it('finds a changed step, an added session and a removed one', () => {
    const accepted = version([a, b])
    const changedA = { ...a, steps: [{ repeat: 2, kind: 'work' } as unknown as S['Step']] }
    const pending = version([changedA, c])
    expect([...changedSessionIds(accepted, pending)].sort()).toEqual(['a', 'b', 'c'])
  })

  it('is empty for identical versions regardless of key order, and without an accepted version', () => {
    const reordered = { steps: a.steps, description: '', title: 'a', kind: 'easy', date: '2027-02-01', id: 'a' } as Session
    expect(changedSessionIds(version([a, b]), version([reordered, b])).size).toBe(0)
    expect(changedSessionIds(null, version([a])).size).toBe(0)
  })
})

describe('runsByLocalDay', () => {
  it('files each run under the day the athlete saw, with a day\'s runs in start order', () => {
    const late = run('late', '2026-03-28T22:30:00Z', 3600, 1000)
    const next = run('next', '2026-03-28T23:30:00Z', 3600, 1000)
    const evening = run('evening', '2026-03-29T18:00:00Z', 3600, 1000)
    const morning = run('morning', '2026-03-29T07:00:00Z', 3600, 1000)
    const map = runsByLocalDay([evening, next, morning, late])
    const d28 = Date.UTC(2026, 2, 28) / 86_400_000
    expect(map.get(d28)?.map((r) => r.activity_id)).toEqual(['late'])
    expect(map.get(d28 + 1)?.map((r) => r.activity_id)).toEqual(['next', 'morning', 'evening'])
  })
})

describe('outcomeBySession', () => {
  it('indexes outcomes by session id', () => {
    const v = version([])
    v.outcomes = [{ session_id: 's1', verdict: 'done', activity_ids: [], note: '' }]
    expect(outcomeBySession(v).get('s1')?.verdict).toBe('done')
  })
})

describe('weeklyDistance', () => {
  it('sums runs per Monday week and leaves future weeks null', () => {
    const weeks: S['Week'][] = [
      { start_date: '2027-02-01', phase: 'build', focus: '', planned_distance_m: 30000, detailed: true, sessions: [] },
      { start_date: '2027-02-08', phase: 'build', focus: '', planned_distance_m: 32000, detailed: true, sessions: [] },
    ]
    const v = version([], { weeks })
    const runs = runsByLocalDay([
      run('1', '2027-02-01T07:00:00Z', 3600, 8000),
      run('2', '2027-02-07T07:00:00Z', 3600, 12000),
      run('3', '2027-02-08T07:00:00Z', 3600, 5000),
    ])
    expect(weeklyDistance(v, runs, new Date(2027, 1, 6))).toEqual([
      { startDate: '2027-02-01', plannedM: 30000, runM: 20000 },
      { startDate: '2027-02-08', plannedM: 32000, runM: null },
    ])
    expect(weeklyDistance(v, runs, new Date(2027, 1, 8))[1]?.runM).toBe(5000)
  })

  it('lists the weeks in date order, as the calendar numbers them', () => {
    const weeks: S['Week'][] = [
      { start_date: '2027-02-08', phase: 'build', focus: '', planned_distance_m: 32000, detailed: true, sessions: [] },
      { start_date: '2027-02-01', phase: 'build', focus: '', planned_distance_m: 30000, detailed: true, sessions: [] },
    ]
    const v = version([], { weeks })
    expect(weeklyDistance(v, new Map(), new Date(2027, 1, 6)).map((w) => w.startDate)).toEqual([
      '2027-02-01',
      '2027-02-08',
    ])
  })
})

describe('nextSession', () => {
  it('skips a rest session today and returns the first running one after', () => {
    const v = version([
      session('past', '2027-02-04'),
      session('rest', '2027-02-06', { kind: 'rest' }),
      session('go', '2027-02-07'),
    ])
    expect(nextSession(v, new Date(2027, 1, 6))?.id).toBe('go')
    expect(nextSession(v, new Date(2027, 1, 8))).toBeNull()
  })
})

describe('nextWeek', () => {
  function week(start: string, sessions: Session[], detailed = true): S['Week'] {
    return { start_date: start, phase: 'build', focus: '', planned_distance_m: 30000, detailed, sessions }
  }
  const v = version([], {
    weeks: [
      week('2027-02-01', [session('a', '2027-02-02')]),
      week('2027-02-08', [session('c', '2027-02-13'), session('b', '2027-02-09')]),
      week('2027-02-15', [], false),
      week('2027-02-22', [session('race', '2027-02-27', { kind: 'race' })]),
    ],
  })

  it('on a Sunday takes the week that starts the next day, its sessions in date order', () => {
    const next = nextWeek(v, new Date(2027, 1, 7))
    expect(next?.week.start_date).toBe('2027-02-08')
    expect(next?.sessions.map((e) => e.session.id)).toEqual(['b', 'c'])
    expect(next?.sessions[0]?.phase).toBe('build')
  })

  it('on a Monday takes the week after the one that has begun', () => {
    expect(nextWeek(v, new Date(2027, 1, 15))?.week.start_date).toBe('2027-02-22')
  })

  it('gives nothing for an outline week, which has no sessions to take', () => {
    expect(nextWeek(v, new Date(2027, 1, 14))).toBeNull()
  })

  it('gives nothing once the last week has begun', () => {
    expect(nextWeek(v, new Date(2027, 1, 22))).toBeNull()
  })
})

describe('sessionEntries', () => {
  it('lists every session in date order with its week phase, keeping a day in file order', () => {
    const v = version([], {
      weeks: [
        {
          start_date: '2027-02-08',
          phase: 'sharpen',
          focus: '',
          planned_distance_m: 0,
          detailed: true,
          sessions: [session('w2-b', '2027-02-10'), session('w2-a', '2027-02-09'), session('w2-c', '2027-02-10')],
        },
        { start_date: '2027-02-15', phase: 'base', focus: '', planned_distance_m: 0, detailed: false, sessions: [] },
        {
          start_date: '2027-02-01',
          phase: 'build',
          focus: '',
          planned_distance_m: 0,
          detailed: true,
          sessions: [session('w1-a', '2027-02-02')],
        },
      ],
    })
    expect(sessionEntries(v).map((e) => [e.session.id, e.phase])).toEqual([
      ['w1-a', 'build'],
      ['w2-a', 'sharpen'],
      ['w2-b', 'sharpen'],
      ['w2-c', 'sharpen'],
    ])
  })

  it("carries the plan's easy speed and profile scale, so every session's profile is drawn on one scale", () => {
    const easy = session('w1-a', '2027-02-02', {
      kind: 'easy',
      steps: [{ role: 'work', repeat: 1, distance_m: 6000, speed: { low_mps: 2.9, high_mps: 3.1 } }],
    })
    const reps = session('w1-b', '2027-02-04', {
      kind: 'intervals',
      steps: [{ role: 'work', repeat: 4, distance_m: 400, speed: { low_mps: 5.0, high_mps: 5.0 } }],
    })
    const [first, second] = sessionEntries(version([easy, reps]))
    expect(first?.profile?.easyMps).toBeCloseTo(3.0)
    expect(first?.profile?.scale?.topMps).toBe(5.0)
    expect(second?.profile).toEqual(first?.profile)
  })

  it('finds one session by id, and nothing for an id the version has none for', () => {
    const v = version([session('w1-a', '2027-02-02')])
    expect(sessionEntry(v, 'w1-a')?.session.id).toBe('w1-a')
    expect(sessionEntry(v, 'w1-a')?.phase).toBe('build')
    expect(sessionEntry(v, 'w9-z')).toBeNull()
    expect(sessionEntry(v, undefined)).toBeNull()
  })
})

describe('daysToRace', () => {
  it('counts down and goes negative after the race', () => {
    expect(daysToRace('2027-03-13', new Date(2027, 1, 6))).toBe(35)
    expect(daysToRace('2027-03-13', new Date(2027, 2, 14))).toBe(-1)
  })
})

describe('trajectory', () => {
  it('reads the riegel prediction at the goal distance, skipping withdrawn and rejected', () => {
    const snap = (model: string, t: number, d = 10000): S['SnapshotPrediction'] => ({
      distance_key: '10k', distance_m: d, model, predicted_time_s: t, low_s: null, high_s: null,
    })
    const detail = {
      goal_id: 'g',
      status: 'active',
      versions: [
        { number: 1, status: 'superseded', plan: version([], { number: 1, snapshot: [snap('riegel', 3100), snap('ordinary_runs', 3200), snap('riegel', 1400, 5000)] }) },
        { number: 2, status: 'withdrawn', plan: version([], { number: 2 }) },
        { number: 3, status: 'rejected', plan: version([], { number: 3 }) },
        { number: 4, status: 'proposed', plan: version([], { number: 4, snapshot: [snap('ordinary_runs', 3050)] }) },
      ],
    } as PlanDetail
    // The ordinary-run prediction is never read: the plan's estimate rests
    // on best efforts only, so version 4 has no point.
    expect(trajectory(detail, 10000)).toEqual([
      { number: 1, createdAt: '2027-01-24T10:00:00Z', bestEffortS: 3100 },
      { number: 4, createdAt: '2027-01-24T10:00:00Z', bestEffortS: null },
    ])
  })

  it('matches the goal distance within half a percent, as snapshotPrediction does', () => {
    const snap = (d: number): S['SnapshotPrediction'] => ({
      distance_key: 'half', distance_m: d, model: 'riegel', predicted_time_s: 6000, low_s: null, high_s: null,
    })
    const detail = {
      goal_id: 'g',
      status: 'active',
      versions: [{ number: 1, status: 'accepted', plan: version([], { number: 1, snapshot: [snap(21097.5)] }) }],
    } as PlanDetail
    expect(trajectory(detail, 21100)[0]?.bestEffortS).toBe(6000)
    expect(trajectory(detail, 5200)[0]?.bestEffortS).toBeNull()
  })

  it('lists versions in number order whatever order the file lists them in', () => {
    const detail = {
      goal_id: 'g',
      status: 'active',
      versions: [
        { number: 2, status: 'proposed', plan: version([], { number: 2 }) },
        { number: 1, status: 'accepted', plan: version([], { number: 1 }) },
      ],
    } as PlanDetail
    expect(trajectory(detail, 10000).map((p) => p.number)).toEqual([1, 2])
  })
})

describe('checkpointSessions', () => {
  it('dates each checkpoint by its session, in date order, and skips one naming no session', () => {
    const v = version(
      [
        session('tt', '2027-02-04', {
          kind: 'time_trial',
          planned_distance_m: 7000,
          steps: [
            { role: 'warmup', repeat: 1, distance_m: 2000 },
            { role: 'work', repeat: 1, distance_m: 3000 },
            { role: 'cooldown', repeat: 1, distance_m: 2000 },
          ],
        }),
        session('long', '2027-02-02', { kind: 'long' }),
      ],
      {
        checkpoints: [
          { session_id: 'tt', description: '3 km time trial', target_time_s: 690 },
          { session_id: 'long', description: 'Long run at goal effort' },
          { session_id: 'gone', description: 'A session the plan no longer has', target_time_s: 100 },
        ],
      },
    )
    expect(checkpointSessions(v)).toEqual([
      {
        sessionId: 'long',
        date: '2027-02-02',
        kind: 'long',
        targetDistanceM: null,
        description: 'Long run at goal effort',
        targetS: null,
      },
      {
        sessionId: 'tt',
        date: '2027-02-04',
        kind: 'time_trial',
        targetDistanceM: 3000,
        description: '3 km time trial',
        targetS: 690,
      },
    ])
  })
})

describe('checkpointSessions target distance', () => {
  const target = (s: Session) =>
    checkpointSessions(version([s], { checkpoints: [{ session_id: s.id, description: 'x', target_time_s: 1 }] }))[0]
      ?.targetDistanceM

  it('is the work step of a time trial, not the whole session with its warm-up and cool-down', () => {
    expect(
      target(
        session('tt', '2027-02-04', {
          kind: 'time_trial',
          planned_distance_m: 9000,
          steps: [
            { role: 'warmup', repeat: 1, distance_m: 2000 },
            { role: 'work', repeat: 1, distance_m: 5000 },
            { role: 'cooldown', repeat: 1, distance_m: 2000 },
          ],
        }),
      ),
    ).toBe(5000)
  })

  it('is null for a time trial of repeats, of several work steps or of none', () => {
    const run = (steps: Session['steps']) =>
      target(session('tt', '2027-02-04', { kind: 'time_trial', planned_distance_m: 9000, steps }))
    expect(run([{ role: 'work', repeat: 3, distance_m: 1000 }])).toBeNull()
    expect(
      run([
        { role: 'work', repeat: 1, distance_m: 1000 },
        { role: 'work', repeat: 1, distance_m: 2000 },
      ]),
    ).toBeNull()
    expect(run([])).toBeNull()
    expect(run([{ role: 'work', repeat: 1, duration_s: 1200 }])).toBeNull()
  })

  it('stays the planned distance for another kind', () => {
    expect(target(session('long', '2027-02-04', { kind: 'long', planned_distance_m: 13000 }))).toBe(13000)
  })
})

describe('timeTrialDate', () => {
  it('is the date of the first time trial a checkpoint names', () => {
    const v = version(
      [
        session('tt2', '2027-02-06', { kind: 'time_trial' }),
        session('tt1', '2027-02-04', { kind: 'time_trial' }),
        session('long', '2027-02-02', { kind: 'long' }),
      ],
      {
        checkpoints: [
          { session_id: 'long', description: 'Long run' },
          { session_id: 'tt2', description: 'Second trial' },
          { session_id: 'tt1', description: 'First trial' },
        ],
      },
    )
    expect(timeTrialDate(v, new Date(2027, 0, 24))).toBe('2027-02-04')
    // On the first trial's own day it is still the upcoming one.
    expect(timeTrialDate(v, new Date(2027, 1, 4))).toBe('2027-02-04')
  })

  it('skips a trial already run for the next one, and falls back to the latest once all have passed', () => {
    const v = version(
      [session('tt1', '2027-02-04', { kind: 'time_trial' }), session('tt2', '2027-02-06', { kind: 'time_trial' })],
      {
        checkpoints: [
          { session_id: 'tt1', description: 'First trial' },
          { session_id: 'tt2', description: 'Second trial' },
        ],
      },
    )
    expect(timeTrialDate(v, new Date(2027, 1, 5))).toBe('2027-02-06')
    expect(timeTrialDate(v, new Date(2027, 1, 12))).toBe('2027-02-06')
  })

  it('leaves out a trial on or before the data the version was written from', () => {
    const sessions = [
      session('tt1', '2027-02-04', { kind: 'time_trial' }),
      session('tt2', '2027-02-06', { kind: 'time_trial' }),
    ]
    const judged = version(sessions, {
      checkpoints: [{ session_id: 'tt1', description: 'First trial' }],
      dataThrough: '2027-02-04',
    })
    expect(timeTrialDate(judged, new Date(2027, 1, 5))).toBeNull()
    const both = version(sessions, {
      checkpoints: [
        { session_id: 'tt1', description: 'First trial' },
        { session_id: 'tt2', description: 'Second trial' },
      ],
      dataThrough: '2027-02-04',
    })
    expect(timeTrialDate(both, new Date(2027, 1, 5))).toBe('2027-02-06')
  })

  it('is null when no checkpoint names a time trial, even if the plan has one', () => {
    const v = version([session('tt', '2027-02-04', { kind: 'time_trial' })], {
      checkpoints: [],
    })
    expect(timeTrialDate(v, new Date(2027, 0, 24))).toBeNull()
  })
})

describe('raceSetsEstimate', () => {
  // The race is on Saturday 13 March; check 11 in docs/reference/plans.md gives the window.
  const week = (start: string): S['Week'] => ({
    start_date: start,
    phase: 'build',
    focus: '',
    planned_distance_m: 30000,
    detailed: true,
    sessions: [],
  })

  it('holds in a revision written within two weeks of the race', () => {
    // Data through Monday 8 March: the window runs 9 to 22 March.
    expect(raceSetsEstimate(version([], { dataThrough: '2027-03-08' }))).toBe(true)
    // Data through Sunday 21 February: the window ends 7 March, before the race.
    expect(raceSetsEstimate(version([], { dataThrough: '2027-02-21' }))).toBe(false)
  })

  it('starts from the first week when the data ends before it', () => {
    expect(raceSetsEstimate(version([], { weeks: [week('2027-03-01')] }))).toBe(true)
    expect(raceSetsEstimate(version([], { weeks: [week('2027-02-01')] }))).toBe(false)
  })
})

describe('paceRange', () => {
  it('writes the faster pace first', () => {
    expect(paceRange({ low_mps: 3.8462, high_mps: 3.9216 })).toBe('4:15-4:20')
  })
})

describe('shownVersion', () => {
  const detail = (statuses: S['PlanVersionEntry']['status'][]): PlanDetail =>
    ({
      goal_id: 'g',
      status: 'active',
      versions: statuses.map((status, i) => ({ number: i + 1, status, plan: version([], { number: i + 1 }) })),
    }) as PlanDetail

  it('shows the pending version first, then the accepted one, then the newest', () => {
    expect(shownVersion(detail(['superseded', 'accepted', 'proposed']), undefined)?.number).toBe(3)
    expect(shownVersion(detail(['superseded', 'accepted', 'rejected']), undefined)?.number).toBe(2)
    expect(shownVersion(detail(['rejected', 'withdrawn']), undefined)?.number).toBe(2)
    expect(shownVersion(detail([]), undefined)).toBeNull()
  })

  it('shows a requested version, and falls back to the default for one that does not exist', () => {
    expect(shownVersion(detail(['accepted', 'proposed']), 1)?.number).toBe(1)
    expect(shownVersion(detail(['accepted', 'proposed']), 9)?.number).toBe(2)
  })
})

describe('goalChangesFirst', () => {
  it('moves a goal change to the front and keeps the rest in order', () => {
    const entry = (title: string, goal = false): S['ChangeEntry'] => ({
      title,
      reason: '',
      session_ids: [],
      goal_change: goal,
    })
    const ordered = goalChangesFirst([entry('a'), entry('b'), entry('goal', true), entry('c')])
    expect(ordered.map((c) => c.title)).toEqual(['goal', 'a', 'b', 'c'])
  })
})

describe('dataAgeDays', () => {
  it('counts whole days from the newest run to today, and is null without one', () => {
    expect(dataAgeDays('2027-02-05', new Date(2027, 1, 19))).toBe(14)
    expect(dataAgeDays('2027-02-19', new Date(2027, 1, 19))).toBe(0)
    expect(dataAgeDays(null, new Date(2027, 1, 19))).toBeNull()
  })
})

describe('archivedByAccepting', () => {
  it('names the active goal a never-accepted goal would replace', () => {
    const active = summary({ goal_id: 'old' })
    const fresh = summary({ goal_id: 'new', status: 'proposed', accepted_version: null, pending_version: 1 })
    expect(archivedByAccepting([fresh, active], 'new')).toBe('old')
  })

  it('names nothing for a revision of the active goal, or with no other goal active', () => {
    const active = summary({ goal_id: 'old', pending_version: 2 })
    const fresh = summary({ goal_id: 'new', status: 'proposed', accepted_version: null, pending_version: 1 })
    expect(archivedByAccepting([fresh, active], 'old')).toBeNull()
    expect(archivedByAccepting([fresh], 'new')).toBeNull()
  })
})

describe('snapshotPrediction', () => {
  it('reads one model at the goal distance', () => {
    const v = version([], {
      snapshot: [
        { distance_key: '5k', distance_m: 5000, model: 'riegel', predicted_time_s: 1400, low_s: null, high_s: null },
        { distance_key: '10k', distance_m: 10000, model: 'riegel', predicted_time_s: 2900, low_s: null, high_s: null },
      ],
    })
    expect(snapshotPrediction(v, 'riegel')?.predicted_time_s).toBe(2900)
    expect(snapshotPrediction(v, 'ordinary_runs')).toBeNull()
  })

  it('matches a goal distance within half a percent of a prediction distance', () => {
    const halfSnapshot = [
      { distance_key: 'half', distance_m: 21097.5, model: 'riegel', predicted_time_s: 6000, low_s: null, high_s: null },
      { distance_key: '5k', distance_m: 5000, model: 'riegel', predicted_time_s: 1400, low_s: null, high_s: null },
    ]
    const half = version([], { snapshot: halfSnapshot })
    half.goal.distance_m = 21100
    expect(snapshotPrediction(half, 'riegel')?.predicted_time_s).toBe(6000)
    const odd = version([], { snapshot: halfSnapshot })
    odd.goal.distance_m = 5200
    expect(snapshotPrediction(odd, 'riegel')).toBeNull()
  })
})

describe('planSpan', () => {
  it('runs from the first Monday to the day after the last Sunday, the API\'s exclusive end', () => {
    const weeks: S['Week'][] = [
      { start_date: '2027-02-15', phase: 'build', focus: '', planned_distance_m: 0, detailed: true, sessions: [] },
      { start_date: '2027-02-08', phase: 'build', focus: '', planned_distance_m: 0, detailed: true, sessions: [] },
      { start_date: '2027-03-08', phase: 'taper', focus: '', planned_distance_m: 0, detailed: false, sessions: [] },
    ]
    expect(planSpan(version([], { weeks }))).toEqual({ from: '2027-02-08', to: '2027-03-15' })
  })

  it('is null for a plan with no weeks', () => {
    expect(planSpan(version([], { weeks: [] }))).toBeNull()
  })
})

describe('calendarWeeks', () => {
  const day = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8))) / 86_400_000

  it('lays each detailed week out Monday to Sunday with its sessions and runs, numbered in date order', () => {
    const weeks: S['Week'][] = [
      {
        start_date: '2027-02-08',
        phase: 'build',
        focus: '',
        planned_distance_m: 30000,
        detailed: true,
        sessions: [session('w2-long', '2027-02-14', { kind: 'long' })],
      },
      {
        start_date: '2027-02-01',
        phase: 'build',
        focus: '',
        planned_distance_m: 28000,
        detailed: true,
        sessions: [session('w1-easy', '2027-02-02'), session('w1-strides', '2027-02-02', { kind: 'strides' })],
      },
    ]
    const runs = runsByLocalDay([run('r1', '2027-02-02T07:00:00Z', 3600, 8000), run('r2', '2027-02-04T07:00:00Z', 3600, 5000)])
    const [first, second] = calendarWeeks(version([], { weeks }), runs)

    expect(first?.number).toBe(1)
    expect(first?.week.start_date).toBe('2027-02-01')
    expect(first?.days.map((d) => d.day)).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => day('2027-02-01') + i))
    expect(first?.days[1]?.sessions.map((s) => s.id)).toEqual(['w1-easy', 'w1-strides'])
    expect(first?.days[1]?.runs.map((r) => r.activity_id)).toEqual(['r1'])
    // An unplanned run on a day with no session still has its day.
    expect(first?.days[3]?.sessions).toEqual([])
    expect(first?.days[3]?.runs.map((r) => r.activity_id)).toEqual(['r2'])
    expect(second?.number).toBe(2)
    expect(second?.days[6]?.sessions.map((s) => s.id)).toEqual(['w2-long'])
  })

  it('gives an outline week no days, but keeps the runs done in it', () => {
    const weeks: S['Week'][] = [
      { start_date: '2027-02-01', phase: 'base', focus: 'Volume', planned_distance_m: 30000, detailed: false, sessions: [] },
    ]
    const runs = runsByLocalDay([run('r1', '2027-02-07T07:00:00Z', 3600, 8000), run('r0', '2027-01-31T07:00:00Z', 3600, 5000)])
    const [outline] = calendarWeeks(version([], { weeks }), runs)
    expect(outline?.days).toEqual([])
    expect(outline?.outlineRuns.map((r) => r.activity_id)).toEqual(['r1'])
  })
})

describe('sessionTarget', () => {
  it('is the work step\'s pace range when it has a speed', () => {
    const s = session('i', '2027-02-02', {
      kind: 'intervals',
      steps: [
        { role: 'warmup', repeat: 1, duration_s: 900, speed: { low_mps: 2.5, high_mps: 2.8 } },
        { role: 'work', repeat: 6, distance_m: 800, speed: { low_mps: 3.8462, high_mps: 3.9216 } },
      ],
    })
    expect(sessionTarget(s)).toBe('4:15-4:20')
  })

  it('is the work step\'s amount when it has no speed', () => {
    const s = session('t', '2027-02-02', {
      steps: [{ role: 'work', repeat: 1, duration_s: 1200, heart_rate: { low_bpm: 160, high_bpm: 170 } }],
    })
    expect(sessionTarget(s)).toBe('20 min')
  })

  it('falls back to the session\'s planned distance, then nothing', () => {
    expect(sessionTarget(session('e', '2027-02-02', { planned_distance_m: 7000 }))).toBe('7 km')
    expect(sessionTarget(session('r', '2027-02-02', { kind: 'rest' }))).toBeNull()
  })
})
