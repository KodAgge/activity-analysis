import { describe, expect, it } from 'vitest'
import { customBoundChange, exclusiveEnd, inclusiveLastDay, periodLabel, periodRange, todayLocalDate } from './period'

const TODAY = '2026-09-28'

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
