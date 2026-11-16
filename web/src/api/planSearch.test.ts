import { describe, expect, it } from 'vitest'
import { planSearchRedirectTarget, validatePlanSearch } from './planSearch'

describe('validatePlanSearch', () => {
  it('keeps a positive whole version number, as a number or as digits', () => {
    expect(validatePlanSearch({ version: 2 })).toEqual({ version: 2 })
    expect(validatePlanSearch({ version: '3' })).toEqual({ version: 3 })
  })

  it('drops a version that is not a positive whole number, and any unknown key', () => {
    expect(validatePlanSearch({ version: 0 })).toEqual({})
    expect(validatePlanSearch({ version: 1.5 })).toEqual({})
    expect(validatePlanSearch({ version: 'latest' })).toEqual({})
    expect(validatePlanSearch({ version: '' })).toEqual({})
    expect(validatePlanSearch({ week: 2 })).toEqual({})
  })

  it('keeps a session id beside the version', () => {
    expect(validatePlanSearch({ session: 'w1-intervals' })).toEqual({ session: 'w1-intervals' })
    expect(validatePlanSearch({ version: 2, session: '2026-08-25-intervals' })).toEqual({
      version: 2,
      session: '2026-08-25-intervals',
    })
    // The router's parser hands a numeric id over as a number; ids may be all digits.
    expect(validatePlanSearch({ session: 12 })).toEqual({ session: '12' })
  })

  it('drops a session that cannot be a session id', () => {
    expect(validatePlanSearch({ session: '' })).toEqual({})
    expect(validatePlanSearch({ session: 'W1 intervals' })).toEqual({})
    expect(validatePlanSearch({ session: '-w1' })).toEqual({})
    expect(validatePlanSearch({ session: true })).toEqual({})
    expect(validatePlanSearch({ session: 1.5 })).toEqual({})
    expect(validatePlanSearch({ session: { id: 'w1' } })).toEqual({})
  })
})

describe('planSearchRedirectTarget', () => {
  it('is null for a URL that already says what the view shows', () => {
    expect(planSearchRedirectTarget({})).toBeNull()
    expect(planSearchRedirectTarget({ version: 2 })).toBeNull()
    expect(planSearchRedirectTarget({ version: 2, session: 'w1-intervals' })).toBeNull()
  })

  it('names the clean search for one that does not', () => {
    expect(planSearchRedirectTarget({ version: 'x', week: 2 })).toEqual({})
    expect(planSearchRedirectTarget({ version: '2' })).toEqual({ version: 2 })
    expect(planSearchRedirectTarget({ session: 'Not an id' })).toEqual({})
  })
})
