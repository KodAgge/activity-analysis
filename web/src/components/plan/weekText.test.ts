import { describe, expect, it } from 'vitest'
import type { Session, WeekEntry } from './planMath'
import { weekRangeLabel, weekStartLabel, weekText } from './weekText'

function session(id: string, date: string, over: Partial<Session> = {}): Session {
  return { id, date, kind: 'easy', title: id, description: '', steps: [], ...over }
}

const intervals = session('2026-08-25-intervals', '2026-08-25', {
  kind: 'intervals',
  title: 'Six by 800 m',
  planned_distance_m: 9000,
  planned_duration_s: 2700,
  description: 'Warm-up:\n- Easy jog\n\nThe reps are the session.',
  steps: [
    { role: 'warmup', repeat: 1, distance_m: 2000, heart_rate: { low_bpm: 130, high_bpm: 145 } },
    { role: 'work', repeat: 6, distance_m: 800, speed: { low_mps: 4, high_mps: 4.1667 }, note: 'Even splits' },
    { role: 'recovery', repeat: 6, duration_s: 90 },
  ],
} as Partial<Session>)

const rest = session('2026-08-27-rest', '2026-08-27', { kind: 'rest', title: 'Rest' })

const entry: WeekEntry = {
  week: {
    start_date: '2026-08-24',
    phase: 'build',
    focus: 'Add one quality session.',
    planned_distance_m: 26000,
    detailed: true,
    sessions: [intervals, rest],
  },
  sessions: [
    { session: intervals, phase: 'build' },
    { session: rest, phase: 'build' },
  ],
}

describe('weekText', () => {
  it("writes the week's load and note under its summary", () => {
    const text = weekText('5 km under 25:00', entry, new Date(2026, 7, 23), null, {
      start: { local_date: '2026-08-23', ctl: 56, atl: 68.8, form: -12.8 },
      end: { local_date: '2026-08-30', ctl: 57.6, atl: 66, form: -8.4 },
      startLabel: 'Sun 23 Aug',
      endLabel: 'Sun 30 Aug',
      note: 'Keep Tuesday easy.',
    })
    expect(text.split('\n').slice(0, 4)).toEqual([
      '5 km under 25:00, week of 24 Aug to 30 Aug',
      'Build. Add one quality session. 26 km planned.',
      'Fitness (CTL) 56.0 -> 57.6, fatigue (ATL) 68.8 -> 66.0, form -12.8 -> -8.4.',
      'Keep Tuesday easy.',
    ])
  })

  it('writes the week out as plain text, a block per session', () => {
    expect(weekText('5 km under 25:00', entry, new Date(2026, 7, 23))).toBe(
      [
        '5 km under 25:00, week of 24 Aug to 30 Aug',
        'Build. Add one quality session. 26 km planned.',
        '',
        'Tuesday 25 August · Intervals · Six by 800 m',
        'Planned 9 km · 45 min',
        'Warm-up:',
        '- Easy jog',
        '',
        'The reps are the session.',
        '',
        'Steps:',
        '- Warm-up 2 km · 130-145 bpm',
        '- Work 6 × 800 m · 4:00-4:10/km · 14.4-15.0 km/h',
        '  Even splits',
        '- Recovery 6 × 1:30',
        '',
        'Thursday 27 August · Rest · Rest',
      ].join('\n'),
    )
  })

  it('labels a heart rate target with its zone when given the zone boundaries', () => {
    const text = weekText('5 km under 25:00', entry, new Date(2026, 7, 23), [150, 160, 170, 180])
    expect(text).toContain('- Warm-up 2 km · 130-145 bpm (Z1)')
  })

  it('names a week across a month and a year by its days', () => {
    const late = { ...entry, week: { ...entry.week, start_date: '2026-12-28' } }
    expect(weekStartLabel(late)).toBe('28 Dec')
    expect(weekRangeLabel(late)).toBe('28 Dec to 3 Jan')
  })
})
