import { describe, expect, it } from 'vitest'
import { applyTrendsSearchChange, trendsSearchRedirectTarget, validateTrendsSearch } from './trendsSearch'

const TODAY = '2026-11-14'

describe('validateTrendsSearch', () => {
  it('writes nothing for the default, the last 12 months', () => {
    expect(validateTrendsSearch({})).toEqual({})
    expect(validateTrendsSearch({ period: 'last_12_months' })).toEqual({})
  })

  it('keeps all time, a year and the previous 12 months', () => {
    expect(validateTrendsSearch({ period: 'all' })).toEqual({ period: 'all' })
    expect(validateTrendsSearch({ period: 'year_2025' })).toEqual({ period: 'year_2025' })
    expect(validateTrendsSearch({ period: 'previous_12_months' })).toEqual({ period: 'previous_12_months' })
  })

  it('keeps a custom range with its dates, and drops dates from any other period', () => {
    expect(validateTrendsSearch({ period: 'custom', from: '2026-01-01', to: '2026-03-01' })).toEqual({
      period: 'custom',
      from: '2026-01-01',
      to: '2026-03-01',
    })
    expect(validateTrendsSearch({ period: 'all', from: '2026-01-01' })).toEqual({ period: 'all' })
  })

  it('falls back to the default for an unknown period, a crossed range or a custom one with no date', () => {
    expect(validateTrendsSearch({ period: 'forever' })).toEqual({})
    expect(validateTrendsSearch({ period: 'custom', from: '2026-03-01', to: '2026-01-01' })).toEqual({})
    expect(validateTrendsSearch({ period: 'custom' })).toEqual({})
  })

  it('drops keys it does not know', () => {
    expect(validateTrendsSearch({ period: 'all', variable: 'distance' })).toEqual({ period: 'all' })
  })
})

describe('trendsSearchRedirectTarget', () => {
  it('needs no redirect for a bare /trends, so a hash link into the page lands without one', () => {
    expect(trendsSearchRedirectTarget({})).toBeNull()
    expect(trendsSearchRedirectTarget({ period: 'all' })).toBeNull()
  })

  it('redirects a malformed search to its clean shape', () => {
    expect(trendsSearchRedirectTarget({ period: 'last_12_months' })).toEqual({})
    expect(trendsSearchRedirectTarget({ period: 'nope' })).toEqual({})
  })
})

describe('applyTrendsSearchChange', () => {
  it('seeds a custom range from the last 12 months it replaces', () => {
    expect(applyTrendsSearchChange({}, { period: 'custom' }, TODAY)).toEqual({
      period: 'custom',
      from: '2025-11-14',
      to: '2026-11-15',
    })
  })

  it('seeds a custom range from a year it replaces', () => {
    expect(applyTrendsSearchChange({ period: 'year_2024' }, { period: 'custom' }, TODAY)).toEqual({
      period: 'custom',
      from: '2024-01-01',
      to: '2025-01-01',
    })
  })

  it('drops the dates when a preset replaces a custom range', () => {
    expect(
      applyTrendsSearchChange({ period: 'custom', from: '2026-01-01', to: '2026-02-01' }, { period: 'all' }, TODAY),
    ).toEqual({ period: 'all' })
  })

  it('moves one bound of a custom range and keeps the other', () => {
    expect(
      applyTrendsSearchChange(
        { period: 'custom', from: '2026-01-01', to: '2026-02-01' },
        { from: '2025-12-01', to: '2026-02-01' },
        TODAY,
      ),
    ).toEqual({ period: 'custom', from: '2025-12-01', to: '2026-02-01' })
  })
})
