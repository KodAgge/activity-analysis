import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DISTANCE_KEY,
  progressionSearchRedirectTarget,
  validateProgressionSearch,
} from './progressionSearch'

describe('validateProgressionSearch', () => {
  it('keeps a stated distance, whatever it is, because the key set belongs to the analysis layer', () => {
    expect(validateProgressionSearch({ distance: '10k' })).toEqual({ distance: '10k' })
    expect(validateProgressionSearch({ distance: '50k' })).toEqual({ distance: '50k' })
  })

  it('defaults to 5 km when the URL names no distance, or names it badly', () => {
    expect(validateProgressionSearch({})).toEqual({ distance: DEFAULT_DISTANCE_KEY })
    expect(validateProgressionSearch({ distance: '' })).toEqual({ distance: DEFAULT_DISTANCE_KEY })
    expect(validateProgressionSearch({ distance: 5000 })).toEqual({ distance: DEFAULT_DISTANCE_KEY })
    expect(validateProgressionSearch({ distance: ['5k'] })).toEqual({ distance: DEFAULT_DISTANCE_KEY })
  })

  it('drops every other key', () => {
    expect(validateProgressionSearch({ distance: '10k', unknown: 'x' })).toEqual({ distance: '10k' })
  })

  it('is idempotent, which is what keeps the redirect from looping', () => {
    for (const raw of [{}, { distance: '10k' }, { distance: 7 }, { distance: '5k', extra: true }]) {
      const once = validateProgressionSearch(raw)
      expect(validateProgressionSearch({ ...once })).toEqual(once)
    }
  })
})

describe('progressionSearchRedirectTarget', () => {
  it('proposes no redirect for a URL already in its clean shape', () => {
    expect(progressionSearchRedirectTarget({ distance: '10k' })).toBeNull()
  })

  it('redirects a bare URL to the default distance, so the address bar says what the chart shows', () => {
    expect(progressionSearchRedirectTarget({})).toEqual({ distance: DEFAULT_DISTANCE_KEY })
  })

  it('redirects an unknown key away', () => {
    expect(progressionSearchRedirectTarget({ distance: '10k', unknown: 'x' })).toEqual({ distance: '10k' })
  })
})
