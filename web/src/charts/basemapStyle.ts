import { layers, namedFlavor } from '@protomaps/basemaps'
import type { StyleSpecification } from 'maplibre-gl'

export type MapFlavour = 'light' | 'grayscale'

/**
 * The MapLibre style for one area in one flavour.
 *
 * Every URL is on the app's own origin: the archive through the `pmtiles`
 * protocol, which reads it by byte range from the API, and the glyphs and
 * sprite from the assets the `tiles` command fetched. MapLibre needs them
 * absolute, so `origin` is `window.location.origin` at the call site.
 * Labels are English, falling back to the local name where OpenStreetMap
 * has no English one.
 */
export function buildStyle(
  areaId: string,
  flavour: MapFlavour,
  origin: string,
  attribution: string,
): StyleSpecification {
  return {
    version: 8,
    glyphs: `${origin}/api/basemap/assets/fonts/{fontstack}/{range}.pbf`,
    sprite: `${origin}/api/basemap/assets/sprites/v4/${flavour}`,
    sources: {
      protomaps: {
        type: 'vector',
        url: `pmtiles://${origin}/api/basemap/areas/${areaId}.pmtiles`,
        attribution,
      },
    },
    layers: layers('protomaps', namedFlavor(flavour), { lang: 'en' }),
  }
}

/**
 * One MapLibre style over several areas at once, for a map that is not
 * fitted to one route: the territory map frames a region, and a region's
 * box can span two fetched areas (the real store's largest does, its east
 * and west halves) or none at all on a store that has never run `tiles`.
 *
 * Each area is its own `pmtiles` source, and Protomaps' layer list is
 * repeated per source, interleaved layer by layer - every area's `earth`,
 * then every area's `landcover`, and so on up to the labels - so one
 * area's fills never paint over another's roads or names where their low
 * zoom tiles overlap. Each repeat's id is suffixed with its area; the
 * background is drawn once. A label both archives carry collides with
 * itself and MapLibre places it once.
 *
 * `background`, `--panel`'s colour at the call site, is the style's
 * background either way: past the fetched areas, and on its own when there
 * are none, where the territory still draws, on plain ground rather than
 * on nothing.
 */
export function buildAreasStyle(
  areaIds: readonly string[],
  flavour: MapFlavour,
  origin: string,
  attribution: string,
  background: string,
): StyleSpecification {
  const glyphs = `${origin}/api/basemap/assets/fonts/{fontstack}/{range}.pbf`
  if (areaIds.length === 0) {
    return {
      version: 8,
      glyphs,
      sources: {},
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': background } }],
    }
  }
  const sources: StyleSpecification['sources'] = {}
  const perArea = areaIds.map((id) => {
    const sourceId = `protomaps-${id}`
    sources[sourceId] = {
      type: 'vector',
      url: `pmtiles://${origin}/api/basemap/areas/${id}.pmtiles`,
      attribution,
    }
    return layers(sourceId, namedFlavor(flavour), { lang: 'en' })
  })
  const first = perArea[0] ?? []
  const interleaved: StyleSpecification['layers'] = []
  first.forEach((layer, index) => {
    if (layer.type === 'background') {
      // Protomaps' own background is a mid grey, which is what shows
      // wherever the map is panned past every fetched area; `--panel`
      // there reads as plain ground rather than as a block of missing map.
      interleaved.push({ ...layer, paint: { ...layer.paint, 'background-color': background } })
      return
    }
    areaIds.forEach((id, k) => {
      const own = perArea[k]?.[index]
      if (own !== undefined) interleaved.push({ ...own, id: `${own.id}--${id}` })
    })
  })
  return {
    version: 8,
    glyphs,
    sprite: `${origin}/api/basemap/assets/sprites/v4/${flavour}`,
    sources,
    layers: interleaved,
  }
}
