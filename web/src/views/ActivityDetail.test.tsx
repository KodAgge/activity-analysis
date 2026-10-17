import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import type uPlot from 'uplot'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import type { components } from '../api/schema'
import { paceScaleEnds } from '../charts/paceColour'
import type { StreamPanelProps } from '../charts/StreamPanel'
import type { SplitsProps } from '../components/Splits'
import { distance, duration, heartRate, NO_VALUE, pace as formatPace } from '../format'
import { router } from '../router'

vi.mock('../api/client', () => ({
  api: { GET: vi.fn() },
}))

// `cssVar` resolves a token through `getComputedStyle`, which jsdom cannot
// - see `StreamPanel.test.tsx`'s own copy of this mock. Echoing the token
// back wrapped as `var(...)`, rather than the bare name `StreamPanel.test.tsx`
// uses for a mocked canvas context, is what makes it observable here on a
// real SVG `style.stroke`: jsdom's CSSOM accepts `var(--x)`, a real CSS
// value, and silently drops a bare custom-property name, which is not one.
vi.mock('../charts/cssVar', () => ({ cssVar: (name: string) => `var(${name})` }))

/**
 * `RouteMap` is a lazy chunk (see `components/RouteHero.tsx`, which `ActivityDetail.tsx`'s hero renders),
 * so this file's job is what the view hands it - `area` above all - never
 * MapLibre's own drawing, which is `RouteMap.test.tsx`'s.
 *
 * `routeMapShouldThrow` lets one test make the component throw during
 * render, which is what a *rejected* lazy import looks like once React gets
 * to it: `React.lazy` re-throws its settled promise's rejection reason at
 * the point it tries to render the resolved component, which is
 * indistinguishable, from the error boundary's point of view, from the
 * component itself throwing. Reading the flag inside the component rather
 * than inside the `vi.mock` factory is what makes this safe to flip per
 * test: the factory runs once for the whole file (the module resolves
 * successfully exactly once, the way a real chunk that has already loaded
 * would), while the flag is read fresh on every render.
 */
const { routeMapShouldThrow } = vi.hoisted(() => ({ routeMapShouldThrow: { current: false } }))
vi.mock('../charts/RouteMap', () => ({
  default: (props: { area: { id: string } }) => {
    if (routeMapShouldThrow.current) throw new Error('Failed to fetch dynamically imported module')
    return <div data-testid="route-map-stub" data-area={props.area.id} />
  },
}))

/**
 * `ActivityDetail` renders four real `StreamPanel`s, which pull in the real
 * `uplot` package - `StreamPanel.test.tsx` mocks that package directly to
 * draw one chart in isolation, but this file's job is what `ActivityDetail`
 * decides to *hand* each panel (or an `Absent` in its place), not how uPlot
 * draws it - so the whole component is replaced with a prop-recording spy
 * instead, the same boundary `Overview.test.tsx` draws around `VolumeBars`.
 *
 * `useRealStreamPanel` is the one exception, the same per-test escape hatch
 * `routeMapShouldThrow` above is: the moment is a cross-panel behaviour -
 * hovering one panel has to move another's heading - which the prop spy
 * cannot show at all, so the one test that covers it flips this flag and
 * renders the real `StreamPanel`, over the mocked `uplot` package below
 * rather than a real canvas jsdom does not have.
 */
const { streamPanelCalls, useRealStreamPanel } = vi.hoisted(() => ({
  streamPanelCalls: [] as Record<string, unknown>[],
  useRealStreamPanel: { current: false },
}))
vi.mock('../charts/StreamPanel', async (importOriginal) => {
  const real = await importOriginal<typeof import('../charts/StreamPanel')>()
  return {
    StreamPanel: (props: Record<string, unknown>) => {
      if (useRealStreamPanel.current) {
        return <real.StreamPanel {...(props as unknown as StreamPanelProps)} />
      }
      streamPanelCalls.push(props)
      return <div data-testid={`stream-panel-${String(props['channel'])}`} />
    },
    // Rendered by this view directly in the two states where there is no
    // chart, so the section keeps the accessible name it takes from this
    // heading. The stub emits a real heading with the real id, because that
    // is precisely what the `aria-labelledby` on the section resolves
    // against - a `<div>` here would let the naming break silently.
    StreamPanelHeading: (props: Record<string, unknown>) => {
      // The real `CHANNEL_LABEL`, inline rather than a module-level const:
      // a `vi.mock` factory is hoisted, so referring out to one risks
      // reading it before initialisation.
      const labels: Record<string, string> = {
        pace: 'Pace',
        hr: 'Heart rate',
        cadence: 'Cadence',
        elevation: 'Elevation',
      }
      const channel = String(props['channel'])
      return (
        <h2 id={props['headingId'] === undefined ? undefined : String(props['headingId'])}>
          {labels[channel] ?? channel}
        </h2>
      )
    },
  }
})

/**
 * The moment's own cross-panel test renders the real `StreamPanel`, which
 * builds a real `UPlot` on top of the real `uplot` package - mocked here the
 * same way `StreamPanel.test.tsx` mocks it, since jsdom has no canvas for
 * the real one to draw into. `instances` is what that test fires a
 * `setCursor` hook through, standing in for a real pointer move.
 */
const { uPlotInstances, MockUPlot } = vi.hoisted(() => {
  class MockUPlot {
    static paths = { bars: () => undefined }
    opts: uPlot.Options
    data: uPlot.AlignedData
    setData = () => {}
    setSize = () => {}
    destroy = () => {}
    cursor = { idx: null as number | null, left: -10 }
    setCursor = () => {}
    valToPos = (v: number) => v
    posToIdx = (left: number) => Math.round(left)
    over = document.createElement('div')
    constructor(opts: uPlot.Options, data: uPlot.AlignedData) {
      this.opts = opts
      this.data = data
      uPlotInstances.push(this)
    }
  }
  const uPlotInstances: InstanceType<typeof MockUPlot>[] = []
  return { uPlotInstances, MockUPlot }
})
vi.mock('uplot', () => ({ default: MockUPlot }))
vi.mock('uplot/dist/uPlot.min.css', () => ({}))

/** Same reasoning as `StreamPanel` above: `Splits`' own interval and per-km logic is `Splits.test.tsx`'s job. This file only checks what it is handed. */
const { splitsCalls } = vi.hoisted(() => ({ splitsCalls: [] as SplitsProps[] }))
vi.mock('../components/Splits', () => ({
  Splits: (props: SplitsProps) => {
    splitsCalls.push(props)
    return <div data-testid="splits-stub" />
  },
}))

type ActivityDetailResponse = components['schemas']['ActivityDetail']
type ActivitySummary = components['schemas']['ActivitySummary']
type Lap = components['schemas']['Lap']
type DerivedBlocks = components['schemas']['DerivedBlocks']
type Streams = components['schemas']['Streams']
type Health = components['schemas']['Health']
type Basemap = components['schemas']['Basemap']
type ActivityRoute = components['schemas']['ActivityRoute']

/** The fixture `6116b2e90f551a6c` summary (2026-08-25, the interval session) - fetched from a running server, see the task report. */
function summaryFixture(overrides: Partial<ActivitySummary> = {}): ActivitySummary {
  return {
    activity_id: '6116b2e90f551a6c',
    start_time_utc: '2026-08-25T15:41:23Z',
    utc_offset_s: 7200,
    sport: 'running',
    recorded_sport: 'running',
    sub_sport: 'generic',
    name: 'Run',
    distance_m: 9234.22,
    elapsed_time_s: 3711.567,
    timer_time_s: 3334.583,
    moving_time_s: 3318.0,
    ascent_m: 21.0,
    descent_m: 29.0,
    avg_speed_mps: 2.769,
    max_speed_mps: 4.273,
    avg_hr_bpm: 165.0,
    max_hr_bpm: 196.0,
    avg_cadence_spm: 151.203125,
    calories: 821.0,
    source: 'strava_fit',
    pr_distance_keys: [],
    ...overrides,
  }
}

/** A synthetic run with no heart rate at all, the shape a recording without a strap takes. */
function noHeartRateSummaryFixture(overrides: Partial<ActivitySummary> = {}): ActivitySummary {
  return {
    activity_id: 'feed000000000001',
    start_time_utc: '2026-01-10T12:00:00Z',
    utc_offset_s: 3600,
    sport: 'running',
    recorded_sport: 'running',
    sub_sport: 'generic',
    name: null,
    distance_m: 5000.0,
    elapsed_time_s: 1500.0,
    timer_time_s: 1500.0,
    moving_time_s: 1500.0,
    ascent_m: 15.0,
    descent_m: 15.0,
    avg_speed_mps: null,
    max_speed_mps: null,
    avg_hr_bpm: null,
    max_hr_bpm: null,
    avg_cadence_spm: 160.0,
    calories: 400.0,
    source: 'strava_fit',
    pr_distance_keys: [],
    ...overrides,
  }
}

/** A synthetic cycling activity - not running, so `derived` is null. */
function cyclingSummaryFixture(overrides: Partial<ActivitySummary> = {}): ActivitySummary {
  return {
    activity_id: 'feed000000000002',
    start_time_utc: '2026-01-12T12:00:00Z',
    utc_offset_s: 3600,
    sport: 'cycling',
    recorded_sport: 'cycling',
    sub_sport: 'generic',
    name: 'Bike',
    distance_m: 3000.0,
    elapsed_time_s: 1000.0,
    timer_time_s: 1000.0,
    moving_time_s: null,
    ascent_m: 10.0,
    descent_m: 10.0,
    avg_speed_mps: 3.0,
    max_speed_mps: 7.0,
    avg_hr_bpm: 90.0,
    max_hr_bpm: 120.0,
    avg_cadence_spm: null,
    calories: 75.0,
    source: 'strava_fit',
    pr_distance_keys: [],
    ...overrides,
  }
}

/** The cycling activity's single lap, the whole session. */
function cyclingLapFixture(): Lap {
  return {
    lap_index: 0,
    start_time_utc: '2026-01-12T12:00:00Z',
    trigger: 'session_end',
    elapsed_time_s: 1000.0,
    distance_m: 3000.0,
    avg_speed_mps: 3.0,
    avg_hr_bpm: 90.0,
    max_hr_bpm: 120.0,
    avg_cadence_spm: null,
    ascent_m: 10.0,
    descent_m: 10.0,
    calories: 75.0,
  }
}

function derivedFixture(overrides: Partial<DerivedBlocks> = {}): DerivedBlocks {
  return {
    metrics: {
      elapsed_time_s: 3713.0,
      moving_time_s: 3318.0,
      paused_time_s: 395.0,
      distance_m: 9234.22,
      ascent_per_km_m: 2.27,
      is_indoor: false,
      has_hr: true,
      has_gps: true,
      is_gpx_sourced: false,
      locality: 'Jönköping',
      country_code: 'SE',
      country: 'Sweden',
      locality_distance_m: 3504,
    },
    zones: [
      { zone_index: 0, low_bpm: null, high_bpm: 104, seconds_s: 49 },
      { zone_index: 1, low_bpm: 104, high_bpm: 124, seconds_s: 210 },
      { zone_index: 2, low_bpm: 124, high_bpm: 145, seconds_s: 382 },
      { zone_index: 3, low_bpm: 145, high_bpm: 166, seconds_s: 921 },
      { zone_index: 4, low_bpm: 166, high_bpm: 186, seconds_s: 925 },
      { zone_index: 5, low_bpm: 186, high_bpm: 207, seconds_s: 832 },
      { zone_index: 6, low_bpm: 207, high_bpm: null, seconds_s: 0 },
    ],
    best_efforts: [],
    tags: [
      {
        kind: 'effort',
        tag: 'intervals',
        distance_key: null,
        rep_count: 5,
        // The real reason string, verbatim, ASCII apostrophe included - an
        // earlier version of this fixture used a U+2019 the server never
        // sends.
        rep_pattern: '-WRWRWRWRWR---',
        reason: "5 recorded reps, faster than the run's average, each beside a recovery (-WRWRWRWRWR---)",
      },
    ],
    // An intervals session, which the efficiency fit leaves out, so the API
    // serves no decoupling and says why.
    decoupling: null,
    decoupling_absent_reason: 'An interval session, which the efficiency fit leaves out.',
    ...overrides,
  }
}

function lapFixture(overrides: Partial<Lap> & { lap_index: number }): Lap {
  return {
    start_time_utc: '2026-08-25T15:41:23Z',
    trigger: 'distance',
    elapsed_time_s: 300,
    distance_m: 1000,
    avg_speed_mps: 3.3,
    avg_hr_bpm: 160,
    max_hr_bpm: 170,
    avg_cadence_spm: 170,
    ascent_m: 2,
    descent_m: 1,
    calories: 70,
    ...overrides,
  }
}

/** The real detail shape checked against a running server - see the task report. */
function detailFixture(overrides: Partial<ActivityDetailResponse> = {}): ActivityDetailResponse {
  return {
    summary: summaryFixture(),
    laps: [lapFixture({ lap_index: 0 }), lapFixture({ lap_index: 1, trigger: 'session_end' })],
    derived: derivedFixture(),
    derived_absent_reason: null,
    reclassification: null,
    route: null,
    ...overrides,
  }
}

function streamsFixture(overrides: Partial<Streams> = {}): Streams {
  const t = [0, 1, 2, 3, 4]
  return {
    activity_id: '6116b2e90f551a6c',
    sample_count: t.length,
    t_s: t,
    distance_m: t.map((ti) => ti * 3),
    speed_mps: t.map(() => 3),
    hr_bpm: t.map(() => 160),
    cadence_spm: t.map(() => 170),
    altitude_m: t.map(() => 10),
    lat_deg: t.map(() => 57.77),
    lon_deg: t.map(() => 14.18),
    paused: t.map(() => false),
    outage: t.map(() => false),
    ...overrides,
  }
}

/** The `<section>` around a mocked stream panel, found from the panel's own test id. */
function paceSectionOf(panel: HTMLElement): HTMLElement {
  const section = panel.closest('section')
  if (section === null) throw new Error('the pace panel is not inside a section')
  return section
}

/**
 * The expected and stored analysis versions only need to agree with each other.
 * The value is deliberately not tied to `config.py`'s `ANALYSIS_VERSION`, so a version bump does not stale this fixture.
 */
function healthFixture(overrides: Partial<Health> = {}): Health {
  return {
    root: '/data',
    canonical: '/data/canonical',
    derived: '/data/derived',
    counts: { activities: 1944 },
    expected_ingest_version: 2,
    expected_analysis_version: 4,
    stored_ingest_versions: [2],
    stored_analysis_versions: [4],
    stale: false,
    ...overrides,
  }
}

/** No fetched areas - `activity-analysis tiles` never ran - which is what makes every hero draw the bare trace by default. */
function basemapFixture(overrides: Partial<Basemap> = {}): Basemap {
  return {
    areas: [],
    attribution: 'attr',
    ...overrides,
  }
}

type ApiGetResult = Awaited<ReturnType<typeof api.GET>>

function jsonResult<T>(data: T): ApiGetResult {
  return { data, error: undefined, response: new Response() } as ApiGetResult
}

function errorResult(detail: string, status = 404): ApiGetResult {
  return {
    data: undefined,
    error: { detail },
    response: new Response(null, { status }),
  } as ApiGetResult
}

interface MockOpts {
  detail?: ActivityDetailResponse
  streams?: ApiGetResult
  health?: Health
  basemap?: ApiGetResult
}

function mockApi(opts: MockOpts = {}) {
  vi.mocked(api.GET).mockImplementation((path) => {
    if (path === '/api/activities/{activity_id}') return Promise.resolve(jsonResult(opts.detail ?? detailFixture()))
    if (path === '/api/activities/{activity_id}/streams') {
      return Promise.resolve(opts.streams ?? jsonResult(streamsFixture()))
    }
    if (path === '/api/basemap') return Promise.resolve(opts.basemap ?? jsonResult(basemapFixture()))
    return Promise.resolve(jsonResult(opts.health ?? healthFixture()))
  })
}

/**
 * Mounts the real route tree at `/activities/<id>`, exercising the real
 * `getRouteApi('/activities/$activityId')` param resolution rather than a
 * hand-rolled stand-in.
 *
 * `precedingEntries` are history entries the reader would have visited
 * before this one. The default - none - is the shareable-URL case: a fresh
 * tab, a bookmark, a pasted link or a reload, where the detail view is the
 * first entry in the session and there is nothing to go back to.
 */
function renderActivityDetailAt(activityId: string, precedingEntries: string[] = []) {
  const testRouter = createRouter({
    routeTree: router.routeTree,
    history: createMemoryHistory({ initialEntries: [...precedingEntries, `/activities/${activityId}`] }),
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  )
  return testRouter
}

/**
 * The pending `/api/basemap` override for the next `renderDetail()` call, so
 * `mockBasemap`/`mockBasemapError` can be called before rendering without
 * also having to restate the detail and streams fixtures every other test
 * in this file already relies on `mockApi`'s own defaults for.
 */
let basemapOverride: ApiGetResult | undefined

/** `mockBasemap({ areas: [...], attribution })` before the next `renderDetail()`. */
function mockBasemap(basemap: Basemap): void {
  basemapOverride = jsonResult(basemap)
}

/** A failed `/api/basemap` fetch before the next `renderDetail()`. */
function mockBasemapError(): void {
  basemapOverride = errorResult('could not read the fetched map areas', 503)
}

/**
 * `renderActivityDetailAt` against the fixture activity whose trace has
 * GPS (`6116b2e90f551a6c`), with the detail and streams mocks at their
 * usual defaults and `/api/basemap` at whatever `mockBasemap`/
 * `mockBasemapError` set for this test, or no fetched areas otherwise.
 */
function renderDetail() {
  mockApi({ basemap: basemapOverride })
  return renderActivityDetailAt('6116b2e90f551a6c')
}

/**
 * The way back's name as a link, its shape when the view is the first entry
 * in the session, as every render here is unless it passes more history -
 * see `components/BackControl.tsx`.
 */
const BACK_LABEL = 'Back to activities'

/**
 * Whether `first` comes before `second` in the rendered document.
 *
 * Document order is what several of the decisions on this screen actually
 * are - the route hero opens the page and the title reads under it, and a
 * run with no trace states that where a section would be, *after* the
 * title - so the tests for them have to assert order rather than mere
 * presence.
 */
function precedes(first: Element, second: Element): boolean {
  const inOrder = Array.from(document.querySelectorAll('*'))
  return inOrder.indexOf(first) < inOrder.indexOf(second)
}

/** The value in the header's stat `<dl>` next to the given `<dt>` label. */
function statValue(label: string): string {
  // Scoped to `<dt>`: the route hero's pace legend can carry the same word
  // in its own `<figcaption>` (see "the hero legend" below), and an
  // unscoped match would then be ambiguous.
  const dt = screen.getByText(label, { selector: 'dt' })
  const wrapper = dt.closest('div')
  if (wrapper === null) throw new Error(`no wrapper for "${label}"`)
  const dd = wrapper.querySelector('dd')
  if (dd === null) throw new Error(`no value rendered for "${label}"`)
  return dd.textContent ?? ''
}

beforeEach(() => {
  vi.mocked(api.GET).mockReset()
  streamPanelCalls.length = 0
  splitsCalls.length = 0
  basemapOverride = undefined
  routeMapShouldThrow.current = false
  useRealStreamPanel.current = false
  uPlotInstances.length = 0
})

describe('ActivityDetail', () => {
  it("shows the header's tag and its reasoning, read from derived.tags", async () => {
    mockApi()
    renderActivityDetailAt('6116b2e90f551a6c')

    await screen.findByText('Intervals')
    expect(
      screen.getByText("5 recorded reps, faster than the run's average, each beside a recovery (-WRWRWRWRWR---)"),
    ).toBeInTheDocument()
  })

  it('shows no tag at all for a run with no effort tag - the 86-of-307 case - rather than guessing one', async () => {
    // A run with no heart rate gets no effort tag and can still carry
    // PR flags. `classify_effort` declined to guess, and this view must
    // not paper over that with an invented label.
    mockApi({
      detail: detailFixture({
        summary: noHeartRateSummaryFixture(),
        laps: [],
        derived: derivedFixture({
          metrics: {
            elapsed_time_s: 1500,
            moving_time_s: 1500,
            paused_time_s: 0,
            distance_m: 5000,
            ascent_per_km_m: 3.0,
            is_indoor: false,
            has_hr: false,
            has_gps: true,
            is_gpx_sourced: false,
            locality: 'Jönköping',
            country_code: 'SE',
            country: 'Sweden',
            locality_distance_m: 2000,
          },
          zones: [],
          tags: [
            {
              kind: 'flag',
              tag: 'pr',
              distance_key: '1mi',
              rep_count: null,
              rep_pattern: null,
              reason: '1mi in 8:00, beating 8:30 over 3 earlier efforts',
            },
          ],
        }),
      }),
    })
    renderActivityDetailAt('feed000000000001')

    await screen.findByText('PR')
    for (const label of ['Easy', 'Steady', 'Intervals', 'All out']) {
      expect(screen.queryByText(label)).toBeNull()
    }
    // Not just "none of these four labels appear" - no effort badge of any
    // kind is rendered at all. A flag row mistakenly promoted to the
    // effort slot would print raw tag text ("pr") rather than any of the
    // four labels above and slip past that loop undetected.
    expect(screen.queryByLabelText('Automatic effort tag')).toBeNull()
  })

  it('keeps the route panel and explains itself for a treadmill run (has_gps: false) instead of drawing an empty map', async () => {
    mockApi({
      detail: detailFixture({
        summary: summaryFixture({ activity_id: 'feed000000000003', sub_sport: 'treadmill', name: 'Treadmill', ascent_m: null, descent_m: null }),
        derived: derivedFixture({
          metrics: {
            elapsed_time_s: 2400,
            moving_time_s: 2400,
            paused_time_s: 0,
            distance_m: 7000,
            ascent_per_km_m: null,
            is_indoor: true,
            has_hr: true,
            has_gps: false,
            is_gpx_sourced: false,
            // A treadmill run has no position, so no place. All four null
            // together is the shape the derived layer writes.
            locality: null,
            country_code: null,
            country: null,
            locality_distance_m: null,
          },
        }),
      }),
      streams: jsonResult(streamsFixture({ lat_deg: [null, null, null, null, null], lon_deg: [null, null, null, null, null] })),
    })
    renderActivityDetailAt('feed000000000003')

    const routeSection = await screen.findByRole('region', { name: 'Route' })
    expect(within(routeSection).getByText(/footpod rather than GPS/)).toBeInTheDocument()
    // Not just absent text somewhere on the page - the route panel itself
    // (its section) is what is present and self-explaining.
    expect(within(routeSection).queryByRole('img', { name: 'Route map' })).toBeNull()
    // The treadmill's own null ascent renders the no-value glyph, not "0 m".
    expect(statValue('Ascent')).toBe(NO_VALUE)
  })

  it('renders no derived panels for a non-running activity and states why, from derived_absent_reason', async () => {
    const reason =
      'the derived layer covers running only and this activity is not recorded as a run, so it has no metrics, zone distribution or best efforts'
    mockApi({
      detail: detailFixture({
        summary: cyclingSummaryFixture(),
        laps: [cyclingLapFixture()],
        derived: null,
        derived_absent_reason: reason,
      }),
      streams: errorResult(`no 1 Hz grid for feed000000000002: ${reason}`),
    })
    renderActivityDetailAt('feed000000000002')

    await screen.findByText(reason)
    expect(screen.queryByRole('region', { name: 'Route' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Heart rate zones' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Splits' })).toBeNull()
    expect(streamPanelCalls).toHaveLength(0)
    expect(splitsCalls).toHaveLength(0)
    // The cycling activity's own null `moving_time_s` (the derived
    // layer covers running only, so this field is never populated for it)
    // renders the no-value glyph, never "0:00".
    expect(statValue('Moving time')).toBe(NO_VALUE)
    expect(statValue('Cadence')).toBe(NO_VALUE)
  })

  it('says under the header when a run is counted as a walk, with both paces', async () => {
    // A run recorded on the running profile at 12:00/km moving, against the
    // 9:00/km threshold.
    const reason =
      'this activity was recorded as a run but is counted as a walk, its moving pace being slower than 9:00/km, so it has no metrics, zone distribution or best efforts'
    mockApi({
      detail: detailFixture({
        summary: summaryFixture({ sport: 'walking', recorded_sport: 'running' }),
        derived: null,
        derived_absent_reason: reason,
        reclassification: {
          recorded_sport: 'running',
          sport: 'walking',
          avg_speed_mps: 1000 / 720,
          threshold_mps: 1000 / 540,
        },
      }),
      streams: errorResult(`no 1 Hz grid for 6116b2e90f551a6c: ${reason}`),
    })
    renderActivityDetailAt('6116b2e90f551a6c')

    expect(
      await screen.findByText(
        'Recorded as a run, counted as a walk: its moving pace of 12:00/km is slower than 9:00/km.',
      ),
    ).toBeInTheDocument()
  })

  it('says nothing about sport for an activity counted as what it was recorded as', async () => {
    mockApi({ detail: detailFixture(), streams: streamsFixture() })
    renderActivityDetailAt('6116b2e90f551a6c')

    await screen.findAllByText(formatPace(summaryFixture().avg_speed_mps))
    expect(screen.queryByText(/counted as a/)).toBeNull()
  })

  it('renders an explanation instead of a blank panel when the streams endpoint 404s', async () => {
    mockApi({
      streams: errorResult('no 1 Hz grid for 6116b2e90f551a6c: this run has none, so recompute has not been run since it was ingested'),
    })
    renderActivityDetailAt('6116b2e90f551a6c')

    const routeSection = await screen.findByRole('region', { name: 'Route' })
    expect(within(routeSection).getByText(/recompute has not been run/)).toBeInTheDocument()
    // A 404 is a stated absence, never a failure - see M9 below.
    expect(within(routeSection).getByRole('note')).toBeInTheDocument()
    expect(within(routeSection).queryByRole('alert')).toBeNull()
    // The per-km tab is told the same reason rather than being handed a
    // silent null with nothing to say about it.
    expect(splitsCalls.at(-1)?.streamsAbsentReason).toMatch(/recompute has not been run/)
    expect(splitsCalls.at(-1)?.streamsFailureReason).toBeNull()
    expect(splitsCalls.at(-1)?.streams).toBeNull()
  })

  it('renders a failure, not a stated absence, when the streams request fails for a reason other than 404 (M9)', async () => {
    // The exact defect the final review found: a stopped server mid-page
    // (a 503, here) used to read as calmly as a genuine 404 - a dashed
    // "this is absent" note with role="note" - while the page's own
    // detail-query failure renders role="alert" for the same class of
    // problem. This is the same request failing for a different reason,
    // and it must read as a failure too.
    mockApi({
      streams: errorResult("DuckDB: file not found, run 'recompute'", 503),
    })
    renderActivityDetailAt('6116b2e90f551a6c')

    const routeSection = await screen.findByRole('region', { name: 'Route' })
    expect(within(routeSection).getByRole('alert')).toHaveTextContent(/file not found/)
    expect(within(routeSection).queryByRole('note')).toBeNull()

    // Named from its own visible heading now, not from an `aria-label` that
    // only a screen reader could see - so this assertion also proves the
    // chart is labelled on screen.
    const paceSection = screen.getByRole('region', { name: 'Pace' })
    expect(within(paceSection).getByRole('alert')).toHaveTextContent(/file not found/)

    // The per-km tab reads the same failure, and not as an absence.
    expect(splitsCalls.at(-1)?.streamsFailureReason).toMatch(/file not found/)
    expect(splitsCalls.at(-1)?.streamsAbsentReason).toBeNull()
    expect(splitsCalls.at(-1)?.streams).toBeNull()
  })

  it("passes each stream panel the mean of its own trace, not the summary's average", async () => {
    // The line is drawn over the trace, so it is the trace's mean. The fixture's
    // summary says 2.769 m/s, 165 bpm and 151.2 spm; its streams say
    // something else, with a paused second the mean must skip.
    mockApi({
      streams: jsonResult(
        streamsFixture({
          speed_mps: [3, 3, 9, 4, 4],
          hr_bpm: [150, 160, null, 170, 190],
          cadence_spm: [170, 172, null, 174, 176],
          paused: [false, false, true, false, false],
        }),
      ),
    })
    renderActivityDetailAt('6116b2e90f551a6c')
    await screen.findByTestId('stream-panel-pace')

    const byChannel = new Map(streamPanelCalls.map((call) => [call['channel'], call]))
    expect(byChannel.get('pace')?.['average']).toBe(3.5)
    expect(byChannel.get('hr')?.['average']).toBe(167.5)
    expect(byChannel.get('cadence')?.['average']).toBe(173)
    expect(byChannel.get('pace')?.['values']).toEqual([3, 3, 9, 4, 4])
  })

  it("says under the pace panel why its line differs from the header's Pace", async () => {
    // Default fixtures: the trace is a flat 3 m/s (5:33/km), the summary
    // 2.769 m/s (6:01/km) over 3318 s and 9234.22 m, outdoors.
    mockApi()
    renderActivityDetailAt('6116b2e90f551a6c')
    const paceSection = paceSectionOf(await screen.findByTestId('stream-panel-pace'))
    expect(
      within(paceSection).getByText(
        "The line averages the watch's speed reading, which covers 9.95 km in the moving time; the 6:01/km pace above uses the run's 9.23 km.",
      ),
    ).toBeVisible()
  })

  it("names Strava's session total on a treadmill", async () => {
    mockApi({
      detail: detailFixture({
        derived: derivedFixture({ metrics: { ...derivedFixture().metrics, is_indoor: true, has_gps: false } }),
      }),
    })
    renderActivityDetailAt('6116b2e90f551a6c')
    const paceSection = paceSectionOf(await screen.findByTestId('stream-panel-pace'))
    expect(within(paceSection).getByText(/uses Strava's 9\.23 km session total\.$/)).toBeVisible()
  })

  it('shows no note when the line and the header format to the same pace', async () => {
    mockApi({ streams: jsonResult(streamsFixture({ speed_mps: [2.769, 2.769, 2.769, 2.769, 2.769] })) })
    renderActivityDetailAt('6116b2e90f551a6c')
    const paceSection = paceSectionOf(await screen.findByTestId('stream-panel-pace'))
    expect(within(paceSection).queryByText(/The line averages/)).toBeNull()
  })

  it('gives the elevation panel the altitude stream and no reference line', async () => {
    // Added on the maintainer's instruction of 2026-09-02 as its own panel
    // beside the other three. `altitude_m` was already on the streams response, so
    // this needed no API change at all.
    mockApi()
    renderActivityDetailAt('6116b2e90f551a6c')
    await screen.findByTestId('stream-panel-elevation')

    const call = streamPanelCalls.find((c) => c['channel'] === 'elevation')
    if (call === undefined) throw new Error('expected an elevation StreamPanel call')
    expect(call['values']).toEqual(streamsFixture().altitude_m)

    // No average, deliberately: a mean altitude is not a quantity anybody
    // trains against, and a flat line through the middle of a terrain
    // profile would read as a target rather than as arithmetic. Ascent is
    // the number that matters and it is in the stat rail already.
    expect(call['average']).toBeNull()
  })

  it('places the decoupling section after Time in zone and before the stream panels', async () => {
    mockApi({
      detail: detailFixture({
        derived: derivedFixture({
          decoupling: {
            decoupling_pct: 13.076,
            first_half_speed_mps: 2.5574,
            second_half_speed_mps: 2.4451,
            first_half_hr_bpm: 148.41,
            second_half_hr_bpm: 163.24,
            is_aerobic_long_run: true,
            outside_population_reason: null,
          },
          decoupling_absent_reason: null,
        }),
      }),
    })
    renderActivityDetailAt('6116b2e90f551a6c')
    const section = await screen.findByRole('region', { name: 'Aerobic decoupling' })
    expect(within(section).getByText('+13.1%')).toBeInTheDocument()
    const zones = screen.getByRole('region', { name: 'Time in zone' })
    const pacePanel = await screen.findByTestId('stream-panel-pace')
    expect(precedes(zones, section)).toBe(true)
    expect(precedes(section, pacePanel)).toBe(true)
  })

  it('keeps the decoupling section for a run with no value, and states why', async () => {
    mockApi()
    renderActivityDetailAt('6116b2e90f551a6c')
    const section = await screen.findByRole('region', { name: 'Aerobic decoupling' })
    expect(within(section).getByRole('note')).toHaveTextContent('An interval session, which the efficiency fit leaves out.')
  })

  it('draws the four stream panels in a fixed order, elevation last', async () => {
    mockApi()
    renderActivityDetailAt('6116b2e90f551a6c')
    await screen.findByTestId('stream-panel-elevation')

    // Read off the rendered document rather than the call list, so a
    // reordering of the JSX is what this catches - the call order alone
    // would also pass on a page that rendered them in some other order.
    const rendered = Array.from(document.querySelectorAll('[data-testid^="stream-panel-"]'), (el) =>
      el.getAttribute('data-testid'),
    )
    expect(rendered).toEqual([
      'stream-panel-pace',
      'stream-panel-hr',
      'stream-panel-cadence',
      'stream-panel-elevation',
    ])
  })

  describe('the time axis', () => {
    /** Answers the desktop layout's query as a window at or past 60rem would. */
    function atDesktopWidth() {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === '(min-width: 60rem)',
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }))
    }
    afterEach(() => {
      vi.unstubAllGlobals()
    })
    const timeAxisByChannel = () =>
      Object.fromEntries(streamPanelCalls.map((call) => [String(call['channel']), call['timeAxis']]))

    it('is drawn by the bottom panel alone beside the pinned desktop hero', async () => {
      atDesktopWidth()
      mockApi()
      renderActivityDetailAt('6116b2e90f551a6c')
      await screen.findByTestId('stream-panel-elevation')
      expect(timeAxisByChannel()).toEqual({ pace: false, hr: false, cadence: false, elevation: true })
    })

    it('moves up to the last panel with a chart when the bottom one has nothing to draw', async () => {
      // A run with no altitude recorded: elevation shows its absence, so
      // without this the stack would have no time axis at all.
      atDesktopWidth()
      mockApi({ streams: jsonResult(streamsFixture({ altitude_m: [null, null, null, null, null] })) })
      renderActivityDetailAt('6116b2e90f551a6c')
      await screen.findByTestId('stream-panel-elevation')
      expect(timeAxisByChannel()).toEqual({ pace: false, hr: false, cadence: true, elevation: false })
    })

    it('is drawn by every panel on a phone', async () => {
      // The test setup's own `matchMedia` answers no to every query.
      mockApi()
      renderActivityDetailAt('6116b2e90f551a6c')
      await screen.findByTestId('stream-panel-elevation')
      expect(timeAxisByChannel()).toEqual({ pace: true, hr: true, cadence: true, elevation: true })
    })

    it('is drawn by every panel on desktop when there is no hero to pin', async () => {
      atDesktopWidth()
      const noPosition = [null, null, null, null, null]
      mockApi({ streams: jsonResult(streamsFixture({ lat_deg: noPosition, lon_deg: noPosition })) })
      renderActivityDetailAt('6116b2e90f551a6c')
      // No position at all, so the route is stated absent in its own
      // section under the title and there is no hero.
      await screen.findByTestId('stream-panel-elevation')
      expect(screen.getByText('No GPS route recorded for this activity.')).toBeInTheDocument()
      expect(timeAxisByChannel()).toEqual({ pace: true, hr: true, cadence: true, elevation: true })
    })
  })

  it('opens on the route, above the title, with the way back floating over it', async () => {
    // The screen's whole shape: the trace is the hero and the title block
    // reads underneath it, which is what makes this the activity's picture
    // rather than a chart in a document. The route panel used to share a
    // row with the zone table, to fill the 584px of horizontal emptiness a
    // letterboxed trace left beside it; a full-bleed hero at the trace's
    // own clamped ratio has no such hole, so the zones stand alone again.
    mockApi()
    renderActivityDetailAt('6116b2e90f551a6c')

    const route = await screen.findByRole('region', { name: 'Route' })
    expect(within(route).getByRole('img', { name: 'Route map' })).toBeInTheDocument()

    expect(precedes(route, screen.getByRole('heading', { level: 1 }))).toBe(true)

    // The way back rides on the hero, which is where the reference puts it
    // and the only place it can be on a screen with no chrome bar.
    expect(within(route).getByLabelText(BACK_LABEL)).toBeInTheDocument()

    // And the zone distribution is its own region, not a column of the
    // route's.
    const zones = screen.getByRole('region', { name: 'Time in zone' })
    expect(route.contains(zones)).toBe(false)
  })

  it('gives a run with no trace no hero at all, and states the absence below the title instead', async () => {
    // A hero-sized box saying "no GPS route recorded" would spend the most
    // valuable block on the screen on the absence of its own subject. The
    // route section stays, at the page gutter, under the title - and the
    // way back moves into the flow with it rather than floating on nothing.
    mockApi({
      streams: jsonResult(
        streamsFixture({ lat_deg: [null, null, null, null, null], lon_deg: [null, null, null, null, null] }),
      ),
    })
    renderActivityDetailAt('6116b2e90f551a6c')

    const route = await screen.findByRole('region', { name: 'Route' })
    expect(precedes(screen.getByRole('heading', { level: 1 }), route)).toBe(true)
    expect(within(route).queryByLabelText(BACK_LABEL)).toBeNull()
    expect(screen.getByLabelText(BACK_LABEL)).toBeInTheDocument()
    expect(within(route).getByText(/No GPS route recorded/)).toBeInTheDocument()
  })

  describe('the hero legend', () => {
    it("gives the legend the run's two end paces", async () => {
      const t = Array.from({ length: 100 }, (_, i) => i)
      const speed = t.map((i) => 2 + (i / 99) * 2)
      const paused = t.map(() => false)
      const outage = t.map(() => false)
      mockApi({
        streams: jsonResult(
          streamsFixture({
            sample_count: t.length,
            t_s: t,
            distance_m: t.map((i) => i * 3),
            speed_mps: speed,
            hr_bpm: t.map(() => 160),
            cadence_spm: t.map(() => 170),
            altitude_m: t.map(() => 10),
            lat_deg: t.map((i) => 57.77 + i * 0.0001),
            lon_deg: t.map((i) => 14.18 + i * 0.0001),
            paused,
            outage,
          }),
        ),
      })
      renderActivityDetailAt('6116b2e90f551a6c')

      const ends = paceScaleEnds(speed, paused, outage)
      if (ends === null) throw new Error('expected pace ends from a run with varying moving speed')

      const legend = await screen.findByTestId('pace-legend')
      expect(within(legend).getByText(formatPace(ends.slow))).toBeInTheDocument()
      expect(within(legend).getByText(formatPace(ends.fast))).toBeInTheDocument()
    })

    it('renders no legend for a run whose speeds are all null, and draws the trace in the stopped colour', async () => {
      // No moving speed at all - `paceScaleEnds` returns null, so there is
      // no ramp to show. The route still colours, though: `pacePieces`
      // takes a null `PaceEnds` for exactly this case and comes back with
      // every piece's `step: null`, which both pictures draw in the
      // stopped colour rather than falling back to the plain accent line.
      mockApi({
        streams: jsonResult(streamsFixture({ speed_mps: [null, null, null, null, null] })),
      })
      renderActivityDetailAt('6116b2e90f551a6c')

      const route = await screen.findByRole('region', { name: 'Route' })
      expect(screen.queryByTestId('pace-legend')).toBeNull()

      // No covering basemap area by default, so this is the real bare
      // `Route` trace, not the mocked `RouteMap`.
      const polylines = route.querySelectorAll('polyline')
      expect(polylines.length).toBeGreaterThan(0)
      for (const polyline of Array.from(polylines)) {
        expect((polyline as SVGPolylineElement).style.stroke).toBe('var(--pace-map-stopped)')
      }
    })
  })

  describe('the hero picks the map', () => {
    it('draws the bare trace when no area covers the route', async () => {
      // default mock: no areas
      renderDetail()
      expect(await screen.findByRole('img', { name: 'Route map' })).toBeInTheDocument()
      expect(screen.queryByTestId('route-map-stub')).toBeNull()
    })

    it('draws the map when an area covers every sample', async () => {
      mockBasemap({ areas: [{ id: 'abc', west: -180, south: -90, east: 180, north: 90 }], attribution: 'attr' })
      renderDetail()
      expect(await screen.findByTestId('route-map-stub')).toHaveAttribute('data-area', 'abc')
    })

    it('keeps the bare trace when the basemap request fails', async () => {
      mockBasemapError()
      renderDetail()
      expect(await screen.findByRole('img', { name: 'Route map' })).toBeInTheDocument()
      expect(screen.queryByTestId('route-map-stub')).toBeNull()
    })

    it('keeps the bare trace when the RouteMap chunk fails to load, rather than an uncaught render error', async () => {
      // What a rejected dynamic import looks like once React gets to it -
      // see the comment on `routeMapShouldThrow` above.
      routeMapShouldThrow.current = true
      // React reports an error its boundary caught through `console.error`,
      // which is the behaviour under test here rather than a warning about
      // it; the boundary's fallback is what the assertions read.
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        mockBasemap({ areas: [{ id: 'abc', west: -180, south: -90, east: 180, north: 90 }], attribution: 'attr' })
        renderDetail()
        expect(await screen.findByRole('img', { name: 'Route map' })).toBeInTheDocument()
        expect(screen.queryByTestId('route-map-stub')).toBeNull()
      } finally {
        consoleError.mockRestore()
      }
    })
  })

  it('titles the run by its local day and puts the time and the place in the byline under it', async () => {
    // The reference's own shape: a bold title with one quiet line beneath
    // carrying when and where. Splitting the stamp is what makes the title
    // one line rather than a wrapped 29-character date-and-time.
    mockApi()
    renderActivityDetailAt('6116b2e90f551a6c')

    const title = await screen.findByRole('heading', { level: 1 })
    expect(title).toHaveTextContent('Tuesday 25 August 2026')
    expect(title).not.toHaveTextContent('17:41')
    // The fixture's 3504 m from Jönköping's own point, well inside
    // NEAR_THRESHOLD_M, so the run is *in* Jönköping and the label does not
    // hedge.
    const byline = screen.getByText(/17:41/).closest('p')
    expect(byline).toHaveTextContent('17:41')
    expect(byline).toHaveTextContent('Jönköping, Sweden')
    expect(screen.queryByText(/near Jönköping/)).toBeNull()
  })

  it('passes the all-null hr stream and a null average to the hr panel for a run with no heart rate - never a defaulted 0', async () => {
    // A run with no heart rate: `hr_bpm` is null across the whole
    // grid and `avg_hr_bpm` is null on the summary. Nothing in this view
    // may substitute a 0 for either on the way to `StreamPanel`.
    const allNullHr = Array<number | null>(5).fill(null)
    mockApi({
      detail: detailFixture({ summary: noHeartRateSummaryFixture() }),
      streams: jsonResult(streamsFixture({ activity_id: 'feed000000000001', hr_bpm: allNullHr })),
    })
    renderActivityDetailAt('feed000000000001')
    await screen.findByTestId('stream-panel-hr')

    const hrCall = streamPanelCalls.find((call) => call['channel'] === 'hr')
    if (hrCall === undefined) throw new Error('expected an hr StreamPanel call')
    expect(hrCall['values']).toEqual(allNullHr)
    expect(hrCall['average']).toBeNull()
  })

  it("hands Splits the tag's rep_count and rep_pattern, and the intervals-tag criterion - never a count derived from the laps themselves", async () => {
    mockApi()
    renderActivityDetailAt('6116b2e90f551a6c')
    await screen.findByTestId('splits-stub')

    const call = splitsCalls.at(-1)
    expect(call?.repCount).toBe(5)
    expect(call?.repPattern).toBe('-WRWRWRWRWR---')
    expect(call?.isIntervalsSession).toBe(true)
  })

  it('never leads the splits tab from a non-null rep_count alone - only an actual intervals tag counts', async () => {
    // A contrived, non-real tag: `steady` carrying a `rep_count`, which the
    // real analysis layer never produces. If `ActivityDetail` decided
    // `isIntervalsSession` from "rep_count is non-null" rather than from
    // `tag === 'intervals'`, this would wrongly read as an interval
    // session.
    mockApi({
      detail: detailFixture({
        derived: derivedFixture({
          tags: [
            {
              kind: 'effort',
              tag: 'steady',
              distance_key: null,
              rep_count: 3,
              rep_pattern: null,
              reason: 'median heart rate 161 bpm, 77.7% of max, no recorded reps',
            },
          ],
        }),
      }),
    })
    renderActivityDetailAt('6116b2e90f551a6c')
    await screen.findByTestId('splits-stub')

    expect(splitsCalls.at(-1)?.isIntervalsSession).toBe(false)
  })

  describe('the way back to the list', () => {
    it('goes back through history when the reader arrived from the list, keeping the filters they set', async () => {
      // The reason this is a history-back at all: a `Link to="/activities"`
      // resets every search param, so a reader who filtered the list down
      // to "Treadmill" and clicked a row would lose that filter on the way
      // back. Asserting the restored `q` - not just the pathname - is what
      // makes this fail if the button is ever swapped for a plain link.
      mockApi()
      const testRouter = renderActivityDetailAt('6116b2e90f551a6c', ['/activities?q=Treadmill'])

      // Named `Back`, not after the list: history can lead anywhere.
      const back = await screen.findByRole('button', { name: 'Back' })
      fireEvent.click(back)

      await waitFor(() => {
        expect(testRouter.state.location.pathname).toBe('/activities')
      })
      expect(testRouter.state.location.search).toMatchObject({ q: 'Treadmill' })
    })

    it('falls back to a link when this view is the first entry in the session, so the way back is never dead', async () => {
      // A pasted link, a bookmark, a fresh tab or a reload: `history.back()`
      // here either does nothing at all or leaves the application, which
      // would leave the only route to the list dead exactly where the
      // reader has no other context. Dropping the `canGoBack` guard makes
      // this find a button rather than a link and fail.
      mockApi()
      const testRouter = renderActivityDetailAt('6116b2e90f551a6c')

      const back = await screen.findByRole('link', { name: /Back to activities/ })
      expect(back).toHaveAttribute('href', '/activities')

      fireEvent.click(back)

      await waitFor(() => {
        expect(testRouter.state.location.pathname).toBe('/activities')
      })
    })
  })

  describe('every nullable header stat renders the no-value glyph, never a 0-shaped default', () => {
    it('distance_m', async () => {
      // Not observed with a null distance_m in the real running history,
      // but the field is nullable per the schema (docs/reference/math/
      // identity.md: "a recording that captured heart rate only"), so the
      // no-value branch still has to be exercised.
      mockApi({ detail: detailFixture({ summary: summaryFixture({ distance_m: null }) }) })
      renderActivityDetailAt('6116b2e90f551a6c')
      await screen.findByText('Distance')
      expect(statValue('Distance')).toBe(NO_VALUE)
    })

    it('moving_time_s - the cycling shape', async () => {
      mockApi({
        detail: detailFixture({
          summary: cyclingSummaryFixture(),
          laps: [cyclingLapFixture()],
          derived: null,
          derived_absent_reason: 'the derived layer covers running only',
        }),
        streams: errorResult('no 1 Hz grid for feed000000000002: the derived layer covers running only'),
      })
      renderActivityDetailAt('feed000000000002')
      await screen.findByText('the derived layer covers running only')
      expect(statValue('Moving time')).toBe(NO_VALUE)
    })

    it('avg_speed_mps (pace) - the no-heart-rate shape', async () => {
      mockApi({ detail: detailFixture({ summary: noHeartRateSummaryFixture() }) })
      renderActivityDetailAt('feed000000000001')
      // Not `findByText`: the default streams fixture's constant speed also
      // gives the route hero a pace legend, whose caption is the same word.
      await screen.findByText('Pace', { selector: 'dt' })
      expect(statValue('Pace')).toBe(NO_VALUE)
    })

    it('avg_hr_bpm - the no-heart-rate shape', async () => {
      mockApi({ detail: detailFixture({ summary: noHeartRateSummaryFixture() }) })
      renderActivityDetailAt('feed000000000001')
      await screen.findByText('Heart rate')
      expect(statValue('Heart rate')).toBe(NO_VALUE)
    })

    it('avg_cadence_spm - the cycling shape', async () => {
      mockApi({
        detail: detailFixture({
          summary: cyclingSummaryFixture(),
          laps: [cyclingLapFixture()],
          derived: null,
          derived_absent_reason: 'the derived layer covers running only',
        }),
        streams: errorResult('no 1 Hz grid for feed000000000002: the derived layer covers running only'),
      })
      renderActivityDetailAt('feed000000000002')
      await screen.findByText('the derived layer covers running only')
      expect(statValue('Cadence')).toBe(NO_VALUE)
    })

    it('ascent_m - the treadmill shape', async () => {
      mockApi({
        detail: detailFixture({
          summary: summaryFixture({ activity_id: 'feed000000000003', sub_sport: 'treadmill', ascent_m: null, descent_m: null }),
          derived: derivedFixture({
            metrics: {
              elapsed_time_s: 2400,
              moving_time_s: 2400,
              paused_time_s: 0,
              distance_m: 7000,
              ascent_per_km_m: null,
              is_indoor: true,
              has_hr: true,
              has_gps: false,
              is_gpx_sourced: false,
              // A treadmill run has no position, so no place. All four null
              // together is the shape the derived layer writes.
              locality: null,
              country_code: null,
              country: null,
              locality_distance_m: null,
            },
          }),
        }),
      })
      renderActivityDetailAt('feed000000000003')
      await screen.findByText('Ascent')
      expect(statValue('Ascent')).toBe(NO_VALUE)
    })
  })

  describe('the route line under the title', () => {
    /** A synthetic route this run ranks 4th of 27 in. */
    function routeFixture(overrides: Partial<ActivityRoute> = {}): ActivityRoute {
      return {
        route_id: '0a1b2c3d4e5f6a7b',
        name: 'Jönköping 9.2 km',
        run_count: 27,
        rank: 4,
        direction: 'forward',
        ...overrides,
      }
    }

    /** The one link whose text starts `Route:`, or null. */
    function routeLink(): HTMLElement | null {
      return screen.queryAllByRole('link').find((link) => /^Route:/.test(link.textContent ?? '')) ?? null
    }

    it("names the run's route, its run count and this run's rank, and links to the route", async () => {
      mockApi({ detail: detailFixture({ route: routeFixture() }) })
      renderActivityDetailAt('6116b2e90f551a6c')

      await screen.findByRole('heading', { level: 1 })
      const link = routeLink()
      expect(link).not.toBeNull()
      expect(link).toHaveTextContent('Route: Jönköping 9.2 km · 27 runs · 4th fastest')
      expect(link).toHaveAttribute('href', '/routes/0a1b2c3d4e5f6a7b')
    })

    it('reads rank 1 as "fastest"', async () => {
      mockApi({ detail: detailFixture({ route: routeFixture({ rank: 1 }) }) })
      renderActivityDetailAt('6116b2e90f551a6c')

      await screen.findByRole('heading', { level: 1 })
      expect(routeLink()).toHaveTextContent('Route: Jönköping 9.2 km · 27 runs · fastest')
      expect(routeLink()).not.toHaveTextContent('1st')
    })

    it('gives an ineligible run, which has no rank, no rank', async () => {
      mockApi({ detail: detailFixture({ route: routeFixture({ rank: null }) }) })
      renderActivityDetailAt('6116b2e90f551a6c')

      await screen.findByRole('heading', { level: 1 })
      const link = routeLink()
      expect(link).not.toBeNull()
      expect(link?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Route: Jönköping 9.2 km · 27 runs')
    })

    it('draws no route line for a run in no route', async () => {
      mockApi({ detail: detailFixture({ route: null }) })
      renderActivityDetailAt('6116b2e90f551a6c')

      await screen.findByRole('heading', { level: 1 })
      expect(routeLink()).toBeNull()
      expect(screen.queryByText(/^Route:/)).toBeNull()
    })

    it('puts the line under the title, before the numbers', async () => {
      mockApi({ detail: detailFixture({ route: routeFixture() }) })
      renderActivityDetailAt('6116b2e90f551a6c')

      const title = await screen.findByRole('heading', { level: 1 })
      const link = routeLink()
      if (link === null) throw new Error('no route line')
      expect(precedes(title, link)).toBe(true)
      expect(precedes(link, screen.getByText('Distance'))).toBe(true)
    })
  })

  describe('the moment', () => {
    it('moving the pointer over one stream panel updates the heading of another', async () => {
      // The real `StreamPanel`s for this one test (see `useRealStreamPanel`
      // above): the four channels share one `MomentStore` through
      // `ActivityDetail`'s own `MomentProvider`, so a pointer move reported
      // by the pace chart has to move the heart rate panel's heading too -
      // the behaviour a prop-recording spy cannot show. The moment comes
      // from a native `pointermove` on the chart's own `over` element, not
      // from uPlot's `setCursor` hook - see `StreamPanel.tsx`'s own comment
      // on why that hook is not wired to the store at all.
      useRealStreamPanel.current = true
      mockApi({
        streams: jsonResult(streamsFixture({ hr_bpm: [150, 160, 170, 180, 190] })),
      })
      renderActivityDetailAt('6116b2e90f551a6c')

      await screen.findByRole('heading', { name: 'Pace' })
      // pace, hr, cadence, elevation, in `STREAM_CHANNELS`' own order.
      expect(uPlotInstances).toHaveLength(4)

      const paceChart = uPlotInstances[0]
      if (paceChart === undefined) throw new Error('no pace chart was constructed')

      const move = new PointerEvent('pointermove', { pointerType: 'mouse' })
      Object.defineProperty(move, 'offsetX', { value: 0 })
      act(() => {
        paceChart.over.dispatchEvent(move)
      })

      expect(await screen.findByText(heartRate(150))).toBeInTheDocument()
    })

    it('shows the moment label on the route hero with the elapsed time and distance', async () => {
      useRealStreamPanel.current = true
      mockApi()
      renderActivityDetailAt('6116b2e90f551a6c')

      await screen.findByRole('heading', { name: 'Pace' })
      const paceChart = uPlotInstances[0]
      if (paceChart === undefined) throw new Error('no pace chart was constructed')

      const move = new PointerEvent('pointermove', { pointerType: 'mouse' })
      Object.defineProperty(move, 'offsetX', { value: 0 })
      act(() => {
        paceChart.over.dispatchEvent(move)
      })

      // Sample 0 of the default `streamsFixture`: `t_s[0]` is 0 and
      // `distance_m[0]` is 0.
      const label = await screen.findByTestId('moment-label')
      expect(label).toHaveAttribute('aria-hidden', 'true')
      expect(label.textContent).toBe(`${duration(0)} · ${distance(0)}`)
    })

    it("appends 'stopped' to the moment label for a paused sample", async () => {
      useRealStreamPanel.current = true
      mockApi({
        streams: jsonResult(streamsFixture({ paused: [false, true, false, false, false] })),
      })
      renderActivityDetailAt('6116b2e90f551a6c')

      await screen.findByRole('heading', { name: 'Pace' })
      const paceChart = uPlotInstances[0]
      if (paceChart === undefined) throw new Error('no pace chart was constructed')

      const move = new PointerEvent('pointermove', { pointerType: 'mouse' })
      Object.defineProperty(move, 'offsetX', { value: 1 })
      act(() => {
        paceChart.over.dispatchEvent(move)
      })

      // Sample 1: `t_s[1]` is 1 and `distance_m[1]` is 3, paused `true`.
      const label = await screen.findByTestId('moment-label')
      expect(label.textContent).toBe(`${duration(1)} · ${distance(3)} · stopped`)
    })
  })
})
