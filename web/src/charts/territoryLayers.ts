import { layers, namedFlavor } from '@protomaps/basemaps'
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl'
import type { components } from '../api/schema'
import type { MapFlavour } from './basemapStyle'
import type { Box } from './territoryMath'

type TerritoryFeatureCollection = components['schemas']['TerritoryFeatureCollection']

/** A ring of `[lon, lat]` positions, closed, as GeoJSON writes it. */
type Ring = number[][]

/**
 * The zooms the coarse underlay is read at, coarsest first.
 *
 * `activity-analysis tiles` fetches each area's own box, and a region's
 * fitted view runs past it: on the real store one region's box spans two
 * areas with a strip between them and an empty corner, and a desktop frame wider
 * than the box shows more. Every archive carries zooms 0 to 15 for the
 * tiles its box meets, and a low zoom tile is far larger than the box, so
 * the same archive read as a second source capped at these zooms is land,
 * water and the main roads for the whole frame, overzoomed. It sits under
 * the detailed layers, which cover it wherever they have tiles; a zoom 9
 * tile is 0.7 degrees wide, a zoom 6 tile 5.6, so the finer fills most of
 * a frame and the coarser the rest.
 *
 * Zoom 0 is the whole world in one tile and zoom 3 a sixty-fourth of it:
 * they are what a reader zoomed out to find the other places sees between
 * them, continents and seas rather than blank page, and zoom 0 alone is
 * too coarse for a country.
 *
 * At each zoom an area is read only when its box meets a tile no earlier
 * area's did: two neighbouring areas share their zoom 0, 3 and 6 tiles,
 * and a second copy of the same tile would only be drawn twice.
 */
export const UNDERLAY_MAXZOOMS = [0, 3, 6, 9] as const

/** The tiles at zoom `z` a box meets, as `x/y` keys. */
export function tilesMeetingBox(box: Box, z: number): string[] {
  const n = 2 ** z
  const clamp = (v: number) => Math.min(n - 1, Math.max(0, v))
  const x = (lon: number) => clamp(Math.floor(((lon + 180) / 360) * n))
  const y = (lat: number) => {
    const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180
    return clamp(Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n))
  }
  const keys: string[] = []
  for (let tx = x(box.west); tx <= x(box.east); tx++) {
    for (let ty = y(box.north); ty <= y(box.south); ty++) keys.push(`${String(tx)}/${String(ty)}`)
  }
  return keys
}

/**
 * The underlay sources' bounds, which replace the archive's own box.
 *
 * MapLibre 6 splits an overzoomed vector tile into tiles at the view's own
 * zoom (`zoomLevelsToOverscale`), and checks each of those against the
 * source's bounds, so with the archive's box as bounds the underlay was
 * asked for nothing outside the box - exactly where it is needed. Out here
 * a request that the archive has no tile for comes back empty.
 */
const WORLD_BOUNDS: [number, number, number, number] = [-180, -85.0511, 180, 85.0511]

/** The Protomaps layers the underlay keeps: the ground's fills and the roads a region is read by. */
function isUnderlayLayer(layer: LayerSpecification): boolean {
  if (layer.type === 'fill') {
    return layer.id === 'earth' || layer.id === 'landcover' || layer.id === 'water' || layer.id.startsWith('landuse_')
  }
  return layer.type === 'line' && (layer.id === 'roads_highway' || layer.id === 'roads_major')
}

/**
 * `style` with a coarse underlay of its areas, between the
 * background and the first detailed layer. See `UNDERLAY_MAXZOOMS`.
 *
 * A style with no areas is returned unchanged: there is nothing to read.
 * The underlay's sources carry no attribution of their own, being the
 * same archives the detailed sources already credit.
 */
export function withCoarseUnderlay(
  style: StyleSpecification,
  areas: readonly (Box & { id: string })[],
  flavour: MapFlavour,
  origin: string,
): StyleSpecification {
  if (areas.length === 0) return style
  const sources: StyleSpecification['sources'] = { ...style.sources }
  const underlay: LayerSpecification[] = []
  for (const maxzoom of UNDERLAY_MAXZOOMS) {
    const seen = new Set<string>()
    const readers = areas.filter((area) => {
      const fresh = tilesMeetingBox(area, maxzoom).filter((key) => !seen.has(key))
      for (const key of fresh) seen.add(key)
      return fresh.length > 0
    })
    for (const { id } of readers) {
      const sourceId = `underlay-z${String(maxzoom)}-${id}`
      sources[sourceId] = {
        type: 'vector',
        url: `pmtiles://${origin}/api/basemap/areas/${id}.pmtiles`,
        maxzoom,
        bounds: WORLD_BOUNDS,
      }
      for (const layer of layers(sourceId, namedFlavor(flavour), { lang: 'en' })) {
        if (isUnderlayLayer(layer)) underlay.push({ ...layer, id: `${layer.id}--${sourceId}` })
      }
    }
  }
  const [first, ...rest] = style.layers
  const head = first?.type === 'background' ? [first] : []
  const tail = first?.type === 'background' ? rest : style.layers
  return { ...style, sources, layers: [...head, ...underlay, ...tail] }
}

/** Where the territory's layers go in a basemap's layer list. */
export interface TerritoryAnchors {
  /**
   * The layer the claimed ground's fill is inserted under in the Light
   * flavour: the detailed basemap's first water. Over the land and its land cover, so the ground
   * is one colour whatever grows on it, and under the water, the
   * buildings, the roads and the names, so a lake in claimed ground is
   * still a lake and its streets stay white and sharp.
   */
  groundBefore: string | undefined
  /**
   * The layer the claimed ground's knockout and `--accent` tint are
   * inserted under in the Grey flavour: the first detailed layer after the
   * water, so the ground lies over a lake in it as well as over its land,
   * one tone, and under the buildings, the roads and the names. The
   * claimed shape then reads whole rather than holed by every lake in it,
   * which in Grey were blocks of dark grey inside the pink.
   */
  tintBefore: string | undefined
  /** The first label: the veil and the edge go under every name, so no name is ever washed or struck through. */
  overlayBefore: string | undefined
}

/**
 * The anchors in `layerIds`, a style's layer ids in drawing order. The
 * coarse underlay's own water is passed over: it lies under every
 * detailed layer, and the fill under it would be under the whole map.
 * With no water the fill goes under the first label too, and with no label
 * either both go on top: a style of background alone still shows the
 * ground.
 */
export function territoryAnchors(layerIds: readonly string[]): TerritoryAnchors {
  const firstLabel = layerIds.find((id) => isLabel(id))
  const isDetailedWater = (id: string) => isWaterFill(id) && !id.includes('--underlay-')
  const firstWater = layerIds.find(isDetailedWater)
  const lastWater = layerIds.findLastIndex(isDetailedWater)
  const afterWater = lastWater === -1 ? undefined : layerIds[lastWater + 1]
  return {
    groundBefore: firstWater ?? firstLabel,
    tintBefore: afterWater ?? firstWater ?? firstLabel,
    overlayBefore: firstLabel,
  }
}

/** Protomaps' symbol layers, by the ids `basemaps` 5 gives them, area suffix or not. */
const LABEL_PREFIXES = [
  'address_label',
  'water_waterway_label',
  'roads_oneway',
  'roads_labels',
  'water_label',
  'earth_label',
  'roads_shields',
  'pois',
  'places_',
]

/** Protomaps' water itself, `water` and its `water_stream` and `water_river` lines, area suffix or not; not its labels. */
function isWaterFill(id: string): boolean {
  const base = id.split('--')[0] ?? id
  return base === 'water' || base === 'water_stream' || base === 'water_river'
}

function isLabel(id: string): boolean {
  return LABEL_PREFIXES.some((prefix) => id.startsWith(prefix))
}

/** The world as one ring, to the latitudes Web Mercator draws. */
const WORLD: Ring = [
  [-180, -85.06],
  [180, -85.06],
  [180, 85.06],
  [-180, 85.06],
  [-180, -85.06],
]

/** The unclaimed ground as a GeoJSON Feature a `geojson` source takes. */
export interface UnclaimedGround {
  type: 'Feature'
  properties: Record<string, never>
  geometry: { type: 'MultiPolygon'; coordinates: Ring[][] }
}

/** Twice the signed planar area of a ring in degrees, enough to order rings that nest. */
function ringArea(ring: Ring): number {
  let sum = 0
  for (let i = 0; i + 1 < ring.length; i++) {
    const [x0 = 0, y0 = 0] = ring[i] ?? []
    const [x1 = 0, y1 = 0] = ring[i + 1] ?? []
    sum += x0 * y1 - x1 * y0
  }
  return Math.abs(sum)
}

/** Whether `point` is inside `ring`, by the even-odd crossing rule. */
export function ringContains(ring: Ring, point: readonly number[]): boolean {
  const [px = 0, py = 0] = point
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi = 0, yi = 0] = ring[i] ?? []
    const [xj = 0, yj = 0] = ring[j] ?? []
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Every polygon of the collection as rings, exterior first, whether a feature is a Polygon or a MultiPolygon. */
function polygonsOf(territory: TerritoryFeatureCollection): Ring[][] {
  const polygons: Ring[][] = []
  for (const feature of territory.features) {
    const geometry = feature.geometry
    if (geometry.type === 'Polygon') polygons.push(geometry.coordinates as Ring[])
    else polygons.push(...(geometry.coordinates as Ring[][]))
  }
  return polygons
}

/**
 * The unclaimed ground, as one MultiPolygon: the world with every part of
 * the territory cut out of it, and every unclaimed hole inside a part put
 * back.
 *
 * MapLibre has no inverted fill, so the ground a veil should lie on has to
 * be spelled out. The parts of a union are disjoint, so each one lies in
 * exactly one smallest enclosing gap - the world, or a hole in another
 * part, the moat round an island - and is cut out of that gap alone.
 * Cutting it from every gap that contains it would leave rings overlapping
 * and the fill painted twice or not at all.
 */
export function unclaimedGround(territory: TerritoryFeatureCollection): UnclaimedGround {
  const polygons = polygonsOf(territory)
  // The gaps: the world, then every hole of every part, each with its own cut-outs.
  const gaps: { ring: Ring; area: number; cuts: Ring[] }[] = [{ ring: WORLD, area: Infinity, cuts: [] }]
  for (const polygon of polygons) {
    for (const hole of polygon.slice(1)) gaps.push({ ring: hole, area: ringArea(hole), cuts: [] })
  }
  for (const polygon of polygons) {
    const exterior = polygon[0]
    const probe = exterior?.[0]
    if (exterior === undefined || probe === undefined) continue
    let home = gaps[0]
    for (const gap of gaps.slice(1)) {
      if (gap.area < (home?.area ?? Infinity) && ringContains(gap.ring, probe)) home = gap
    }
    home?.cuts.push(exterior)
  }
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'MultiPolygon', coordinates: gaps.map((gap) => [gap.ring, ...gap.cuts]) },
  }
}

/** The centre of a box, where a place's marker stands. */
export function boxCentre(box: Box): [number, number] {
  return [(box.west + box.east) / 2, (box.south + box.north) / 2]
}

/** A place as the map sees it at this moment: where its centre lands on screen and how big its ground is there. */
export interface PlaceOnScreen {
  id: string
  x: number
  y: number
  /** The longer side of the place's box on screen, in CSS px. */
  size: number
  /** The marker's label text, name and ground, whose length sets its width. */
  label: string
}

/** How a shown place is drawn: named, or a dot where a name would sit on another's. */
export type PlaceMark = 'named' | 'dot'

/** A marker's estimated box: the label at the 12 px label size, plus the dot and padding. */
const MARK_CHAR_PX = 6.6
const MARK_PAD_PX = 40
const MARK_HEIGHT_PX = 26

/**
 * Which places get a marker, and which of those are named, in `places`'
 * order - the endpoint's, largest region first.
 *
 * A place is marked once its ground is smaller than `maxPx` on screen.
 * Zoomed out to a continent, places a few hundred kilometres apart land on
 * the same pixels, and their names would overprint each other: a place
 * whose name would overlap an already named one is drawn as its dot alone,
 * still a button with its name, so the larger place keeps its name.
 */
export function placeMarks(places: readonly PlaceOnScreen[], maxPx: number): Map<string, PlaceMark> {
  const marks = new Map<string, PlaceMark>()
  const named: { left: number; right: number; top: number; bottom: number }[] = []
  for (const place of places) {
    if (place.size >= maxPx) continue
    const half = (MARK_PAD_PX + MARK_CHAR_PX * place.label.length) / 2
    const box = { left: place.x - half, right: place.x + half, top: place.y - MARK_HEIGHT_PX / 2, bottom: place.y + MARK_HEIGHT_PX / 2 }
    const clash = named.some((b) => box.left < b.right && box.right > b.left && box.top < b.bottom && box.bottom > b.top)
    marks.set(place.id, clash ? 'dot' : 'named')
    if (!clash) named.push(box)
  }
  return marks
}

/**
 * How far past the core's box a part may lie and still join it, as a share
 * of the box's longer side. On the real store a part holding a fifth of
 * the core's ground, lying 0.44 of the core's longer side past its box,
 * does not join it.
 */
const CORE_REACH = 0.25
/**
 * The least a part may hold, as a share of the ground already in the core,
 * to widen the core's box. On the real store a sliver holding 1.5% of the
 * core's ground, lying a fifth of the core's longer side out to the west,
 * would otherwise widen the box by 22% and draw the core a fifth smaller
 * on a phone, for a strip the fit button still shows.
 */
const CORE_JOIN_SHARE = 0.05
/** Below this share of the region's ground the core is no fair view of it, and the whole region is fitted instead. */
const CORE_MIN_SHARE = 0.5

/** The box of a feature's exterior rings, which hold every vertex of its holes too. */
function featureBox(geometry: TerritoryFeatureCollection['features'][number]['geometry']): Box {
  const box = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity }
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates as Ring[]] : (geometry.coordinates as Ring[][])
  for (const polygon of polygons) {
    for (const [x = 0, y = 0] of polygon[0] ?? []) {
      box.west = Math.min(box.west, x)
      box.east = Math.max(box.east, x)
      box.south = Math.min(box.south, y)
      box.north = Math.max(box.north, y)
    }
  }
  return box
}

function boxesMeet(a: Box, b: Box): boolean {
  return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south
}

/**
 * The box a region's map opens on: its largest part and every part near
 * it, rather than the region's whole box.
 *
 * A region gathers every part within its clustering distance, so its box
 * runs to the farthest one: on the real store one region's box is 2.2
 * times as wide and 1.6 times as tall as its largest part, and another's
 * over seven times both, for a speck about seven of that part's lengths
 * away. Fitted whole, the ground that is
 * most of the region is drawn at a half or a tenth of the size the map has
 * room for, a blob in which no street can be told claimed or not. The core
 * starts as the largest part's box and takes in any part within
 * `CORE_REACH` of it that holds at least `CORE_JOIN_SHARE` of the ground
 * already taken in, growing as it does. A core holding less than
 * `CORE_MIN_SHARE` of the region's ground - two parts of a size, far apart
 * - is no view of the region, and the region's own box is returned. The
 * map's fit button shows the whole region either way.
 */
export function claimCore(territory: TerritoryFeatureCollection, region: Box & { region_id: string }): Box {
  const parts = territory.features
    .filter((f) => f.properties.region_id === region.region_id)
    .map((f) => ({ box: featureBox(f.geometry), area: f.properties.area_m2 }))
    .filter((p) => Number.isFinite(p.box.west))
    .sort((a, b) => b.area - a.area)
  const whole: Box = { west: region.west, south: region.south, east: region.east, north: region.north }
  const first = parts[0]
  if (first === undefined) return whole
  const core = { ...first.box }
  let held = first.area
  const left = parts.slice(1)
  for (let grew = true; grew; ) {
    grew = false
    const kx = Math.cos((((core.south + core.north) / 2) * Math.PI) / 180)
    const reach = CORE_REACH * Math.max((core.east - core.west) * kx, core.north - core.south)
    const near = { west: core.west - reach / kx, east: core.east + reach / kx, south: core.south - reach, north: core.north + reach }
    for (let i = left.length - 1; i >= 0; i--) {
      const part = left[i]
      if (part === undefined || part.area < CORE_JOIN_SHARE * held || !boxesMeet(part.box, near)) continue
      core.west = Math.min(core.west, part.box.west)
      core.east = Math.max(core.east, part.box.east)
      core.south = Math.min(core.south, part.box.south)
      core.north = Math.max(core.north, part.box.north)
      held += part.area
      left.splice(i, 1)
      grew = true
    }
  }
  const total = held + left.reduce((sum, p) => sum + p.area, 0)
  return held < CORE_MIN_SHARE * total ? whole : core
}
