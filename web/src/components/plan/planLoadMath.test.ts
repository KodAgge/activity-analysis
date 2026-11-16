import { describe, expect, it } from 'vitest'
import type { components } from '../../api/schema'
import {
  PREDATES_HR_PLANNING,
  PREDATES_PLANNED_TRIMP,
  UNFACTORED_ZONE,
  FITNESS_LEAD_DAYS,
  ceilingShare,
  fitnessFirstDay,
  fitnessSeries,
  weekLoad,
  outlookSeries,
  plannedLoadNote,
  plannedTrimp,
  weeklyLoad,
  weeklyZoneMix,
  zoneOf,
} from './planLoadMath'
import type { RunLoad } from './planLoadMath'
import { calendarDayOfDate } from '../../format'

type S = components['schemas']

function week(start: string, over: Partial<S['Week']> = {}): S['Week'] {
  return { start_date: start, phase: 'build', focus: '', planned_distance_m: 0, detailed: true, sessions: [], ...over }
}

function plan(weeks: S['Week'][], prov: Partial<S['Provenance']> = {}): S['PlanVersion'] {
  return {
    goal: { distance_m: 10000, target_time_s: 3000, race_date: '2027-03-13' },
    weeks,
    changes: [],
    outcomes: [],
    checkpoints: [],
    provenance: { number: 1, revises: null, created_at: '2027-01-24T10:00:00Z', data_through: '2027-01-23', snapshot: [], ...prov },
  } as unknown as S['PlanVersion']
}

function runLoad(date: string, over: Partial<RunLoad> = {}): RunLoad {
  return {
    activity_id: date,
    local_date: date,
    lthr_bpm: 170,
    trimp: 50,
    rest_bpm: 50,
    max_bpm: 200,
    rest_from_setting: false,
    max_from_setting: false,
    zone_seconds: [600, 600, 0, 0, 0],
    hr_bpm: [],
    hr_seconds: [],
    ...over,
  }
}

const TODAY = new Date(2027, 1, 20)

const PER_MINUTE = [1, 1.5, 2, 2.5, 3]

describe('plannedTrimp', () => {
  it('weighs each zone by its TRIMP per minute, as Python does', () => {
    expect(plannedTrimp([60, 30, 0, 10, 0], PER_MINUTE)).toBe(130)
  })

  it('is null when a zone with planned minutes has no TRIMP per minute', () => {
    expect(plannedTrimp([60, 30, 0, 10, 0], [1, 1.5, 2, null, 3])).toBeNull()
  })

  it('needs no TRIMP per minute for a zone with no minutes', () => {
    expect(plannedTrimp([60, 30, 0, 10, 0], [1, 1.5, null, 2.5, null])).toBe(130)
  })
})

describe('zoneOf', () => {
  it('gives a top on a boundary the zone the boundary closes, rounding both as printed', () => {
    const b = [150, 160.4, 170, 180]
    expect(zoneOf(160.4, b)).toBe(2)
    expect(zoneOf(161, b)).toBe(3)
    expect(zoneOf(100, b)).toBe(1)
    expect(zoneOf(190, b)).toBe(5)
  })
})

describe('ceilingShare', () => {
  it('uses the written bpm, not the zones', () => {
    const run = runLoad('2027-02-01', { hr_bpm: [120, 140, 150, 160], hr_seconds: [100, 100, 100, 100] })
    expect(ceilingShare(run, 150)).toBe(0.75)
    expect(ceilingShare(run, 119)).toBe(0)
  })

  it('is null with no histogram seconds', () => {
    expect(ceilingShare(runLoad('2027-02-01'), 150)).toBeNull()
  })
})

describe('weeklyLoad', () => {
  const p = plan(
    [
      week('2027-02-08', { planned_zone_minutes: [60, 30, 0, 10, 0] }),
      week('2027-02-01', { planned_zone_minutes: [30, 0, 0, 0, 0] }),
      week('2027-03-01'),
    ],
    { trimp_per_minute: PER_MINUTE },
  )

  it("files a run at 23:30 local under its local day's week", () => {
    // Sunday 7 Feb 23:30 local belongs to the week of 1 Feb, however its UTC day reads.
    const rows = weeklyLoad(p, [runLoad('2027-02-07', { trimp: 40 }), runLoad('2027-02-08', { trimp: 10 })], TODAY)
    expect(rows.map((r) => r.start)).toEqual(['2027-02-01', '2027-02-08', '2027-03-01'])
    expect(rows[0]).toEqual({ start: '2027-02-01', planned: 30, run: 40 })
    expect(rows[1]).toEqual({ start: '2027-02-08', planned: 130, run: 10 })
  })

  it('leaves a week not yet begun without a run total, and a week without minutes without a plan', () => {
    const rows = weeklyLoad(p, [], TODAY)
    expect(rows[2]).toEqual({ start: '2027-03-01', planned: null, run: null })
  })

  it('gives a begun week without runs 0', () => {
    expect(weeklyLoad(p, [], TODAY)[0]?.run).toBe(0)
  })

  it('leaves a begun week whose runs all lack heart rate unknown rather than 0', () => {
    const noHr = { trimp: null, zone_seconds: [] }
    const rows = weeklyLoad(p, [runLoad('2027-02-02', noHr), runLoad('2027-02-04', noHr)], TODAY)
    expect(rows[0]?.run).toBeNull()
  })

  it('sums the runs that have a TRIMP when only some lack heart rate', () => {
    const rows = weeklyLoad(p, [runLoad('2027-02-02', { trimp: null, zone_seconds: [] }), runLoad('2027-02-04', { trimp: 35 })], TODAY)
    expect(rows[0]?.run).toBe(35)
  })

  it('plans nothing for a version without the TRIMP per minute stamp', () => {
    const unstamped = plan([week('2027-02-01', { planned_zone_minutes: [30, 0, 0, 0, 0] })])
    expect(weeklyLoad(unstamped, [], TODAY)[0]?.planned).toBeNull()
  })
})

describe('plannedLoadNote', () => {
  it('says a version without zone minutes predates heart-rate planning', () => {
    expect(plannedLoadNote(plan([week('2027-02-01')], { trimp_per_minute: PER_MINUTE }))).toBe(PREDATES_HR_PLANNING)
  })

  it('says a version with zone minutes but no stamp predates planned TRIMP', () => {
    expect(plannedLoadNote(plan([week('2027-02-01', { planned_zone_minutes: [30, 0, 0, 0, 0] })]))).toBe(
      PREDATES_PLANNED_TRIMP,
    )
  })

  it('says why a week whose minutes fall in a zone without a TRIMP per minute has no planned bar', () => {
    const p = plan([week('2027-02-01', { planned_zone_minutes: [30, 0, 0, 0, 5] })], {
      trimp_per_minute: [1, 1.5, 2, 2.5, null],
    })
    expect(plannedLoadNote(p)).toBe(UNFACTORED_ZONE)
  })

  it('has nothing to say when every week with minutes has a planned TRIMP', () => {
    const p = plan([week('2027-02-01', { planned_zone_minutes: [30, 0, 0, 0, 0] }), week('2027-02-08')], {
      trimp_per_minute: PER_MINUTE,
    })
    expect(plannedLoadNote(p)).toBeNull()
  })
})

describe('weeklyZoneMix', () => {
  it('groups zones 1-2, 3 and 4-5', () => {
    const p = plan([week('2027-02-01', { planned_zone_minutes: [10, 20, 30, 40, 50] })])
    const rows = weeklyZoneMix(p, [runLoad('2027-02-02', { zone_seconds: [60, 120, 180, 240, 300] })], TODAY)
    expect(rows).toEqual([{ start: '2027-02-01', planned: [30, 30, 90], run: [3, 3, 9] }])
  })

  it('gives a begun week without runs zeros, and one whose runs all lack estimated zones nothing', () => {
    const p = plan([week('2027-02-01'), week('2027-02-08')])
    const rows = weeklyZoneMix(p, [runLoad('2027-02-09', { trimp: null, zone_seconds: [] })], TODAY)
    expect(rows.map((r) => r.run)).toEqual([[0, 0, 0], null])
    // A run with TRIMP from before the first threshold estimate has no zones either.
    const early = weeklyZoneMix(p, [runLoad('2027-02-09', { trimp: 40, zone_seconds: [] })], TODAY)
    expect(early.map((r) => r.run)).toEqual([[0, 0, 0], null])
  })
})

describe('outlookSeries', () => {
  function point(start: string, offset: number | null, vdot: number | null): S['PredictionHistoryPoint'] {
    return {
      activity_id: start,
      start_time_utc: start,
      utc_offset_s: offset,
      best_efforts_vdot: vdot,
      best_efforts_s: vdot === null ? null : 3000,
      ordinary_runs_s: 3100,
      ordinary_runs_low_s: 3000,
      ordinary_runs_high_s: 3200,
    }
  }

  it('expects each stamped week at its Sunday, the last at the race', () => {
    const shown = plan(
      [
        week('2027-02-01', { expected_vdot: 50, expected_garmin_vo2max: 52 }),
        week('2027-02-08'),
        week('2027-02-15', { expected_vdot: 51 }),
      ],
      { target_vdot: 52 },
    )
    const out = outlookSeries(shown, [], '2027-02-01')
    expect(out.expected).toEqual([
      { date: '2027-02-07', vdot: 50, garmin: 52 },
      { date: '2027-03-13', vdot: 51, garmin: null },
    ])
    expect(out.measured).toEqual([])
    expect(out.targetVdot).toBe(52)
  })

  it('measures the best-efforts series from the first week on, one point per run with a value', () => {
    const history = [
      point('2027-01-31T12:00:00Z', 0, 48.9),
      // 23:30Z on 31 January is 1 February at UTC+1, the first week's Monday.
      point('2027-01-31T23:30:00Z', 3600, 49.1),
      point('2027-02-03T08:00:00Z', 3600, null),
      point('2027-02-05T08:00:00Z', 3600, 49.4),
    ]
    // The run without a value breaks the line, as the trajectory's does.
    expect(outlookSeries(plan([week('2027-02-01')]), history, '2027-02-01').measured).toEqual([
      [{ date: '2027-02-01', vdot: 49.1 }],
      [{ date: '2027-02-05', vdot: 49.4 }],
    ])
  })

  it('measures nothing after the race', () => {
    // The race is 13 March; a run that evening counts, the next day's does not.
    const history = [point('2027-03-10T08:00:00Z', 0, 49.0), point('2027-03-13T18:00:00Z', 0, 49.2), point('2027-03-14T08:00:00Z', 0, 49.5)]
    expect(outlookSeries(plan([week('2027-02-01')]), history, '2027-02-01').measured).toEqual([
      [
        { date: '2027-03-10', vdot: 49.0 },
        { date: '2027-03-13', vdot: 49.2 },
      ],
    ])
  })

  it('breaks the measured line where runs are more than six weeks apart', () => {
    const history = [
      point('2027-01-04T08:00:00Z', 0, 48.0),
      point('2027-01-10T08:00:00Z', 0, 48.2),
      point('2027-03-01T08:00:00Z', 0, 49.0),
    ]
    expect(outlookSeries(plan([week('2027-02-01')]), history, '2026-12-01').measured).toEqual([
      [
        { date: '2027-01-04', vdot: 48.0 },
        { date: '2027-01-10', vdot: 48.2 },
      ],
      [{ date: '2027-03-01', vdot: 49.0 }],
    ])
  })
})

describe('fitnessSeries', () => {
  const loadWeek = (start: string, ctl: number, atl: number): S['LoadWeek'] => ({
    week_start: start,
    days: 7,
    trimp: 7 * ctl,
    ctl_mean: ctl,
    atl_mean: atl,
    form_mean: ctl - atl,
    distance_m: 0,
  })
  const stamp: S['ExpectedLoad'] = {
    start: { local_date: '2027-01-23', ctl: 40, atl: 50, form: -10 },
    race_morning: { local_date: '2027-03-12', ctl: 44, atl: 36, form: 8 },
    weeks: [
      { week_start: '2027-01-18', days: 7, trimp: 300, ctl_mean: 40, atl_mean: 48, form_mean: -8 },
      { week_start: '2027-01-25', days: 7, trimp: 310, ctl_mean: 41, atl_mean: 46, form_mean: -5 },
    ],
    bridged_from: ['earlier'],
  }

  it('draws each stamped week at its middle and passes the stamp through', () => {
    const series = fitnessSeries(plan([week('2027-01-25')], { expected_load: stamp }), [])
    expect(series.expected).toEqual([
      { day: calendarDayOfDate('2027-01-21'), ctl: 40, atl: 48, form: -8 },
      { day: calendarDayOfDate('2027-01-28'), ctl: 41, atl: 46, form: -5 },
    ])
    expect(series.raceMorning?.form).toBe(8)
    expect(series.start?.ctl).toBe(40)
    expect(series.bridgedFrom).toEqual(['earlier'])
    expect(series.raceDay).toBe(calendarDayOfDate('2027-03-13'))
  })

  it('reaches back a fitness time constant before the first week', () => {
    const series = fitnessSeries(plan([week('2027-02-01')]), [])
    expect(series.firstDay).toBe(calendarDayOfDate('2027-02-01') - FITNESS_LEAD_DAYS)
    expect(series.expected).toEqual([])
    expect(series.raceMorning).toBeNull()
  })

  it('reaches back further when the expected series starts earlier', () => {
    const series = fitnessSeries(plan([week('2027-03-01')], { expected_load: stamp }), [])
    expect(series.firstDay).toBe(calendarDayOfDate('2027-01-18'))
  })

  it('draws a race week cut short by a Monday race on race day, inside the axis', () => {
    // A Monday race: its week's expected mean covers the Monday alone, and
    // the race is the axis' last day, so the point belongs on the race day.
    const raceWeek = { week_start: '2027-03-15', days: 1, trimp: 0, ctl_mean: 44, atl_mean: 36, form_mean: 8 }
    const mondayRace = { ...stamp, weeks: [...stamp.weeks, raceWeek] }
    const version = plan([week('2027-03-08')], { expected_load: mondayRace })
    const series = fitnessSeries({ ...version, goal: { ...version.goal, race_date: '2027-03-15' } }, [
      { ...loadWeek('2027-03-15', 44, 36), days: 1 },
    ])
    expect(series.expected.at(-1)?.day).toBe(calendarDayOfDate('2027-03-15'))
    expect(series.measured.at(-1)?.day).toBe(calendarDayOfDate('2027-03-15'))
    expect(series.raceDay).toBe(calendarDayOfDate('2027-03-15'))
  })

  it('leaves out a measured race week whose days run past a Tuesday race', () => {
    // Runs after the race fill the measured race week to seven days, so its
    // mean holds the days after the race; the expected one ends on race day.
    const raceWeek = { week_start: '2027-03-15', days: 2, trimp: 0, ctl_mean: 44, atl_mean: 36, form_mean: 8 }
    const tuesdayRace = { ...stamp, weeks: [...stamp.weeks, raceWeek] }
    const version = plan([week('2027-03-08')], { expected_load: tuesdayRace })
    const tuesday = { ...version, goal: { ...version.goal, race_date: '2027-03-16' } }
    const before = loadWeek('2027-03-08', 43, 40)
    const afterRuns = fitnessSeries(tuesday, [before, loadWeek('2027-03-15', 44, 36)])
    expect(afterRuns.expected.at(-1)?.day).toBe(calendarDayOfDate('2027-03-15') + 0.5)
    expect(afterRuns.measured.map((m) => m.ctl)).toEqual([43])
    // Until a run after the race, the measured race week ends on race day too.
    const untilRace = fitnessSeries(tuesday, [before, { ...loadWeek('2027-03-15', 44, 36), days: 2 }])
    expect(untilRace.measured.at(-1)?.day).toBe(calendarDayOfDate('2027-03-15') + 0.5)
  })

  it('draws the week still running at the middle of its days so far', () => {
    // Monday to Wednesday measured: their middle is the Tuesday.
    const series = fitnessSeries(plan([week('2027-02-01')]), [{ ...loadWeek('2027-02-01', 42, 45), days: 3 }])
    expect(series.measured[0]?.day).toBe(calendarDayOfDate('2027-02-02'))
  })

  it('keeps the measured weeks inside the span, oldest first', () => {
    const measured = [
      loadWeek('2027-02-01', 42, 45),
      loadWeek('2026-12-14', 30, 30),
      loadWeek('2027-01-18', 40, 50),
      loadWeek('2027-03-15', 50, 40),
    ]
    const series = fitnessSeries(plan([week('2027-02-01')]), measured)
    expect(series.measured.map((m) => m.ctl)).toEqual([40, 42])
    expect(series.measured[0]?.form).toBe(-10)
  })
})

describe('fitnessFirstDay', () => {
  it('is the first day fitnessSeries draws, which the measured weeks are asked from', () => {
    const queued = plan([week('2027-03-08')], {
      expected_load: {
        start: { local_date: '2027-01-23', ctl: 40, atl: 50, form: -10 },
        race_morning: { local_date: '2027-03-12', ctl: 44, atl: 36, form: 8 },
        weeks: [{ week_start: '2027-01-18', days: 7, trimp: 300, ctl_mean: 40, atl_mean: 48, form_mean: -8 }],
        bridged_from: ['earlier'],
      },
    })
    expect(fitnessFirstDay(queued)).toBe(calendarDayOfDate('2027-01-18'))
    expect(fitnessSeries(queued, []).firstDay).toBe(fitnessFirstDay(queued))
  })
})

describe('weekLoad', () => {
  const point = (local_date: string, ctl: number, atl: number): S['LoadPoint'] => ({ local_date, ctl, atl, form: ctl - atl })
  const stampWeek = (start: string, from: S['LoadPoint'], to: S['LoadPoint']): S['ExpectedLoadWeek'] => ({
    week_start: start,
    days: 7,
    trimp: 300,
    ctl_mean: 40,
    atl_mean: 45,
    form_mean: -5,
    start: from,
    end: to,
  })
  const stamp: S['ExpectedLoad'] = {
    start: point('2027-02-28', 40, 50),
    race_morning: point('2027-03-12', 41, 35),
    weeks: [
      stampWeek('2027-03-01', point('2027-02-28', 40, 50), point('2027-03-07', 41, 44)),
      stampWeek('2027-03-08', point('2027-03-07', 41, 44), point('2027-03-12', 41, 35)),
    ],
    bridged_from: [],
  }

  it("returns a week's stamped start and end, its note, and its Sunday", () => {
    const w = week('2027-03-01', { load_note: 'Hold back on Tuesday.' })
    const figures = weekLoad(plan([w], { expected_load: stamp }), w)
    expect(figures.start?.ctl).toBe(40)
    expect(figures.end?.atl).toBe(44)
    expect(figures.note).toBe('Hold back on Tuesday.')
    expect(figures.startLabel).toBe('Sun 28 Feb')
    expect(figures.endLabel).toBe('Sun 7 Mar')
  })

  it('labels the race week end race morning', () => {
    const w = week('2027-03-08')
    expect(weekLoad(plan([w], { expected_load: stamp }), w).endLabel).toBe('Race morning')
  })

  it('has no figures without a stamp, or with a stamp older than week start and end', () => {
    const w = week('2027-03-01')
    expect(weekLoad(plan([w]), w)).toMatchObject({ start: null, end: null, note: null })
    const older = { ...stamp, weeks: stamp.weeks.map(({ start: _s, end: _e, ...rest }) => rest) }
    expect(weekLoad(plan([w], { expected_load: older }), w)).toMatchObject({ start: null, end: null })
  })
})
