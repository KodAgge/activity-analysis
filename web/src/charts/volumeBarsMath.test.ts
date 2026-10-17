import { describe, expect, it } from 'vitest'
import { localIsoDate, trailingMean, trendLastIndex } from './volumeBarsMath'

describe('trailingMean', () => {
  it('averages each period with the ones before it', () => {
    expect(trailingMean([3, 6, 9, 12], 2, 3)).toEqual([null, 4.5, 7.5, 10.5])
  })

  it('has no value until the window is full', () => {
    expect(trailingMean([1, 2, 3], 3, 2)).toEqual([null, null, 2])
    expect(trailingMean([1, 2], 3, 1)).toEqual([null, null])
  })

  it('counts a zero period as zero, so a week off pulls the average down', () => {
    expect(trailingMean([10, 0, 10, 0], 2, 3)).toEqual([null, 5, 5, 5])
  })

  it('has no value after the last known period', () => {
    expect(trailingMean([4, 4, 4, 0, 0], 2, 2)).toEqual([null, 4, 4, null, null])
  })

  it('has no value anywhere when no period is known', () => {
    expect(trailingMean([4, 4, 4], 2, -1)).toEqual([null, null, null])
  })
})

describe('trendLastIndex', () => {
  const weeks = ['2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07']

  it('stops at the week holding the last activity when the weeks after it are finished', () => {
    // The store's export ends on the Friday of the third week: the two
    // Mondays after it are weeks nothing is known about.
    expect(trendLastIndex(weeks, '2026-08-28', '2026-09-10')).toBe(2)
  })

  it('leaves out the week in progress, which always reads low', () => {
    expect(trendLastIndex(weeks, '2026-09-09', '2026-09-10')).toBe(3)
  })

  it('counts a week as finished from the Monday after it', () => {
    expect(trendLastIndex(weeks, '2026-09-09', '2026-09-14')).toBe(4)
    expect(trendLastIndex(weeks, '2026-09-09', '2026-09-13')).toBe(3)
  })

  it('is -1 on a store with no activity', () => {
    expect(trendLastIndex(weeks, null, '2026-09-10')).toBe(-1)
  })

  it('is -1 when the only week is the one in progress', () => {
    expect(trendLastIndex(['2026-09-07'], '2026-09-08', '2026-09-10')).toBe(-1)
  })
})

describe('localIsoDate', () => {
  it("is the machine's own calendar date, zero-padded", () => {
    expect(localIsoDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
    expect(localIsoDate(new Date(2026, 11, 31, 0, 1))).toBe('2026-12-31')
  })
})
