import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../api/schema'
import { NO_VALUE } from '../format'
import { Records } from './Records'

type Record_ = components['schemas']['Record']
type RouteSummary = components['schemas']['RouteSummary']

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))
vi.mock('../api/client', () => ({ api: { GET: getMock } }))

/** The `/api/records` shape, with synthetic values: an even 5:00/km 5 km. */
function recordFixture(overrides: Partial<Record_> = {}): Record_ {
  return {
    distance_key: '5k',
    distance_m: 5000,
    elapsed_time_s: 1500,
    avg_hr_bpm: 160.0,
    effort_count: 155,
    activity_id: 'fastest',
    start_time_utc: '2025-10-12T16:00:00Z',
    utc_offset_s: 7200,
    name: 'Run',
    ...overrides,
  }
}

/** A route as `/api/routes` serves it, with synthetic values. */
function routeFixture(overrides: Partial<RouteSummary> = {}): RouteSummary {
  return {
    route_id: '0a1b2c3d4e5f6a7b',
    name: 'Jönköping 7.5 km',
    locality: 'Jönköping',
    run_count: 27,
    median_distance_m: 7456.1,
    first_run_utc: '2024-04-06T16:00:00Z',
    last_run_utc: '2026-08-15T16:30:00Z',
    // 1000 / 3.125 = 320 s per km, which is 5:20/km.
    record_speed_mps: 3.125,
    record_activity_id: 'fastest',
    record_start_time_utc: '2025-06-07T16:00:00Z',
    record_utc_offset_s: 7200,
    ...overrides,
  }
}

/** `/api/records` answers `items`; `/api/routes` answers `routes`, none by default. */
function mockRecords(items: Record_[], routes: RouteSummary[] = []): void {
  getMock.mockImplementation((path: string) => {
    if (path === '/api/records') return Promise.resolve({ data: { items }, error: undefined })
    if (path === '/api/routes') return Promise.resolve({ data: routes, error: undefined })
    return Promise.resolve({ data: undefined, error: { detail: `unmocked ${path}` } })
  })
}

function renderRecords() {
  const rootRoute = createRootRoute()
  const recordsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Records })
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/activities/$activityId',
    component: () => <div>detail</div>,
  })
  const routeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/routes/$routeId',
    component: () => <div>route</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([recordsRoute, detailRoute, routeRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  getMock.mockReset()
})

describe('Records', () => {
  it('shows each distance with its own time, pace, heart rate and attempt count', async () => {
    mockRecords([recordFixture()])
    renderRecords()

    const row = await screen.findByRole('listitem')
    // 1500 s is 25:00, and 5000 m in that time is 5:00/km.
    expect(within(row).getByText('25:00')).toBeInTheDocument()
    expect(within(row).getByText('5:00/km')).toBeInTheDocument()
    expect(within(row).getByText('160 bpm')).toBeInTheDocument()
    // The count says what it counts: an unlabelled 155 beside a 160 bpm is
    // two numbers the reader has to tell apart by guessing.
    expect(within(row).getByText('best of 155')).toBeInTheDocument()
  })

  it('shows the metres behind each key, so `1mi` and `half` are not codes to know', async () => {
    mockRecords([
      recordFixture({ distance_key: '1mi', distance_m: 1609.344, elapsed_time_s: 450 }),
      recordFixture({ distance_key: 'half', distance_m: 21097.5, elapsed_time_s: 7200 }),
    ])
    renderRecords()

    await screen.findByText('1 mile')
    expect(screen.getByText('Half marathon')).toBeInTheDocument()
    expect(screen.getByText('1.61 km')).toBeInTheDocument()
    expect(screen.getByText('21.10 km')).toBeInTheDocument()
  })

  it('leaves the metres off a row whose own label already states them', async () => {
    // The first meta fragment is the most-scanned position in the second
    // line, and on twelve of the nineteen keys in the real store it was the
    // label again in another unit - "5 km" over "5.00 km", "400 m" over
    // "0.40 km". The fact is kept where it is a fact and dropped where it is
    // an echo; the row above pins the keeping.
    mockRecords([
      recordFixture({ distance_key: '5k', distance_m: 5000 }),
      recordFixture({ distance_key: '400m', distance_m: 400, elapsed_time_s: 96 }),
    ])
    renderRecords()

    await screen.findByText('5 km')
    expect(screen.queryByText('5.00 km')).toBeNull()
    expect(screen.getByText('400 m')).toBeInTheDocument()
    expect(screen.queryByText('0.40 km')).toBeNull()
    // Everything else in the line survives, and the run that is left starts
    // with the date rather than with a leading separator.
    const row = screen.getAllByRole('listitem')[0] as HTMLElement
    expect(row.textContent).toBe('5 km25:0012 Oct 2025·160 bpm·best of 1555:00/km')
  })

  it('renders a distance key the label table does not list rather than dropping the row', async () => {
    // Not hypothetical: the live derived store holds nineteen keys where
    // `analysis/best_efforts.py` now defines nine, so ten of the rows on the
    // real page go through `distanceKeyLabel`'s fallback. `25k` parses to
    // "25 km", which states the distance, so the metres are the echo again;
    // a key that parses to nothing keeps them, which is the shape that needs
    // them most.
    mockRecords([
      recordFixture({ distance_key: '25k', distance_m: 25000, elapsed_time_s: 9000 }),
      recordFixture({ distance_key: 'parkrun', distance_m: 5000, elapsed_time_s: 1500 }),
    ])
    renderRecords()

    expect(await screen.findByText('25 km')).toBeInTheDocument()
    expect(screen.queryByText('25.00 km')).toBeNull()
    expect(screen.getByText('parkrun')).toBeInTheDocument()
    expect(screen.getByText('5.00 km')).toBeInTheDocument()
  })

  it('renders the rows in the order the endpoint sent them, shortest distance first', async () => {
    // The API orders by distance; this view must not re-sort by time, which
    // is a different sequence whenever an effort spans a long pause.
    mockRecords([
      recordFixture({ distance_key: '400m', distance_m: 400, elapsed_time_s: 2000 }),
      recordFixture({ distance_key: '5k', distance_m: 5000, elapsed_time_s: 1400 }),
      recordFixture({ distance_key: '10k', distance_m: 10000, elapsed_time_s: 3000 }),
    ])
    renderRecords()

    await screen.findByText('400 m')
    const rows = screen.getAllByRole('listitem')
    const expected = ['400 m', '5 km', '10 km']
    expect(rows).toHaveLength(expected.length)
    expected.forEach((label, index) => {
      const row = rows[index]
      expect(row).toBeDefined()
      expect(within(row as HTMLElement).getByText(label)).toBeInTheDocument()
    })
  })

  it('makes the whole row the link to the activity that set it', async () => {
    mockRecords([recordFixture({ activity_id: 'abc123abc123abc1' })])
    renderRecords()

    const link = await screen.findByRole('link')
    expect(link).toHaveAttribute('href', '/activities/abc123abc123abc1')
    // The row's own content is the link's accessible name, so every part of
    // it reaches a screen reader through the one target a thumb aims at.
    expect(link).toHaveTextContent('5 km')
    expect(link).toHaveTextContent('25:00')
    // Set on, in the athlete's own local wall clock: 16:00 UTC at +2 is the
    // 12th locally as well as in UTC, and the day is what this row states.
    expect(link).toHaveTextContent('12 Oct 2025')
  })

  it('flags a record whose activity recorded no offset rather than assuming home', async () => {
    // A GPX-sourced activity carries no offset, and an unknown offset makes
    // the calendar day itself uncertain, not merely the hour.
    mockRecords([recordFixture({ utc_offset_s: null })])
    renderRecords()

    expect(await screen.findByText('12 Oct 2025 UTC')).toBeInTheDocument()
  })

  it('renders a null heart rate as the no-value glyph, never a zero', async () => {
    mockRecords([recordFixture({ avg_hr_bpm: null })])
    renderRecords()

    const row = await screen.findByRole('listitem')
    expect(within(row).queryByText('0 bpm')).toBeNull()
    expect(within(row).getByText(NO_VALUE)).toBeInTheDocument()
  })

  it('states the absence rather than drawing an empty list when there are no records', async () => {
    mockRecords([])
    renderRecords()

    expect(await screen.findByText(/No records yet/i)).toBeInTheDocument()
    expect(screen.getByRole('note')).toBeInTheDocument()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('names the eligibility rule rather than leaving the numbers unexplained', async () => {
    // On the real store the fastest 400 m effort takes under a third of the
    // page's 400 m record, and a reader who found that out elsewhere
    // deserves to know why rather than distrusting the page.
    mockRecords([recordFixture()])
    renderRecords()

    await screen.findByText('5 km')
    // The page names what the flag is defined on, an advance in the
    // recorded distance, and names no cause. Examined on a real half
    // marathon: the position advanced steadily through the flagged moment
    // and the speed channel never moved, while the odometer gained nearly
    // five times the speed channel's reading in one second. The rule is
    // right; the old wording asserted a cause, and asserting the opposite
    // would be the same mistake - see `views/Records.tsx`.
    expect(screen.getByText(/jump in the recorded distance/i)).toBeInTheDocument()
    expect(screen.queryByText(/GPS jump/i)).toBeNull()
    expect(screen.getByText(/Treadmill/i)).toBeInTheDocument()
    expect(screen.getByText(/span their pauses/i)).toBeInTheDocument()
  })

  it('renders the failure as an alert when the request fails', async () => {
    getMock.mockResolvedValue({ data: undefined, error: { detail: 'DuckDB: file not found' } })
    renderRecords()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/file not found/)
  })
})

/** The `<section>` a `RowList` band names, found by its `<h2>`. */
async function findGroup(title: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { level: 2, name: title })
  const group = heading.closest('section')
  if (group === null) throw new Error(`no section around the "${title}" band`)
  return group
}

describe('Records, the Routes section', () => {
  it('lists each route by name with its run count, record pace and record date', async () => {
    mockRecords([recordFixture()], [routeFixture()])
    renderRecords()

    const routes = await findGroup('Routes')
    const row = within(routes).getByRole('listitem')
    expect(within(row).getByText('Jönköping 7.5 km')).toBeInTheDocument()
    expect(within(row).getByText('27 runs')).toBeInTheDocument()
    expect(within(row).getByText('5:20/km')).toBeInTheDocument()
    // The record run's own offset, so the day is the athlete's and carries
    // no UTC marker.
    expect(within(row).getByText('7 Jun 2025')).toBeInTheDocument()
    expect(within(row).queryByText(/UTC/)).toBeNull()
  })

  it("dates the record in the record run's own wall clock, which can be a different day from UTC", async () => {
    // 23:30 UTC at +2 is 01:30 the next morning where the athlete was.
    mockRecords(
      [recordFixture()],
      [routeFixture({ record_start_time_utc: '2025-06-07T23:30:00Z', record_utc_offset_s: 7200 })],
    )
    renderRecords()

    const routes = await findGroup('Routes')
    expect(within(routes).getByText('8 Jun 2025')).toBeInTheDocument()
  })

  it('flags the day as UTC only when the record run recorded no offset', async () => {
    mockRecords([recordFixture()], [routeFixture({ record_utc_offset_s: null })])
    renderRecords()

    const routes = await findGroup('Routes')
    expect(within(routes).getByText('7 Jun 2025 UTC')).toBeInTheDocument()
  })

  it('makes each route row the link to that route', async () => {
    mockRecords([recordFixture()], [routeFixture({ route_id: 'feedbeeffeedbeef' })])
    renderRecords()

    const routes = await findGroup('Routes')
    const link = within(routes).getByRole('link')
    expect(link).toHaveAttribute('href', '/routes/feedbeeffeedbeef')
    expect(link).toHaveTextContent('Jönköping 7.5 km')
  })

  it('keeps the rows in the order the endpoint sent them', async () => {
    // The API orders by run count, then name; the view must not re-sort.
    mockRecords(
      [recordFixture()],
      [
        routeFixture({ route_id: 'a', name: 'Jönköping 7.5 km', run_count: 27 }),
        routeFixture({ route_id: 'b', name: 'Jönköping 5.1 km', run_count: 4 }),
        routeFixture({ route_id: 'c', name: 'Jönköping 10.1 km', run_count: 3 }),
      ],
    )
    renderRecords()

    const routes = await findGroup('Routes')
    const names = within(routes)
      .getAllByRole('listitem')
      .map((row) => row.querySelector('a')?.getAttribute('href'))
    expect(names).toEqual(['/routes/a', '/routes/b', '/routes/c'])
  })

  it('shows the no-value glyph and no date for a route whose every run is ineligible', async () => {
    mockRecords(
      [recordFixture()],
      [
        routeFixture({
          record_speed_mps: null,
          record_activity_id: null,
          record_start_time_utc: null,
          record_utc_offset_s: null,
        }),
      ],
    )
    renderRecords()

    const routes = await findGroup('Routes')
    const row = within(routes).getByRole('listitem')
    expect(within(row).getByText(NO_VALUE)).toBeInTheDocument()
    expect(within(row).queryByText(/UTC/)).toBeNull()
    expect(within(row).getByText('27 runs')).toBeInTheDocument()
  })

  it('draws no Routes section when the store has no route', async () => {
    mockRecords([recordFixture()], [])
    renderRecords()

    await screen.findByText('5 km')
    expect(screen.queryByRole('heading', { name: 'Routes' })).toBeNull()
  })

  it('still lists the routes when there is no distance record', async () => {
    // The two are separate facts: a route's record needs no best effort at
    // a standard distance to exist, only an eligible run.
    mockRecords([], [routeFixture()])
    renderRecords()

    const routes = await findGroup('Routes')
    expect(within(routes).getByText('Jönköping 7.5 km')).toBeInTheDocument()
    expect(screen.getByText(/No records yet/i)).toBeInTheDocument()
  })

  it('says the routes could not be loaded, without losing the ladder above', async () => {
    getMock.mockImplementation((path: string) => {
      if (path === '/api/records') return Promise.resolve({ data: { items: [recordFixture()] }, error: undefined })
      return Promise.resolve({ data: undefined, error: { detail: 'routes table missing' } })
    })
    renderRecords()

    expect(await screen.findByRole('alert')).toHaveTextContent(/routes table missing/)
    expect(screen.getByText('5 km')).toBeInTheDocument()
  })
})
