import { MapLibreMap, Marker, type LngLatBoundsLike, type PaddingOptions } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { components } from '../api/schema'
import { buildStyle, type MapFlavour } from './basemapStyle'
import { cssVar } from './cssVar'
import { ensureMapGlobals } from './maplibreGlobals'
import { readMapFlavour, writeMapFlavour } from './mapStylePreference'
import { pieceColour, type RoutePace } from './paceColour'
import { IDENTITY, ReplayCanvas, type ReplayPath } from './replayCanvas'
import { Route } from './Route'
import { mapScaleBar, PAD_FRACTION, routeBounds, routePanelRatio, toRuns } from './routeMath'
import { ScaleBar } from './ScaleBar'
import styles from './RouteMap.module.css'

type BasemapArea = components['schemas']['BasemapArea']

export interface RouteMapProps {
  lat: (number | null)[]
  lon: (number | null)[]
  area: BasemapArea
  attribution: string
  /** The route coloured by pace, in place of the single accent line - see paceColour.ts. */
  pace?: RoutePace
  /**
   * The moment to mark with a dot - a grid index into `lat`/`lon`, or
   * `null`/`undefined` for none. See `moment/momentStore.ts`'s
   * `currentMoment` and docs/reference/frontend.md's "The moment".
   */
  moment?: number | null
  /**
   * How far a replay has drawn the line - a grid index, see
   * `moment/useReplay.ts`. `null` or absent draws the full line; a number
   * draws the pieces with `end <= replayHead` over the faint outline. Only
   * a coloured route replays: without `pace` it is ignored.
   */
  replayHead?: number | null
}

/**
 * The pace pieces as a GeoJSON `FeatureCollection`, one `LineString` feature
 * per piece with a `colour` property the paint expression below reads.
 */
function paceFeatureCollection(pace: RoutePace) {
  return {
    type: 'FeatureCollection' as const,
    features: pace.pieces.map((p) => ({
      type: 'Feature' as const,
      properties: { colour: pieceColour(pace, p) },
      geometry: { type: 'LineString' as const, coordinates: p.coords },
    })),
  }
}

/** The width of the drawn route line, in CSS pixels: the map's `route-line` and the replay's canvas alike. */
const LINE_WIDTH_PX = 4.5

/**
 * The replay's parts of one map: the canvas the growing line is drawn on,
 * and whether the style currently loaded holds the route's layers and has
 * its coloured line hidden for a replay. See `ReplayCanvas` for why the
 * line grows on a canvas rather than on the map.
 */
interface MapReplay {
  map: MapLibreMap
  canvas: ReplayCanvas
  /** A style holding `route-line` and `route-outline` has loaded. False from a flavour switch to its `style.load`. */
  styleReady: boolean
  lineHidden: boolean
}

/**
 * Swaps the map's coloured line for the faint outline while a replay runs,
 * and back when it ends: one layout change each way, so the map repaints at
 * the start and the end of a replay and never in between.
 */
function syncRouteLine(replay: MapReplay, head: number | null) {
  const hide = head !== null
  if (!replay.styleReady || replay.lineHidden === hide) return
  replay.map.setLayoutProperty('route-line', 'visibility', hide ? 'none' : 'visible')
  replay.map.setLayoutProperty('route-outline', 'visibility', hide ? 'visible' : 'none')
  replay.lineHidden = hide
}

type Status = 'loading' | 'ready' | 'failed'

/** What the panel is showing, and for which inputs. */
interface Shown {
  lat: (number | null)[]
  lon: (number | null)[]
  areaId: string
  attribution: string
  pace: RoutePace | undefined
  status: Status
}

/**
 * The padding that puts the route where the bare trace puts it.
 *
 * `Route` pads the trace by `PAD_FRACTION` of its own extent on each side,
 * so the padded box holds `1 + 2 * PAD_FRACTION` traces and each side's
 * margin is `PAD_FRACTION / (1 + 2 * PAD_FRACTION)` of the panel on the
 * axis that binds. Padding each axis by its own share of the panel is the
 * same fit: `fitBounds` then letterboxes the other axis, as `meet` does.
 */
function fitPadding(width: number, height: number): PaddingOptions {
  const share = PAD_FRACTION / (1 + 2 * PAD_FRACTION)
  const x = width * share
  const y = height * share
  return { top: y, bottom: y, left: x, right: x }
}

/**
 * Whether a map `error` event is one tile failing to load.
 *
 * Keyed on the event's `tile`, which only `TileManager`'s tile-load failure
 * sets, as `new ErrorEvent(err, {tile})`; a tile that answers 404 fires
 * nothing, and MapLibre tries its parent instead. A failed glyph range
 * fires no event either: `GlyphManager` draws the glyph locally and warns.
 * A source-level failure - the archive's TileJSON, which is where the
 * `pmtiles` protocol reads the archive's header - carries `sourceId` but no
 * `tile`; a style, sprite or validation error carries neither.
 */
function isTileError(event: object): boolean {
  return 'tile' in event && event.tile !== undefined && event.tile !== null
}

const FLAVOURS: { value: MapFlavour; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'grayscale', label: 'Grey' },
]

/**
 * The route over a basemap: the default export of a lazily loaded chunk,
 * so MapLibre is downloaded only when a covered route is first shown.
 *
 * The bare `Route` stays underneath and sizes the panel. It is what shows
 * while the map loads and stays if the map fails, so the hero never goes
 * blank; once the map has loaded it is hidden with `visibility`, which
 * keeps its box and takes it, and its "Route map" label, out of the
 * accessibility tree. An empty overlay takes the label at the same moment,
 * so exactly one "Route map" is exposed at a time. The label is on an
 * overlay rather than on the map's own element because an image's children
 * are presentational: MapLibre's attribution control, with its button and
 * its OpenStreetMap link, would vanish from the accessibility tree inside
 * one. The flavour switch and the scale bar belong to the map, so they
 * appear with it and are never drawn over the bare trace.
 *
 * The map is fixed: no pan, no zoom. It frames the route exactly as the
 * bare trace does, and refits whenever the panel changes size.
 *
 * Three behaviours of the real `MapLibreMap` this is written against, which
 * the test's mock cannot show:
 * - A `setStyle` diffs by default. A diffed swap fires no `style.load` and
 *   drops the route's source and layers, which the new style does not
 *   name, so the flavour switch passes `{ diff: false }` for a full rebuild
 *   whose `style.load` redraws the route.
 * - A browser with no WebGL makes the constructor itself throw, which is
 *   the `catch` below.
 * - A failed tile is reported as an `error` event carrying that `tile`:
 *   `TileManager` fires `new ErrorEvent(err, {tile})`, and the event gains
 *   `sourceId` as it bubbles up to the map. See `isTileError`.
 */
export default function RouteMap({ lat, lon, area, attribution, pace, moment, replayHead }: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  // The moment's own marker, built lazily - see the effect below - and torn
  // down with the map that owns it, never rebuilt for a plain pointer move.
  const markerRef = useRef<Marker | null>(null)
  const [flavour, setFlavour] = useState<MapFlavour>(readMapFlavour)
  // The flavour a map built by the effect opens in. A ref beside the state
  // so the effect can read it without rebuilding the map on every switch.
  const flavourRef = useRef(flavour)
  const paceFeatures = useMemo(() => (pace === undefined ? null : paceFeatureCollection(pace)), [pace])
  // `routePanelRatio` walks every sample to find the route's own bounding
  // box (`routeMath.ts`'s `projectedBox`), which is otherwise recomputed on
  // every pointer move - the per-sample walk `Route`'s own `useTrace` memo
  // documents the cost of, here for the panel's aspect ratio alone.
  const panelRatio = useMemo(() => routePanelRatio(lat, lon), [lat, lon])
  // A flavour switch fires a fresh `style.load` on the same map, through
  // the handler the build effect below registered once - so it reads the
  // current pieces through this ref rather than the effect's own closure.
  const paceFeaturesRef = useRef(paceFeatures)
  // The replay head, read by the same `style.load` handler for the same
  // reason - a new style has to hide its line again mid-replay - and by the
  // build effect's refit, which redraws the canvas up to it.
  const replayHeadRef = useRef(replayHead ?? null)
  useEffect(() => {
    paceFeaturesRef.current = paceFeatures
    replayHeadRef.current = replayHead ?? null
  })
  // The current map's replay parts, for the head's own effect below.
  const replayRef = useRef<MapReplay | null>(null)
  const [shown, setShown] = useState<Shown>(() => ({
    lat,
    lon,
    areaId: area.id,
    attribution,
    pace,
    status: 'loading',
  }))
  const [scale, setScale] = useState({ metres: 0, fraction: 0 })

  // A different route, area or pace is a different map, which starts out
  // loading again: adjusted during render, React's pattern for state that
  // follows a prop, so a map that failed for one route does not stay
  // failed for the next and a loaded one does not hide the next route's
  // bare trace early. `pace` is in the comparison too, not only in the
  // build effect's own dependencies below: the effect tearing down and
  // rebuilding the map is exactly what a real pace change causes, and
  // without this the underlay would stay hidden - `status` still 'ready'
  // from the old map - while the new one loads, leaving a blank panel.
  let status = shown.status
  if (
    shown.lat !== lat ||
    shown.lon !== lon ||
    shown.areaId !== area.id ||
    shown.attribution !== attribution ||
    shown.pace !== pace
  ) {
    status = 'loading'
    setShown({ lat, lon, areaId: area.id, attribution, pace, status })
  }
  const ready = status === 'ready'

  useEffect(() => {
    const container = containerRef.current
    const bounds = routeBounds(lat, lon)
    if (container === null || bounds === null) return undefined
    const lngLatBounds: LngLatBoundsLike = [
      [bounds.west, bounds.south],
      [bounds.east, bounds.north],
    ]
    const route = {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'MultiLineString' as const,
        coordinates: toRuns(lat, lon).map((run) => run.map((p) => [p.lon, p.lat])),
      },
    }
    const setStatus = (next: Status) => setShown((s) => ({ ...s, status: next }))

    // Per map, not per component: under StrictMode, or when the route
    // changes, an earlier map's late event must not touch the current one.
    let map: MapLibreMap | null = null
    let replay: MapReplay | null = null
    let replayElement: HTMLCanvasElement | null = null
    let observer: ResizeObserver | null = null
    let loaded = false
    let failed = false
    let disposed = false
    const dispose = () => {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      // The marker is this map's own overlay, not React's - it has to go
      // with the map that owns it, whether that is a real unmount or this
      // effect rebuilding for a new route, area or pace.
      markerRef.current?.remove()
      markerRef.current = null
      replayElement?.remove()
      if (replayRef.current === replay) replayRef.current = null
      map?.remove()
      if (mapRef.current === map) mapRef.current = null
    }

    const fit = () => {
      if (disposed || map === null) return
      // The layout size, not the bounding box: the activity view's phone
      // hero scales the picture as it collapses (`RouteHero.module.css`'s
      // `.picture`), and a map that loads or resizes while scaled would
      // otherwise be fitted, and its scale bar and replay canvas sized, to
      // the transformed box. MapLibre sizes its own canvas from these too.
      const width = container.clientWidth
      const height = container.clientHeight
      // Nothing to fit into before layout, and MapLibre warns rather than
      // fits; the observer calls again once the panel has a size.
      if (!(width > 0) || !(height > 0)) return
      // MapLibre watches the container too, and its observer may not have
      // run yet: without this the fit would use the canvas's old size.
      map.resize()
      map.fitBounds(lngLatBounds, { padding: fitPadding(width, height), animate: false })
      setScale(mapScaleBar(width, map.getCenter().lat, map.getZoom()))
      // The map is fixed, so a refit is the only thing that moves the route
      // on screen: the replay's pixel paths are projected here, once per
      // fit, and the canvas redrawn up to the head at the new size. Only
      // once loaded - before that the bare trace underneath is the picture
      // and draws the replay itself.
      if (loaded && replay !== null && pace !== undefined) {
        const m = map
        const paths: ReplayPath[] = pace.pieces.map((piece) => {
          const points: number[] = []
          for (const coord of piece.coords) {
            const p = m.project(coord)
            points.push(p.x, p.y)
          }
          return { end: piece.end, colour: pieceColour(pace, piece), points }
        })
        replay.canvas.layout(paths, width, height, window.devicePixelRatio || 1, IDENTITY, LINE_WIDTH_PX)
      }
    }

    try {
      ensureMapGlobals()
      const width = container.clientWidth
      const height = container.clientHeight
      const m = new MapLibreMap({
        container,
        style: buildStyle(area.id, flavourRef.current, window.location.origin, attribution),
        bounds: lngLatBounds,
        fitBoundsOptions: { padding: fitPadding(width, height) },
        interactive: false,
        attributionControl: { compact: true },
      })
      map = m
      if (pace !== undefined) {
        // Inside MapLibre's canvas container, straight after the map's own
        // canvas: over the map, and under the moment's marker, which
        // MapLibre appends to the same container later, and under the
        // controls, which live in a container after this one.
        replayElement = document.createElement('canvas')
        replayElement.className = styles.replayCanvas ?? ''
        m.getCanvasContainer().insertBefore(replayElement, m.getCanvas().nextSibling)
        replay = { map: m, canvas: new ReplayCanvas(replayElement), styleReady: false, lineHidden: false }
        replay.canvas.setHead(replayHeadRef.current)
        replayRef.current = replay
      }
      // Every style, the first and each flavour switched to, arrives
      // without the route, so it is drawn on each one's `style.load`.
      m.on('style.load', () => {
        m.addSource('route', { type: 'geojson', data: route })
        m.addLayer({
          id: 'route-casing',
          type: 'line',
          source: 'route',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': cssVar('--raised', container), 'line-width': 8, 'line-opacity': 0.9 },
        })
        const features = paceFeaturesRef.current
        if (features === null) {
          m.addLayer({
            id: 'route-line',
            type: 'line',
            source: 'route',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': cssVar('--accent', container), 'line-width': LINE_WIDTH_PX },
          })
          return
        }
        // The plain route stays underneath, faint, for the replay to show
        // while the coloured line hides - see `syncRouteLine`.
        m.addLayer({
          id: 'route-outline',
          type: 'line',
          source: 'route',
          layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' },
          paint: { 'line-color': cssVar('--pace-map-outline', container), 'line-width': LINE_WIDTH_PX },
        })
        m.addSource('route-pace', { type: 'geojson', data: features })
        m.addLayer({
          id: 'route-line',
          type: 'line',
          source: 'route-pace',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': ['get', 'colour'], 'line-width': LINE_WIDTH_PX },
        })
        // A new style arrives with its line shown, so one switched to
        // mid-replay hides it again.
        if (replay !== null) {
          replay.styleReady = true
          replay.lineHidden = false
          syncRouteLine(replay, replayHeadRef.current)
        }
      })
      m.on('load', () => {
        if (disposed) return
        loaded = true
        fit()
        setStatus('ready')
      })
      // A failed tile only leaves a hole, before the first load as after it.
      // Before the first load, any other error means there is no map to
      // show: the style, the sprite or the archive itself failed. After it,
      // the map that has drawn stays whatever fails.
      m.on('error', (event) => {
        if (loaded || disposed || failed || isTileError(event)) return
        failed = true
        // Removed once MapLibre has finished emitting this event, not from
        // inside its own dispatch, where `remove()` would tear down the
        // map its remaining listeners are still being called on.
        queueMicrotask(dispose)
        setStatus('failed')
      })
      observer = new ResizeObserver(fit)
      observer.observe(container)
      mapRef.current = m
    } catch {
      // No WebGL, most likely. The bare trace underneath is the fallback,
      // and there is no event to wait for: the failure is known now.
      dispose()
      setStatus('failed')
    }
    return dispose
  }, [lat, lon, area.id, attribution, pace])

  // The moment's marker: kept out of the build effect above so a pointer
  // move never tears down and rebuilds the map. Built lazily, on the first
  // moment that lands on a real position, and moved with `setLngLat` on
  // every one after - the same distinction `RouteMap`'s own module doc
  // draws between a diffed style swap and a full rebuild, here between
  // moving a marker and rebuilding the map.
  useEffect(() => {
    if (!ready) return
    const map = mapRef.current
    if (map === null) return
    const momentLat = moment === undefined || moment === null ? undefined : lat[moment]
    const momentLon = moment === undefined || moment === null ? undefined : lon[moment]
    if (momentLat === undefined || momentLat === null || momentLon === undefined || momentLon === null) {
      markerRef.current?.remove()
      markerRef.current = null
      return
    }
    if (markerRef.current === null) {
      const element = document.createElement('div')
      element.className = styles.dot ?? ''
      // `setLngLat` before `addTo`: the real `Marker._update` (unlike this
      // file's mock) reads `this._lngLat` the moment it is added to a map,
      // and an unset one throws reading `.lng` off `undefined` - caught by
      // `RouteHero`'s error boundary, which falls back to the bare trace
      // and silently drops the map underneath the moment's own dot.
      markerRef.current = new Marker({ element }).setLngLat([momentLon, momentLat]).addTo(map)
      return
    }
    markerRef.current.setLngLat([momentLon, momentLat])
  }, [moment, lat, lon, ready])

  // The replay head: its own effect, never the build effect's, since it
  // changes on every frame of a replay. The canvas strokes only the pieces
  // the head has newly passed; the map itself changes only when a replay
  // starts or ends.
  useEffect(() => {
    const replay = replayRef.current
    if (replay === null) return
    replay.canvas.setHead(replayHead ?? null)
    syncRouteLine(replay, replayHead ?? null)
  }, [replayHead])

  const choose = (next: MapFlavour) => {
    setFlavour(next)
    flavourRef.current = next
    writeMapFlavour(next)
    // The new style has no route layers until its `style.load`, and a
    // `setLayoutProperty` before then would throw, the style not loaded.
    if (replayRef.current !== null) replayRef.current.styleReady = false
    mapRef.current?.setStyle(buildStyle(area.id, next, window.location.origin, attribution), { diff: false })
  }

  return (
    <div className={styles.wrap} style={{ aspectRatio: String(panelRatio), '--route-ratio': String(panelRatio) } as CSSProperties}>
      <div
        className={styles.underlay}
        data-testid="route-underlay"
        style={{ visibility: ready ? 'hidden' : 'visible' }}
      >
        {/* The head only while the bare trace is the picture: once the map
            has loaded it draws the replay, and the hidden underlay need
            not follow every frame. */}
        <Route lat={lat} lon={lon} pace={pace} moment={moment} replayHead={ready ? null : replayHead} />
      </div>
      {status !== 'failed' && (
        // MapLibre owns the inner element and styles it; the outer one is
        // React's, and carries the position.
        <div className={styles.map}>
          <div ref={containerRef} className={styles.canvas} />
        </div>
      )}
      {ready && (
        <>
          <div className={styles.label} role="img" aria-label="Route map" />
          <div className={styles.switch} role="radiogroup" aria-label="Map style">
            {FLAVOURS.map((f) => (
              <label key={f.value} className={styles.segment}>
                <input
                  type="radio"
                  name="map-flavour"
                  value={f.value}
                  checked={flavour === f.value}
                  onChange={() => choose(f.value)}
                />
                <span>{f.label}</span>
              </label>
            ))}
          </div>
        </>
      )}
      {ready && scale.metres > 0 && <ScaleBar metres={scale.metres} fraction={scale.fraction} />}
    </div>
  )
}
