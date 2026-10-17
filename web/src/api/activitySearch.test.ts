import { describe, expect, it } from 'vitest'
import { activitySearchRedirectTarget, isUnfilteredSearch, validateActivitySearch } from './activitySearch'
import type { ActivitySearch } from './activitySearch'

describe('validateActivitySearch', () => {
  it('defaults sport to running when absent', () => {
    expect(validateActivitySearch({})).toEqual({ sport: 'running' })
  })

  it('keeps a recognised sport value', () => {
    expect(validateActivitySearch({ sport: 'cycling' })).toEqual({ sport: 'cycling' })
  })

  it('keeps moving_time_s as a recognised sort value', () => {
    // The fourth sortable column, added alongside the "Moving time" browser
    // header actually being sortable server-side (I2): a validator that
    // still lists only the original three would drop this and silently
    // fall the URL back to the default sort.
    expect(validateActivitySearch({ sort: 'moving_time_s' })).toEqual({ sport: 'running', sort: 'moving_time_s' })
  })

  it('keeps every recognised, well-formed filter', () => {
    const search = {
      sport: 'running',
      from: '2026-01-01',
      to: '2026-02-01',
      source: 'garmin_fit',
      has_hr: true,
      q: 'morning run',
      sort: 'distance_m',
      order: 'asc',
      limit: 25,
      offset: 10,
    }
    expect(validateActivitySearch(search)).toEqual(search)
  })

  describe('adversarial URLs the reviewer probed', () => {
    it('drops a non-numeric limit rather than forwarding a string the endpoint would 422 on', () => {
      const result = validateActivitySearch({ limit: 'abc' })
      expect(result.limit).toBeUndefined()
      expect(result).not.toHaveProperty('limit')
    })

    it('drops an unrecognised sort value rather than forwarding it', () => {
      const result = validateActivitySearch({ sort: 'nonsense' })
      expect(result.sort).toBeUndefined()
      expect(result).not.toHaveProperty('sort')
    })

    it('drops an unrecognised source value rather than forwarding it', () => {
      const result = validateActivitySearch({ source: 'fitbit' })
      expect(result.source).toBeUndefined()
      expect(result).not.toHaveProperty('source')
    })

    it('drops a from value that is not a real calendar date', () => {
      const result = validateActivitySearch({ from: 'hello' })
      expect(result.from).toBeUndefined()
      expect(result).not.toHaveProperty('from')
    })

    it('drops a key the endpoint does not declare at all', () => {
      const result = validateActivitySearch({ unknown: 'x' })
      expect(result).not.toHaveProperty('unknown')
      expect(Object.keys(result)).toEqual(['sport'])
    })
  })

  describe('bounds and shape, beyond simple type checks', () => {
    it('clamps a limit above the endpoint maximum of 200', () => {
      expect(validateActivitySearch({ limit: 9999 }).limit).toBe(200)
    })

    it('clamps a limit below the endpoint minimum of 1', () => {
      expect(validateActivitySearch({ limit: 0 }).limit).toBe(1)
    })

    it('drops a fractional limit rather than rounding it', () => {
      // The endpoint's own type is `int`; Pydantic 422s on "2.5" rather than
      // rounding it, so there is no sane integer to forward here either.
      const result = validateActivitySearch({ limit: 2.5 })
      expect(result).not.toHaveProperty('limit')
    })

    it('clamps a negative offset to zero, the endpoint minimum', () => {
      expect(validateActivitySearch({ offset: -5 }).offset).toBe(0)
    })

    it('drops a fractional offset', () => {
      const result = validateActivitySearch({ offset: 1.5 })
      expect(result).not.toHaveProperty('offset')
    })

    it('rejects a from date with an out-of-range month and day', () => {
      // The regex alone would accept this; the round-trip through Date
      // catches it because 2024-13-40 is not a real calendar date.
      const result = validateActivitySearch({ from: '2024-13-40' })
      expect(result).not.toHaveProperty('from')
    })

    it('accepts a well-formed to date', () => {
      expect(validateActivitySearch({ to: '2026-08-31' }).to).toBe('2026-08-31')
    })
  })

  describe('type mismatches on otherwise-recognised keys', () => {
    it('drops has_hr when it is not a boolean', () => {
      const result = validateActivitySearch({ has_hr: 'true' })
      expect(result).not.toHaveProperty('has_hr')
    })

    it('drops q when it is not a string', () => {
      const result = validateActivitySearch({ q: 42 })
      expect(result).not.toHaveProperty('q')
    })

    it('drops order when it is not one of the two literals', () => {
      const result = validateActivitySearch({ order: 'ascending' })
      expect(result).not.toHaveProperty('order')
    })
  })
})

describe('activitySearchRedirectTarget', () => {
  it('returns null for an already-clean search - the loop guard', () => {
    // The whole point: a URL already equal to its own validated form must
    // not be redirected, or every load of a clean /activities URL would
    // loop.
    expect(activitySearchRedirectTarget({ sport: 'running' })).toBeNull()
    expect(
      activitySearchRedirectTarget({
        sport: 'running',
        limit: 25,
        offset: 10,
        sort: 'distance_m',
        order: 'asc',
      }),
    ).toBeNull()
  })

  it('returns the clamped value even though the key set does not change', () => {
    // `limit` is present on both sides here - only its value differs once
    // clamped. A same-keys comparison would wrongly see no difference.
    expect(activitySearchRedirectTarget({ sport: 'running', limit: 9999 })).toEqual({
      sport: 'running',
      limit: 200,
    })
  })

  it('returns the validated shape when a key is dropped entirely', () => {
    expect(activitySearchRedirectTarget({ limit: 'abc', unknown: 'x' })).toEqual({
      sport: 'running',
    })
  })

  it('returns null for the exact shape its own non-null answer redirects to', () => {
    // This is the idempotence property that keeps the redirect from
    // looping, exercised directly rather than only asserted in a comment:
    // whatever this function says to redirect *to* must itself redirect to
    // nothing.
    const target = activitySearchRedirectTarget({ limit: 9999, unknown: 'x' })
    if (target === null) throw new Error('expected a redirect target, got null')
    expect(activitySearchRedirectTarget(target)).toBeNull()
  })
})

describe('isUnfilteredSearch', () => {
  it('is true when every filter is off, whatever the presentation keys say', () => {
    expect(
      isUnfilteredSearch({ sport: 'all', sort: 'distance_m', order: 'asc', offset: 50, limit: 200, q: '' }),
    ).toBe(true)
  })

  it('treats the default sport as a filter', () => {
    // An empty page under `running` says nothing about the store as a whole.
    expect(isUnfilteredSearch({ sport: 'running' })).toBe(false)
  })

  it('treats each filter this branch added as a filter', () => {
    const cases: Partial<ActivitySearch>[] = [
      { has_pr: true },
      { has_pr: false },
      { min_distance_m: 999000 },
      { max_distance_m: 1 },
      { min_moving_time_s: 1 },
      { max_moving_time_s: 1 },
    ]
    for (const filter of cases) {
      expect(isUnfilteredSearch({ sport: 'all', ...filter }), JSON.stringify(filter)).toBe(false)
    }
  })

  it('treats a filter key it has never heard of as a filter', () => {
    // The point of naming the non-filter keys instead of the filter keys:
    // a filter added later is covered without this function being told.
    const search = { sport: 'all', brand_new_filter: 1 } as unknown as ActivitySearch
    expect(isUnfilteredSearch(search)).toBe(false)
  })
})
