import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../api/schema'
import type { ProgressionScatterProps } from '../charts/ProgressionScatter'
import { Progression } from './Progression'

type Record_ = components['schemas']['Record']
type ProgressionResponse = components['schemas']['Progression']
type ProgressionPoint = components['schemas']['ProgressionPoint']

const { getMock, scatterCalls } = vi.hoisted(() => ({
  getMock: vi.fn(),
  scatterCalls: [] as ProgressionScatterProps[],
}))
vi.mock('../api/client', () => ({ api: { GET: getMock } }))

/**
 * The scatter is stubbed so this file checks what *Progression* hands it -
 * which points, and whether to show the ineligible ones - rather than how
 * it draws them, which `ProgressionScatter.test.tsx` covers.
 */
vi.mock('../charts/ProgressionScatter', () => ({
  ProgressionScatter: (props: ProgressionScatterProps) => {
    scatterCalls.push(props)
    return <div data-testid="scatter" role="img" aria-label={props.ariaLabel} />
  },
  // The key's swatches are the chart's own marks, so they come from the
  // same module and have to be stubbed with it.
  ProgressionMark: ({ style }: { style: string }) => <span data-testid={`mark-${style}`} />,
}))

function record(distance_key: string, distance_m: number, elapsed_time_s = 1500): Record_ {
  return {
    distance_key,
    distance_m,
    elapsed_time_s,
    avg_hr_bpm: 160.0,
    effort_count: 155,
    activity_id: 'fastest',
    start_time_utc: '2025-10-12T16:00:00Z',
    utc_offset_s: 7200,
    name: 'Run',
  }
}

/** A representative subset of the real ladder, shortest first, chosen to exercise the picker rather than to mirror `/api/records`, which returns nineteen keys on the real store. */
const RECORDS: Record_[] = [
  record('400m', 400),
  record('1k', 1000),
  record('1mi', 1609.344),
  record('3k', 3000),
  record('5k', 5000),
  record('10k', 10000, 3100),
  record('15k', 15000),
  record('half', 21097.5),
]

function point(overrides: Partial<ProgressionPoint> = {}): ProgressionPoint {
  return {
    activity_id: 'fastest',
    start_time_utc: '2025-10-12T16:00:00Z',
    utc_offset_s: 7200,
    name: 'Run',
    elapsed_time_s: 1500,
    avg_hr_bpm: 160.0,
    locality: 'Jönköping',
    is_eligible: true,
    is_record: true,
    ineligible_reason: null,
    contains_jump: false,
    ...overrides,
  }
}

function progression(distanceKey: string, items: ProgressionPoint[]): ProgressionResponse {
  const distanceM = RECORDS.find((r) => r.distance_key === distanceKey)?.distance_m ?? 0
  return {
    distance_key: distanceKey,
    distance_m: distanceM,
    effort_count: items.length,
    eligible_count: items.filter((p) => p.is_eligible).length,
    record_count: items.filter((p) => p.is_record).length,
    items,
  }
}

function mockApi(progressions: Record<string, ProgressionResponse>): void {
  getMock.mockImplementation((path: string, init?: { params?: { path?: { distance_key?: string } } }) => {
    if (path === '/api/records') return Promise.resolve({ data: { items: RECORDS }, error: undefined })
    if (path === '/api/progression/{distance_key}') {
      const key = init?.params?.path?.distance_key ?? ''
      const found = progressions[key]
      if (found !== undefined) return Promise.resolve({ data: found, error: undefined, response: new Response() })
      return Promise.resolve({
        data: undefined,
        error: { detail: `no efforts at ${key}` },
        response: new Response(null, { status: 404 }),
      })
    }
    return Promise.resolve({ data: undefined, error: { detail: `unmocked ${path}` } })
  })
}

function renderProgression(initialPath = '/') {
  const rootRoute = createRootRoute()
  const progressionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    // The real route validates in `router.tsx`; the view re-validates on
    // its own regardless, which is what this harness exercises.
    validateSearch: (search: Record<string, unknown>) => search,
    component: Progression,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([progressionRoute]),
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

/** The props of the scatter's last render, narrowed to the distance kind this view draws. */
function lastScatter(): Exclude<ProgressionScatterProps, { kind: 'route' }> {
  const call = scatterCalls.at(-1)
  if (call === undefined) throw new Error('the scatter was never rendered')
  if (call.kind === 'route') throw new Error('the progression view drew a route scatter')
  return call
}

beforeEach(() => {
  getMock.mockReset()
  scatterCalls.length = 0
})

describe('Progression', () => {
  it('defaults to 5 km and says how many efforts and records are drawn', async () => {
    mockApi({ '5k': progression('5k', [point(), point({ activity_id: 'b', is_record: false, is_eligible: false, ineligible_reason: 'treadmill' })]) })
    renderProgression()
    expect(await screen.findByRole('heading', { level: 1, name: 'Progression' })).toBeInTheDocument()
    await screen.findByRole('img', { name: '5 km progression' })
    expect(screen.getByRole('radio', { name: '5 km' })).toBeChecked()
    expect(screen.getByText(/efforts,/)).toHaveTextContent(
      'Faster is lower, so improvement descends. 2 efforts, 1 eligible, 1 record.',
    )
  })

  it('leads with the personal best from /api/records, which is the analysis layer\'s own', async () => {
    mockApi({ '5k': progression('5k', [point()]) })
    renderProgression()
    await screen.findByRole('img', { name: '5 km progression' })
    // A synthetic 1500 s over 5000 m, set on 2025-10-12 at UTC+2. Every one of these
    // is the records endpoint's row for the chosen distance rather than a
    // choice made here over the points: which effort is the best is the
    // analysis layer's decision, not the frontend's.
    const best = screen.getByText('Best 5 km').parentElement
    expect(best).toHaveTextContent('25:00')
    expect(best).toHaveTextContent('Pace 5:00/km')
    expect(best).toHaveTextContent('Heart rate 160 bpm')
    expect(best).toHaveTextContent('12 Oct 2025')
    // No heading repeating the chosen distance: the chip above already says
    // it, and a heading set smaller than its own content is not a heading.
    expect(screen.queryByRole('heading', { level: 2, name: '5 km' })).toBeNull()
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Every effort',
    ])
  })

  it('states the exact distance beside the best only where the label does not', async () => {
    mockApi({
      '5k': progression('5k', [point()]),
      half: progression('half', [point({ elapsed_time_s: 6300 })]),
    })
    renderProgression('/?distance=half')
    await screen.findByRole('img', { name: 'Half marathon progression' })
    expect(screen.getByText('Best Half marathon').parentElement).toHaveTextContent('21.10 km')

    fireEvent.click(screen.getByRole('radio', { name: '5 km' }))
    await screen.findByRole('img', { name: '5 km progression' })
    expect(screen.getByText('Best 5 km').parentElement).not.toHaveTextContent('5.00 km')
  })

  it('lists exactly the distances the endpoint returned, in ladder order', async () => {
    mockApi({ '5k': progression('5k', [point()]) })
    renderProgression()
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(RECORDS.length))
    const labels = screen.getAllByRole('radio').map((o) => o.closest('label')?.textContent)
    expect(labels).toEqual(['400 m', '1 km', '1 mile', '3 km', '5 km', '10 km', '15 km', 'Half marathon'])
    expect(labels).not.toContain('Marathon')
    // One group, named, so the row of pills is a single control to a
    // screen reader rather than eight unrelated radios.
    expect(screen.getByRole('group', { name: 'Distance' })).toBeInTheDocument()
  })

  it('reads the distance from the URL', async () => {
    mockApi({ '10k': progression('10k', [point({ elapsed_time_s: 3100 })]) })
    renderProgression('/?distance=10k')
    await screen.findByRole('img', { name: '10 km progression' })
    expect(screen.getByRole('radio', { name: '10 km' })).toBeChecked()
    expect(screen.getByRole('radio', { name: '5 km' })).not.toBeChecked()
    expect(lastScatter().distanceM).toBe(10000)
  })

  it('puts a newly chosen distance in the URL and requests it', async () => {
    mockApi({
      '5k': progression('5k', [point()]),
      '10k': progression('10k', [point({ activity_id: 'ten', elapsed_time_s: 3100 })]),
    })
    const { router } = renderProgression()
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(RECORDS.length))

    fireEvent.click(screen.getByRole('radio', { name: '10 km' }))

    await screen.findByRole('img', { name: '10 km progression' })
    expect(router.state.location.search).toEqual({ distance: '10k' })
    expect(lastScatter().points.map((p) => p.activity_id)).toEqual(['ten'])
  })

  it('states the absence in words when the chosen distance 404s, rather than drawing an empty chart', async () => {
    mockApi({})
    renderProgression('/?distance=marathon')
    const note = await screen.findByRole('note')
    expect(note).toHaveTextContent('No efforts at Marathon')
    expect(note).toHaveTextContent('no efforts at marathon')
    expect(screen.queryByTestId('scatter')).toBeNull()
    // The picker still offers what the URL says, so the two never disagree.
    expect(screen.getByRole('radio', { name: 'Marathon' })).toBeChecked()
    // And no personal best: `/api/records` has no marathon row, so there is
    // no number to show and none is invented.
    expect(screen.queryByText(/^Best /)).toBeNull()
  })

  it('calls an implausible advance a jump in the recorded distance, naming no cause', async () => {
    // Examined on a real half marathon, which this chart marked ineligible
    // until the measured speed could confirm a jump: the position advanced
    // steadily through the flagged moment and the speed channel never moved,
    // while the odometer gained nearly five times the speed channel's
    // reading in one second. The rule, which tests
    // the odometer's implied speed against 12.5 m/s, is right. The words
    // were not - they asserted a GPS cause - and the fix is to say what the
    // flag is defined on rather than to assert the opposite.
    mockApi({ '5k': progression('5k', [point()]) })
    renderProgression()
    await screen.findByRole('img', { name: '5 km progression' })

    expect(screen.getByText(/jump in the recorded distance/i)).toBeInTheDocument()
    expect(screen.queryByText(/GPS jump/i)).toBeNull()
  })

  it('shows ineligible efforts by default and hides them on the toggle', async () => {
    mockApi({ '5k': progression('5k', [point()]) })
    renderProgression()
    await screen.findByRole('img', { name: '5 km progression' })
    expect(lastScatter().showIneligible).toBe(true)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show ineligible efforts' }))

    expect(lastScatter().showIneligible).toBe(false)
  })

  it('hands the scatter the points verbatim, never re-deciding a record', async () => {
    const items = [point(), point({ activity_id: 'faster-but-treadmill', elapsed_time_s: 1200, is_eligible: false, is_record: false, ineligible_reason: 'treadmill' })]
    mockApi({ '5k': progression('5k', items) })
    renderProgression()
    await screen.findByRole('img', { name: '5 km progression' })
    expect(lastScatter().points).toEqual(items)
  })

  it('renders a real failure as an alert, not as an absence', async () => {
    getMock.mockResolvedValue({
      data: undefined,
      error: { detail: 'DuckDB: file not found' },
      response: new Response(null, { status: 503 }),
    })
    renderProgression()
    const alerts = await screen.findAllByRole('alert')
    expect(alerts.some((a) => /Could not load the progression/.test(a.textContent ?? ''))).toBe(true)
    expect(screen.queryByRole('note')).toBeNull()
  })
})
