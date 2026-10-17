import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import type { components } from '../api/schema'
import type { ProgressionScatterProps } from '../charts/ProgressionScatter'
import { NO_VALUE } from '../format'
import { router } from '../router'

vi.mock('../api/client', () => ({
  api: { GET: vi.fn() },
}))

/**
 * `RouteMap` is the lazy MapLibre chunk; this file checks which area the
 * view hands it, never MapLibre's drawing, the same boundary
 * `ActivityDetail.test.tsx` draws.
 */
vi.mock('../charts/RouteMap', () => ({
  default: (props: { area: { id: string } }) => <div data-testid="route-map-stub" data-area={props.area.id} />,
}))

/**
 * The scatter is stubbed so this file checks what the route view hands it,
 * which `ProgressionScatter.test.tsx`'s route block then draws.
 */
const { scatterCalls } = vi.hoisted(() => ({ scatterCalls: [] as ProgressionScatterProps[] }))
vi.mock('../charts/ProgressionScatter', () => ({
  ProgressionScatter: (props: ProgressionScatterProps) => {
    scatterCalls.push(props)
    return <div data-testid="scatter" role="img" aria-label={props.ariaLabel} />
  },
  ProgressionMark: ({ style }: { style: string }) => <span data-testid={`mark-${style}`} />,
}))

type RouteDetailResponse = components['schemas']['RouteDetail']
type RouteRun = components['schemas']['RouteRun']
type Streams = components['schemas']['Streams']
type Basemap = components['schemas']['Basemap']
type Health = components['schemas']['Health']

const ROUTE_ID = '0a1b2c3d4e5f6a7b'
const REFERENCE_ID = 'b2c3d4e5f6a7b8c9'

function run(overrides: Partial<RouteRun> & { activity_id: string }): RouteRun {
  return {
    start_time_utc: '2025-06-01T16:00:00Z',
    utc_offset_s: 7200,
    name: 'Run',
    distance_m: 7456,
    elapsed_time_s: 2400,
    speed_mps: 3.1067,
    direction: 'forward',
    eligible: true,
    ineligible_reason: null,
    rank: 2,
    is_record: false,
    ...overrides,
  }
}

/** Three runs in time order: the first a record, a reverse run, then a faster ineligible one. */
function runsFixture(): RouteRun[] {
  return [
    run({ activity_id: ROUTE_ID, start_time_utc: '2024-04-02T16:10:00Z', rank: 2, is_record: true }),
    run({
      activity_id: REFERENCE_ID,
      start_time_utc: '2025-06-01T16:00:00Z',
      // 1000 / 3.3 = 303.03 s per km, which is 5:03/km.
      speed_mps: 3.3,
      direction: 'reverse',
      rank: 1,
      is_record: true,
    }),
    run({
      activity_id: 'c3d4e5f6a7b8c9d0',
      start_time_utc: '2026-08-20T16:30:00Z',
      speed_mps: 3.6,
      eligible: false,
      ineligible_reason: 'a jump in the recorded distance',
      rank: null,
    }),
  ]
}

function detailFixture(overrides: Partial<RouteDetailResponse> = {}): RouteDetailResponse {
  const runs = runsFixture()
  return {
    route: {
      route_id: ROUTE_ID,
      name: 'Jönköping 7.4 km',
      locality: 'Jönköping',
      run_count: runs.length,
      median_distance_m: 7456,
      first_run_utc: '2024-04-02T16:10:00Z',
      last_run_utc: '2026-08-20T16:30:00Z',
      record_speed_mps: 3.3,
      record_activity_id: REFERENCE_ID,
      record_start_time_utc: '2025-06-01T16:00:00Z',
      record_utc_offset_s: 7200,
    },
    reference_activity_id: REFERENCE_ID,
    runs,
    ...overrides,
  }
}

function streamsFixture(overrides: Partial<Streams> = {}): Streams {
  const t = [0, 1, 2, 3, 4]
  return {
    activity_id: REFERENCE_ID,
    sample_count: t.length,
    t_s: t,
    distance_m: t.map((ti) => ti * 3),
    speed_mps: t.map(() => 3),
    hr_bpm: t.map(() => 160),
    cadence_spm: t.map(() => 170),
    altitude_m: t.map(() => 10),
    lat_deg: t.map((ti) => 57.75 + ti * 0.001),
    lon_deg: t.map((ti) => 14.17 + ti * 0.001),
    paused: t.map(() => false),
    outage: t.map(() => false),
    ...overrides,
  }
}

function healthFixture(): Health {
  return {
    root: '/data',
    canonical: '/data/canonical',
    derived: '/data/derived',
    counts: { activities: 1944 },
    expected_ingest_version: 2,
    expected_analysis_version: 8,
    stored_ingest_versions: [2],
    stored_analysis_versions: [8],
    stale: false,
  }
}

type ApiGetResult = Awaited<ReturnType<typeof api.GET>>

function jsonResult<T>(data: T): ApiGetResult {
  return { data, error: undefined, response: new Response() } as ApiGetResult
}

function errorResult(detail: string, status: number): ApiGetResult {
  return { data: undefined, error: { detail }, response: new Response(null, { status }) } as ApiGetResult
}

interface MockOpts {
  route?: ApiGetResult
  streams?: ApiGetResult | Promise<ApiGetResult>
  basemap?: Basemap
}

function mockApi(opts: MockOpts = {}) {
  vi.mocked(api.GET).mockImplementation((path) => {
    if (path === '/api/routes/{route_id}') return Promise.resolve(opts.route ?? jsonResult(detailFixture()))
    if (path === '/api/activities/{activity_id}/streams') {
      return Promise.resolve(opts.streams ?? jsonResult(streamsFixture()))
    }
    if (path === '/api/basemap') {
      return Promise.resolve(jsonResult(opts.basemap ?? { areas: [], attribution: 'attr' }))
    }
    return Promise.resolve(jsonResult(healthFixture()))
  })
}

/**
 * Mounts the real route tree at `/routes/<id>`, so the route's registration
 * is under test too. `before` is history the reader arrived through, oldest
 * first.
 */
function renderRouteAt(routeId: string, before: string[] = []) {
  const entries = [...before, `/routes/${routeId}`]
  const testRouter = createRouter({
    routeTree: router.routeTree,
    history: createMemoryHistory({ initialEntries: entries, initialIndex: entries.length - 1 }),
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  )
  return testRouter
}

function lastScatter(): ProgressionScatterProps {
  const props = scatterCalls.at(-1)
  if (props === undefined) throw new Error('the scatter was never drawn')
  return props
}

beforeEach(() => {
  vi.mocked(api.GET).mockReset()
  scatterCalls.length = 0
})

describe('RouteDetail', () => {
  it("titles the view with the route's name and states its run count under it", async () => {
    mockApi()
    renderRouteAt(ROUTE_ID)

    const title = await screen.findByRole('heading', { level: 1 })
    expect(title).toHaveTextContent('Jönköping 7.4 km')
    const byline = screen.getByText('3 runs')
    expect(precedes(title, byline)).toBe(true)
    // First and last run, each in its own run's local wall clock.
    expect(byline.closest('p')).toHaveTextContent('3 runs · 2 Apr 2024 to 20 Aug 2026')
  })

  it("asks for the route by the URL's id", async () => {
    mockApi()
    renderRouteAt(ROUTE_ID)

    await screen.findByRole('heading', { level: 1 })
    expect(vi.mocked(api.GET)).toHaveBeenCalledWith('/api/routes/{route_id}', {
      params: { path: { route_id: ROUTE_ID } },
    })
  })

  it('shows the record pace and the day the record run happened', async () => {
    mockApi()
    renderRouteAt(ROUTE_ID)

    const label = await screen.findByText('Record pace')
    const stat = label.closest('div')
    expect(stat).toHaveTextContent('5:03/km')
    // The record run's own offset, served on the summary: 16:00 UTC at +2.
    expect(stat).toHaveTextContent('1 Jun 2025')
    expect(stat).not.toHaveTextContent('UTC')
  })

  it("hands the scatter the route's runs verbatim, as a route", async () => {
    mockApi()
    renderRouteAt(ROUTE_ID)

    await screen.findByTestId('scatter')
    const props = lastScatter()
    expect(props.kind).toBe('route')
    if (props.kind !== 'route') throw new Error('not a route scatter')
    expect(props.runs).toEqual(runsFixture())
    expect(props.showIneligible).toBe(true)
  })

  it('says the axis is pace per km, which way is faster, and what is on it', async () => {
    // The ladder's labels are bare m:ss, so the unit has to be said here.
    mockApi()
    renderRouteAt(ROUTE_ID)

    await screen.findByTestId('scatter')
    expect(screen.getByText(/Pace per km\. Faster is lower/)).toHaveTextContent(
      'Pace per km. Faster is lower, so improvement descends. 3 runs, 2 eligible, 2 records.',
    )
  })

  it('keys the record, eligible and ineligible marks, and leaves the direction key to the chart', async () => {
    mockApi()
    renderRouteAt(ROUTE_ID)

    const key = await screen.findByRole('list', { name: 'Point styles' })
    expect(within(key).getByText('Record')).toBeInTheDocument()
    expect(within(key).getByText('Eligible')).toBeInTheDocument()
    expect(within(key).getByText('Ineligible')).toBeInTheDocument()
    expect(within(key).queryByText(/Forward|Reverse/)).toBeNull()
    expect(screen.queryByRole('list', { name: 'Directions' })).toBeNull()
  })

  it('hides the ineligible runs when the toggle is cleared', async () => {
    mockApi()
    renderRouteAt(ROUTE_ID)

    const toggle = await screen.findByRole('checkbox', { name: 'Show ineligible runs' })
    fireEvent.click(toggle)
    await waitFor(() => expect(lastScatter().showIneligible).toBe(false))
  })

  it("draws the reference run's trace as the hero, fetched by the reference run's id", async () => {
    mockApi()
    renderRouteAt(ROUTE_ID)

    const hero = await screen.findByRole('region', { name: 'Route' })
    expect(await within(hero).findByRole('img', { name: 'Route map' })).toBeInTheDocument()
    expect(vi.mocked(api.GET)).toHaveBeenCalledWith('/api/activities/{activity_id}/streams', {
      params: { path: { activity_id: REFERENCE_ID } },
    })
    expect(precedes(hero, screen.getByRole('heading', { level: 1 }))).toBe(true)
  })

  it('draws the map under the trace when a fetched area covers it', async () => {
    mockApi({ basemap: { areas: [{ id: 'sthlm', west: -180, south: -90, east: 180, north: 90 }], attribution: 'attr' } })
    renderRouteAt(ROUTE_ID)

    expect(await screen.findByTestId('route-map-stub')).toHaveAttribute('data-area', 'sthlm')
  })

  it('links the trace to the run it was drawn from', async () => {
    mockApi()
    renderRouteAt(ROUTE_ID)

    const link = await screen.findByRole('link', { name: /Map from the run on 1 Jun 2025/ })
    expect(link).toHaveAttribute('href', `/activities/${REFERENCE_ID}`)
  })

  it("states the absence in place of the hero when the reference run's grid is missing", async () => {
    mockApi({ streams: errorResult('no 1 Hz grid for this activity', 404) })
    renderRouteAt(ROUTE_ID)

    // The note first: while the grid is in flight the pending hero is also
    // a region named Route, and it is replaced once the 404 lands.
    const note = await screen.findByRole('note')
    expect(note).toHaveTextContent(/no 1 Hz grid/)
    const section = screen.getByRole('region', { name: 'Route' })
    expect(section).toContainElement(note)
    expect(within(section).queryByRole('img', { name: 'Route map' })).toBeNull()
    expect(precedes(screen.getByRole('heading', { level: 1 }), section)).toBe(true)
  })

  it('says the route is loading, in words of its own apart from the hero', async () => {
    vi.mocked(api.GET).mockImplementation((path) =>
      path === '/api/routes/{route_id}' ? new Promise<ApiGetResult>(() => undefined) : Promise.resolve(jsonResult(healthFixture())),
    )
    renderRouteAt(ROUTE_ID)

    expect(await screen.findByText('Loading the route…')).toBeInTheDocument()
    expect(screen.queryByText('Loading the map…')).toBeNull()
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  })

  it('says the map is loading while the reference run is in flight', async () => {
    mockApi({ streams: new Promise<ApiGetResult>(() => undefined) })
    renderRouteAt(ROUTE_ID)

    const hero = await screen.findByRole('region', { name: 'Route' })
    expect(within(hero).getByText('Loading the map…')).toBeInTheDocument()
  })

  it('states no record pace and no record day for a route where every run is ineligible', async () => {
    const detail = detailFixture()
    mockApi({
      route: jsonResult({
        ...detail,
        route: {
          ...detail.route,
          record_speed_mps: null,
          record_activity_id: null,
          record_start_time_utc: null,
          record_utc_offset_s: null,
        },
        runs: detail.runs.map((r) => ({ ...r, eligible: false, ineligible_reason: 'GPX-sourced', rank: null, is_record: false })),
      }),
    })
    renderRouteAt(ROUTE_ID)

    const label = await screen.findByText('Record pace')
    const stat = label.closest('div')
    if (stat === null) throw new Error('the record stat has no wrapper')
    expect(within(stat).getByText(NO_VALUE)).toBeInTheDocument()
    expect(stat).not.toHaveTextContent(/\d{4}/)
    expect(screen.getByText(/Pace per km\./)).toHaveTextContent('3 runs, 0 eligible, 0 records.')
  })

  describe('the way back', () => {
    it('floats on the hero and goes back through history when the reader came from somewhere', async () => {
      mockApi()
      const testRouter = renderRouteAt(ROUTE_ID, ['/records'])

      const hero = await screen.findByRole('region', { name: 'Route' })
      const back = await within(hero).findByRole('button', { name: 'Back' })
      fireEvent.click(back)
      await waitFor(() => expect(testRouter.state.location.pathname).toBe('/records'))
    })

    it('is a link to Records when the route view is the first entry in the session', async () => {
      mockApi()
      renderRouteAt(ROUTE_ID)

      const hero = await screen.findByRole('region', { name: 'Route' })
      expect(within(hero).getByRole('link', { name: 'Back to Records' })).toHaveAttribute('href', '/records')
    })

    it('stands at the top of the page when there is no hero to float on', async () => {
      mockApi({ streams: errorResult('no 1 Hz grid for this activity', 404) })
      renderRouteAt(ROUTE_ID)

      await screen.findByRole('note')
      const back = screen.getByRole('link', { name: 'Back to Records' })
      expect(precedes(back, screen.getByRole('heading', { level: 1 }))).toBe(true)
      expect(screen.getByRole('region', { name: 'Route' })).not.toContainElement(back)
    })
  })

  it('says there is no such route, with a way back to Records, for an unknown id', async () => {
    mockApi({ route: errorResult('No route with id nope', 404) })
    renderRouteAt('nope')

    expect(await screen.findByRole('heading', { level: 1, name: 'No such route' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to Records' })).toHaveAttribute('href', '/records')
    expect(screen.queryByTestId('scatter')).toBeNull()
  })

  it('renders any other failure as an alert rather than as an unknown route', async () => {
    mockApi({ route: errorResult('the routes table could not be read', 503) })
    renderRouteAt(ROUTE_ID)

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be read/)
    expect(screen.queryByText('No such route')).toBeNull()
  })
})

/** Whether `first` comes before `second` in document order. */
function precedes(first: Element, second: Element): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}
