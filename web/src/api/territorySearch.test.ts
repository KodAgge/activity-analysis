import { describe, expect, it } from 'vitest'
import { territorySearchRedirectTarget, validateTerritorySearch } from './territorySearch'

describe('validateTerritorySearch', () => {
  it('keeps a region id', () => {
    expect(validateTerritorySearch({ region: '9f3c2a71d4e8b065' })).toEqual({ region: '9f3c2a71d4e8b065' })
  })

  it('drops an empty, a non-string and an unknown key', () => {
    expect(validateTerritorySearch({ region: '  ' })).toEqual({})
    expect(validateTerritorySearch({ region: 12 })).toEqual({})
    expect(validateTerritorySearch({ zoom: '4' })).toEqual({})
  })
})

describe('territorySearchRedirectTarget', () => {
  it('is null for a URL that already says what the view shows', () => {
    expect(territorySearchRedirectTarget({})).toBeNull()
    expect(territorySearchRedirectTarget({ region: 'abc' })).toBeNull()
  })

  it('names the clean search for one that does not', () => {
    expect(territorySearchRedirectTarget({ region: '', zoom: '4' })).toEqual({})
  })
})
