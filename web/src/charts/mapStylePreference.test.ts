import { afterEach, describe, expect, it, vi } from 'vitest'
import { readMapFlavour, writeMapFlavour } from './mapStylePreference'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('the map flavour preference', () => {
  it('defaults to light', () => {
    expect(readMapFlavour()).toBe('light')
  })

  it('remembers grayscale', () => {
    writeMapFlavour('grayscale')
    expect(readMapFlavour()).toBe('grayscale')
  })

  it('reads a value it did not write as light', () => {
    localStorage.setItem('activity-analysis:map-flavour', 'neon')
    expect(readMapFlavour()).toBe('light')
  })

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(readMapFlavour()).toBe('light')
    expect(() => writeMapFlavour('grayscale')).not.toThrow()
  })
})
