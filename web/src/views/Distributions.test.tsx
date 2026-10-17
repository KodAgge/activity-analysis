import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../api/schema'
import type { HistogramProps } from '../charts/Histogram'
import { Distributions } from './Distributions'

type DistributionRun = components['schemas']['DistributionRun']
type DistributionsResponse = components['schemas']['Distributions']

const { getMock, histogramCalls } = vi.hoisted(() => ({
  getMock: vi.fn(),
  histogramCalls: [] as HistogramProps[],
}))
vi.mock('../api/client', () => ({ api: { GET: getMock } }))

/**
 * The histogram is stubbed so this file checks what *Distributions* hands
 * it - which buckets, which series, which selection - rather than how it
 * draws them, which `Histogram.test.tsx` covers. The stub is a listbox
 * named the way the real one is, with one clickable option per bucket, so
 * a test selects a bucket the way a reader does.
 */
vi.mock('../charts/Histogram', () => ({
  Histogram: (props: HistogramProps) => {
    histogramCalls.push(props)
    return (
      <div role="listbox" aria-label={props.label}>
        {props.buckets.map((bucket) => (
          <div
            key={bucket.key}
            role="option"
            aria-selected={bucket.key === props.selectedKey}
            onClick={() => props.onSelect(bucket.key)}
          >
            {bucket.label}
          </div>
        ))}
      </div>
    )
  },
}))

function run(overrides: Partial<DistributionRun> = {}): DistributionRun {
  return {
    activity_id: 'r00',
    start_time_utc: '2026-01-13T16:00:00Z',
    utc_offset_s: 7200,
    is_indoor: false,
    distance_m: 6000,
    moving_time_s: 2100,
    elapsed_time_s: 2160,
    avg_speed_mps: 2.857,
    avg_hr_bpm: 152,
    max_hr_bpm: 175,
    avg_cadence_spm: 162,
    ascent_per_km_m: 4.2,
    hr_at_median_bpm: 158,
    cadence_at_median_spm: 166,
    decoupling_pct: 4.1,
    is_aerobic_long_run: false,
    days_since_previous_run: 2,
    ...overrides,
  }
}

/**
 * Ten runs over three calendar years, weekday and weekend, two of them on
 * a treadmill, three with no heart rate. Three fall in the 6 to 7 km
 * bucket, on three different days, so the bucket list has an order to
 * get right; 7000 m exactly is the next bucket's, not this one's.
 */
const RUNS: DistributionRun[] = [
  run({ activity_id: 'r01', start_time_utc: '2024-05-06T16:00:00Z', distance_m: 5200, avg_hr_bpm: null }), // Mon
  run({ activity_id: 'r02', start_time_utc: '2024-11-09T10:00:00Z', distance_m: 12000, avg_hr_bpm: null }), // Sat
  run({ activity_id: 'r03', start_time_utc: '2025-02-04T16:00:00Z', distance_m: 6100, avg_hr_bpm: null }), // Tue
  run({ activity_id: 'r04', start_time_utc: '2025-06-14T10:00:00Z', distance_m: 6500 }), // Sat
  run({ activity_id: 'r05', start_time_utc: '2025-10-01T16:00:00Z', distance_m: 8000, is_indoor: true }), // Wed
  run({ activity_id: 'r06', start_time_utc: '2026-01-13T16:00:00Z', distance_m: 6900 }), // Tue
  run({ activity_id: 'r07', start_time_utc: '2026-03-21T10:00:00Z', distance_m: 15000 }), // Sat
  run({ activity_id: 'r08', start_time_utc: '2026-05-05T16:00:00Z', distance_m: 5500, is_indoor: true }), // Tue
  run({ activity_id: 'r09', start_time_utc: '2026-07-18T10:00:00Z', distance_m: 10000 }), // Sat
  run({ activity_id: 'r10', start_time_utc: '2026-09-29T16:00:00Z', distance_m: 7000 }), // Tue
]

/** A synthetic median reference pace, 6:15/km. */
const PAYLOAD: DistributionsResponse = { references: { median_mps: 2.6667 }, runs: RUNS }

function mockApi(payload: DistributionsResponse = PAYLOAD): void {
  getMock.mockImplementation((path: string) => {
    if (path === '/api/distributions') return Promise.resolve({ data: payload, error: undefined })
    return Promise.resolve({ data: undefined, error: { detail: `unmocked ${path}` } })
  })
}

function renderDistributions(initialPath = '/?variable=distance') {
  const rootRoute = createRootRoute()
  const distributionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    // The real route validates in `router.tsx`; the view re-validates on
    // its own regardless, which is what this harness exercises.
    validateSearch: (search: Record<string, unknown>) => search,
    component: Distributions,
  })
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/activities/$activityId',
    component: () => <p>detail</p>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([distributionsRoute, detailRoute]),
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

function search(router: ReturnType<typeof renderDistributions>['router']): Record<string, unknown> {
  return router.state.location.search as Record<string, unknown>
}

/** The `RowList` group a band heading names: the section the heading opens. */
function listUnder(heading: HTMLElement): HTMLElement {
  const section = heading.closest('section')
  if (section === null) throw new Error('the heading opens no section')
  return section
}

function lastHistogram(): HistogramProps {
  const call = histogramCalls.at(-1)
  if (call === undefined) throw new Error('no histogram was rendered')
  return call
}

beforeEach(() => {
  getMock.mockReset()
  histogramCalls.length = 0
  // Only the clock is faked, so the query's promises still settle: the
  // periods are relative to today, and today is the day this was written.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-28T12:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Distributions', () => {
  it('says it is loading until the runs arrive', async () => {
    getMock.mockImplementation(() => new Promise(() => {}))
    renderDistributions()
    expect(await screen.findByText('Loading the runs…')).toBeInTheDocument()
  })

  it('surfaces a failed request as an alert', async () => {
    getMock.mockImplementation(() => Promise.resolve({ data: undefined, error: { detail: 'store unreadable' } }))
    renderDistributions()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the runs: store unreadable')
  })

  it('states the absence when the store holds no runs at all', async () => {
    mockApi({ references: { median_mps: null }, runs: [] })
    renderDistributions()
    expect(await screen.findByRole('note')).toHaveTextContent('No runs are stored yet')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('draws every served run as one histogram of counts, with the counts in the caption', async () => {
    mockApi()
    renderDistributions()
    expect(await screen.findByRole('listbox', { name: 'Distance, runs per bucket' })).toBeInTheDocument()
    expect(screen.getByText(/^Distance, km\./)).toHaveTextContent('Distance, km. 10 of 10 runs, median run 6.95 km.')
    const histogram = lastHistogram()
    expect(histogram.series).toHaveLength(1)
    // 5 to 16 km in 1 km buckets, the axis built from every run.
    expect(histogram.buckets.map((b) => b.key)[0]).toBe('5000')
    expect(histogram.series[0].values.reduce((a, b) => a + b, 0)).toBe(10)
  })

  it('counts the runs with a value and the runs left out for lacking one', async () => {
    mockApi()
    renderDistributions('/?variable=avg_hr')
    await screen.findByRole('listbox', { name: 'Average heart rate, runs per bucket' })
    expect(screen.getByText(/^Average heart rate, bpm\./)).toHaveTextContent('7 of 10 runs, 3 left out')
  })

  it('offers the fifteen variables, naming the reference pace from the payload', async () => {
    mockApi()
    renderDistributions()
    const select = await screen.findByRole('combobox', { name: 'Variable' })
    const options = within(select).getAllByRole('option')
    expect(options).toHaveLength(15)
    expect(options.map((o) => o.textContent)).toContain('Cadence at 6:15/km')
  })

  it('clears the bucket when the variable changes', async () => {
    mockApi()
    const { router } = renderDistributions('/?variable=distance&bucket=6000')
    fireEvent.change(await screen.findByRole('combobox', { name: 'Variable' }), { target: { value: 'avg_hr' } })
    await waitFor(() => expect(search(router)).toEqual({ variable: 'avg_hr' }))
  })

  it('compares the last 12 months against the 12 before when two periods are chosen from all time', async () => {
    mockApi()
    const { router } = renderDistributions()
    fireEvent.change(await screen.findByRole('combobox', { name: 'Compare' }), { target: { value: 'periods' } })
    await waitFor(() =>
      expect(search(router)).toEqual({ variable: 'distance', compare: 'periods', period: 'last_12_months' }),
    )
    expect(screen.getByRole('combobox', { name: 'Period' })).toHaveValue('last_12_months')
    expect(screen.getByRole('combobox', { name: 'Against' })).toHaveValue('previous_12_months')
    // Two groups drawn as one overlay, each as a share of itself.
    const histogram = lastHistogram()
    expect(histogram.series.map((s) => s.label)).toEqual(['Last 12 months', 'Previous 12 months'])
    expect(histogram.label).toBe('Distance, share of runs per bucket')
  })

  it('disables the days control while comparing by days, and restores its value when the comparison ends', async () => {
    mockApi()
    const { router } = renderDistributions('/?variable=distance&compare=days&days=weekends')
    await screen.findByRole('listbox')
    expect(screen.getByRole('group', { name: 'Days' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Weekends' })).toBeChecked()

    fireEvent.change(screen.getByRole('combobox', { name: 'Compare' }), { target: { value: 'none' } })
    await waitFor(() => expect(search(router)).toEqual({ variable: 'distance', days: 'weekends' }))
    expect(screen.getByRole('group', { name: 'Days' })).toBeEnabled()
    expect(screen.getByRole('radio', { name: 'Weekends' })).toBeChecked()
    // And the filter applies again: four of the ten runs are on a weekend.
    expect(screen.getByText(/^Distance, km\./)).toHaveTextContent('4 of 4 runs')
  })

  it('disables the treadmill checkbox while comparing outdoor with treadmill', async () => {
    mockApi()
    renderDistributions('/?variable=distance&compare=surface')
    await screen.findByRole('listbox')
    expect(screen.getByRole('checkbox', { name: 'Include treadmill runs' })).toBeDisabled()
    expect(screen.getByText(/^Distance, km\./)).toHaveTextContent('Outdoor: 8 of 8 runs')
    expect(screen.getByText(/^Distance, km\./)).toHaveTextContent('Treadmill: 2 of 2 runs')
  })

  it('leaves treadmill runs out when the checkbox is cleared', async () => {
    mockApi()
    const { router } = renderDistributions()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Include treadmill runs' }))
    await waitFor(() => expect(search(router)).toEqual({ variable: 'distance', treadmill: 'exclude' }))
    expect(screen.getByText(/^Distance, km\./)).toHaveTextContent('8 of 8 runs')
  })

  it('writes the bar measure to the URL', async () => {
    mockApi()
    const { router } = renderDistributions()
    fireEvent.click(await screen.findByRole('radio', { name: 'Kilometres' }))
    await waitFor(() => expect(search(router)).toEqual({ variable: 'distance', measure: 'distance' }))
    expect(lastHistogram().label).toBe('Distance, kilometres per bucket')
  })

  it('reads an empty compared group as zero of zero and still draws the chart', async () => {
    mockApi({ references: { median_mps: 2.6667 }, runs: RUNS.filter((r) => !['r02', 'r04', 'r07', 'r09'].includes(r.activity_id)) })
    renderDistributions('/?variable=distance&compare=days')
    await screen.findByRole('listbox')
    expect(screen.getByText(/^Distance, km\./)).toHaveTextContent('Weekends: 0 of 0 runs')
    const weekends = lastHistogram().series[1]
    expect(weekends?.label).toBe('Weekends')
    expect(weekends?.values.every((v) => v === 0)).toBe(true)
    expect(weekends?.medianAt).toBeNull()
  })

  it('states the absence of a variable no run has, and keeps the caption', async () => {
    mockApi()
    renderDistributions('/?variable=decoupling')
    expect(await screen.findByRole('note')).toHaveTextContent('Aerobic decoupling')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByText(/^Aerobic decoupling, %\./)).toHaveTextContent('0 of 10 runs, 10 left out')
  })

  it('warns that pace moves raw cadence across periods, and links to the reference-pace variable', async () => {
    mockApi()
    const { router } = renderDistributions('/?variable=avg_cadence&compare=periods&period=last_12_months')
    await screen.findByRole('listbox')
    const link = screen.getByRole('link', { name: 'Cadence at 6:15/km' })
    expect(link.closest('p')).toHaveTextContent(
      'Part of a shift in average cadence between periods can come from pace. Cadence at 6:15/km holds the pace fixed.',
    )
    fireEvent.click(link)
    await waitFor(() => expect(search(router)).toMatchObject({ variable: 'cadence_at_reference', compare: 'periods' }))
    expect(screen.queryByRole('link', { name: /at 6:15\/km/ })).toBeNull()
  })

  it('does not warn about pace for a variable already held at a reference pace, or when not comparing over time', async () => {
    mockApi()
    renderDistributions('/?variable=cadence_at_reference&compare=periods&period=last_12_months')
    await screen.findByRole('listbox')
    expect(screen.queryByText(/can come from pace/)).toBeNull()
  })

  it('does not warn about pace for a comparison that is not over time', async () => {
    mockApi()
    renderDistributions('/?variable=avg_cadence&compare=days')
    await screen.findByRole('listbox')
    expect(screen.queryByText(/can come from pace/)).toBeNull()
  })

  it('lists a selected bucket\'s runs newest first, each linking to its activity', async () => {
    mockApi()
    renderDistributions('/?variable=distance&bucket=6000')
    const list = listUnder(await screen.findByRole('heading', { name: 'All runs, 6 to 7 km' }))
    const links = within(list).getAllByRole('link')
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/activities/r06', '/activities/r04', '/activities/r03'])
    expect(links[0]).toHaveTextContent('Tue 13 Jan 2026 18:00')
    expect(links[0]).toHaveTextContent('6.90 km')
    expect(lastHistogram().selectedKey).toBe('6000')
  })

  it('selects a bucket from the chart without a new buckets, series or formatter identity, any of which would rebuild it', async () => {
    mockApi()
    const { router } = renderDistributions()
    await screen.findByRole('listbox')
    const before = lastHistogram()
    fireEvent.click(screen.getByRole('option', { name: '6 to 7' }))
    await waitFor(() => expect(search(router)).toEqual({ variable: 'distance', bucket: '6000' }))
    const after = lastHistogram()
    expect(after.selectedKey).toBe('6000')
    expect(after.buckets).toBe(before.buckets)
    expect(after.series).toBe(before.series)
    expect(after.formatValue).toBe(before.formatValue)
  })

  it('heads a start-hour bucket list with the hour as a time of day, and shows each run\'s distance rather than its hour again', async () => {
    mockApi()
    renderDistributions('/?variable=start_hour&bucket=18')
    const list = listUnder(await screen.findByRole('heading', { name: 'All runs, 18:00' }))
    const links = within(list).getAllByRole('link')
    // The six 16:00 UTC runs, 18:00 local at +2.
    expect(links).toHaveLength(6)
    expect(links[0]).toHaveTextContent('Tue 29 Sep 2026 18:00')
    expect(links[0]).toHaveTextContent('7.00 km')
    expect(links[0]?.textContent?.match(/18:00/g)).toHaveLength(1)
  })

  it('counts runs on a whole-number y ladder, and shares on any', async () => {
    mockApi()
    const { router } = renderDistributions()
    await screen.findByRole('listbox')
    expect(lastHistogram().wholeNumbers).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: 'Kilometres' }))
    await waitFor(() => expect(search(router)).toMatchObject({ measure: 'distance' }))
    expect(lastHistogram().wholeNumbers).toBe(false)
  })

  it('keeps the bucket edges fixed when comparing by days and when filtering to one year', async () => {
    mockApi()
    const { router } = renderDistributions()
    await screen.findByRole('listbox')
    const keys = lastHistogram().buckets.map((b) => b.key)

    fireEvent.change(screen.getByRole('combobox', { name: 'Compare' }), { target: { value: 'days' } })
    await waitFor(() => expect(search(router)).toMatchObject({ compare: 'days' }))
    expect(lastHistogram().buckets.map((b) => b.key)).toEqual(keys)

    fireEvent.change(screen.getByRole('combobox', { name: 'Compare' }), { target: { value: 'none' } })
    await waitFor(() => expect(search(router)).toEqual({ variable: 'distance' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Period' }), { target: { value: 'year_2025' } })
    await waitFor(() => expect(search(router)).toEqual({ variable: 'distance', period: 'year_2025' }))
    // 2025's runs span 6.1 to 8 km alone, and the axis still runs 5 to 16.
    expect(screen.getByText(/^Distance, km\./)).toHaveTextContent('3 of 3 runs')
    expect(lastHistogram().buckets.map((b) => b.key)).toEqual(keys)
  })

  it('clears the selection when the selected bucket is chosen again', async () => {
    mockApi()
    const { router } = renderDistributions('/?variable=distance&bucket=6000')
    fireEvent.click(await screen.findByRole('option', { name: '6 to 7' }))
    await waitFor(() => expect(search(router)).toEqual({ variable: 'distance' }))
  })

  it('lists nothing and does not throw for a bucket that names no bucket', async () => {
    mockApi()
    renderDistributions('/?variable=distance&bucket=nonsense')
    await screen.findByRole('listbox')
    expect(screen.queryByRole('heading', { name: /All runs,/ })).toBeNull()
    expect(lastHistogram().selectedKey).toBeNull()
  })

  it('lists one group per compared group, under the same names', async () => {
    mockApi()
    renderDistributions('/?variable=distance&compare=days&bucket=6000')
    await screen.findByRole('listbox')
    expect(within(listUnder(screen.getByRole('heading', { name: 'Weekdays, 6 to 7 km' }))).getAllByRole('link')).toHaveLength(2)
    expect(within(listUnder(screen.getByRole('heading', { name: 'Weekends, 6 to 7 km' }))).getAllByRole('link')).toHaveLength(1)
  })

  it('draws one small histogram per year present, on one shared y scale', async () => {
    mockApi()
    renderDistributions('/?variable=distance&compare=years')
    await screen.findByRole('listbox', { name: 'Distance, 2024' })
    expect(screen.getAllByRole('listbox').map((l) => l.getAttribute('aria-label'))).toEqual([
      'Distance, 2024',
      'Distance, 2025',
      'Distance, 2026',
    ])
    const charts = histogramCalls.slice(-3)
    expect(charts.every((c) => c.compact === true)).toBe(true)
    expect(new Set(charts.map((c) => c.yMax)).size).toBe(1)
    expect(screen.getByText(/^2025: /)).toHaveTextContent('2025: 3 of 3 runs, median run 6.50 km')
  })

  it('offers each year holding a run as a period, and filters to it', async () => {
    mockApi()
    const { router } = renderDistributions()
    const period = await screen.findByRole('combobox', { name: 'Period' })
    expect(within(period).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'All time',
      'Last 12 months',
      'Previous 12 months',
      '2026',
      '2025',
      '2024',
      'Custom range',
    ])
    fireEvent.change(period, { target: { value: 'year_2025' } })
    await waitFor(() => expect(search(router)).toEqual({ variable: 'distance', period: 'year_2025' }))
    expect(screen.getByText(/^Distance, km\./)).toHaveTextContent('3 of 3 runs')
  })

  it('takes a custom range\'s last day inclusive and stores the day after it', async () => {
    mockApi()
    const { router } = renderDistributions('/?variable=distance&period=custom&from=2025-01-01&to=2025-07-01')
    const to = await screen.findByLabelText('To')
    expect(to).toHaveValue('2025-06-30')
    expect(screen.getByLabelText('From')).toHaveValue('2025-01-01')
    fireEvent.change(to, { target: { value: '2025-06-14' } })
    await waitFor(() =>
      expect(search(router)).toEqual({ variable: 'distance', period: 'custom', from: '2025-01-01', to: '2025-06-15' }),
    )
    // The last day counts: the run on 14 June is in.
    expect(screen.getByText(/^Distance, km\./)).toHaveTextContent('2 of 2 runs')
  })
})
