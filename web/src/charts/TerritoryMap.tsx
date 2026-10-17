import {
  MapLibreMap,
  Marker,
  NavigationControl,
  type DataDrivenPropertyValueSpecification,
  type LngLatBoundsLike,
  type PaddingOptions,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { components } from '../api/schema'
import { Absent } from '../components/Absent'
import { area as areaLabel } from '../format'
import { buildAreasStyle, type MapFlavour } from './basemapStyle'
import { cssVar } from './cssVar'
import { ensureMapGlobals } from './maplibreGlobals'
import { readTerritoryFlavour, writeTerritoryFlavour } from './territoryFlavour'
import { mapScaleBar } from './routeMath'
import { ScaleBar } from './ScaleBar'
import {
  boxCentre,
  claimCore,
  territoryAnchors,
  unclaimedGround,
  withCoarseUnderlay,
  placeMarks,
  type PlaceOnScreen,
  type TerritoryAnchors,
} from './territoryLayers'
import { areasMeetingBox, type Box } from './territoryMath'
import styles from './TerritoryMap.module.css'

type BasemapArea = components['schemas']['BasemapArea']
type TerritoryFeatureCollection = components['schemas']['TerritoryFeatureCollection']
type TerritoryRegion = components['schemas']['TerritoryRegion']

export interface TerritoryMapProps {
  /** Every part of the claimed ground, `GET /api/territory`'s `territory`, drawn whole. */
  territory: TerritoryFeatureCollection
  /**
   * The region the map opens on, fitted to its core (`claimCore`): its
   * largest part and the parts near it. The fit button shows all of it, and
   * the other regions' ground is still drawn, a pan away.
   */
  region: TerritoryRegion
  /**
   * Every region, for the place markers a zoomed-out map shows. Empty, or
   * left out, shows none.
   */
  regions?: readonly TerritoryRegion[]
  /** Called with a region's id when the reader picks its marker; the view owns which region is chosen. */
  onSelectRegion?: (regionId: string) => void
  /** Every fetched basemap area, `GET /api/basemap`'s; empty draws the ground on a plain background. */
  areas: readonly BasemapArea[]
  attribution: string
}

/** The territory's own sources and layers, by id, added on every style's `style.load`. */
const SOURCE_ID = 'territory'
const VEIL_SOURCE_ID = 'territory-unclaimed'
const KNOCKOUT_ID = 'territory-knockout'
const FILL_ID = 'territory-fill'
const VEIL_ID = 'territory-veil'
const CASING_ID = 'territory-casing'
const EDGE_ID = 'territory-edge'

/**
 * How the claimed and the unclaimed ground differ, which is the whole
 * map's job: layers on each side of the edge rather than one strong tint.
 *
 * The claimed ground is a light `--accent` tint over a `--raised`
 * knockout, both drawn over the land and its land cover and under the
 * buildings, the roads and the names (`territoryAnchors`), so the streets
 * of the ground stay white and sharp. The knockout makes the tint one
 * colour: without it `--accent` mixed with what lay under it and the
 * ground came out in three, pink over city blocks, grey-brown over the
 * light flavour's forest green and slate over lakes, the last two in no
 * token and the forest most of one small town's ground.
 *
 * In Grey the knockout and the tint both lie over the water, so a lake
 * in the ground is the ground's one tone: with the knockout under the
 * water it was a deeper patch of pink, which a critic took for ground
 * claimed twice, and before that a dark grey hole. In Light both are
 * under the water, so a lake keeps Light's cyan, which already says
 * water, rather than the slate the tint made of it.
 *
 * The unclaimed ground is washed toward `--raised` (`VEIL_OPACITY`), under
 * the labels so every name still reads: the map outside reads as context
 * and the ground inside as the subject, and the line between them does not
 * rest on the edge alone.
 *
 * The tint holds its strength at every zoom: what has to stay legible
 * through it, the water, buildings, roads and names, is drawn above it,
 * and a tint that faded with zoom left a street-scale part, the ground of
 * a town visited once, an outline with nothing in it. At 0.34 a city's ground read
 * pale enough next to the veiled grey that a critic took its edge for the
 * only line between claimed and unclaimed; 0.44 still leaves the streets
 * inside white and sharp.
 */
const FILL_OPACITY = 0.44
/**
 * The knockout's strength: short of solid, so a ghost of the woods and
 * fields under the ground survives, and far enough that the tint over it
 * is one colour.
 */
const KNOCKOUT_OPACITY = 0.88
/**
 * The veil's strength by flavour, lighter as the zoom brings streets worth
 * reading. Grey takes the stronger wash: its land and water are mid
 * greys, darker than any of the app's surfaces, and washed half way to
 * `--raised` the map outside the ground reads as the app's own light
 * ground with its streets and names on it, and the pink inside is the one
 * colour on the screen. Light keeps the weaker one, since its land is
 * already pale.
 */
const VEIL_OPACITY: Record<MapFlavour, DataDrivenPropertyValueSpecification<number>> = {
  grayscale: ['interpolate', ['linear'], ['zoom'], 9, 0.5, 16, 0.4],
  light: ['interpolate', ['linear'], ['zoom'], 9, 0.34, 16, 0.26],
}

/**
 * The edge, in CSS px by zoom, and the `--raised` casing under it that
 * lifts it off the roads it runs along. Thin at a city's zoom, where a
 * region's many parts would otherwise run together; full weight at a
 * street's.
 */
const EDGE_WIDTH: DataDrivenPropertyValueSpecification<number> = ['interpolate', ['linear'], ['zoom'], 9, 1.75, 13, 2.25, 16, 3]
const CASING_WIDTH: DataDrivenPropertyValueSpecification<number> = ['interpolate', ['linear'], ['zoom'], 9, 4, 13, 5.5, 16, 7]

/** Past this the basemap's zoom 15 tiles are overzoomed into blur; the ground itself stays sharp. */
const MAX_ZOOM = 17

/** The share of the panel's shorter side left clear around a fitted region. */
const FIT_PAD_SHARE = 0.07

/**
 * A place's marker shows once its claimed ground is smaller on screen than
 * this, in CSS px, on its longer side: too small to find as a shape, but
 * still a place the reader has been. The fitted region's own ground is
 * never this small, so a marker means the reader zoomed out.
 */
const PLACE_MARKER_MAX_PX = 36

/**
 * The width of the zoom buttons' column and its inset, in CSS px, kept
 * clear on the right of a fitted region: on a phone the region's ground
 * otherwise runs under the buttons, as the largest region's south-east part did.
 */
const CONTROL_COLUMN_PX = 44

/**
 * A panel at least this much taller than it is wide is a phone's hero:
 * its controls are cleared above and below the fitted ground rather than
 * beside it.
 */
const PORTRAIT_RATIO = 1.25

/** The share of a tall panel's width left clear on each side of a fit: the edge's casing is enough margin. */
const PORTRAIT_PAD_SHARE = 0.035

/**
 * The bands a tall panel keeps its fitted ground out of, in CSS px: the
 * Light/Grey switch's under the view's overlay at the top, and at the
 * bottom the zoom and fit buttons' column, three 29 px buttons over the
 * attribution row, about 140 px from the panel's foot, measured at 430 px
 * wide. At 96 px a beach region, the one taller than a phone's panel,
 * ran under the buttons.
 */
const SWITCH_BAND_PX = 44
const CONTROL_STACK_PX = 148

/**
 * The padding a fit leaves, in CSS px. `--map-overlay-top`, in px, is the
 * band across the panel's top that the view lays its own controls over -
 * the place pills on a phone - and the fitted ground is kept below it.
 */
function fitPadding(container: HTMLElement): PaddingOptions {
  const width = container.clientWidth
  const height = container.clientHeight
  const parsed = Number.parseFloat(cssVar('--map-overlay-top', container))
  const overlay = Number.isFinite(parsed) ? parsed : 0
  if (height >= width * PORTRAIT_RATIO) {
    // A phone's tall panel: a region is wider than the panel's shape, so
    // the fit is set by the width, and the controls are cleared above and
    // below instead of beside, where they cost no zoom.
    const pad = Math.round(width * PORTRAIT_PAD_SHARE)
    return {
      top: pad + overlay + SWITCH_BAND_PX,
      bottom: pad + CONTROL_STACK_PX,
      left: pad,
      right: pad,
    }
  }
  const pad = Math.round(Math.min(width, height) * FIT_PAD_SHARE)
  return {
    top: pad + overlay,
    bottom: pad,
    left: pad,
    right: pad + CONTROL_COLUMN_PX,
  }
}

function boundsOf(box: Box): LngLatBoundsLike {
  return [
    [box.west, box.south],
    [box.east, box.north],
  ]
}

const FLAVOURS: { value: MapFlavour; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'grayscale', label: 'Grey' },
]

type Status = 'loading' | 'ready' | 'failed'

/** The SVG for the fit button: four corners of a frame round a filled shape, drawn in `currentColor`. */
const FIT_ICON =
  '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">' +
  '<path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" fill="none" stroke="currentColor" stroke-width="1.75" ' +
  'stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M7 8.5 10 6.5l3 2.5-.8 4.5H8.2Z" fill="currentColor" fill-opacity=".28" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linejoin="round"/></svg>'

/**
 * MapLibre's zoom buttons with a third under them, in the same group:
 * back to the whole of the chosen region after the reader has panned or
 * zoomed away from it. One group rather than two, so the controls take
 * one column's height in the corner the ground most often reaches. The
 * button's name is set by the component as the region changes.
 */
class ZoomAndFitControl extends NavigationControl {
  readonly fitButton: HTMLButtonElement
  constructor(onFit: () => void) {
    super({ showCompass: false })
    this.fitButton = document.createElement('button')
    this.fitButton.type = 'button'
    this.fitButton.className = styles.fitButton ?? ''
    this.fitButton.innerHTML = FIT_ICON
    this.fitButton.addEventListener('click', onFit)
  }
  override onAdd(map: MapLibreMap): HTMLElement {
    const container = super.onAdd(map)
    container.append(this.fitButton)
    return container
  }
}

/**
 * The claimed ground over the basemap: the default export of a lazily
 * loaded chunk, for the reason `RouteMap` is one - MapLibre is twice the
 * rest of the application.
 *
 * Unlike `RouteMap` the reader can move this map: a region is years of
 * runs, and the ground in it is worth reading street by street. Gestures
 * are cooperative - two fingers on a phone, a modifier with the wheel on a
 * desktop - so a page that scrolls past the map is never caught by it. A
 * button over the zoom buttons fits the chosen region again, and zoomed
 * out far enough that a place's ground is too small to see, the place
 * becomes a marker naming it and its ground, which chooses it.
 *
 * One map for the component's life. A different region refits it, and
 * swaps the style only when the region needs a different set of basemap
 * areas; a flavour switch swaps the style too. Every style arrives without
 * the territory, so `style.load` adds it each time, as `RouteMap` adds its
 * route.
 */
export default function TerritoryMap({
  territory,
  region,
  regions = [],
  onSelectRegion,
  areas,
  attribution,
}: TerritoryMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const fitControlRef = useRef<ZoomAndFitControl | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [flavour, setFlavour] = useState<MapFlavour>(readTerritoryFlavour)
  const [scale, setScale] = useState({ metres: 0, fraction: 0 })

  const regionAreas = useMemo(() => areasMeetingBox(areas, region), [areas, region])
  const areaIds = useMemo(() => regionAreas.map((a) => a.id), [regionAreas])
  const areaKey = areaIds.join(',')
  const unclaimed = useMemo(() => unclaimedGround(territory), [territory])
  const core = useMemo(() => claimCore(territory, region), [territory, region])

  // Read by handlers registered once, in the build effect below.
  const territoryRef = useRef(territory)
  const unclaimedRef = useRef(unclaimed)
  const regionRef = useRef(region)
  const coreRef = useRef(core)
  const regionsRef = useRef(regions)
  const onSelectRef = useRef(onSelectRegion)
  const styleKeyRef = useRef('')
  const styleFlavourRef = useRef<MapFlavour>('light')
  const anchorsRef = useRef<TerritoryAnchors>({
    groundBefore: undefined,
    tintBefore: undefined,
    overlayBefore: undefined,
  })
  const syncMarkersRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    territoryRef.current = territory
    unclaimedRef.current = unclaimed
    regionRef.current = region
    coreRef.current = core
    regionsRef.current = regions
    onSelectRef.current = onSelectRegion
  })

  /** The style for a set of areas in a flavour, remembering where in it the territory goes. */
  const styleFor = (meeting: readonly BasemapArea[], next: MapFlavour, container: HTMLElement) => {
    const origin = window.location.origin
    const panel = cssVar('--panel', container)
    const ids = meeting.map((a) => a.id)
    const style = withCoarseUnderlay(buildAreasStyle(ids, next, origin, attribution, panel), meeting, next, origin)
    anchorsRef.current = territoryAnchors(style.layers.map((layer) => layer.id))
    styleFlavourRef.current = next
    return style
  }

  // The map itself, once.
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return undefined
    let map: MapLibreMap | null = null
    let observer: ResizeObserver | null = null
    let loaded = false
    let disposed = false
    const markers = new Map<string, { marker: Marker; element: HTMLButtonElement; shown: boolean }>()
    const dispose = () => {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      for (const { marker } of markers.values()) marker.remove()
      markers.clear()
      map?.remove()
      if (mapRef.current === map) mapRef.current = null
    }
    const updateScale = () => {
      if (map === null || disposed) return
      setScale(mapScaleBar(container.clientWidth, map.getCenter().lat, map.getZoom()))
    }
    const fitTo = (box: Box) => {
      if (map === null || disposed) return
      map.fitBounds(boundsOf(box), { padding: fitPadding(container) })
    }

    // A marker per region, made once and shown only while that region's
    // ground is too small to see. Markers are DOM rather than map layers so
    // they are buttons - focusable, named, and in the project's own type.
    const syncMarkers = () => {
      const m = map
      if (m === null || disposed || !loaded) return
      const places: PlaceOnScreen[] = regionsRef.current.map((r) => {
        const sw = m.project([r.west, r.south])
        const ne = m.project([r.east, r.north])
        const centre = m.project(boxCentre(r))
        return {
          id: r.region_id,
          x: centre.x,
          y: centre.y,
          size: Math.max(Math.abs(ne.x - sw.x), Math.abs(ne.y - sw.y)),
          label: `${r.name} ${areaLabel(r.area_m2)}`,
        }
      })
      const marks = placeMarks(places, PLACE_MARKER_MAX_PX)
      for (const r of regionsRef.current) {
        if (markers.has(r.region_id)) continue
        const element = document.createElement('button')
        element.type = 'button'
        element.className = styles.place ?? ''
        const name = document.createElement('span')
        name.className = styles.placeName ?? ''
        name.textContent = r.name
        const figure = document.createElement('span')
        figure.className = styles.placeArea ?? ''
        figure.textContent = areaLabel(r.area_m2)
        element.append(name, figure)
        element.setAttribute('aria-label', `${r.name}, ${areaLabel(r.area_m2)} claimed`)
        element.title = `${r.name}, ${areaLabel(r.area_m2)}`
        const id = r.region_id
        element.addEventListener('click', (event) => {
          event.stopPropagation()
          if (id === regionRef.current.region_id) fitTo(coreRef.current)
          else onSelectRef.current?.(id)
        })
        markers.set(id, { marker: new Marker({ element }).setLngLat(boxCentre(r)), element, shown: false })
      }
      for (const [id, entry] of markers) {
        const mark = marks.get(id)
        entry.element.classList.toggle(styles.placeDot ?? '', mark === 'dot')
        entry.element.classList.toggle(styles.placeChosen ?? '', id === regionRef.current.region_id)
        const show = mark !== undefined
        if (show === entry.shown) continue
        entry.shown = show
        if (show) entry.marker.addTo(m)
        else entry.marker.remove()
      }
    }
    syncMarkersRef.current = syncMarkers

    try {
      ensureMapGlobals()
      const flavourAtBuild = readTerritoryFlavour()
      const meeting = areasMeetingBox(areas, regionRef.current)
      styleKeyRef.current = `${meeting.map((a) => a.id).join(',')}|${flavourAtBuild}`
      const m = new MapLibreMap({
        container,
        style: styleFor(meeting, flavourAtBuild, container),
        bounds: boundsOf(coreRef.current),
        fitBoundsOptions: { padding: fitPadding(container) },
        maxZoom: MAX_ZOOM,
        cooperativeGestures: true,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        attributionControl: { compact: true },
      })
      map = m
      m.touchZoomRotate.disableRotation()
      const controls = new ZoomAndFitControl(() => fitTo(regionRef.current))
      fitControlRef.current = controls
      controls.fitButton.setAttribute('aria-label', `Show all of ${regionRef.current.name}`)
      controls.fitButton.title = `Show all of ${regionRef.current.name}`
      m.addControl(controls, 'bottom-right')
      m.on('style.load', () => {
        const accent = cssVar('--accent', container)
        const raised = cssVar('--raised', container)
        const { groundBefore, tintBefore, overlayBefore } = anchorsRef.current
        m.addSource(SOURCE_ID, { type: 'geojson', data: territoryRef.current })
        m.addSource(VEIL_SOURCE_ID, { type: 'geojson', data: unclaimedRef.current })
        m.addLayer(
          {
            id: KNOCKOUT_ID,
            type: 'fill',
            source: SOURCE_ID,
            paint: { 'fill-color': raised, 'fill-opacity': KNOCKOUT_OPACITY },
          },
          // In Grey over the water as well, so a lake in the ground is the
          // ground's one tone; in Light under it, so the lake keeps its cyan.
          styleFlavourRef.current === 'light' ? groundBefore : tintBefore,
        )
        m.addLayer(
          { id: FILL_ID, type: 'fill', source: SOURCE_ID, paint: { 'fill-color': accent, 'fill-opacity': FILL_OPACITY } },
          // Light's cyan already says water, and the tint over it came out
          // slate; Grey's water is a grey that inside the pink read as a hole.
          styleFlavourRef.current === 'light' ? groundBefore : tintBefore,
        )
        m.addLayer(
          {
            id: VEIL_ID,
            type: 'fill',
            source: VEIL_SOURCE_ID,
            paint: { 'fill-color': raised, 'fill-opacity': VEIL_OPACITY[styleFlavourRef.current] },
          },
          overlayBefore,
        )
        m.addLayer(
          {
            id: CASING_ID,
            type: 'line',
            source: SOURCE_ID,
            layout: { 'line-join': 'round' },
            paint: { 'line-color': raised, 'line-width': CASING_WIDTH, 'line-opacity': 0.9 },
          },
          overlayBefore,
        )
        m.addLayer(
          {
            id: EDGE_ID,
            type: 'line',
            source: SOURCE_ID,
            layout: { 'line-join': 'round' },
            paint: { 'line-color': accent, 'line-width': EDGE_WIDTH },
          },
          overlayBefore,
        )
      })
      m.on('load', () => {
        if (disposed) return
        loaded = true
        updateScale()
        syncMarkers()
        setStatus('ready')
      })
      m.on('moveend', updateScale)
      m.on('move', syncMarkers)
      m.on('error', (event) => {
        // A tile that fails leaves a hole; anything else before the first
        // load means there is no map to show. See `RouteMap`'s `isTileError`.
        const isTile = 'tile' in event && event.tile !== undefined && event.tile !== null
        if (loaded || disposed || isTile) return
        queueMicrotask(dispose)
        setStatus('failed')
      })
      observer = new ResizeObserver(() => {
        if (disposed || map === null) return
        map.resize()
        updateScale()
        syncMarkers()
      })
      observer.observe(container)
      mapRef.current = m
    } catch {
      // No WebGL, most likely: the constructor throws.
      dispose()
      setStatus('failed')
    }
    return dispose
    // Built once; the effects below carry every later change to it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A region needing other areas, or a flavour switch, is a new style.
  useEffect(() => {
    const map = mapRef.current
    const container = containerRef.current
    if (map === null || container === null) return
    const key = `${areaKey}|${flavour}`
    if (key === styleKeyRef.current) return
    styleKeyRef.current = key
    map.setStyle(styleFor(regionAreas, flavour, container), { diff: false })
    // `styleFor` reads only `attribution` beyond its arguments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areaKey, flavour, attribution])

  // A different region refits the map to its core and renames the fit button.
  useEffect(() => {
    const map = mapRef.current
    const container = containerRef.current
    const button = fitControlRef.current?.fitButton
    if (button !== undefined) {
      button.setAttribute('aria-label', `Show all of ${region.name}`)
      button.title = `Show all of ${region.name}`
    }
    if (map === null || container === null) return
    map.fitBounds(boundsOf(core), {
      padding: fitPadding(container),
      animate: false,
    })
  }, [region, core])

  // New ground - a refetch after a restart - replaces both sources' data.
  useEffect(() => {
    const map = mapRef.current
    for (const [id, data] of [
      [SOURCE_ID, territory],
      [VEIL_SOURCE_ID, unclaimed],
    ] as const) {
      const source = map?.getSource(id)
      if (source !== undefined && 'setData' in source && typeof source.setData === 'function') source.setData(data)
    }
  }, [territory, unclaimed])

  // A changed list of regions is new markers on the next move.
  useEffect(() => {
    syncMarkersRef.current()
  }, [regions])

  const choose = (next: MapFlavour) => {
    setFlavour(next)
    writeTerritoryFlavour(next)
  }

  if (status === 'failed') {
    return (
      <div className={styles.wrap}>
        <Absent label="No map" reason="The map could not be drawn in this browser, which may have WebGL switched off." />
      </div>
    )
  }

  return (
    <div className={styles.wrap}>
      <div ref={containerRef} className={styles.canvas} />
      {status === 'loading' && <p className={styles.pending}>Loading the map…</p>}
      {status === 'ready' && (
        <>
          <div className={styles.label} role="img" aria-label={`Map of the ground claimed in ${region.name}`} />
          <div className={styles.switch} role="radiogroup" aria-label="Map style">
            {FLAVOURS.map((f) => (
              <label key={f.value} className={styles.segment}>
                <input
                  type="radio"
                  name="territory-map-flavour"
                  value={f.value}
                  checked={flavour === f.value}
                  onChange={() => choose(f.value)}
                />
                <span>{f.label}</span>
              </label>
            ))}
          </div>
          {scale.metres > 0 && <ScaleBar metres={scale.metres} fraction={scale.fraction} />}
        </>
      )}
    </div>
  )
}
