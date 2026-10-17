import type { MapFlavour } from './basemapStyle'

const KEY = 'activity-analysis:map-flavour'

/**
 * The last flavour picked, per browser. Storage can be absent or throw in a
 * private window, so every access is guarded and Light is the answer when
 * there is none.
 */
export function readMapFlavour(): MapFlavour {
  try {
    return localStorage.getItem(KEY) === 'grayscale' ? 'grayscale' : 'light'
  } catch {
    return 'light'
  }
}

export function writeMapFlavour(flavour: MapFlavour): void {
  try {
    localStorage.setItem(KEY, flavour)
  } catch {
    // A preference that cannot be stored is only forgotten.
  }
}
