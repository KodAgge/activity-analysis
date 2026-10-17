import { describe, expect, it } from 'vitest'
import type { DistributionRun } from '../charts/distributionVariables'
import {
  applySearchChange,
  customBoundChange,
  distributionSearchRedirectTarget,
  exclusiveEnd,
  inclusiveLastDay,
  groupsFor,
  periodLabel,
  periodRange,
  todayLocalDate,
  validateDistributionSearch,
  yearsIn,
  type DistributionSearch,
} from './distributionSearch'

function run(overrides: Partial<DistributionRun> = {}): DistributionRun {
  return {
    activity_id: 'a1',
    start_time_utc: '2026-01-01T06:00:00Z',
    utc_offset_s: 0,
    is_indoor: false,
    distance_m: 5000,
    moving_time_s: 1800,
    elapsed_time_s: 1850,
    avg_speed_mps: 2.78,
    avg_hr_bpm: 150,
    max_hr_bpm: 170,
    avg_cadence_spm: 160,
    ascent_per_km_m: 5,
    hr_at_median_bpm: 150,
    cadence_at_median_spm: 160,
    decoupling_pct: 3,
    is_aerobic_long_run: true,
    days_since_previous_run: 1,
    ...overrides,
  }
}

const TODAY = '2026-09-28'

describe('validateDistributionSearch', () => {
  it('is idempotent over a table of inputs', () => {
    const cases: Record<string, unknown>[] = [
      {},
      { variable: 'avg_hr' },
      { variable: 'distance', measure: 'distance' },
      { variable: 'distance', period: 'last_12_months' },
      { variable: 'distance', period: 'year_2024' },
      { variable: 'distance', period: 'custom', from: '2026-01-01', to: '2026-02-01' },
      { variable: 'distance', period: 'custom', from: '2026-01-01' },
      { variable: 'distance', days: 'weekends' },
      { variable: 'distance', treadmill: 'exclude' },
      { variable: 'distance', compare: 'periods', vs: 'year_2023' },
      { variable: 'distance', compare: 'periods', vs: 'custom', vs_from: '2025-01-01', vs_to: '2025-06-01' },
      { variable: 'distance', bucket: '5000' },
      { variable: 'distance', bucket: 5000 },
      { variable: 'nonsense' },
      { variable: 'distance', period: 'year_20x5' },
    ]
    for (const raw of cases) {
      const once = validateDistributionSearch(raw)
      const twice = validateDistributionSearch({ ...once })
      expect(twice, JSON.stringify(raw)).toEqual(once)
    }
  })

  it('defaults variable to distance and drops every other default key', () => {
    expect(validateDistributionSearch({})).toEqual({ variable: 'distance' })
  })

  it('falls unknown variable back to distance', () => {
    expect(validateDistributionSearch({ variable: 'not_a_variable' })).toEqual({ variable: 'distance' })
  })

  it('drops measure, period, days, treadmill and compare when they equal their default', () => {
    const result = validateDistributionSearch({
      variable: 'distance',
      measure: 'runs',
      period: 'all',
      days: 'all',
      treadmill: 'include',
      compare: 'none',
    })
    expect(result).toEqual({ variable: 'distance' })
  })

  it('keeps a non-default measure, days, treadmill and compare', () => {
    expect(validateDistributionSearch({ variable: 'distance', measure: 'distance' }).measure).toBe('distance')
    expect(validateDistributionSearch({ variable: 'distance', days: 'weekdays' }).days).toBe('weekdays')
    expect(validateDistributionSearch({ variable: 'distance', treadmill: 'exclude' }).treadmill).toBe('exclude')
    expect(validateDistributionSearch({ variable: 'distance', compare: 'years' }).compare).toBe('years')
  })

  it('drops an unrecognised measure, days, treadmill or compare value', () => {
    expect(validateDistributionSearch({ measure: 'nonsense' })).not.toHaveProperty('measure')
    expect(validateDistributionSearch({ days: 'nonsense' })).not.toHaveProperty('days')
    expect(validateDistributionSearch({ treadmill: 'nonsense' })).not.toHaveProperty('treadmill')
    expect(validateDistributionSearch({ compare: 'nonsense' })).not.toHaveProperty('compare')
  })

  it('keeps a well-formed year period', () => {
    expect(validateDistributionSearch({ period: 'year_2024' }).period).toBe('year_2024')
  })

  it('drops year_20x5, a period naming fewer than four digits or non-digits', () => {
    const result = validateDistributionSearch({ period: 'year_20x5' })
    expect(result).not.toHaveProperty('period')
  })

  it('keeps a custom period with both dates when from < to', () => {
    const result = validateDistributionSearch({ period: 'custom', from: '2026-01-01', to: '2026-02-01' })
    expect(result.period).toBe('custom')
    expect(result.from).toBe('2026-01-01')
    expect(result.to).toBe('2026-02-01')
  })

  it('keeps a custom period given only one valid date', () => {
    const fromOnly = validateDistributionSearch({ period: 'custom', from: '2026-01-01' })
    expect(fromOnly.period).toBe('custom')
    expect(fromOnly.from).toBe('2026-01-01')
    expect(fromOnly).not.toHaveProperty('to')

    const toOnly = validateDistributionSearch({ period: 'custom', to: '2026-02-01' })
    expect(toOnly.period).toBe('custom')
    expect(toOnly.to).toBe('2026-02-01')
    expect(toOnly).not.toHaveProperty('from')
  })

  it('drops period, from and to together when from >= to', () => {
    const result = validateDistributionSearch({ period: 'custom', from: '2026-02-01', to: '2026-01-01' })
    expect(result).not.toHaveProperty('period')
    expect(result).not.toHaveProperty('from')
    expect(result).not.toHaveProperty('to')
  })

  it('drops period, from and to together when custom names no valid date at all', () => {
    const result = validateDistributionSearch({ period: 'custom', from: 'hello', to: 'also not a date' })
    expect(result).not.toHaveProperty('period')
    expect(result).not.toHaveProperty('from')
    expect(result).not.toHaveProperty('to')
  })

  it('drops from and to when period is not custom', () => {
    const result = validateDistributionSearch({ period: 'last_12_months', from: '2026-01-01', to: '2026-02-01' })
    expect(result).not.toHaveProperty('from')
    expect(result).not.toHaveProperty('to')
  })

  it('drops vs, vs_from and vs_to unless compare is periods', () => {
    const result = validateDistributionSearch({
      compare: 'days',
      vs: 'year_2023',
      vs_from: '2026-01-01',
      vs_to: '2026-02-01',
    })
    expect(result).not.toHaveProperty('vs')
    expect(result).not.toHaveProperty('vs_from')
    expect(result).not.toHaveProperty('vs_to')

    const bare = validateDistributionSearch({ vs: 'year_2023' })
    expect(bare).not.toHaveProperty('vs')
  })

  it('keeps vs under compare=periods, and drops it back to the default previous_12_months', () => {
    expect(validateDistributionSearch({ compare: 'periods', vs: 'year_2023' }).vs).toBe('year_2023')
    const atDefault = validateDistributionSearch({ compare: 'periods', vs: 'previous_12_months' })
    expect(atDefault).not.toHaveProperty('vs')
  })

  it('keeps vs_from/vs_to only with compare=periods and vs=custom, subject to the same from<to rule', () => {
    const result = validateDistributionSearch({
      compare: 'periods',
      vs: 'custom',
      vs_from: '2025-01-01',
      vs_to: '2025-06-01',
    })
    expect(result.vs).toBe('custom')
    expect(result.vs_from).toBe('2025-01-01')
    expect(result.vs_to).toBe('2025-06-01')

    const backwards = validateDistributionSearch({
      compare: 'periods',
      vs: 'custom',
      vs_from: '2025-06-01',
      vs_to: '2025-01-01',
    })
    expect(backwards).not.toHaveProperty('vs')
    expect(backwards).not.toHaveProperty('vs_from')
    expect(backwards).not.toHaveProperty('vs_to')
  })

  it('keeps bucket as a plain string', () => {
    expect(validateDistributionSearch({ bucket: '5000' }).bucket).toBe('5000')
    expect(validateDistributionSearch({ bucket: 'below' }).bucket).toBe('below')
  })

  it('keeps a numeric bucket, stringified - the router\'s own JSON parseSearch turns ?bucket=5000 into the number 5000', () => {
    // histogramMath.bucketsFor builds a numeric variable's regular bucket
    // keys with String(lo) and a category's with String(category.key), so
    // most bucket keys are exactly this shape: a bare numeric string that
    // TanStack Router's default parseSearch (JSON.parse per value) hands
    // back as a number, not a string, for any URL a reader actually typed
    // or pasted rather than one this app itself built with a JS object.
    expect(validateDistributionSearch({ bucket: 5000 }).bucket).toBe('5000')
    expect(validateDistributionSearch({ bucket: 0 }).bucket).toBe('0')
    expect(validateDistributionSearch({ bucket: -12.5 }).bucket).toBe('-12.5')
  })

  it('drops a non-finite or non-string/number bucket, and an empty string', () => {
    expect(validateDistributionSearch({ bucket: '' })).not.toHaveProperty('bucket')
    expect(validateDistributionSearch({ bucket: Number.NaN })).not.toHaveProperty('bucket')
    expect(validateDistributionSearch({ bucket: Number.POSITIVE_INFINITY })).not.toHaveProperty('bucket')
    expect(validateDistributionSearch({ bucket: true })).not.toHaveProperty('bucket')
    expect(validateDistributionSearch({ bucket: ['5000'] })).not.toHaveProperty('bucket')
    expect(validateDistributionSearch({ bucket: { key: '5000' } })).not.toHaveProperty('bucket')
  })

  it('drops a key it has never heard of', () => {
    const result = validateDistributionSearch({ variable: 'distance', unknown: 'x' })
    expect(result).toEqual({ variable: 'distance' })
  })
})

describe('distributionSearchRedirectTarget', () => {
  it('is null for an already-clean search', () => {
    expect(distributionSearchRedirectTarget({ variable: 'distance' })).toBeNull()
    expect(
      distributionSearchRedirectTarget({ variable: 'avg_hr', measure: 'distance', compare: 'years' }),
    ).toBeNull()
  })

  it('redirects a bare search to the default variable', () => {
    expect(distributionSearchRedirectTarget({})).toEqual({ variable: 'distance' })
  })

  it('redirects away an unknown key and an invalid value', () => {
    expect(distributionSearchRedirectTarget({ variable: 'distance', period: 'year_20x5', unknown: 'x' })).toEqual({
      variable: 'distance',
    })
  })

  it('normalises a numeric bucket to its string form, the shape a hand-typed ?bucket=5000 actually parses to', () => {
    // TanStack Router's default parseSearch is JSON.parse per raw query
    // value (`defaultParseSearch` in `@tanstack/router-core`), so a URL
    // typed or pasted as `?bucket=5000` hands `beforeLoad` the *number*
    // 5000 here, not the string '5000' - this is exactly that parsed
    // shape, not a hypothetical one.
    expect(distributionSearchRedirectTarget({ variable: 'distance', bucket: 5000 })).toEqual({
      variable: 'distance',
      bucket: '5000',
    })
  })
})

describe('periodRange', () => {
  it('is unbounded for all', () => {
    expect(periodRange('all', undefined, undefined, TODAY)).toEqual({ from: null, to: null })
  })

  it('is the trailing 12 months through tomorrow for last_12_months', () => {
    expect(periodRange('last_12_months', undefined, undefined, TODAY)).toEqual({
      from: '2025-09-28',
      to: '2026-09-29',
    })
  })

  it('is the 12 months before that for previous_12_months', () => {
    expect(periodRange('previous_12_months', undefined, undefined, TODAY)).toEqual({
      from: '2024-09-28',
      to: '2025-09-28',
    })
  })

  it('is one calendar year for year_YYYY', () => {
    expect(periodRange('year_2024', undefined, undefined, TODAY)).toEqual({
      from: '2024-01-01',
      to: '2025-01-01',
    })
  })

  it('is from/to verbatim for custom, half-open, null for a missing side', () => {
    expect(periodRange('custom', '2026-01-01', '2026-02-01', TODAY)).toEqual({
      from: '2026-01-01',
      to: '2026-02-01',
    })
    expect(periodRange('custom', '2026-01-01', undefined, TODAY)).toEqual({
      from: '2026-01-01',
      to: null,
    })
  })

  it('steps a 29 February today to 1 March a year earlier under month arithmetic', () => {
    expect(periodRange('last_12_months', undefined, undefined, '2024-02-29')).toEqual({
      from: '2023-03-01',
      to: '2024-03-01',
    })
  })
})

describe('periodLabel', () => {
  it('labels every preset', () => {
    // "All time" rather than "All runs": beside another period in a
    // comparison it names a span of time, the way the other presets do.
    expect(periodLabel('all', undefined, undefined)).toBe('All time')
    expect(periodLabel('last_12_months', undefined, undefined)).toBe('Last 12 months')
    expect(periodLabel('previous_12_months', undefined, undefined)).toBe('Previous 12 months')
    expect(periodLabel('year_2024', undefined, undefined)).toBe('2024')
  })

  it('labels a custom range by its first and last day, not by the exclusive end the URL holds', () => {
    expect(periodLabel('custom', '2026-01-01', '2026-02-01')).toBe('1 January 2026 to 31 January 2026')
    expect(periodLabel('custom', '2026-01-01', undefined)).toBe('From 1 January 2026')
    expect(periodLabel('custom', undefined, '2026-03-01')).toBe('Through 28 February 2026')
  })
})

describe('yearsIn', () => {
  it('lists the distinct years present, ascending', () => {
    const runs = [
      run({ start_time_utc: '2024-06-01T06:00:00Z' }),
      run({ start_time_utc: '2026-01-01T06:00:00Z' }),
      run({ start_time_utc: '2025-01-01T06:00:00Z' }),
      run({ start_time_utc: '2025-06-01T06:00:00Z' }),
    ]
    expect(yearsIn(runs)).toEqual([2024, 2025, 2026])
  })

  it('is empty for no runs', () => {
    expect(yearsIn([])).toEqual([])
  })
})

describe('groupsFor', () => {
  const search: DistributionSearch = { variable: 'distance' }

  it('compare=none is one group, All runs, with every run', () => {
    const runs = [run({ activity_id: 'a' }), run({ activity_id: 'b' })]
    const groups = groupsFor(search, runs, TODAY)
    expect(groups).toEqual([{ key: 'all', label: 'All runs', runs }])
  })

  it('compare=none applies the period, days and treadmill filters', () => {
    const inWindow = run({ activity_id: 'in', start_time_utc: '2026-09-01T06:00:00Z', is_indoor: false })
    const outsideWindow = run({ activity_id: 'out', start_time_utc: '2020-01-01T06:00:00Z', is_indoor: false })
    const treadmillRun = run({ activity_id: 'tm', start_time_utc: '2026-09-02T06:00:00Z', is_indoor: true })
    const groups = groupsFor(
      { variable: 'distance', period: 'last_12_months', treadmill: 'exclude' },
      [inWindow, outsideWindow, treadmillRun],
      TODAY,
    )
    expect(groups).toEqual([{ key: 'all', label: 'All runs', runs: [inWindow] }])
  })

  it('compare=periods groups period against vs, filtered by days and treadmill in each', () => {
    const a = run({ activity_id: 'a', start_time_utc: '2026-09-01T06:00:00Z' })
    const b = run({ activity_id: 'b', start_time_utc: '2024-10-01T06:00:00Z' })
    const groups = groupsFor(
      { variable: 'distance', compare: 'periods', period: 'last_12_months', vs: 'previous_12_months' },
      [a, b],
      TODAY,
    )
    expect(groups).toEqual([
      { key: 'a', label: 'Last 12 months', runs: [a] },
      { key: 'b', label: 'Previous 12 months', runs: [b] },
    ])
  })

  it('compare=days splits weekdays from weekends and ignores the days filter', () => {
    const weekday = run({ activity_id: 'wd', start_time_utc: '2026-09-28T06:00:00Z' }) // Monday
    const weekend = run({ activity_id: 'we', start_time_utc: '2026-09-26T06:00:00Z' }) // Saturday
    const groups = groupsFor(
      { variable: 'distance', compare: 'days', days: 'weekends' },
      [weekday, weekend],
      TODAY,
    )
    expect(groups).toEqual([
      { key: 'weekdays', label: 'Weekdays', runs: [weekday] },
      { key: 'weekends', label: 'Weekends', runs: [weekend] },
    ])
  })

  it('compare=days gives an empty Weekends group when the period holds no weekend runs', () => {
    const weekday = run({ activity_id: 'wd', start_time_utc: '2026-09-28T06:00:00Z' }) // Monday
    const groups = groupsFor({ variable: 'distance', compare: 'days' }, [weekday], TODAY)
    expect(groups).toEqual([
      { key: 'weekdays', label: 'Weekdays', runs: [weekday] },
      { key: 'weekends', label: 'Weekends', runs: [] },
    ])
  })

  it('compare=surface splits outdoor from treadmill and ignores the treadmill filter', () => {
    const outdoor = run({ activity_id: 'out', is_indoor: false })
    const unknown = run({ activity_id: 'unk', is_indoor: null })
    const indoor = run({ activity_id: 'in', is_indoor: true })
    const groups = groupsFor(
      { variable: 'distance', compare: 'surface', treadmill: 'exclude' },
      [outdoor, unknown, indoor],
      TODAY,
    )
    expect(groups).toEqual([
      { key: 'outdoor', label: 'Outdoor', runs: [outdoor, unknown] },
      { key: 'treadmill', label: 'Treadmill', runs: [indoor] },
    ])
  })

  it('a null is_indoor survives treadmill=exclude outside compare=surface too', () => {
    const outdoor = run({ activity_id: 'out', is_indoor: false })
    const unknown = run({ activity_id: 'unk', is_indoor: null })
    const indoor = run({ activity_id: 'in', is_indoor: true })
    const groups = groupsFor({ variable: 'distance', treadmill: 'exclude' }, [outdoor, unknown, indoor], TODAY)
    expect(groups).toEqual([{ key: 'all', label: 'All runs', runs: [outdoor, unknown] }])
  })

  it('reads the weekday on the local calendar: 23:30 UTC on a Friday at +1 is a Saturday run', () => {
    const lateFriday = run({ activity_id: 'sat', start_time_utc: '2026-01-02T23:30:00Z', utc_offset_s: 3600 })
    expect(groupsFor({ variable: 'distance', compare: 'days' }, [lateFriday], TODAY)).toEqual([
      { key: 'weekdays', label: 'Weekdays', runs: [] },
      { key: 'weekends', label: 'Weekends', runs: [lateFriday] },
    ])
    expect(groupsFor({ variable: 'distance', days: 'weekends' }, [lateFriday], TODAY)).toEqual([
      { key: 'all', label: 'All runs', runs: [lateFriday] },
    ])
  })

  it('reads the year and the period on the local calendar: 23:30 UTC on 31 December at +1 is 2026', () => {
    const newYear = run({ activity_id: 'ny', start_time_utc: '2025-12-31T23:30:00Z', utc_offset_s: 3600 })
    expect(yearsIn([newYear])).toEqual([2026])
    expect(groupsFor({ variable: 'distance', period: 'year_2026' }, [newYear], TODAY)[0]?.runs).toEqual([newYear])
    expect(groupsFor({ variable: 'distance', period: 'year_2025' }, [newYear], TODAY)[0]?.runs).toEqual([])
    expect(
      groupsFor({ variable: 'distance', period: 'custom', from: '2026-01-01', to: '2026-02-01' }, [newYear], TODAY)[0]?.runs,
    ).toEqual([newYear])
    expect(groupsFor({ variable: 'distance', compare: 'years' }, [newYear], TODAY)).toEqual([
      { key: '2026', label: '2026', runs: [newYear] },
    ])
  })

  it('compare=years groups one bucket per calendar year present after filtering', () => {
    const y2024 = run({ activity_id: '2024', start_time_utc: '2024-06-01T06:00:00Z' })
    const y2025a = run({ activity_id: '2025a', start_time_utc: '2025-03-01T06:00:00Z' })
    const y2025b = run({ activity_id: '2025b', start_time_utc: '2025-11-01T06:00:00Z' })
    const groups = groupsFor({ variable: 'distance', compare: 'years' }, [y2024, y2025a, y2025b], TODAY)
    expect(groups).toEqual([
      { key: '2024', label: '2024', runs: [y2024] },
      { key: '2025', label: '2025', runs: [y2025a, y2025b] },
    ])
  })
})

describe('todayLocalDate', () => {
  it('reads the given Date with the machine-local getters', () => {
    const now = new Date(2026, 8, 28, 23, 30) // month is 0-based: September
    expect(todayLocalDate(now)).toBe('2026-09-28')
  })

  it('pads single-digit months and days', () => {
    const now = new Date(2026, 0, 5)
    expect(todayLocalDate(now)).toBe('2026-01-05')
  })
})

describe('inclusiveLastDay and exclusiveEnd', () => {
  it('turn the URL\'s exclusive end into the last day a reader picks, and back', () => {
    expect(inclusiveLastDay('2026-02-01')).toBe('2026-01-31')
    expect(inclusiveLastDay('2024-03-01')).toBe('2024-02-29')
    expect(exclusiveEnd('2026-01-31')).toBe('2026-02-01')
    expect(exclusiveEnd('2026-12-31')).toBe('2027-01-01')
  })
})

describe('customBoundChange', () => {
  it('sets the first day, and moves the end past it when the two would cross', () => {
    expect(customBoundChange({ from: '2026-01-01', to: '2026-02-01' }, 'from', '2026-01-10')).toEqual({
      from: '2026-01-10',
      to: '2026-02-01',
    })
    expect(customBoundChange({ from: '2026-01-01', to: '2026-02-01' }, 'from', '2026-03-05')).toEqual({
      from: '2026-03-05',
      to: '2026-03-06',
    })
  })

  it('takes the last day inclusive and stores the day after it', () => {
    expect(customBoundChange({ from: '2026-01-01', to: '2026-02-01' }, 'lastDay', '2026-01-15')).toEqual({
      from: '2026-01-01',
      to: '2026-01-16',
    })
  })

  it('moves the first day back when the last day is set before it', () => {
    expect(customBoundChange({ from: '2026-01-10', to: '2026-02-01' }, 'lastDay', '2026-01-05')).toEqual({
      from: '2026-01-05',
      to: '2026-01-06',
    })
  })

  it('clears a bound whose input was emptied', () => {
    expect(customBoundChange({ from: '2026-01-01', to: '2026-02-01' }, 'from', '')).toEqual({ to: '2026-02-01' })
    expect(customBoundChange({ from: '2026-01-01', to: '2026-02-01' }, 'lastDay', '')).toEqual({ from: '2026-01-01' })
  })

  it('ignores a value that is not a date', () => {
    expect(customBoundChange({ from: '2026-01-01', to: '2026-02-01' }, 'from', '2026-13-40')).toEqual({
      from: '2026-01-01',
      to: '2026-02-01',
    })
  })
})

describe('applySearchChange', () => {
  it('clears the bucket when the variable changes, because a key means nothing on another axis', () => {
    expect(applySearchChange({ variable: 'distance', bucket: '6000' }, { variable: 'avg_hr' }, TODAY)).toEqual({
      variable: 'avg_hr',
    })
  })

  it('keeps the bucket across any other change', () => {
    expect(applySearchChange({ variable: 'distance', bucket: '6000' }, { measure: 'distance' }, TODAY)).toEqual({
      variable: 'distance',
      measure: 'distance',
      bucket: '6000',
    })
  })

  it('clears the bucket when asked to', () => {
    expect(applySearchChange({ variable: 'distance', bucket: '6000' }, { bucket: undefined }, TODAY)).toEqual({
      variable: 'distance',
    })
  })

  it('compares the last 12 months against the 12 before when periods are chosen from all time', () => {
    expect(applySearchChange({ variable: 'distance' }, { compare: 'periods' }, TODAY)).toEqual({
      variable: 'distance',
      compare: 'periods',
      period: 'last_12_months',
    })
  })

  it('keeps a period the reader already chose when periods are compared', () => {
    expect(applySearchChange({ variable: 'distance', period: 'year_2024' }, { compare: 'periods' }, TODAY)).toEqual({
      variable: 'distance',
      period: 'year_2024',
      compare: 'periods',
    })
  })

  it('keeps the days filter in the URL while comparing by days, so turning it off restores it', () => {
    const comparing = applySearchChange({ variable: 'distance', days: 'weekends' }, { compare: 'days' }, TODAY)
    expect(comparing).toEqual({ variable: 'distance', days: 'weekends', compare: 'days' })
    expect(applySearchChange(comparing, { compare: 'none' }, TODAY)).toEqual({ variable: 'distance', days: 'weekends' })
  })

  it('seeds a custom range from the period it replaces, so choosing custom does not fall back to all time', () => {
    expect(applySearchChange({ variable: 'distance', period: 'year_2024' }, { period: 'custom' }, TODAY)).toEqual({
      variable: 'distance',
      period: 'custom',
      from: '2024-01-01',
      to: '2025-01-01',
    })
    expect(applySearchChange({ variable: 'distance' }, { period: 'custom' }, TODAY)).toEqual({
      variable: 'distance',
      period: 'custom',
      from: '2025-09-28',
      to: '2026-09-29',
    })
  })

  it('seeds the second period the same way', () => {
    expect(
      applySearchChange({ variable: 'distance', compare: 'periods', period: 'last_12_months' }, { vs: 'custom' }, TODAY),
    ).toEqual({
      variable: 'distance',
      compare: 'periods',
      period: 'last_12_months',
      vs: 'custom',
      vs_from: '2024-09-28',
      vs_to: '2025-09-28',
    })
  })

  it('drops a value set back to its default', () => {
    expect(applySearchChange({ variable: 'distance', measure: 'time' }, { measure: 'runs' }, TODAY)).toEqual({
      variable: 'distance',
    })
  })
})
