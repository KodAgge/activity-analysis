import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../api/schema'
import type { TerritoryMapProps } from '../charts/TerritoryMap'
import type { TerritoryGrowthProps } from '../charts/TerritoryGrowth'
import { Territory } from './Territory'

type TerritoryResponse = components['schemas']['Territory']
type TerritoryRegion = components['schemas']['TerritoryRegion']
type Basemap = components['schemas']['Basemap']

const { getMock, mapCalls, growthCalls } = vi.hoisted(() => ({
  getMock: vi.fn(),
  mapCalls: [] as TerritoryMapProps[],
  growthCalls: [] as TerritoryGrowthProps[],
}))
vi.mock('../api/client', () => ({ api: { GET: getMock } }))

/** The map and the chart are stubbed: this file checks what the view hands them, their own tests how they draw. */
vi.mock('../charts/TerritoryMap', () => ({
  default: (props: TerritoryMapProps) => {
    mapCalls.push(props)
    return <div data-testid="territory-map">{props.region.name}</div>
  },
}))
vi.mock('../charts/TerritoryGrowth', () => ({
  TerritoryGrowth: (props: TerritoryGrowthProps) => {
    growthCalls.push(props)
    return <div data-testid="territory-growth" />
  },
}))

function region(id: string, name: string, area: number, claims: number): TerritoryRegion {
  return {
    region_id: id,
    name,
    locality: name,
    country: 'Sweden',
    area_m2: area,
    part_count: 1,
    claim_count: claims,
    first_claim_utc: '2024-03-10T16:20:00Z',
    last_claim_utc: '2026-05-03T09:15:00Z',
    west: 13.75,
    south: 57.65,
    east: 14.35,
    north: 57.8,
  }
}

function payload(overrides: Partial<TerritoryResponse> = {}): TerritoryResponse {
  return {
    total_area_m2: 4_750_000,
    closure_max_m: 200,
    sliver_radius_m: 15,
    counts: { outdoor_runs: 40, loop_runs: 25, claiming_runs: 3, regions: 2, parts: 3 },
    regions: [region('jkp', 'Jönköping', 3_500_000, 2), region('lks', 'Lakeside', 1_250_000, 1)],
    territory: { type: 'FeatureCollection', features: [] },
    growth: [
      {
        activity_id: 'a1',
        start_time_utc: '2024-03-10T16:20:00Z',
        utc_offset_s: 3600,
        name: null,
        region_id: 'jkp',
        enclosed_m2: 250_000,
        new_m2: 250_000,
        cumulative_m2: 250_000,
      },
      {
        activity_id: 'a2',
        start_time_utc: '2024-07-14T08:30:00Z',
        utc_offset_s: 7200,
        name: 'Run',
        region_id: 'lks',
        enclosed_m2: 1_250_000,
        new_m2: 1_250_000,
        cumulative_m2: 1_500_000,
      },
      {
        activity_id: 'a3',
        start_time_utc: '2026-05-03T09:15:00Z',
        utc_offset_s: 7200,
        name: 'Run',
        region_id: 'jkp',
        enclosed_m2: 3_250_000,
        new_m2: 3_250_000,
        cumulative_m2: 4_750_000,
      },
    ],
    ...overrides,
  }
}

const BASEMAP: Basemap = {
  areas: [{ id: 'west', west: 13.7, south: 57.7, east: 14.0, north: 57.85 }],
  attribution: 'OSM',
}

function mockApi(territory: TerritoryResponse | 'fail', basemap: Basemap | 'fail' = BASEMAP): void {
  getMock.mockImplementation((path: string) => {
    if (path === '/api/territory') {
      return Promise.resolve(
        territory === 'fail' ? { data: undefined, error: { detail: 'boom' } } : { data: territory, error: undefined },
      )
    }
    if (path === '/api/basemap') {
      return Promise.resolve(
        basemap === 'fail' ? { data: undefined, error: { detail: 'no manifest' } } : { data: basemap, error: undefined },
      )
    }
    return Promise.resolve({ data: undefined, error: { detail: `unmocked ${path}` } })
  })
}

function renderTerritory(initialPath = '/territory') {
  const rootRoute = createRootRoute()
  const territoryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/territory',
    validateSearch: (search: Record<string, unknown>) => search,
    component: Territory,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([territoryRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { ...utils, router }
}

beforeEach(() => {
  getMock.mockReset()
  mapCalls.length = 0
  growthCalls.length = 0
})

describe('Territory', () => {
  it('says it is loading while the territory is in flight', async () => {
    getMock.mockImplementation(() => new Promise(() => {}))
    renderTerritory()
    expect(await screen.findByText('Loading the territory…')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Territory' })).toBeInTheDocument()
  })

  it('states a failure as an alert', async () => {
    mockApi('fail')
    renderTerritory()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the territory: boom')
  })

  it('states an empty store as an absence that says what claims ground', async () => {
    mockApi(payload({ total_area_m2: 0, regions: [], growth: [], counts: { outdoor_runs: 4, loop_runs: 0, claiming_runs: 0, regions: 0, parts: 0 } }))
    renderTerritory()
    const note = await screen.findByRole('note')
    expect(note).toHaveTextContent('No ground claimed yet')
    expect(note).toHaveTextContent('ends within 200 m of where it started. None of the 4 outdoor runs did.')
    expect(screen.queryByTestId('territory-map')).toBeNull()
  })

  it('leads with the total, then fits the map to the largest place', async () => {
    mockApi(payload())
    renderTerritory()
    expect(await screen.findByText('4.75')).toBeInTheDocument()
    expect(await screen.findByTestId('territory-map')).toHaveTextContent('Jönköping')
    const map = mapCalls.at(-1)
    expect(map?.areas).toEqual(BASEMAP.areas)
    expect(map?.attribution).toBe('OSM')
    // Each place's pill names its ground too, shown beside the map on a desktop.
    expect(screen.getByRole('radio', { name: 'Jönköping 3.50 km²' })).toBeChecked()
  })

  it("names the place under the map, with its runs, the local days of its first and last claim, and its ground out of the whole", async () => {
    mockApi(payload())
    renderTerritory()
    await screen.findByTestId('territory-map')
    const heading = screen.getByRole('heading', { level: 2, name: 'Jönköping, Sweden' })
    const section = heading.closest('section')
    expect(section).not.toBeNull()
    // The picker and the map are inside the section the title names.
    expect(section).toContainElement(screen.getByRole('group', { name: 'Place' }))
    expect(section).toContainElement(screen.getByTestId('territory-map'))
    expect(screen.getByText(/^2 runs, /)).toHaveTextContent('2 runs, 10 Mar 2024 to 3 May 2026')
    // Each day holds on one line.
    expect(screen.getByText(/^2 runs, /).textContent).toContain('3\u00a0May\u00a02026')
    expect(section).toHaveTextContent('3.50 km²of 4.75 km²')
  })

  it('on a phone, leads with the map, its place named under it, and the total after both', async () => {
    mockApi(payload())
    renderTerritory()
    const map = await screen.findByTestId('territory-map')
    const place = screen.getByRole('heading', { level: 2, name: 'Jönköping, Sweden' })
    const title = screen.getByRole('heading', { level: 1, name: 'Territory' })
    const follows = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    expect(follows(map, place)).toBe(true)
    expect(follows(place, title)).toBe(true)
    expect(screen.getByRole('region', { name: 'Jönköping, Sweden' })).toContainElement(map)
  })

  it('moves to another place through the picker, and keeps it in the URL', async () => {
    mockApi(payload())
    const { router } = renderTerritory()
    fireEvent.click(await screen.findByRole('radio', { name: /^Lakeside / }))
    await waitFor(() => expect(router.state.location.search).toEqual({ region: 'lks' }))
    await waitFor(() => expect(mapCalls.at(-1)?.region.region_id).toBe('lks'))
    // One claim: the day once, not a range from it to itself.
    expect(screen.getByText(/^1 run, 14 Jul 2024$/)).toBeInTheDocument()
  })

  it('opens on the place the URL names', async () => {
    mockApi(payload())
    renderTerritory('/territory?region=lks')
    expect(await screen.findByTestId('territory-map')).toHaveTextContent('Lakeside')
  })

  it('falls back to the largest for a region id no longer in the payload', async () => {
    mockApi(payload())
    renderTerritory('/territory?region=gone')
    expect(await screen.findByTestId('territory-map')).toHaveTextContent('Jönköping')
  })

  it('still draws the ground, on no basemap, when the manifest fails', async () => {
    mockApi(payload(), 'fail')
    renderTerritory()
    await screen.findByTestId('territory-map')
    expect(mapCalls.at(-1)?.areas).toEqual([])
  })

  it('hands the growth chart every claiming run, marks the chosen place on it, and keys the marks', async () => {
    mockApi(payload())
    renderTerritory()
    await screen.findByTestId('territory-growth')
    expect(growthCalls.at(-1)?.growth).toHaveLength(3)
    expect(growthCalls.at(-1)?.markedRegionId).toBe('jkp')
    const heading = screen.getByRole('heading', { level: 2, name: 'Growth' })
    // The key is on the heading's line, beside it rather than inside it.
    expect(heading.parentElement?.contains(screen.getByText('2 runs in Jönköping'))).toBe(true)
  })

  it('opens the place of a step the growth chart is clicked on', async () => {
    mockApi(payload())
    const { router } = renderTerritory()
    await screen.findByTestId('territory-growth')
    act(() => growthCalls.at(-1)?.onSelectRegion?.('lks'))
    await waitFor(() => expect(router.state.location.search).toEqual({ region: 'lks' }))
    await waitFor(() => expect(growthCalls.at(-1)?.markedRegionId).toBe('lks'))
  })

  describe('on a desktop', () => {
    let desktop: { mockRestore: () => void }
    beforeEach(() => {
      desktop = vi.spyOn(window, 'matchMedia').mockImplementation(
        (query: string) =>
          ({
            matches: true,
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false,
          }) as MediaQueryList,
      )
    })
    afterEach(() => desktop.mockRestore())

    it('reads title, total and places first, then the map and the Growth section under it', async () => {
      mockApi(payload())
      renderTerritory()
      const map = await screen.findByTestId('territory-map')
      const title = screen.getByRole('heading', { level: 1, name: 'Territory' })
      const places = screen.getByRole('heading', { level: 2, name: 'Places' })
      const growth = screen.getByTestId('territory-growth')
      const follows = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      expect(follows(title, places)).toBe(true)
      expect(follows(places, map)).toBe(true)
      const growthHeading = screen.getByRole('heading', { level: 2, name: 'Growth' })
      expect(follows(map, growthHeading)).toBe(true)
      expect(follows(growthHeading, growth)).toBe(true)
      expect(screen.getAllByTestId('territory-growth')).toHaveLength(1)
      // Titled one way at both widths: a Section heading with its note,
      // not an uppercase eyebrow.
      expect(screen.getByText(/since 10 Mar 2024\.$/)).toBeInTheDocument()
      expect(screen.queryByText(/^Growth since/)).not.toBeInTheDocument()
      expect(screen.getAllByText('What counts, and why')).toHaveLength(1)
    })

    it('lists every place with its ground, and gives the chosen one its country, runs and days', async () => {
      mockApi(payload())
      renderTerritory()
      await screen.findByTestId('territory-map')
      const chosen = screen.getByRole('radio', { name: /^Jönköping 3.50 km²/ })
      expect(chosen).toBeChecked()
      expect(chosen).toHaveAccessibleName(
        'Jönköping 3.50 km² Sweden 2 runs 10 Mar 2024 to 3 May 2026'.replace(/(\d+) (\w{3}) (\d{4})/g, '$1\u00a0$2\u00a0$3'),
      )
      expect(screen.getByRole('radio', { name: 'Lakeside 1.25 km²' })).not.toBeChecked()
    })

    it('titles a single place with its name and notes its ground, runs and days', async () => {
      const one = payload()
      mockApi({ ...one, regions: one.regions.slice(0, 1) })
      renderTerritory()
      await screen.findByTestId('territory-map')
      expect(screen.getByRole('heading', { level: 2, name: 'Jönköping, Sweden' })).toBeInTheDocument()
      expect(screen.getByText(/^3.50 km² from 2 runs, /)).toHaveTextContent('3.50 km² from 2 runs, 10 Mar 2024 to 3 May 2026')
      expect(screen.queryByRole('group', { name: 'Place' })).toBeNull()
    })
  })

  it('has no picker for a single place', async () => {
    const one = payload()
    mockApi({ ...one, regions: one.regions.slice(0, 1) })
    renderTerritory()
    await screen.findByTestId('territory-map')
    expect(screen.queryByRole('group', { name: 'Place' })).toBeNull()
  })
})
