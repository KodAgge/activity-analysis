import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoutePace } from './paceColour'
import { recordCanvases, type Recorded } from './recordingCanvas.testUtil'
import { PAD_FRACTION, mapScaleBar } from './routeMath'

type Handler = (...args: unknown[]) => void

/**
 * MapLibre needs WebGL, which jsdom does not have, so - as `UPlot.test.tsx`
 * does for uPlot - the library is replaced by a class that records what it
 * was asked to do and lets the test fire its events by hand. What this
 * cannot show is how the real library reacts: see `RouteMap.tsx` for the
 * three behaviours of the real `Map` its code is written against.
 *
 * `vi.mock` factories are hoisted above every declaration, so the class the
 * factory hands out is built inside `vi.hoisted`.
 */
const { MockMap, setWorkerUrl, MockMarker } = vi.hoisted(() => {
  class MockMap {
    static instances: MockMap[] = []
    static throwOnConstruct = false
    handlers = new Map<string, Handler[]>()
    sources = new Map<string, unknown>()
    layers: string[] = []
    styles: unknown[] = []
    styleOptions: unknown[] = []
    fitCalls: unknown[][] = []
    removeCount = 0
    canvasContainer = document.createElement('div')
    canvas = document.createElement('canvas')
    /** Where the fitted map puts a coordinate: a stand-in linear projection. */
    static project = (lngLat: [number, number]) => ({ x: lngLat[0] * 100, y: lngLat[1] * 10 })
    projectCalls = 0
    /** How deep in its own `fire` the map is, to catch a `remove()` from inside a dispatch. */
    dispatching = 0
    removedMidDispatch = false
    options: Record<string, unknown>
    constructor(options: Record<string, unknown>) {
      if (MockMap.throwOnConstruct) throw new Error('Failed to initialize WebGL')
      this.options = options
      MockMap.instances.push(this)
      // The real constructor puts its controls, the attribution among them,
      // inside the container it is handed.
      const container = options.container
      if (container instanceof HTMLElement) {
        // The canvas container and the map's own canvas inside it, where the
        // real map puts them; the replay's canvas goes in beside it.
        this.canvasContainer = document.createElement('div')
        this.canvasContainer.className = 'maplibregl-canvas-container'
        this.canvas = document.createElement('canvas')
        this.canvas.className = 'maplibregl-canvas'
        this.canvasContainer.append(this.canvas)
        container.append(this.canvasContainer)
        const controls = document.createElement('div')
        controls.className = 'maplibregl-control-container'
        const attribution = document.createElement('details')
        attribution.className = 'maplibregl-ctrl-attrib'
        attribution.innerHTML = '<summary aria-label="Toggle attribution"></summary><a href="https://openstreetmap.org">OpenStreetMap</a>'
        controls.append(attribution)
        container.append(controls)
      }
      this.styles.push(options.style)
    }
    get removed() {
      return this.removeCount > 0
    }
    on(event: string, handler: Handler) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
      return this
    }
    fire(event: string, ...args: unknown[]) {
      this.dispatching++
      try {
        for (const h of this.handlers.get(event) ?? []) h(...args)
      } finally {
        this.dispatching--
      }
    }
    setStyle(style: unknown, options?: unknown) {
      this.styles.push(style)
      this.styleOptions.push(options)
      this.sources.clear()
      this.layers = []
    }
    addSource(id: string, source: unknown) {
      this.sources.set(id, source)
    }
    getSource(id: string) {
      return this.sources.get(id)
    }
    addLayer(layer: { id: string }) {
      this.layers.push(layer.id)
    }
    fitBounds(...args: unknown[]) {
      this.fitCalls.push(args)
    }
    resize() {}
    getZoom() {
      return 14
    }
    getCenter() {
      return { lat: 57.73, lng: 14.15 }
    }
    remove() {
      if (this.dispatching > 0) this.removedMidDispatch = true
      this.removeCount++
    }
    getCanvasContainer() {
      return this.canvasContainer
    }
    getCanvas() {
      return this.canvas
    }
    project(lngLat: [number, number]) {
      this.projectCalls++
      return MockMap.project(lngLat)
    }
    layoutPropertyCalls: unknown[][] = []
    setLayoutProperty(...args: unknown[]) {
      this.layoutPropertyCalls.push(args)
    }
  }
  // Recorded with the number of maps built when it was called, which has
  // to be none: MapLibre starts its workers from the first map.
  const setWorkerUrl = vi.fn((url: string) => ({ url, mapsBefore: MockMap.instances.length }))
  class MockMarker {
    static instances: MockMarker[] = []
    options: unknown
    lngLatCalls: unknown[][] = []
    addToCalls: unknown[] = []
    removeCount = 0
    constructor(options: unknown) {
      this.options = options
      MockMarker.instances.push(this)
    }
    setLngLat(...args: unknown[]) {
      this.lngLatCalls.push(args)
      return this
    }
    addTo(map: unknown) {
      this.addToCalls.push(map)
      return this
    }
    remove() {
      this.removeCount++
      return this
    }
  }
  return { MockMap, setWorkerUrl, MockMarker }
})

vi.mock('maplibre-gl', () => ({ MapLibreMap: MockMap, Marker: MockMarker, addProtocol: vi.fn(), setWorkerUrl }))
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}))
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '/assets/worker.js' }))
vi.mock('pmtiles', () => ({ Protocol: class { tile = vi.fn() } }))

// jsdom has no `ResizeObserver`; this hands the test the callback to fire.
let resizeCallback: ResizeObserverCallback | null = null
const observers: FakeResizeObserver[] = []
class FakeResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback
    observers.push(this)
  }
}

const { default: RouteMap } = await import('./RouteMap')

const area = { id: 'abc123', west: 14.1, south: 57.7, east: 14.3, north: 57.8 }
const lat = [57.71, 57.72, null, 57.75]
const lon = [14.15, 14.16, null, 14.2]

// jsdom lays nothing out, so every box is 0 x 0 and a real map would have
// nothing to fit into. The panel is given a size, as a browser would.
const PANEL_WIDTH = 400
const PANEL_HEIGHT = 300

beforeEach(() => {
  MockMap.instances.length = 0
  MockMap.throwOnConstruct = false
  MockMarker.instances.length = 0
  observers.length = 0
  resizeCallback = null
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  layOut(PANEL_WIDTH, PANEL_HEIGHT)
})

/**
 * Gives every element the layout size a browser would, and a bounding box
 * of a different size, as the activity view's collapsing phone hero reports
 * while its picture is scaled: the box is the transformed one, and the map
 * is fitted to the layout size, which the transform leaves alone.
 */
function layOut(width: number, height: number) {
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(width)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(height)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, width * TRANSFORM_SCALE, height * TRANSFORM_SCALE),
  )
}

/** A collapsed phone hero's picture scale, near its real 281 / 390. */
const TRANSFORM_SCALE = 0.72
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

function renderMap() {
  render(<RouteMap lat={lat} lon={lon} area={area} attribution="attr" />)
  const map = MockMap.instances[0]
  if (map === undefined) throw new Error('no map constructed')
  return map
}

describe('RouteMap', () => {
  it("points MapLibre at the worker Vite emits, before the first map", () => {
    // Set once per page, so only the first map this file builds calls it.
    renderMap()
    expect(setWorkerUrl).toHaveBeenCalledTimes(1)
    expect(setWorkerUrl.mock.results[0]?.value).toEqual({ url: '/assets/worker.js', mapsBefore: 0 })
  })

  it('builds a fixed map and fits the route with the bare trace padding', () => {
    const map = renderMap()
    expect(map.options.interactive).toBe(false)
    act(() => map.fire('load'))
    const [bounds, options] = map.fitCalls.at(-1) ?? []
    expect(bounds).toEqual([
      [14.15, 57.71],
      [14.2, 57.75],
    ])
    // Route pads each axis by PAD_FRACTION of the trace inside a box of
    // (1 + 2 * PAD_FRACTION) traces, so each side's padding is that share
    // of the panel's own extent on that axis.
    const share = PAD_FRACTION / (1 + 2 * PAD_FRACTION)
    expect(options).toMatchObject({ animate: false })
    const padding = (options as { padding: Record<string, number> }).padding
    expect(padding.left).toBeCloseTo(PANEL_WIDTH * share, 9)
    expect(padding.right).toBeCloseTo(PANEL_WIDTH * share, 9)
    expect(padding.top).toBeCloseTo(PANEL_HEIGHT * share, 9)
    expect(padding.bottom).toBeCloseTo(PANEL_HEIGHT * share, 9)
  })

  it('does not fit a panel that has no size yet', () => {
    layOut(0, 0)
    const map = renderMap()
    act(() => map.fire('load'))
    expect(map.fitCalls).toHaveLength(0)
  })

  describe('the moment', () => {
    // `lat[2]`/`lon[2]` are real numbers on the module's own fixture; the
    // gap sits at index 2, which the "a null position removes it" case
    // below moves onto instead.
    it('creates one marker after load, adds it to the map, and places it at the moment', () => {
      const { rerender } = render(<RouteMap lat={lat} lon={lon} area={area} attribution="attr" />)
      const map = MockMap.instances[0]
      if (map === undefined) throw new Error('no map constructed')
      act(() => map.fire('load'))

      rerender(<RouteMap lat={lat} lon={lon} area={area} attribution="attr" moment={3} />)

      expect(MockMarker.instances).toHaveLength(1)
      const marker = MockMarker.instances[0]
      if (marker === undefined) throw new Error('no marker constructed')
      expect(marker.addToCalls).toEqual([map])
      expect(marker.lngLatCalls.at(-1)).toEqual([[lon[3], lat[3]]])
    })

    it('moves the same marker when the moment changes to another valid sample', () => {
      const { rerender } = render(<RouteMap lat={lat} lon={lon} area={area} attribution="attr" moment={3} />)
      const map = MockMap.instances[0]
      if (map === undefined) throw new Error('no map constructed')
      act(() => map.fire('load'))
      expect(MockMarker.instances).toHaveLength(1)

      rerender(<RouteMap lat={lat} lon={lon} area={area} attribution="attr" moment={0} />)

      expect(MockMarker.instances).toHaveLength(1)
      const marker = MockMarker.instances[0]
      if (marker === undefined) throw new Error('no marker constructed')
      expect(marker.lngLatCalls.at(-1)).toEqual([[lon[0], lat[0]]])
      expect(marker.removeCount).toBe(0)
    })

    it('removes the marker when the moment clears', () => {
      const { rerender } = render(<RouteMap lat={lat} lon={lon} area={area} attribution="attr" moment={3} />)
      const map = MockMap.instances[0]
      if (map === undefined) throw new Error('no map constructed')
      act(() => map.fire('load'))
      const marker = MockMarker.instances[0]
      if (marker === undefined) throw new Error('no marker constructed')

      rerender(<RouteMap lat={lat} lon={lon} area={area} attribution="attr" moment={null} />)

      expect(marker.removeCount).toBe(1)
    })

    it("removes the marker when the moment's own position is null", () => {
      // Index 2 on the module fixture is the GPS gap.
      const { rerender } = render(<RouteMap lat={lat} lon={lon} area={area} attribution="attr" moment={3} />)
      const map = MockMap.instances[0]
      if (map === undefined) throw new Error('no map constructed')
      act(() => map.fire('load'))
      const marker = MockMarker.instances[0]
      if (marker === undefined) throw new Error('no marker constructed')

      rerender(<RouteMap lat={lat} lon={lon} area={area} attribution="attr" moment={2} />)

      expect(marker.removeCount).toBe(1)
    })

    it('places no marker before the map has loaded', () => {
      render(<RouteMap lat={lat} lon={lon} area={area} attribution="attr" moment={3} />)
      expect(MockMarker.instances).toHaveLength(0)
    })

    it("draws the moment's dot on the underlay's bare trace before the map has loaded", () => {
      // The marker effect bails on `!ready`, so before `load` (and for as
      // long as the map fails to reach it) the underlay's own `Route` is
      // the only thing that can show the moment at all - it needs `moment`
      // passed through, not only `lat`/`lon`/`pace`.
      render(<RouteMap lat={lat} lon={lon} area={area} attribution="attr" moment={3} />)
      const underlay = screen.getByTestId('route-underlay')
      expect(underlay.querySelector('circle')).not.toBeNull()
    })

    it("draws the moment's dot on the underlay's bare trace when the map fails to load", async () => {
      render(<RouteMap lat={lat} lon={lon} area={area} attribution="attr" moment={3} />)
      const map = MockMap.instances[0]
      if (map === undefined) throw new Error('no map constructed')
      await act(async () => map.fire('error', { error: new Error('tiles 404') }))

      const underlay = screen.getByTestId('route-underlay')
      expect(underlay).toBeVisible()
      expect(underlay.querySelector('circle')).not.toBeNull()
    })

    it('removes the marker on dispose', () => {
      const { unmount } = render(<RouteMap lat={lat} lon={lon} area={area} attribution="attr" moment={3} />)
      const map = MockMap.instances[0]
      if (map === undefined) throw new Error('no map constructed')
      act(() => map.fire('load'))
      const marker = MockMarker.instances[0]
      if (marker === undefined) throw new Error('no marker constructed')
      unmount()
      expect(marker.removeCount).toBe(1)
    })
  })

  it('draws the route as a casing and a line, split at the GPS gap', () => {
    const map = renderMap()
    act(() => map.fire('style.load'))
    expect(map.layers).toEqual(['route-casing', 'route-line'])
    const source = map.getSource('route') as { data: { geometry: { type: string; coordinates: unknown[] } } }
    expect(source.data.geometry.type).toBe('MultiLineString')
    expect(source.data.geometry.coordinates).toHaveLength(2)
  })

  describe('coloured by pace', () => {
    const pace: RoutePace = {
      pieces: [
        { step: 0, start: 0, end: 1, coords: [[14.15, 57.71], [14.16, 57.72]] },
        { step: null, start: 1, end: 3, coords: [[14.16, 57.72], [14.2, 57.75]] },
      ],
      palette: ['#111111', '#222222'],
      stoppedColour: '#999999',
    }

    it('draws the pace pieces as their own source, coloured per piece', () => {
      render(<RouteMap lat={lat} lon={lon} area={area} attribution="attr" pace={pace} />)
      const map = MockMap.instances[0]
      if (map === undefined) throw new Error('no map constructed')
      act(() => map.fire('style.load'))

      expect(map.layers).toEqual(['route-casing', 'route-outline', 'route-line'])
      const source = map.getSource('route-pace') as {
        data: { type: string; features: { properties: { colour: string } }[] }
      }
      expect(source.data.type).toBe('FeatureCollection')
      expect(source.data.features).toHaveLength(2)
      expect(source.data.features[0]).toMatchObject({ properties: { colour: '#111111' } })
      expect(source.data.features[1]).toMatchObject({ properties: { colour: '#999999' } })
    })

    describe('the replay head', () => {
      // Pieces ending at samples 2, 4 and 6, told apart by colour.
      const replayPace: RoutePace = {
        pieces: [
          { step: 0, start: 0, end: 2, coords: [[14.15, 57.71], [14.16, 57.72]] },
          { step: 1, start: 2, end: 4, coords: [[14.16, 57.72], [14.18, 57.73]] },
          { step: null, start: 4, end: 6, coords: [[14.18, 57.73], [14.2, 57.75]] },
        ],
        palette: ['#111111', '#222222'],
        stoppedColour: '#999999',
      }
      let canvases: Map<HTMLCanvasElement, Recorded>
      beforeEach(() => {
        canvases = recordCanvases()
      })

      function replayCanvas(map: InstanceType<typeof MockMap>): HTMLCanvasElement {
        const element = map.canvasContainer.querySelector('canvas:not(.maplibregl-canvas)')
        if (!(element instanceof HTMLCanvasElement)) throw new Error('no replay canvas')
        return element
      }
      const strokes = (map: InstanceType<typeof MockMap>) => canvases.get(replayCanvas(map))?.strokes ?? []
      const colours = (map: InstanceType<typeof MockMap>) => strokes(map).map((s) => s.colour)
      const lineCalls = (map: InstanceType<typeof MockMap>) =>
        map.layoutPropertyCalls.filter(([layer]) => layer === 'route-line')

      function renderLoaded(replayHead: number | null) {
        const view = render(
          <RouteMap lat={lat} lon={lon} area={area} attribution="attr" pace={replayPace} replayHead={replayHead} />,
        )
        const map = MockMap.instances[0]
        if (map === undefined) throw new Error('no map constructed')
        act(() => map.fire('style.load'))
        act(() => map.fire('load'))
        const rerender = (head: number | null) =>
          view.rerender(
            <RouteMap lat={lat} lon={lon} area={area} attribution="attr" pace={replayPace} replayHead={head} />,
          )
        return { map, rerender }
      }

      it('puts its canvas over the map canvas and under anything added after, such as the marker', () => {
        const { map } = renderLoaded(null)
        const children = Array.from(map.canvasContainer.children)
        expect(children.indexOf(replayCanvas(map))).toBe(children.indexOf(map.canvas) + 1)
      })

      it('draws nothing and leaves the map alone without a head', () => {
        const { map } = renderLoaded(null)
        expect(strokes(map)).toEqual([])
        expect(map.layoutPropertyCalls).toEqual([])
      })

      it('strokes the pieces the head has passed, in their colours, at the projected points', () => {
        const { map, rerender } = renderLoaded(null)
        rerender(4)
        expect(colours(map)).toEqual(['#111111', '#222222'])
        expect(strokes(map)[0]?.first).toEqual([1415, 577.1])
        expect(canvases.get(replayCanvas(map))?.lineWidth).toBe(4.5)
      })

      it('strokes exactly the new pieces between two heads', () => {
        const { map, rerender } = renderLoaded(null)
        rerender(2)
        rerender(3)
        expect(colours(map)).toEqual(['#111111'])
        rerender(6)
        expect(colours(map)).toEqual(['#111111', '#222222', '#999999'])
      })

      it('hides the coloured line once at the start and restores it at the end', () => {
        const { map, rerender } = renderLoaded(null)
        rerender(0)
        rerender(2)
        rerender(4)
        expect(map.layoutPropertyCalls).toEqual([
          ['route-line', 'visibility', 'none'],
          ['route-outline', 'visibility', 'visible'],
        ])
        rerender(null)
        expect(map.layoutPropertyCalls.slice(2)).toEqual([
          ['route-line', 'visibility', 'visible'],
          ['route-outline', 'visibility', 'none'],
        ])
        expect(canvases.get(replayCanvas(map))?.clears).toBe(1)
      })

      it('redraws up to the current head when the panel resizes', () => {
        const { map, rerender } = renderLoaded(null)
        rerender(4)
        const rec = canvases.get(replayCanvas(map))
        if (rec === undefined) throw new Error('nothing drawn')
        rec.strokes.length = 0
        act(() => resizeCallback?.([], {} as ResizeObserver))
        expect(colours(map)).toEqual(['#111111', '#222222'])
      })

      it('projects the pieces once per fit, not per frame', () => {
        const { map, rerender } = renderLoaded(null)
        const afterFit = map.projectCalls
        expect(afterFit).toBe(6)
        rerender(2)
        rerender(4)
        rerender(6)
        expect(map.projectCalls).toBe(afterFit)
      })

      it('draws nothing on the map before it has loaded, where the underlay draws the head', () => {
        render(<RouteMap lat={lat} lon={lon} area={area} attribution="attr" pace={replayPace} replayHead={4} />)
        const map = MockMap.instances[0]
        if (map === undefined) throw new Error('no map constructed')
        expect(strokes(map)).toEqual([])
        const underlay = screen.getByTestId('route-underlay')
        expect(underlay.querySelectorAll('canvas')).toHaveLength(1)
      })

      it('draws a head it was handed before loading once the map loads', () => {
        const { map } = renderLoaded(4)
        expect(colours(map)).toEqual(['#111111', '#222222'])
        expect(lineCalls(map)).toEqual([['route-line', 'visibility', 'none']])
      })

      it('hides the coloured line again after a flavour switch mid-replay, and keeps the canvas', () => {
        const { map, rerender } = renderLoaded(4)
        fireEvent.click(screen.getByRole('radio', { name: 'Grey' }))
        map.layoutPropertyCalls.length = 0
        // Between the switch and its `style.load` the new style has no
        // layers, so a frame there changes the canvas only.
        rerender(6)
        expect(map.layoutPropertyCalls).toEqual([])
        expect(colours(map)).toEqual(['#111111', '#222222', '#999999'])
        act(() => map.fire('style.load'))
        expect(map.layoutPropertyCalls).toEqual([
          ['route-line', 'visibility', 'none'],
          ['route-outline', 'visibility', 'visible'],
        ])
      })

      it('makes no canvas for a route drawn without pace', () => {
        const map = renderMap()
        expect(map.canvasContainer.querySelectorAll('canvas')).toHaveLength(1)
      })

      it('removes its canvas with the map', () => {
        const { map } = renderLoaded(null)
        const element = replayCanvas(map)
        cleanup()
        expect(element.isConnected).toBe(false)
      })
    })

    it('keeps the accent line when given no pace', () => {
      const map = renderMap()
      act(() => map.fire('style.load'))
      expect(map.layers).toEqual(['route-casing', 'route-line'])
      expect(map.getSource('route-pace')).toBeUndefined()
    })

    it('redraws the pace pieces on a flavour switch', () => {
      render(<RouteMap lat={lat} lon={lon} area={area} attribution="attr" pace={pace} />)
      const map = MockMap.instances[0]
      if (map === undefined) throw new Error('no map constructed')
      act(() => map.fire('load'))
      act(() => map.fire('style.load'))
      expect(map.getSource('route-pace')).toBeDefined()

      fireEvent.click(screen.getByRole('radio', { name: 'Grey' }))
      expect(map.getSource('route-pace')).toBeUndefined()
      act(() => map.fire('style.load'))
      expect(map.layers).toEqual(['route-casing', 'route-outline', 'route-line'])
      expect(map.getSource('route-pace')).toBeDefined()
    })
  })

  it('shows the bare trace until the map has loaded, then hides it', () => {
    const map = renderMap()
    expect(screen.getByTestId('route-underlay')).toBeVisible()
    expect(screen.getAllByRole('img', { name: 'Route map' })).toHaveLength(1)
    // The switch belongs to the map, and is never drawn over the bare trace.
    expect(screen.queryByRole('radiogroup', { name: 'Map style' })).toBeNull()
    act(() => map.fire('load'))
    expect(screen.getByTestId('route-underlay')).toHaveStyle({ visibility: 'hidden' })
    expect(screen.getAllByRole('img', { name: 'Route map' })).toHaveLength(1)
    expect(screen.getByRole('radiogroup', { name: 'Map style' })).toBeInTheDocument()
  })

  it("keeps MapLibre's attribution outside the labelled image, so it stays reachable", () => {
    const map = renderMap()
    act(() => map.fire('load'))
    const image = screen.getByRole('img', { name: 'Route map' })
    const attribution = document.querySelector('.maplibregl-ctrl-attrib')
    expect(attribution).not.toBeNull()
    expect(image.contains(attribution)).toBe(false)
    expect(screen.getByRole('link', { name: 'OpenStreetMap' })).toBeInTheDocument()
  })

  it('treats a tile error before loading as a hole, not a failure', () => {
    const map = renderMap()
    act(() => map.fire('error', { error: new Error('tile failed'), tile: {}, sourceId: 'protomaps' }))
    expect(map.removed).toBe(false)
    act(() => map.fire('load'))
    expect(screen.getByTestId('route-underlay')).toHaveStyle({ visibility: 'hidden' })
    expect(screen.getByRole('radiogroup', { name: 'Map style' })).toBeInTheDocument()
  })

  it('falls back when the archive itself fails before loading', async () => {
    // The shape of a TileJSON failure, which is where the `pmtiles` protocol
    // reads the archive's header: the source's id, and no tile.
    const map = renderMap()
    await act(async () => map.fire('error', { error: new Error('Bad response code: 404'), sourceId: 'protomaps' }))
    expect(map.removeCount).toBe(1)
    expect(screen.getByTestId('route-underlay')).toBeVisible()
    expect(screen.queryByRole('radiogroup', { name: 'Map style' })).toBeNull()
  })

  it("states the map's own scale once it has loaded", () => {
    const map = renderMap()
    act(() => map.fire('load'))
    const expected = mapScaleBar(PANEL_WIDTH, 57.73, 14)
    // The underlay's own bar is still in the document, hidden with it, so
    // the map's is the one outside the underlay.
    const underlay = screen.getByTestId('route-underlay')
    const bars = screen.getAllByTestId('scale-bar').filter((el) => !underlay.contains(el))
    expect(bars).toHaveLength(1)
    const rule = bars[0]?.querySelector<HTMLElement>('[data-testid="scale-bar-rule"]')
    expect(rule?.style.width).toBe(`${String(100 * expected.fraction)}%`)
  })

  it('keeps the map after a tile error once it has loaded', () => {
    const map = renderMap()
    act(() => map.fire('load'))
    act(() => map.fire('error', { error: new Error('one tile 404') }))
    expect(map.removed).toBe(false)
    expect(screen.getByRole('radiogroup', { name: 'Map style' })).toBeInTheDocument()
  })

  it('falls back to the bare trace when the map errors before loading', async () => {
    const { unmount } = render(<RouteMap lat={lat} lon={lon} area={area} attribution="attr" />)
    const map = MockMap.instances[0]
    if (map === undefined) throw new Error('no map constructed')
    await act(async () => map.fire('error', { error: new Error('tiles 404') }))
    expect(map.removeCount).toBe(1)
    expect(observers[0]?.disconnect).toHaveBeenCalled()
    expect(screen.getByTestId('route-underlay')).toBeVisible()
    expect(screen.queryByRole('radiogroup', { name: 'Map style' })).toBeNull()
    // A second error from the same map, and the unmount after it, must not
    // remove it again.
    await act(async () => map.fire('error', { error: new Error('another') }))
    unmount()
    expect(map.removeCount).toBe(1)
  })

  it('removes a failed map only after its error event has finished dispatching', async () => {
    const map = renderMap()
    await act(async () => map.fire('error', { error: new Error('style 404') }))
    expect(map.removeCount).toBe(1)
    expect(map.removedMidDispatch).toBe(false)
    expect(screen.getByTestId('route-underlay')).toBeVisible()
  })

  it('refits when the panel resizes', () => {
    const map = renderMap()
    act(() => map.fire('load'))
    const before = map.fitCalls.length
    act(() => resizeCallback?.([], {} as ResizeObserver))
    expect(map.fitCalls.length).toBe(before + 1)
  })

  it('switches flavour, remembers it, and redraws the route on the new style', () => {
    const map = renderMap()
    act(() => map.fire('load'))
    fireEvent.click(screen.getByRole('radio', { name: 'Grey' }))
    expect(localStorage.getItem('activity-analysis:map-flavour')).toBe('grayscale')
    expect(JSON.stringify(map.styles.at(-1))).toContain('sprites/v4/grayscale')
    // A diffed `setStyle` fires no `style.load` and strips the route layers
    // the new style does not name, so the swap has to be a full rebuild.
    expect(map.styleOptions.at(-1)).toMatchObject({ diff: false })
    expect(map.layers).toEqual([])
    act(() => map.fire('style.load'))
    expect(map.layers).toEqual(['route-casing', 'route-line'])
    expect(screen.getByRole('radio', { name: 'Grey' })).toBeChecked()
  })

  it('opens in the remembered flavour', () => {
    localStorage.setItem('activity-analysis:map-flavour', 'grayscale')
    const map = renderMap()
    expect(JSON.stringify(map.styles[0])).toContain('sprites/v4/grayscale')
    act(() => map.fire('load'))
    expect(screen.getByRole('radio', { name: 'Grey' })).toBeChecked()
  })

  it('falls back when the map cannot be constructed at all', () => {
    MockMap.throwOnConstruct = true
    render(<RouteMap lat={lat} lon={lon} area={area} attribution="attr" />)
    expect(screen.getByTestId('route-underlay')).toBeVisible()
    expect(screen.queryByRole('radiogroup', { name: 'Map style' })).toBeNull()
    expect(screen.getAllByRole('img', { name: 'Route map' })).toHaveLength(1)
  })

  it('falls back, and removes the half-built map, when wiring it up throws', () => {
    const original = MockMap.prototype.on
    MockMap.prototype.on = () => {
      throw new Error('WebGL unavailable')
    }
    try {
      render(<RouteMap lat={lat} lon={lon} area={area} attribution="attr" />)
      expect(screen.getByTestId('route-underlay')).toBeVisible()
      expect(screen.queryByRole('radiogroup', { name: 'Map style' })).toBeNull()
      expect(MockMap.instances[0]?.removeCount).toBe(1)
    } finally {
      MockMap.prototype.on = original
    }
  })

  it('removes the map and stops observing on unmount', () => {
    const { unmount } = render(<RouteMap lat={lat} lon={lon} area={area} attribution="attr" />)
    const map = MockMap.instances[0]
    unmount()
    expect(map?.removeCount).toBe(1)
    expect(observers[0]?.disconnect).toHaveBeenCalled()
  })

  it('survives StrictMode mounting it twice, leaving one live map', () => {
    const { unmount } = render(
      <StrictMode>
        <RouteMap lat={lat} lon={lon} area={area} attribution="attr" />
      </StrictMode>,
    )
    expect(MockMap.instances).toHaveLength(2)
    const [first, second] = MockMap.instances
    if (first === undefined || second === undefined) throw new Error('expected two maps')
    expect(first.removeCount).toBe(1)
    expect(second.removeCount).toBe(0)
    act(() => second.fire('load'))
    expect(screen.getByTestId('route-underlay')).toHaveStyle({ visibility: 'hidden' })
    fireEvent.click(screen.getByRole('radio', { name: 'Grey' }))
    expect(first.styles).toHaveLength(1)
    expect(second.styles).toHaveLength(2)
    unmount()
    expect(first.removeCount).toBe(1)
    expect(second.removeCount).toBe(1)
  })

  it('starts over when it is handed a different route', () => {
    const { rerender } = render(<RouteMap lat={lat} lon={lon} area={area} attribution="attr" />)
    const first = MockMap.instances[0]
    if (first === undefined) throw new Error('no map constructed')
    act(() => first.fire('load'))
    expect(screen.getByTestId('route-underlay')).toHaveStyle({ visibility: 'hidden' })

    const otherLat = [57.76, 57.77]
    const otherLon = [14.21, 14.22]
    rerender(<RouteMap lat={otherLat} lon={otherLon} area={area} attribution="attr" />)
    expect(first.removeCount).toBe(1)
    const second = MockMap.instances[1]
    if (second === undefined) throw new Error('no second map constructed')
    // The new map has not loaded, so the bare trace of the new route shows.
    expect(screen.getByTestId('route-underlay')).toBeVisible()
    expect(screen.getAllByRole('img', { name: 'Route map' })).toHaveLength(1)
    act(() => second.fire('load'))
    expect(screen.getByTestId('route-underlay')).toHaveStyle({ visibility: 'hidden' })
  })
})
