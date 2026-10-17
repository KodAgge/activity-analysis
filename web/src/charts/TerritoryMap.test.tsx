import { act, fireEvent, render, screen } from '@testing-library/react'
import type { CSSProperties } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../api/schema'

type Handler = (...args: unknown[]) => void
type TerritoryRegion = components['schemas']['TerritoryRegion']
type TerritoryFeatureCollection = components['schemas']['TerritoryFeatureCollection']

/**
 * MapLibre needs WebGL, which jsdom does not have, so the library is a
 * recording stand-in whose events the test fires by hand, as in
 * `RouteMap.test.tsx`.
 */
const { MockMap, MockNavigationControl, MockMarker } = vi.hoisted(() => {
  class MockMarker {
    static instances: MockMarker[] = []
    element: HTMLElement
    lngLat: unknown = null
    map: unknown = null
    constructor(options: { element: HTMLElement }) {
      this.element = options.element
      MockMarker.instances.push(this)
    }
    setLngLat(lngLat: unknown) {
      this.lngLat = lngLat
      return this
    }
    addTo(map: { container: HTMLElement }) {
      this.map = map
      map.container.append(this.element)
      return this
    }
    remove() {
      this.map = null
      this.element.remove()
      return this
    }
  }
  class MockMap {
    static instances: MockMap[] = []
    static throwOnConstruct = false
    handlers = new Map<string, Handler[]>()
    sources = new Map<string, { data: unknown; setData: (d: unknown) => void }>()
    layers: { id: string; type: string; paint?: Record<string, unknown>; before?: string }[] = []
    styles: unknown[] = []
    styleOptions: unknown[] = []
    fitCalls: unknown[][] = []
    controls: unknown[][] = []
    removeCount = 0
    touchZoomRotate = { disableRotation: vi.fn() }
    options: Record<string, unknown>
    container: HTMLElement
    /** Degrees to pixels, linear: a stand-in for Mercator at a zoom the test sets. */
    pxPerDegree = 1000
    constructor(options: Record<string, unknown>) {
      if (MockMap.throwOnConstruct) throw new Error('Failed to initialize WebGL')
      this.options = options
      this.container = options.container as HTMLElement
      this.styles.push(options.style)
      MockMap.instances.push(this)
    }
    on(event: string, handler: Handler) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
      return this
    }
    fire(event: string, ...args: unknown[]) {
      for (const h of this.handlers.get(event) ?? []) h(...args)
    }
    addControl(...args: unknown[]) {
      this.controls.push(args)
    }
    setStyle(style: unknown, options?: unknown) {
      this.styles.push(style)
      this.styleOptions.push(options)
      this.sources.clear()
      this.layers = []
    }
    addSource(id: string, source: { data: unknown }) {
      const entry = {
        data: source.data,
        setData: (d: unknown) => {
          entry.data = d
        },
      }
      this.sources.set(id, entry)
    }
    getSource(id: string) {
      return this.sources.get(id)
    }
    addLayer(layer: { id: string; type: string; paint?: Record<string, unknown> }, before?: string) {
      this.layers.push({ ...layer, before })
    }
    project([lng, lat]: [number, number]) {
      return { x: lng * this.pxPerDegree, y: -lat * this.pxPerDegree }
    }
    fitBounds(...args: unknown[]) {
      this.fitCalls.push(args)
    }
    resize() {}
    getZoom() {
      return 11
    }
    getCenter() {
      return { lat: 57.75, lng: 14.05 }
    }
    remove() {
      this.removeCount++
    }
  }
  class MockNavigationControl {
    options: unknown
    constructor(options: unknown) {
      this.options = options
    }
    onAdd() {
      const container = document.createElement('div')
      container.append(document.createElement('button'), document.createElement('button'))
      return container
    }
  }
  return { MockMap, MockNavigationControl, MockMarker }
})

vi.mock('maplibre-gl', () => ({
  MapLibreMap: MockMap,
  Marker: MockMarker,
  NavigationControl: MockNavigationControl,
  addProtocol: vi.fn(),
  setWorkerUrl: vi.fn(),
}))
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}))
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '/assets/worker.js' }))
vi.mock('pmtiles', () => ({ Protocol: class { tile = vi.fn() } }))

class FakeResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

const { default: TerritoryMap } = await import('./TerritoryMap')

function region(id: string, name: string, box: { west: number; south: number; east: number; north: number }): TerritoryRegion {
  return {
    region_id: id,
    name,
    locality: name,
    country: 'Sweden',
    area_m2: 1,
    part_count: 1,
    claim_count: 1,
    first_claim_utc: '2025-01-01T00:00:00Z',
    last_claim_utc: '2025-01-01T00:00:00Z',
    ...box,
  }
}

// A region whose box lies across two areas, and a small one with an area of its own.
const jonkoping = region('jkp', 'Jönköping', { west: 13.75, south: 57.65, east: 14.35, north: 57.8 })
const lakeside = region('lks', 'Lakeside', { west: 14.6, south: 57.0, east: 14.68, north: 57.04 })
const areas = [
  { id: 'west', west: 13.7, south: 57.7, east: 14.0, north: 57.85 },
  { id: 'east', west: 14.1, south: 57.62, east: 14.4, north: 57.76 },
  { id: 'lks', west: 14.55, south: 56.95, east: 14.72, north: 57.05 },
]
const territory: TerritoryFeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { region_id: 'jkp', part_index: 0, area_m2: 1 },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [13.9, 57.7],
            [14.0, 57.7],
            [14.0, 57.75],
            [13.9, 57.7],
          ],
        ],
      },
    },
  ],
}

beforeEach(() => {
  MockMap.instances.length = 0
  MockMarker.instances.length = 0
  MockMap.throwOnConstruct = false
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(500)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

function onlyMap() {
  const map = MockMap.instances[0]
  if (map === undefined) throw new Error('no map constructed')
  return map
}

/** The detailed basemap sources' archives, leaving out the coarse underlay's second reading of them. */
function sourceUrls(style: unknown): string[] {
  const sources = (style as { sources: Record<string, { url?: string }> }).sources
  return Object.entries(sources)
    .filter(([id]) => id.startsWith('protomaps-'))
    .map(([, s]) => s.url ?? '')
}

describe('TerritoryMap', () => {
  it("opens fitted to the region's core, over every basemap area the region's whole box meets", () => {
    render(<TerritoryMap territory={territory} region={jonkoping} areas={areas} attribution="attr" />)
    const map = onlyMap()
    // The one part's box, not the region's: `claimCore`.
    expect(map.options.bounds).toEqual([
      [13.9, 57.7],
      [14.0, 57.75],
    ])
    expect(map.options.fitBoundsOptions).toEqual({ padding: { top: 35, bottom: 35, left: 35, right: 79 } })
    expect(sourceUrls(map.styles[0]).map((u) => u.split('/').at(-1))).toEqual(['west.pmtiles', 'east.pmtiles'])
  })

  it('keeps the fitted ground below the band the view lays over the top', () => {
    render(
      <div style={{ '--map-overlay-top': '60px' } as CSSProperties}>
        <TerritoryMap territory={territory} region={jonkoping} areas={areas} attribution="attr" />
      </div>,
    )
    expect(onlyMap().options.fitBoundsOptions).toEqual({ padding: { top: 95, bottom: 35, left: 35, right: 79 } })
  })

  it("clears a phone's tall panel of its controls above and below the ground, not beside it", () => {
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(430)
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(716)
    render(
      <div style={{ '--map-overlay-top': '60px' } as CSSProperties}>
        <TerritoryMap territory={territory} region={jonkoping} areas={areas} attribution="attr" />
      </div>,
    )
    // 3.5% of 430 a side; the pills' 60 and the switch's 44 above, the buttons' 148 below.
    expect(onlyMap().options.fitBoundsOptions).toEqual({ padding: { top: 119, bottom: 163, left: 15, right: 15 } })
  })

  it('refits a newly chosen region to its own core, or its box when it has no ground drawn', () => {
    const { rerender } = render(
      <TerritoryMap territory={territory} region={jonkoping} areas={areas} attribution="attr" />,
    )
    const map = onlyMap()
    rerender(<TerritoryMap territory={territory} region={lakeside} areas={areas} attribution="attr" />)
    expect(map.fitCalls.at(-1)?.[0]).toEqual([
      [14.6, 57.0],
      [14.68, 57.04],
    ])
  })

  it('lets the reader move the map, cooperatively, with zoom buttons and no rotation', () => {
    render(<TerritoryMap territory={territory} region={jonkoping} areas={areas} attribution="attr" />)
    const map = onlyMap()
    expect(map.options.interactive).toBeUndefined()
    expect(map.options.cooperativeGestures).toBe(true)
    expect(map.options.dragRotate).toBe(false)
    expect(map.controls.some((c) => c[0] instanceof MockNavigationControl)).toBe(true)
  })

  it('keeps the knockout and the tint under the water in Light, and the veil and edge under the labels', () => {
    render(<TerritoryMap territory={territory} region={jonkoping} areas={areas} attribution="attr" />)
    const map = onlyMap()
    act(() => map.fire('style.load'))
    expect(map.sources.get('territory')?.data).toBe(territory)
    const veil = map.sources.get('territory-unclaimed')?.data as { geometry: { coordinates: number[][][][] } }
    // The world, with the one part cut out of it.
    expect(veil.geometry.coordinates[0]?.[1]).toEqual(territory.features[0]?.geometry.coordinates[0])
    expect(map.layers.map((l) => `${l.id}:${l.type}<${String(l.before)}`)).toEqual([
      'territory-knockout:fill<water--west',
      'territory-fill:fill<water--west',
      'territory-veil:fill<address_label--west',
      'territory-casing:line<address_label--west',
      'territory-edge:line<address_label--west',
    ])
  })

  it('draws the knockout and the tint over the water in Grey, and adds the territory again to the new style', () => {
    render(<TerritoryMap territory={territory} region={jonkoping} areas={areas} attribution="attr" />)
    const map = onlyMap()
    act(() => map.fire('style.load'))
    act(() => map.fire('load'))
    // A flavour switch is a new style without the territory, and gets it again.
    fireEvent.click(screen.getByRole('radio', { name: 'Grey' }))
    expect(map.layers).toHaveLength(0)
    act(() => map.fire('style.load'))
    expect(map.layers.map((l) => `${l.id}<${String(l.before)}`)).toEqual([
      // A lake in the ground is the ground's one tone in Grey, not a deeper patch of it.
      'territory-knockout<landuse_pedestrian--west',
      'territory-fill<landuse_pedestrian--west',
      'territory-veil<address_label--west',
      'territory-casing<address_label--west',
      'territory-edge<address_label--west',
    ])
  })

  it('reads the coarse underlay under the detailed basemap, so the frame past the areas is still map', () => {
    render(<TerritoryMap territory={territory} region={jonkoping} areas={areas} attribution="attr" />)
    const style = onlyMap().styles[0] as { sources: Record<string, { maxzoom?: number }> }
    expect(Object.keys(style.sources).filter((id) => id.startsWith('underlay-'))).toEqual([
      'underlay-z0-west',
      'underlay-z3-west',
      'underlay-z6-west',
      'underlay-z9-west',
      'underlay-z9-east',
    ])
  })

  it('fits the chosen region again from the button under the zoom, and renames it with the region', () => {
    const { rerender } = render(
      <TerritoryMap territory={territory} region={jonkoping} areas={areas} attribution="attr" />,
    )
    const map = onlyMap()
    expect(map.controls).toHaveLength(1)
    const control = map.controls[0]?.[0] as { onAdd: (m: unknown) => HTMLElement } | undefined
    if (control === undefined) throw new Error('no control added')
    const group = control.onAdd(map)
    // Zoom in, zoom out, then the fit button, in one group.
    expect(group.querySelectorAll('button')).toHaveLength(3)
    const button = group.querySelectorAll('button')[2]
    expect(button).toHaveAccessibleName('Show all of Jönköping')
    button?.click()
    expect(map.fitCalls.at(-1)?.[0]).toEqual([
      [13.75, 57.65],
      [14.35, 57.8],
    ])
    rerender(<TerritoryMap territory={territory} region={lakeside} areas={areas} attribution="attr" />)
    expect(button).toHaveAccessibleName('Show all of Lakeside')
  })

  it('marks a place once its ground is too small to see, and its marker chooses it', () => {
    const onSelect = vi.fn()
    render(
      <TerritoryMap
        territory={territory}
        region={jonkoping}
        regions={[jonkoping, lakeside]}
        onSelectRegion={onSelect}
        areas={areas}
        attribution="attr"
      />,
    )
    const map = onlyMap()
    act(() => map.fire('load'))
    // At 1000 px a degree both places are far too big for a marker.
    expect(screen.queryByRole('button', { name: /Lakeside/ })).toBeNull()
    map.pxPerDegree = 50
    act(() => map.fire('move'))
    // Lakeside's 0.08 degree box is 4 px now; Jönköping's 0.6 is 30.
    fireEvent.click(screen.getByRole('button', { name: 'Lakeside, 0.00 km² claimed' }))
    expect(onSelect).toHaveBeenCalledWith('lks')
    // The chosen place's own marker fits it again rather than choosing it.
    const fitsBefore = map.fitCalls.length
    fireEvent.click(screen.getByRole('button', { name: 'Jönköping, 0.00 km² claimed' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(map.fitCalls.length).toBe(fitsBefore + 1)
    map.pxPerDegree = 1000
    act(() => map.fire('move'))
    expect(screen.queryByRole('button', { name: /Lakeside/ })).toBeNull()
  })

  it('shows the style switch and names the map only once it has loaded', () => {
    render(<TerritoryMap territory={territory} region={jonkoping} areas={areas} attribution="attr" />)
    expect(screen.getByText('Loading the map…')).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Map style' })).toBeNull()
    act(() => onlyMap().fire('load'))
    expect(screen.getByRole('radiogroup', { name: 'Map style' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Map of the ground claimed in Jönköping' })).toBeInTheDocument()
  })

  it('refits to a new region, and swaps the style only because its areas differ', () => {
    const { rerender } = render(
      <TerritoryMap territory={territory} region={jonkoping} areas={areas} attribution="attr" />,
    )
    const map = onlyMap()
    rerender(<TerritoryMap territory={territory} region={lakeside} areas={areas} attribution="attr" />)
    expect(MockMap.instances).toHaveLength(1)
    expect(map.fitCalls.at(-1)?.[0]).toEqual([
      [14.6, 57.0],
      [14.68, 57.04],
    ])
    expect(sourceUrls(map.styles.at(-1)).map((u) => u.split('/').at(-1))).toEqual(['lks.pmtiles'])
    expect(map.styleOptions.at(-1)).toEqual({ diff: false })
  })

  it('opens in Light whatever the route map was last set to', () => {
    localStorage.setItem('activity-analysis:map-flavour', 'grayscale')
    render(<TerritoryMap territory={territory} region={jonkoping} areas={areas} attribution="attr" />)
    const map = onlyMap()
    act(() => map.fire('load'))
    expect((map.styles[0] as { sprite: string }).sprite).toMatch(/\/light$/)
    expect(screen.getByRole('radio', { name: 'Light' })).toBeChecked()
  })

  it('opens in the flavour it remembers', () => {
    localStorage.setItem('activity-analysis:territory-map-flavour', 'grayscale')
    render(<TerritoryMap territory={territory} region={jonkoping} areas={areas} attribution="attr" />)
    const map = onlyMap()
    act(() => map.fire('load'))
    expect((map.styles[0] as { sprite: string }).sprite).toMatch(/\/grayscale$/)
    expect(screen.getByRole('radio', { name: 'Grey' })).toBeChecked()
  })

  it('switches flavour with a full style rebuild and remembers it apart from the route map', () => {
    render(<TerritoryMap territory={territory} region={jonkoping} areas={areas} attribution="attr" />)
    const map = onlyMap()
    act(() => map.fire('load'))
    fireEvent.click(screen.getByRole('radio', { name: 'Grey' }))
    expect((map.styles.at(-1) as { sprite: string }).sprite).toMatch(/\/grayscale$/)
    expect(map.styleOptions.at(-1)).toEqual({ diff: false })
    expect(localStorage.getItem('activity-analysis:territory-map-flavour')).toBe('grayscale')
    expect(localStorage.getItem('activity-analysis:map-flavour')).toBeNull()
  })

  it('draws the ground on plain background when no area is fetched', () => {
    render(<TerritoryMap territory={territory} region={jonkoping} areas={[]} attribution="" />)
    expect((onlyMap().styles[0] as { sources: object }).sources).toEqual({})
  })

  it('states the absence when the map cannot be built at all', () => {
    MockMap.throwOnConstruct = true
    render(<TerritoryMap territory={territory} region={jonkoping} areas={areas} attribution="attr" />)
    expect(screen.getByRole('note')).toHaveTextContent('The map could not be drawn')
  })

  it('gives up on a style failure before the first load, but not on a failed tile', async () => {
    render(<TerritoryMap territory={territory} region={jonkoping} areas={areas} attribution="attr" />)
    const map = onlyMap()
    act(() => map.fire('error', { tile: {}, sourceId: 'protomaps-west' }))
    expect(screen.queryByRole('note')).toBeNull()
    await act(async () => {
      map.fire('error', { error: new Error('style') })
      await Promise.resolve()
    })
    expect(screen.getByRole('note')).toHaveTextContent('The map could not be drawn')
    expect(map.removeCount).toBe(1)
  })
})
