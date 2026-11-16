import { describe, expect, it } from 'vitest'
import type { components } from '../api/schema'
import { calendarDayOfDate } from '../format'
import {
  HALF_WEEK_DAYS,
  latestCompleteWeek,
  loadPlot,
  loadScales,
  loadXRange,
  readingAt,
  weighsAnyRun,
} from './trainingLoadMath'

type LoadDay = components['schemas']['LoadDay']
type LoadWeek = components['schemas']['LoadWeek']

function week(weekStart: string, overrides: Partial<LoadWeek> = {}): LoadWeek {
  return {
    week_start: weekStart,
    days: 7,
    trimp: 300,
    ctl_mean: 40,
    atl_mean: 50,
    form_mean: -10,
    distance_m: 30000,
    ...overrides,
  }
}

function day(localDate: string, overrides: Partial<LoadDay> = {}): LoadDay {
  return {
    local_date: localDate,
    trimp: 0,
    ctl: 40,
    atl: 50,
    form: -10,
    distance_m: 0,
    distance_7d_m: 25000,
    ...overrides,
  }
}

/** The seven days of the Monday-started week beginning `monday`. */
function daysOf(monday: string, overrides: Partial<LoadDay> = {}): LoadDay[] {
  const start = calendarDayOfDate(monday)
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date((start + i) * 86_400_000).toISOString().slice(0, 10)
    return day(date, overrides)
  })
}

describe('latestCompleteWeek', () => {
  it('the figures use the latest complete week, not the current one', () => {
    const weeks = [week('2026-10-26'), week('2026-11-02', { ctl_mean: 44 }), week('2026-11-09', { days: 4, ctl_mean: 47 })]
    expect(latestCompleteWeek(weeks)?.week_start).toBe('2026-11-02')
  })

  it('does not trust the payload order', () => {
    const weeks = [week('2026-11-02'), week('2026-10-26')]
    expect(latestCompleteWeek(weeks)?.week_start).toBe('2026-11-02')
  })

  it('does not count a week that runs past the period it was asked for', () => {
    // The period ends on the Wednesday of the week of 9 November: that
    // week's seven days are stored, but four of them are outside it.
    const weeks = [week('2026-11-02'), week('2026-11-09')]
    expect(latestCompleteWeek(weeks, '2026-11-11')?.week_start).toBe('2026-11-02')
    expect(latestCompleteWeek(weeks, '2026-11-15')?.week_start).toBe('2026-11-09')
    expect(latestCompleteWeek(weeks)?.week_start).toBe('2026-11-09')
  })

  it('has none when no week is complete', () => {
    expect(latestCompleteWeek([week('2026-11-09', { days: 3 })])).toBeUndefined()
    expect(latestCompleteWeek([])).toBeUndefined()
  })
})

describe('weighsAnyRun', () => {
  it('is false when every week has zero TRIMP, as when no run carries heart rate', () => {
    expect(weighsAnyRun([week('2026-11-02', { trimp: 0 })], [])).toBe(false)
    expect(weighsAnyRun([], [])).toBe(false)
    expect(weighsAnyRun([week('2026-11-02', { trimp: 0 }), week('2026-11-09', { trimp: 12 })], [])).toBe(true)
  })

  it('reads the days too, since a period shorter than a week from a Monday holds no week', () => {
    expect(weighsAnyRun([], [day('2026-11-12', { trimp: 80 })])).toBe(true)
    expect(weighsAnyRun([], [day('2026-11-12')])).toBe(false)
  })
})

describe('loadPlot', () => {
  const weeks = [week('2026-11-02', { trimp: 420, ctl_mean: 48, atl_mean: 60, form_mean: -12 })]
  const days = daysOf('2026-11-02', { distance_7d_m: 30000 })
  const thursday = calendarDayOfDate('2026-11-05') + 0.5

  it('puts a week half a week after its Monday', () => {
    expect(HALF_WEEK_DAYS).toBe(3.5)
  })

  it('puts a week at the middle of its seven days, which is its Thursday', () => {
    const plot = loadPlot(days, weeks)
    const i = plot.x.indexOf(thursday)
    expect(i).toBeGreaterThanOrEqual(0)
    expect(plot.trimp[i]).toBe(420)
    // Per day times seven, so fitness and fatigue share the weekly bars' scale.
    expect(plot.fitness[i]).toBe(48 * 7)
    expect(plot.fatigue[i]).toBe(60 * 7)
    expect(plot.form[i]).toBe(-12)
  })

  it('leaves a weekly series undefined on the other days, so its line runs through them', () => {
    const plot = loadPlot(days, weeks)
    expect(plot.x).toHaveLength(7)
    expect(plot.trimp.filter((v) => v !== undefined)).toEqual([420])
    expect(plot.fitness.filter((v) => v !== undefined)).toHaveLength(1)
  })

  it('carries the 7-day distance on every day, at the middle of the day', () => {
    const plot = loadPlot(days, weeks)
    expect(plot.x[0]).toBe(calendarDayOfDate('2026-11-02') + 0.5)
    expect(plot.distance).toEqual(Array(7).fill(30000))
  })

  it('keeps a week whose Thursday falls outside the days it was sent with', () => {
    const plot = loadPlot(days.slice(0, 2), weeks)
    expect(plot.x).toContain(thursday)
    expect(plot.trimp[plot.x.indexOf(thursday)]).toBe(420)
  })
})

describe('loadXRange', () => {
  it('runs from the first Monday to the end of the last week', () => {
    const range = loadXRange(daysOf('2026-11-02'), [week('2026-11-02')])
    expect(range).toEqual([calendarDayOfDate('2026-11-02'), calendarDayOfDate('2026-11-09')])
  })

  it('reaches a day past the last week', () => {
    const range = loadXRange([day('2026-11-10')], [week('2026-11-02')])
    expect(range).toEqual([calendarDayOfDate('2026-11-02'), calendarDayOfDate('2026-11-11')])
  })
})

describe('loadScales', () => {
  it('starts the load and distance ladders at zero on the same three rungs, so they share one grid', () => {
    const plot = loadPlot(daysOf('2026-11-02', { distance_7d_m: 37000 }), [week('2026-11-02', { trimp: 520, atl_mean: 69 })])
    const { load, distance } = loadScales(plot)
    expect(load.min).toBe(0)
    expect(distance.min).toBe(0)
    expect(load.splits).toHaveLength(3)
    expect(distance.splits).toHaveLength(3)
    // Fatigue times seven, 483, is under the 520 bars; both sit inside.
    expect(load.max).toBeGreaterThanOrEqual(520)
    expect(distance.max).toBeGreaterThanOrEqual(37000)
  })

  it('puts zero on the form ladder whichever side form sits', () => {
    for (const form of [-16, 8]) {
      const plot = loadPlot(daysOf('2026-11-02'), [week('2026-11-02', { form_mean: form })])
      const scale = loadScales(plot).form
      expect(scale.splits).toContain(0)
      expect(scale.min).toBeLessThanOrEqual(Math.min(form, 0))
      expect(scale.max).toBeGreaterThanOrEqual(Math.max(form, 0))
    }
  })
})

describe('readingAt', () => {
  it('names the week a day falls in and that day 7-day distance', () => {
    const weeks = [week('2026-10-26', { trimp: 1 }), week('2026-11-02', { trimp: 2 })]
    const days = [day('2026-11-03', { distance_7d_m: 12000 })]
    const reading = readingAt(days, weeks, calendarDayOfDate('2026-11-03') + 0.5, '2026-11-20')
    expect(reading.week?.week_start).toBe('2026-11-02')
    expect(reading.day?.distance_7d_m).toBe(12000)
    expect(reading.dayNumber).toBe(calendarDayOfDate('2026-11-03'))
  })

  it('calls a short week in progress only when it holds today', () => {
    const weeks = [week('2026-11-02'), week('2026-11-09', { days: 3 })]
    const x = calendarDayOfDate('2026-11-10')
    expect(readingAt([], weeks, x, '2026-11-11').weekInProgress).toBe(true)
    expect(readingAt([], weeks, x, '2026-11-16').weekInProgress).toBe(false)
    // A complete week holding today is not short, so not in progress.
    expect(readingAt([], weeks, calendarDayOfDate('2026-11-03'), '2026-11-04').weekInProgress).toBe(false)
  })

  it('has no day reading on a day the payload does not carry', () => {
    const reading = readingAt([], [week('2026-11-02')], calendarDayOfDate('2026-11-08'), '2026-11-20')
    expect(reading.week?.week_start).toBe('2026-11-02')
    expect(reading.day).toBeUndefined()
  })
})
