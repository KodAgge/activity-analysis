import type { MapFlavour } from './basemapStyle'

const KEY = 'activity-analysis:territory-map-flavour'

/**
 * The territory map's flavour, per browser, apart from the route hero's
 * (`mapStylePreference`), because the two maps are read for different
 * things and a reader may want each in its own flavour.
 *
 * Light is the default, matching the route hero (chosen by the maintainer on 2026-10-03).
 * Grey leaves the accent the only colour on the map, so the ground and its
 * edge carry the hierarchy without Light's cyan water and green woods
 * competing with the pink fill; it is a click away, and remembered once
 * picked.
 *
 * Storage can be absent or throw in a private window, so every access is
 * guarded and Light is the answer when there is none.
 */
export function readTerritoryFlavour(): MapFlavour {
  try {
    return localStorage.getItem(KEY) === 'grayscale' ? 'grayscale' : 'light'
  } catch {
    return 'light'
  }
}

export function writeTerritoryFlavour(flavour: MapFlavour): void {
  try {
    localStorage.setItem(KEY, flavour)
  } catch {
    // A preference that cannot be stored is only forgotten.
  }
}
