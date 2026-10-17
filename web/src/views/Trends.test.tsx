import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../api/schema'
import type { TrendChartProps } from '../charts/TrendChart'
import { linearTrend } from '../charts/trendsFindings'
import { NO_VALUE, localCalendarTime, trimmedNumber } from '../format'
import { Trends } from './Trends'

type TrendPoint = components['schemas']['TrendPoint']
type TrendsResponse = components['schemas']['Trends']
type FitnessPoint = components['schemas']['FitnessPoint']
type DeviceVo2maxPoint = components['schemas']['DeviceVo2maxPoint']
type Predictions = components['schemas']['Predictions']
type ReferencePaces = components['schemas']['ReferencePacesOut']

const { getMock, trendChartCalls } = vi.hoisted(() => ({
  getMock: vi.fn(),
  trendChartCalls: [] as TrendChartProps[],
}))
vi.mock('../api/client', () => ({ api: { GET: getMock } }))

/**
 * `TrendChart` needs a real layout engine jsdom does not have, and this
 * file's job is to check what *Trends* hands each chart, not how the chart
 * draws it - that is `TrendChart.test.tsx`'s job. The stub renders the
 * legend labels as text so a test can find a chart by what it says.
 */
vi.mock('../charts/TrendChart', () => ({
  TrendChart: (props: TrendChartProps) => {
    trendChartCalls.push(props)
    return (
      <div data-testid="trend-chart" role="img" aria-label={props.ariaLabel}>
        {props.series.map((s) => (
          <span key={s.label}>{s.label}</span>
        ))}
      </div>
    )
  },
}))

/**
 * An `/api/trends` reference block: the 25th, 50th and 75th percentile of
 * per-activity median speed over the activities that enter the fit, which
 * is what `athlete_fit` stores (`docs/reference/math/efficiency.md`).
 * Synthetic, chosen to land on round paces: 6:40, 6:15 and 5:20 per km.
 */
const REFERENCES: ReferencePaces = { slow_mps: 2.5, median_mps: 2.6667, fast_mps: 3.125 }

function trendPoint(overrides: Partial<TrendPoint> = {}): TrendPoint {
  return {
    activity_id: 'steady-run',
    start_time_utc: '2025-10-12T16:30:00Z',
    utc_offset_s: 7200,
    effort_tag: 'steady',
    hr_at_slow_bpm: 140.0,
    hr_at_median_bpm: 142.0,
    hr_at_fast_bpm: 144.0,
    cadence_at_slow_spm: 160.0,
    cadence_at_median_spm: 162.0,
    cadence_at_fast_spm: 164.0,
    // The trailing 42-day means the analysis layer computes. Close to the
    // raw values above and not equal to them, because a smoothed point is a
    // property of the window rather than of this run.
    hr_at_slow_smoothed_bpm: 140.5,
    hr_at_median_smoothed_bpm: 142.5,
    hr_at_fast_smoothed_bpm: 144.5,
    cadence_at_slow_smoothed_spm: 160.5,
    cadence_at_median_smoothed_spm: 162.5,
    cadence_at_fast_smoothed_spm: 164.5,
    hr_slope_shrunk_bpm_per_mps: 20.0,
    hr_slope_weight: 0.42,
    cadence_slope_shrunk_spm_per_mps: 12.0,
    cadence_slope_weight: 0.55,
    decoupling_pct: 3.1,
    // A steady run of 40 fitted minutes is in the population decoupling is
    // interpretable over, so it carries a smoothed value.
    is_aerobic_long_run: true,
    decoupling_smoothed_pct: 4.2,
    fit_seconds: 2400,
    ...overrides,
  }
}

function trendsFixture(items: TrendPoint[], references: ReferencePaces = REFERENCES): TrendsResponse {
  return {
    references,
    hr_slope_shared_bpm_per_mps: items.length === 0 ? null : 20.5,
    cadence_slope_shared_spm_per_mps: items.length === 0 ? null : 12.5,
    items,
  }
}

function fitnessPoint(overrides: Partial<FitnessPoint> = {}): FitnessPoint {
  return {
    activity_id: 'steady-run',
    start_time_utc: '2025-10-12T16:30:00Z',
    hr_vo2max: 50.0,
    hr_vo2max_smoothed: 49.0,
    vdot: 40.0,
    vdot_distance_key: '5k',
    vdot_smoothed: 39.0,
    qualifying_segments: 48,
    ...overrides,
  }
}

const NO_PREDICTIONS: Predictions = {
  items: [],
  insufficient_data: true,
  reason: 'Fewer than two eligible efforts at any distance.',
}

function mockApi({
  trends = trendsFixture([trendPoint()]),
  fitness = [fitnessPoint()],
  device = [],
  predictions = NO_PREDICTIONS,
}: {
  trends?: TrendsResponse
  fitness?: FitnessPoint[]
  device?: DeviceVo2maxPoint[]
  predictions?: Predictions
} = {}): void {
  getMock.mockImplementation((path: string) => {
    if (path === '/api/trends') return Promise.resolve({ data: trends, error: undefined })
    if (path === '/api/fitness') return Promise.resolve({ data: { items: fitness, device }, error: undefined })
    if (path === '/api/predictions') return Promise.resolve({ data: predictions, error: undefined })
    return Promise.resolve({ data: undefined, error: { detail: `unmocked ${path}` } })
  })
}

function renderTrends() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <Trends />
    </QueryClientProvider>,
  )
}

function chartCalled(ariaLabel: string): TrendChartProps {
  const call = trendChartCalls.filter((c) => c.ariaLabel === ariaLabel).at(-1)
  if (call === undefined) throw new Error(`no TrendChart rendered with aria label "${ariaLabel}"`)
  return call
}

beforeEach(() => {
  getMock.mockReset()
  trendChartCalls.length = 0
})

describe('Trends', () => {
  it('has a heading, like every view', async () => {
    mockApi()
    renderTrends()
    expect(await screen.findByRole('heading', { level: 1, name: 'Trends' })).toBeInTheDocument()
  })

  it('orders the page by what is most interesting', async () => {
    // The order is a decision, not a consequence of which guard each section
    // sat inside. VO2max, race predictions and heart rate are the
    // maintainer's stated order; cadence follows heart rate because they are the same
    // chart of the same fit and read as a pair, decoupling follows as the
    // other aerobic signal, and the slope closes as a stated non-finding
    // rather than opening with one. This supersedes an earlier order, which
    // put VO2max between the two reference-pace charts.
    mockApi()
    renderTrends()
    await screen.findByRole('img', { name: 'VO2max' })

    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(headings).toEqual([
      'VO2max',
      'Race predictions',
      'Heart rate at the reference paces',
      'Cadence at the reference paces',
      'Aerobic decoupling',
      'Cadence slope',
    ])
  })

  it('gives the decoupling section the anchor the activity page links to', async () => {
    // components/Decoupling.tsx links to /trends#decoupling; without this id
    // the link lands at the top of the page, five charts above the one it names.
    mockApi()
    renderTrends()
    await screen.findByRole('img', { name: 'VO2max' })
    const anchored = document.getElementById('decoupling')
    expect(anchored).not.toBeNull()
    expect(within(anchored as HTMLElement).getByRole('heading', { level: 2 })).toHaveTextContent('Aerobic decoupling')
  })

  it('scrolls to the section the URL names once the charts above it have loaded', async () => {
    // The router tries the hash on navigation, before any chart has data;
    // the charts above then grow and push the section out of view.
    const scrolled: Element[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    }
    window.location.hash = '#decoupling'
    try {
      mockApi()
      renderTrends()
      await screen.findByRole('img', { name: 'VO2max' })
      await waitFor(() => expect(scrolled.map((el) => el.id)).toEqual(['decoupling']))
    } finally {
      Element.prototype.scrollIntoView = original
      window.location.hash = ''
    }
  })

  it('does not scroll when the URL names no section', async () => {
    const scrolled: Element[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    }
    try {
      mockApi()
      renderTrends()
      await screen.findByRole('img', { name: 'VO2max' })
      expect(scrolled).toEqual([])
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it('draws the VO2max chart taller than the others, so a trend is separable', async () => {
    // Two smoothed series that can sit far apart, with raw points beneath,
    // need the vertical room to read as a trend rather than as a band.
    mockApi()
    renderTrends()
    await screen.findByRole('img', { name: 'VO2max' })

    expect(chartCalled('VO2max').height).toBe('tall')
    expect(chartCalled('Heart rate at the reference paces').height).not.toBe('tall')
  })

  it('says the effort filter removes per-run points without changing a smoothed value', async () => {
    // Unticking a tag removes points from two charts and changes no plotted
    // value anywhere. Without this the reader watches points vanish under a
    // level that holds still and reads it as broken.
    //
    // The note has to give the right reason for each half. On the heart
    // rate and cadence charts it is that every line on them is a trailing
    // mean the analysis layer computes over the unfiltered history. On
    // decoupling and VO2max it is that the charts are outside the filter
    // altogether - the VO2max chart draws a raw per-run scatter of its own,
    // so calling its series trailing means is false, and a reader who
    // unticks a tag and sees those dots survive is owed the real reason.
    //
    // The claim is about values and not about pixels, and the note has to
    // keep the two apart: the y scale is `paddedRange` over every series
    // including the scatter, so points leaving really does rescale the axis
    // and redraw the same line at a different height. Said loosely as "the
    // lines do not move", the note is contradicted by the first tick a
    // reader makes.
    mockApi()
    renderTrends()
    const filter = (await screen.findByRole('group', { name: 'Effort' }))
    expect(filter).toHaveTextContent(/per-run points on the heart rate and cadence charts/i)
    expect(filter).toHaveTextContent(/trailing means over the whole history, so their values do not change/i)
    expect(filter).toHaveTextContent(/axis rescales as points come and go/i)
    expect(filter).toHaveTextContent(/aerobic decoupling and VO2max charts are outside the filter entirely/i)
    // And not by calling them means: the VO2max chart's own scatter is raw
    // per-run `hr_vo2max`, which its lede two sections down advertises.
    expect(filter).not.toHaveTextContent(/VO2max series are (all )?trailing means/i)
  })

  it('names the three reference paces from the payload, as paces', async () => {
    mockApi()
    renderTrends()
    const chart = await screen.findByRole('img', { name: 'Heart rate at the reference paces' })
    expect(within(chart).getByText('6:40/km')).toBeInTheDocument()
    expect(within(chart).getByText('6:15/km')).toBeInTheDocument()
    expect(within(chart).getByText('5:20/km')).toBeInTheDocument()
  })

  it('takes the labels from the payload rather than from constants: other references, other labels', async () => {
    // The references drift slightly as history grows (they are whole-history
    // quantities), so a label pinned in the component would go
    // stale the first recompute after a new run.
    mockApi({ trends: trendsFixture([trendPoint()], { slow_mps: 3.0, median_mps: 3.2, fast_mps: 3.5 }) })
    renderTrends()
    const chart = await screen.findByRole('img', { name: 'Cadence at the reference paces' })
    expect(within(chart).getByText('5:33/km')).toBeInTheDocument()
    expect(within(chart).getByText('5:13/km')).toBeInTheDocument()
    expect(within(chart).getByText('4:46/km')).toBeInTheDocument()
    expect(within(chart).queryByText('6:40/km')).toBeNull()
  })

  it('hands each chart the per-activity values at each pace, at the local time of day', async () => {
    mockApi()
    renderTrends()
    await screen.findByRole('img', { name: 'Heart rate at the reference paces' })
    // Three smoothed lines, then the one raw scatter for the median
    // reference. The lines are the stored trailing means, not this run's
    // own values - see "plots the smoothed series" above.
    const hr = chartCalled('Heart rate at the reference paces')
    expect(hr.series.map((s) => s.points[0]?.v)).toEqual([140.5, 142.5, 144.5, 142.0])
    expect(hr.yLabel).toBe('bpm')
    const cadence = chartCalled('Cadence at the reference paces')
    expect(cadence.series.map((s) => s.points[0]?.v)).toEqual([160.5, 162.5, 164.5, 162.0])
    expect(cadence.yLabel).toBe('spm')
    // 2025-10-12 18:30:00 local: day 20373 since the epoch, 66 600 s into it.
    const t = hr.series[0]?.points[0]?.t
    if (t === undefined) throw new Error('no first point')
    expect(Math.floor(t)).toBe(20373)
    expect(t - Math.floor(t)).toBeCloseTo(66_600 / 86_400, 9)
  })

  it('plots the smoothed series, not the raw per-run values', async () => {
    // The raw run-to-run step is several times the gap between the three
    // references (`docs/reference/math/efficiency.md`), so plotting the raw
    // values is what made the three lines one band. The smoothing is the
    // analysis layer's: this view plots a stored column.
    mockApi({
      trends: trendsFixture([
        trendPoint({
          hr_at_slow_bpm: 140.0,
          hr_at_median_bpm: 142.0,
          hr_at_fast_bpm: 144.0,
          hr_at_slow_smoothed_bpm: 156,
          hr_at_median_smoothed_bpm: 157,
          hr_at_fast_smoothed_bpm: 158,
        }),
      ]),
    })
    renderTrends()
    await screen.findByRole('img', { name: 'Heart rate at the reference paces' })

    const lines = chartCalled('Heart rate at the reference paces').series.filter((s) => s.scatter !== true)
    expect(lines.map((s) => s.points[0]?.v)).toEqual([156, 157, 158])
  })

  it('keeps the raw per-run values beneath the median line only', async () => {
    // One scatter, not three: the smoothing must not hide its own inputs -
    // the VO2max chart's rule - but three scatters behind three lines is
    // the unreadable band again.
    mockApi()
    renderTrends()
    await screen.findByRole('img', { name: 'Heart rate at the reference paces' })

    const scatter = chartCalled('Heart rate at the reference paces').series.filter((s) => s.scatter === true)
    expect(scatter).toHaveLength(1)
    expect(scatter[0]?.points[0]?.v).toBe(142.0)
    // Tied to the median line's own step of the ramp rather than taking a
    // fourth colour.
    expect(scatter[0]?.colorVar).toBe('--pace-2')
  })

  it('colours the three paces with the sequential ramp, light to dark', async () => {
    // Ordinal, so a ramp rather than the categorical palette, and in the
    // ramp's own order: the slow reference is the lightest step. Line
    // weight no longer says anything - see `TrendChart.test.tsx`.
    mockApi()
    renderTrends()
    await screen.findByRole('img', { name: 'Heart rate at the reference paces' })

    for (const label of ['Heart rate at the reference paces', 'Cadence at the reference paces']) {
      const lines = chartCalled(label).series.filter((s) => s.scatter !== true)
      expect(lines.map((s) => s.colorVar)).toEqual(['--pace-1', '--pace-2', '--pace-3'])
    }
  })

  it('shows each point\'s effort tag, since all-out sessions sit several bpm higher at the same speed', async () => {
    mockApi({
      trends: trendsFixture([
        trendPoint({ activity_id: 'a', start_time_utc: '2025-10-01T16:00:00Z', effort_tag: 'easy' }),
        trendPoint({ activity_id: 'b', start_time_utc: '2025-10-01T16:00:00Z', effort_tag: 'all_out' }),
      ]),
    })
    renderTrends()
    await screen.findByRole('img', { name: 'Heart rate at the reference paces' })
    const hr = chartCalled('Heart rate at the reference paces')
    expect(hr.series[0]?.points.map((p) => p.note)).toEqual(['Easy', 'All out'])
  })

  /** The raw per-run scatter, the one series on a pace chart the effort filter reaches. */
  function scatterOf(ariaLabel: string): TrendChartProps['series'][number] {
    const series = chartCalled(ariaLabel).series.filter((s) => s.scatter === true)
    if (series.length !== 1) throw new Error(`expected one scatter on "${ariaLabel}", found ${String(series.length)}`)
    const only = series[0]
    if (only === undefined) throw new Error('unreachable: length checked')
    return only
  }

  /** The three smoothed reference-pace lines, which no filter may move. */
  function linesOf(ariaLabel: string): TrendChartProps['series'] {
    return chartCalled(ariaLabel).series.filter((s) => s.scatter !== true)
  }

  it('filters the per-run points by effort tag, so a reader can take the all-out sessions out', async () => {
    mockApi({
      trends: trendsFixture([
        trendPoint({ activity_id: 'a', start_time_utc: '2025-10-01T16:00:00Z', effort_tag: 'easy' }),
        trendPoint({ activity_id: 'b', start_time_utc: '2025-10-01T16:00:00Z', effort_tag: 'all_out' }),
        trendPoint({ activity_id: 'c', start_time_utc: '2025-10-15T16:00:00Z', effort_tag: null }),
      ]),
    })
    renderTrends()
    const filter = await screen.findByRole('group', { name: 'Effort' })
    // One box per tag the payload holds, in the classifier's order, plus
    // one for the runs it could not tag; not a box per possible tag.
    expect(within(filter).getAllByRole('checkbox').map((box) => box.getAttribute('name'))).toEqual([
      'easy',
      'all_out',
      'untagged',
    ])
    expect(scatterOf('Heart rate at the reference paces').points).toHaveLength(3)

    fireEvent.click(within(filter).getByRole('checkbox', { name: 'All out' }))

    // The all-out sessions sit several bpm higher at the same speed, and
    // being able to take those points out is the reason this filter exists.
    expect(scatterOf('Heart rate at the reference paces').points).toHaveLength(2)
    // Cadence follows the same filter, not the heart rate chart alone.
    expect(scatterOf('Cadence at the reference paces').points).toHaveLength(2)
  })

  it('leaves the three smoothed pace lines untouched when an effort tag is unticked', async () => {
    // Each smoothed value is a trailing 42-day mean ending at its own run,
    // so dropping a run deletes a sample of the mean series rather than
    // filtering it: the dropped date leaves the shared x axis and uPlot
    // draws a straight chord over it, at values the analysis layer never
    // computed. The same argument took decoupling and VO2max out of the
    // filter. The filter's note promises these values hold still.
    mockApi({
      trends: trendsFixture([
        trendPoint({ activity_id: 'a', start_time_utc: '2025-10-01T16:00:00Z', effort_tag: 'easy' }),
        trendPoint({ activity_id: 'b', start_time_utc: '2025-10-01T16:00:00Z', effort_tag: 'all_out' }),
        trendPoint({ activity_id: 'c', start_time_utc: '2025-10-15T16:00:00Z', effort_tag: 'easy' }),
      ]),
    })
    renderTrends()
    const filter = await screen.findByRole('group', { name: 'Effort' })
    const hrLinesBefore = linesOf('Heart rate at the reference paces')
    const cadenceLinesBefore = linesOf('Cadence at the reference paces')
    expect(hrLinesBefore).toHaveLength(3)

    fireEvent.click(within(filter).getByRole('checkbox', { name: 'All out' }))

    // The scatter did lose the middle run, so the tick registered - and the
    // run it removed was between two others, which is the case that would
    // have bridged a chord across a date the lines still have.
    expect(scatterOf('Heart rate at the reference paces').points).toHaveLength(2)
    expect(linesOf('Heart rate at the reference paces')).toEqual(hrLinesBefore)
    expect(linesOf('Cadence at the reference paces')).toEqual(cadenceLinesBefore)
  })

  it('leaves the decoupling series untouched when an effort tag is unticked', async () => {
    // Every point on that chart is a 90-day mean over the aerobic long-run
    // population, so dropping members of the population does not filter the
    // mean, it recomputes it through fewer runs and draws a different line -
    // the same reason VO2max is outside the filter. The filter's note
    // promises this chart's values do not change, and this holds it to it.
    mockApi({
      trends: trendsFixture([
        trendPoint({
          activity_id: 'a',
          start_time_utc: '2025-10-01T16:00:00Z',
          effort_tag: 'steady',
          is_aerobic_long_run: true,
          decoupling_smoothed_pct: 4.2,
        }),
        trendPoint({
          activity_id: 'b',
          start_time_utc: '2025-10-01T16:00:00Z',
          effort_tag: 'easy',
          is_aerobic_long_run: true,
          decoupling_smoothed_pct: 5.6,
        }),
      ]),
    })
    renderTrends()
    const filter = await screen.findByRole('group', { name: 'Effort' })
    const before = chartCalled('Aerobic decoupling').series[0]?.points

    fireEvent.click(within(filter).getByRole('checkbox', { name: 'Steady' }))

    // The heart rate scatter did lose its steady run, so the tick registered.
    expect(scatterOf('Heart rate at the reference paces').points).toHaveLength(1)
    expect(chartCalled('Aerobic decoupling').series[0]?.points).toEqual(before)
  })

  it('plots only the runs decoupling is interpretable on, and says which', async () => {
    // `decoupling_smoothed_pct` is the trailing 90-day mean over the
    // aerobic-long-run population, so at a run outside that population the
    // quantity is not defined rather than unmeasured - the analysis layer
    // masks the output as well as the input, so most fitted runs carry no
    // value. Passing them through as nulls would give isolated dots and no
    // line at all, since `TrendChart` breaks at every null and never spans a
    // gap, so the series is built from the population alone.
    mockApi({
      trends: trendsFixture([
        trendPoint({ activity_id: 'long', is_aerobic_long_run: true, decoupling_smoothed_pct: 4.2 }),
        trendPoint({
          activity_id: 'session',
          start_time_utc: '2025-10-15T16:00:00Z',
          is_aerobic_long_run: false,
          decoupling_smoothed_pct: null,
        }),
      ]),
    })
    renderTrends()
    await screen.findByRole('img', { name: 'Aerobic decoupling' })

    const chart = chartCalled('Aerobic decoupling')
    expect(chart.series[0]?.points.map((p) => p.v)).toEqual([4.2])
    expect(chart.referenceLine?.value).toBe(5)

    const section = screen.getByRole('heading', { name: 'Aerobic decoupling' }).closest('section')
    expect(section).toHaveTextContent(/easy or steady runs of 40 minutes or more/i)
  })

  it('states the absence for decoupling against its own population, not the effort filter', async () => {
    // A store whose every run is outside the population is not the same
    // fact as a reader unticking every effort tag, and the two must not
    // share a sentence.
    mockApi({
      trends: trendsFixture([
        trendPoint({ activity_id: 'a', is_aerobic_long_run: false, decoupling_smoothed_pct: null }),
      ]),
    })
    renderTrends()
    await screen.findByRole('img', { name: 'Heart rate at the reference paces' })

    expect(chartCalled('Aerobic decoupling').emptyReason).toMatch(/easy or steady/i)
  })

  it('empties the per-run points but not the charts when every effort is unticked', async () => {
    // Unticking everything is now a statement about the points, not about
    // the charts: the lines are the whole history and stay up. So no chart
    // reaches its absent state this way, and none of the absent reasons may
    // blame a selection or send the reader to `recompute` for a filter they
    // can undo with a click.
    mockApi({
      trends: trendsFixture([trendPoint({ activity_id: 'a', effort_tag: 'easy' })]),
    })
    renderTrends()
    const filter = await screen.findByRole('group', { name: 'Effort' })

    fireEvent.click(within(filter).getByRole('checkbox', { name: 'Easy' }))

    for (const label of ['Heart rate at the reference paces', 'Cadence at the reference paces']) {
      expect(scatterOf(label).points).toHaveLength(0)
      expect(linesOf(label).every((s) => s.points.length === 1)).toBe(true)
      expect(chartCalled(label).emptyReason).not.toMatch(/selection/i)
      expect(chartCalled(label).emptyReason).not.toMatch(/recompute/)
    }
    // Decoupling states its own population, for the reason
    // `decouplingSeriesFrom` records - its absence is a different fact.
    expect(chartCalled('Aerobic decoupling').emptyReason).toMatch(/easy or steady/i)
    expect(chartCalled('Aerobic decoupling').emptyReason).not.toMatch(/recompute/)
    expect(chartCalled('Aerobic decoupling').emptyReason).not.toMatch(/selection/i)
  })

  it('dates every point at the local time of day, so two runs on one day stay two points', async () => {
    mockApi({
      trends: trendsFixture([
        trendPoint({ activity_id: 'a', start_time_utc: '2025-10-01T06:00:00Z', utc_offset_s: 7200 }),
        trendPoint({ activity_id: 'b', start_time_utc: '2025-10-01T16:00:00Z', utc_offset_s: 7200 }),
      ]),
    })
    renderTrends()
    await screen.findByRole('img', { name: 'Heart rate at the reference paces' })
    const points = chartCalled('Heart rate at the reference paces').series[0]?.points ?? []
    expect(points.map((p) => p.t)).toEqual([
      localCalendarTime('2025-10-01T06:00:00Z', 7200),
      localCalendarTime('2025-10-01T16:00:00Z', 7200),
    ])
    expect(new Set(points.map((p) => Math.floor(p.t))).size).toBe(1)
  })

  it('plots the smoothed decoupling average over time', async () => {
    mockApi()
    renderTrends()
    await screen.findByRole('img', { name: 'Aerobic decoupling' })
    // The stored 90-day mean, not this run's own `decoupling_pct`: read
    // across one session the raw value measures the session.
    expect(chartCalled('Aerobic decoupling').series[0]?.points[0]?.v).toBe(4.2)
    expect(chartCalled('Aerobic decoupling').yLabel).toBe('%')
  })

  it('states the cadence slope section without calling it an improvement, and draws no chart', async () => {
    // One run is too few to say whether the slope trends, so the finding
    // says so rather than quoting a figure from somebody else's history.
    mockApi()
    renderTrends()
    const section = (await screen.findByRole('heading', { name: 'Cadence slope' })).closest('section')
    if (section === null) throw new Error('the slope readout has no section')
    expect(section).toHaveTextContent(
      'Whether this slope trends needs at least 20 runs with a fitted slope, and 1 run carries one so far.',
    )
    expect(section).not.toHaveTextContent(/standard error/)
    expect(section).not.toHaveTextContent(/improvement/i)
  })

  it('counts the runs that carry a slope, not every fitted run, when there are too few', async () => {
    // A watch with no cadence channel still gets an efficiency row per run,
    // with a null cadence slope: 40 fitted runs, 12 of them with a slope.
    const items = Array.from({ length: 40 }, (_, index) =>
      trendPoint({
        activity_id: `run-${String(index)}`,
        start_time_utc: new Date(Date.UTC(2025, 0, 1 + 7 * index, 7)).toISOString().replace('.000', ''),
        cadence_slope_shrunk_spm_per_mps: index < 12 ? 9.5 : null,
      }),
    )
    mockApi({ trends: trendsFixture(items) })
    renderTrends()
    const section = (await screen.findByRole('heading', { name: 'Cadence slope' })).closest('section')
    if (section === null) throw new Error('the slope readout has no section')
    expect(section).toHaveTextContent(
      'Whether this slope trends needs at least 20 runs with a fitted slope, and 12 runs carry one so far.',
    )
    // The shared slope from the payload, formatted, not a constant.
    expect(section).toHaveTextContent('+12.5 spm per m/s')
    // And no chart. A quantity that does not trend, in a unit as abstract
    // as steps per minute per metre per second, is what the maintainer read
    // as not making sense; the sentence carrying the figure does the job the chart
    // did not. The readout stays.
    expect(within(section).queryByRole('img')).toBeNull()
  })

  it('draws both VO2max estimates smoothed with the raw heart-rate points faintly beneath, and says the level is a model output', async () => {
    mockApi()
    renderTrends()
    await screen.findByRole('img', { name: 'VO2max' })
    const chart = chartCalled('VO2max')
    expect(chart.series.map((s) => [s.label, s.scatter === true, s.points[0]?.v])).toEqual([
      ['Heart rate based, 42-day mean', false, 49.0],
      ['Performance based (VDOT), 42-day mean', false, 39.0],
      ['Heart rate based, per run', true, 50.0],
    ])
    // The raw points share their smoothed line's hue rather than taking a
    // third palette entry.
    expect(chart.series[2]?.paletteSlot).toBe(1)
    const section = screen.getByRole('heading', { name: 'VO2max' }).closest('section')
    expect(section).toHaveTextContent(/level is a model output/i)
    expect(section).toHaveTextContent(/only the trend/i)
    // One run is too few for the offset to VDOT, so the paragraph keeps
    // only the sentence that holds on any history. The offset in units an
    // earlier measurement quoted must not reappear either.
    expect(section).toHaveTextContent(/scales directly with the configured maximum heart rate/)
    expect(section).not.toHaveTextContent(/above VDOT|below VDOT/)
    expect(section).not.toHaveTextContent(/units above/)
  })

  it("draws Garmin's VO2max as a third line in palette slot 3, with the watch's number as a third readout", async () => {
    mockApi({
      device: [
        { calendar_date: '2025-10-01', vo2max: 44.62, vo2max_reported: 45 },
        { calendar_date: '2025-10-02', vo2max: 45.62, vo2max_reported: 46 },
      ],
    })
    renderTrends()
    await screen.findByRole('img', { name: 'VO2max' })
    const garmin = chartCalled('VO2max').series.find((s) => s.label === 'Garmin (watch)')
    expect(garmin?.paletteSlot).toBe(3)
    expect(garmin?.markLatest).toBe(true)
    expect(garmin?.holdsLastForReadout).toBe(true)
    // Garmin's days sit at the start of the day, rarely on a run, so the two
    // means hold too and read as of that instant; the raw points do not.
    expect(chartCalled('VO2max').series.map((s) => [s.label, s.holdsLastForReadout === true])).toEqual([
      ['Heart rate based, 42-day mean', true],
      ['Performance based (VDOT), 42-day mean', true],
      ['Heart rate based, per run', false],
      ['Garmin (watch)', true],
    ])
    expect(garmin?.points.map((p) => [p.t, p.v])).toEqual([
      [20362, 44.62],
      [20363, 45.62],
    ])
    const section = screen.getByRole('heading', { name: 'VO2max' }).closest('section')
    if (section === null) throw new Error('no VO2max section')
    expect(within(section).getByText('Garmin')).toBeInTheDocument()
    expect(within(section).getByText('46')).toBeInTheDocument()
    expect(within(section).getByText('as the watch shows it')).toBeInTheDocument()
    expect(section).toHaveTextContent("Two estimates, and the watch's own")
  })

  it('draws no Garmin line, readout or note without Garmin data, exactly as before', async () => {
    mockApi()
    renderTrends()
    await screen.findByRole('img', { name: 'VO2max' })
    expect(chartCalled('VO2max').series.map((s) => s.label)).not.toContain('Garmin (watch)')
    const section = screen.getByRole('heading', { name: 'VO2max' }).closest('section')
    expect(section).toHaveTextContent('Two estimates, from different evidence')
    expect(section).not.toHaveTextContent('as the watch shows it')
  })

  it("keeps Garmin's days that start before every estimate, widening the axis rather than dropping them", async () => {
    mockApi({ device: [{ calendar_date: '2023-09-10', vo2max: 44.02, vo2max_reported: 44 }] })
    renderTrends()
    await screen.findByRole('img', { name: 'VO2max' })
    const garmin = chartCalled('VO2max').series.find((s) => s.label === 'Garmin (watch)')
    expect(garmin?.points).toHaveLength(1)
  })

  it("shows the absent state when there is no estimate, even with Garmin's data", async () => {
    mockApi({ fitness: [], device: [{ calendar_date: '2025-10-01', vo2max: 44.62, vo2max_reported: 45 }] })
    renderTrends()
    expect(await screen.findByText('No VO2max yet')).toBeInTheDocument()
    expect(trendChartCalls.some((c) => c.ariaLabel === 'VO2max')).toBe(false)
    const section = screen.getByRole('heading', { name: 'VO2max' }).closest('section')
    expect(section).toHaveTextContent('Two estimates, from different evidence')
    expect(section).not.toHaveTextContent("the watch's own")
    expect(section).not.toHaveTextContent('the third line')
  })

  it('dates a VO2max point by its own activity\'s offset, so it lands on the same day as its trend point', async () => {
    // 22:30Z on 1 October at UTC+2 is 00:30 local on the 2nd. `FitnessPoint`
    // carries no offset, so without the join by activity id the same run sat
    // on the 1st here and the 2nd on every other chart on the page.
    mockApi({
      trends: trendsFixture([
        trendPoint({ activity_id: 'late-run', start_time_utc: '2025-10-01T22:30:00Z', utc_offset_s: 7200 }),
      ]),
      fitness: [fitnessPoint({ activity_id: 'late-run', start_time_utc: '2025-10-01T22:30:00Z' })],
    })
    renderTrends()
    await screen.findByRole('img', { name: 'VO2max' })

    const trendT = chartCalled('Heart rate at the reference paces').series[0]?.points[0]?.t
    const fitnessT = chartCalled('VO2max').series[0]?.points[0]?.t
    if (trendT === undefined || fitnessT === undefined) throw new Error('a chart has no point')
    // 2025-10-02 is day 20363.
    expect(Math.floor(trendT)).toBe(20363)
    expect(Math.floor(fitnessT)).toBe(20363)
  })

  it('falls back to the UTC day for a VO2max point the trends payload does not carry, rather than assuming home', async () => {
    mockApi({
      trends: trendsFixture([trendPoint({ activity_id: 'other', start_time_utc: '2025-10-01T08:00:00Z' })]),
      fitness: [fitnessPoint({ activity_id: 'not-in-trends', start_time_utc: '2025-10-01T22:30:00Z' })],
    })
    renderTrends()
    await screen.findByRole('img', { name: 'VO2max' })

    const fitnessT = chartCalled('VO2max').series[0]?.points[0]?.t
    if (fitnessT === undefined) throw new Error('the VO2max chart has no point')
    // 2025-10-01 is day 20362: the UTC day, not a guessed local one.
    expect(Math.floor(fitnessT)).toBe(20362)
  })

  it('states the absence in words on a store with no efficiency rows, and draws no chart', async () => {
    mockApi({ trends: trendsFixture([], { slow_mps: null, median_mps: null, fast_mps: null }), fitness: [] })
    renderTrends()
    const notes = await screen.findAllByRole('note')
    expect(notes.map((n) => n.textContent).join(' ')).toMatch(/No efficiency fit/)
    expect(notes.map((n) => n.textContent).join(' ')).toMatch(/No VO2max/)
    expect(screen.queryByTestId('trend-chart')).toBeNull()
  })

  it('renders the failure as an alert when a request fails, not an empty chart', async () => {
    getMock.mockResolvedValue({ data: undefined, error: { detail: 'DuckDB: file not found' } })
    renderTrends()
    const alerts = await screen.findAllByRole('alert')
    expect(alerts[0]).toHaveTextContent(/file not found/)
    expect(screen.queryByTestId('trend-chart')).toBeNull()
  })
})

describe('Trends race predictions', () => {
  it('reports the best-effort models as one range, with each model beneath it', async () => {
    // The API leaves this to the frontend on purpose: `RaceModel`'s own
    // validator lets a best-effort model omit its band because "their
    // spread is the range across the two models, shown by the caller".
    mockApi({
      predictions: {
        insufficient_data: false,
        reason: null,
        items: [
          {
            distance_key: '10k',
            distance_m: 10000,
            models: [
              { model: 'riegel', predicted_time_s: 3000, low_s: null, high_s: null, source: 'best_efforts' },
              { model: 'cameron', predicted_time_s: 3120, low_s: null, high_s: null, source: 'best_efforts' },
              { model: 'ordinary_runs', predicted_time_s: 3060, low_s: 2940, high_s: 3180, source: 'ordinary_runs' },
            ],
          },
        ],
      },
    })
    renderTrends()
    const row = await screen.findByRole('row', { name: /10 km/ })

    // The range spans the faster and slower of the two, and the
    // ordinary-runs prediction is not folded into it.
    expect(within(row).getByText('50:00 to 52:00')).toBeInTheDocument()
    // Each model is still named, so a reader can see which end is whose,
    // with the analysis layer's key rendered as words.
    expect(within(row).getByText(/Riegel/)).toBeInTheDocument()
    expect(within(row).getByText(/Cameron/)).toBeInTheDocument()
    expect(within(row).queryByText('ordinary_runs')).toBeNull()
    // The ordinary-runs prediction keeps its own time, pace and band.
    expect(within(row).getByText('51:00')).toBeInTheDocument()
    expect(within(row).getByText('5:06/km')).toBeInTheDocument()
    expect(within(row).getByText('49:00 to 53:00')).toBeInTheDocument()
  })

  it('says the ordinary-runs prediction reads typical training, so it is not read as a second race prediction', async () => {
    // `docs/reference/math/predictions.md`: the calibration was fitted
    // against the best 5 km of ordinary training, so after a breakthrough
    // effort it sits slower than the best efforts by design.
    mockApi()
    renderTrends()
    const section = (await screen.findByRole('heading', { name: 'Race predictions' })).closest('section')
    if (section === null) throw new Error('no predictions section')
    expect(section).toHaveTextContent(/typical training/i)
    expect(section).toHaveTextContent(/breakthrough/i)
    expect(section).not.toHaveTextContent(/Critical speed/)
    expect(section).toHaveTextContent(/predictions\.md/)
  })

  it('explains each model where it is shown', async () => {
    // Model names in a table with nothing saying what they are, or
    // why they disagree, is what the maintainer read as unexplained. Every sentence
    // here is sourced from `docs/reference/math/predictions.md`, which owns
    // the claims.
    mockApi()
    renderTrends()
    const section = (await screen.findByRole('heading', { name: 'Race predictions' })).closest('section')
    if (section === null) throw new Error('no predictions section')

    const terms = within(section).getAllByRole('term')
    expect(terms.map((t) => t.textContent)).toEqual(['Riegel', 'Cameron', 'Ordinary runs'])

    // Each term's own definition, so a claim cannot satisfy this by
    // appearing somewhere else in the section.
    const definitions = within(section)
      .getAllByRole('definition')
      .map((d) => d.textContent ?? '')
    expect(definitions[0]).toMatch(/pace decays with distance/i)
    expect(definitions[1]).toMatch(/400 m to the marathon/i)
    expect(definitions[2]).toMatch(/calibrat/i)
    expect(definitions[2]).toMatch(/typical training/i)
  })

  it('keeps every computed distance when only some models dropped out, and states the reason beside the table', async () => {
    // `insufficient_data` is set whenever either source could not produce
    // a model (`docs/reference/api.md`): with no heart-rate estimate in the
    // window the best-effort models are still computed fine, and `Absent`
    // on that flag alone would discard them.
    mockApi({
      predictions: {
        insufficient_data: true,
        reason: 'no heart-rate VO2max estimate in the window, so there is no prediction from ordinary runs',
        items: [
          {
            distance_key: '1k',
            distance_m: 1000,
            models: [
              { model: 'riegel', predicted_time_s: 250, low_s: null, high_s: null, source: 'best_efforts' },
              { model: 'cameron', predicted_time_s: 258, low_s: null, high_s: null, source: 'best_efforts' },
            ],
          },
          { distance_key: '5k', distance_m: 5000, models: [] },
          {
            distance_key: '10k',
            distance_m: 10000,
            models: [
              { model: 'riegel', predicted_time_s: 3000, low_s: null, high_s: null, source: 'best_efforts' },
              { model: 'cameron', predicted_time_s: 3120, low_s: null, high_s: null, source: 'best_efforts' },
            ],
          },
        ],
      },
    })
    renderTrends()
    const section = (await screen.findByRole('heading', { name: 'Race predictions' })).closest('section')
    if (section === null) throw new Error('no predictions section')
    const table = await within(section).findByRole('table')
    const rows = within(table)
      .getAllByRole('row')
      .filter((row) => row.hasAttribute('data-distance-key'))
    expect(rows.map((row) => row.getAttribute('data-distance-key'))).toEqual(['1k', '5k', '10k'])
    // The distance with no ordinary-runs prediction still shows the range
    // across the models it has.
    expect(within(rows[0]!).getByText('4:10 to 4:18')).toBeInTheDocument()
    // A distance that lost every model renders the no-value glyph in both
    // cells rather than a blank row.
    expect(within(rows[1]!).getAllByText(NO_VALUE)).toHaveLength(2)
    expect(within(rows[2]!).getByText('50:00 to 52:00')).toBeInTheDocument()
    // The API's own prose, beside the table rather than in place of it.
    expect(within(section).getByRole('note')).toHaveTextContent('no prediction from ordinary runs')
    expect(within(section).queryByText('No predictions yet')).toBeNull()
  })

  it('states the reason in words when there is not enough data, rather than an empty table', async () => {
    mockApi()
    renderTrends()
    const section = (await screen.findByRole('heading', { name: 'Race predictions' })).closest('section')
    if (section === null) throw new Error('no predictions section')
    await within(section).findByRole('note')
    expect(within(section).getByRole('note')).toHaveTextContent('Fewer than two eligible efforts at any distance.')
    expect(within(section).queryByRole('table')).toBeNull()
  })
})

describe('Trends copy, computed from the viewer’s own history', () => {
  /** A run `i` days after 2025-01-01, at noon UTC. */
  function day(i: number): string {
    return new Date(Date.UTC(2025, 0, 1 + i, 12)).toISOString().replace('.000Z', 'Z')
  }

  async function sectionNamed(name: string): Promise<HTMLElement> {
    // Every chart has its data once the VO2max chart and the cadence slope
    // section are both drawn; before then a section's copy is not final.
    await screen.findByRole('img', { name: 'VO2max' })
    await screen.findByRole('heading', { name: 'Cadence slope' })
    const section = (await screen.findByRole('heading', { name })).closest('section')
    if (section === null) throw new Error(`no section headed "${name}"`)
    return section
  }

  const NO_HEART_RATE = { hr_at_slow_bpm: null, hr_at_median_bpm: null, hr_at_fast_bpm: null } as const

  it('says the heart rate record starts later, with the viewer’s counts, when the oldest runs carry none', async () => {
    mockApi({
      trends: trendsFixture([
        ...[0, 1, 2].map((i) => trendPoint({ activity_id: `old-${String(i)}`, start_time_utc: day(i), ...NO_HEART_RATE })),
        ...[3, 4, 5, 6].map((i) => trendPoint({ activity_id: `new-${String(i)}`, start_time_utc: day(i) })),
      ]),
    })
    renderTrends()
    const section = await sectionNamed('Heart rate at the reference paces')
    expect(section).toHaveTextContent(
      'The heart rate record starts later than the history does: 3 of the 7 runs the fit covers carry no heart rate at all, and they are the oldest 3, so this chart begins where the recording does rather than where the training does. The cadence chart below it covers all 7 and so runs the full span.',
    )
  })

  it('names how many come first when a run without heart rate also falls later', async () => {
    mockApi({
      trends: trendsFixture([
        trendPoint({ activity_id: 'a', start_time_utc: day(0), ...NO_HEART_RATE }),
        trendPoint({ activity_id: 'b', start_time_utc: day(1), ...NO_HEART_RATE }),
        trendPoint({ activity_id: 'c', start_time_utc: day(2) }),
        trendPoint({ activity_id: 'd', start_time_utc: day(3), ...NO_HEART_RATE, cadence_at_median_spm: null }),
      ]),
    })
    renderTrends()
    const section = await sectionNamed('Heart rate at the reference paces')
    expect(section).toHaveTextContent(
      '3 of the 4 runs the fit covers carry no heart rate at all, and the oldest 2 of them come before the first that does',
    )
    // One run carries no cadence, so the cadence chart does not cover all four.
    expect(section).not.toHaveTextContent(/covers all/)
  })

  it('says nothing about a late start when the first run carries heart rate', async () => {
    mockApi({
      trends: trendsFixture([
        trendPoint({ activity_id: 'a', start_time_utc: day(0) }),
        trendPoint({ activity_id: 'b', start_time_utc: day(1), ...NO_HEART_RATE }),
      ]),
    })
    renderTrends()
    const section = await sectionNamed('Heart rate at the reference paces')
    expect(section).not.toHaveTextContent(/record starts later/)
  })

  it('states the raw step against the gap between the paces, or leaves the clause out', async () => {
    // Alternating 140 and 150 at the median reference with the fast and
    // slow references 2 bpm apart: every step is 10, five times the gap.
    mockApi({
      trends: trendsFixture(
        Array.from({ length: 10 }, (_, i) =>
          trendPoint({
            activity_id: `run-${String(i)}`,
            start_time_utc: day(i),
            hr_at_slow_bpm: 140,
            hr_at_median_bpm: i % 2 === 0 ? 140 : 150,
            hr_at_fast_bpm: 142,
          }),
        ),
      ),
    })
    const { unmount } = renderTrends()
    expect(await sectionNamed('Heart rate at the reference paces')).toHaveTextContent(
      'faintly beneath them: run to run the quantity moves about 5 times further than the three paces are apart, so the raw lines would cross each other and say nothing.',
    )
    unmount()

    mockApi()
    renderTrends()
    const section = await sectionNamed('Heart rate at the reference paces')
    expect(section).toHaveTextContent("the median reference's own per-run values faintly beneath them. Lower over time")
    expect(section).not.toHaveTextContent(/times further/)
  })

  it('states the heart rate estimate’s offset from VDOT over the viewer’s own pairs', async () => {
    // Ratios of 1.4 and 1.6, five each: the median is 1.5, so 50% above,
    // and the ratio's sample standard deviation is sqrt(0.1 / 9).
    mockApi({
      fitness: Array.from({ length: 10 }, (_, i) =>
        fitnessPoint({ activity_id: `run-${String(i)}`, vdot_smoothed: 40, hr_vo2max_smoothed: i % 2 === 0 ? 56 : 64 }),
      ),
    })
    renderTrends()
    const section = await sectionNamed('VO2max')
    expect(section).toHaveTextContent(
      `Over the 10 runs that carry both, the heart rate based estimate sits 50% above VDOT at the median, with a standard deviation of ${trimmedNumber(100 * Math.sqrt(0.1 / 9))} percentage points in that offset. The level also scales directly with the configured maximum heart rate`,
    )
    // The 5 km comparison needs the backend's VDOT tables, so it is not stated.
    expect(section).not.toHaveTextContent(/5 km/)
  })

  it('compares both estimates with Garmin’s own over the runs that pair, and states no seasonal swing', async () => {
    // Garmin 40 and 50 on alternate days; the heart rate estimate 10% and 6%
    // above it in turn, a mean of 8%, and on only two distinct points, so
    // correlated at exactly 1; VDOT two thirds of Garmin's value throughout.
    const days = Array.from({ length: 20 }, (_, i) => i)
    const garmin = (i: number) => (i % 2 === 0 ? 40 : 50)
    mockApi({
      fitness: days.map((i) =>
        fitnessPoint({
          activity_id: `run-${String(i)}`,
          start_time_utc: day(i),
          hr_vo2max_smoothed: garmin(i) * (i % 2 === 0 ? 1.1 : 1.06),
          vdot_smoothed: (garmin(i) * 2) / 3,
        }),
      ),
      device: days.map((i) => ({
        calendar_date: day(i).slice(0, 10),
        vo2max: garmin(i),
        vo2max_reported: garmin(i),
      })),
    })
    renderTrends()
    const section = await sectionNamed('VO2max')
    expect(section).toHaveTextContent(
      "so it is a reference rather than a measurement. Paired with Garmin's value for each run's day, or the latest day before it, the smoothed heart rate estimate sits 8% above it on average over 20 runs and the two correlate at 1.00; VDOT sits 33.3% below it over 20 runs.",
    )
    expect(section).not.toHaveTextContent(/December|swings/)
  })

  it('keeps Garmin’s paragraph without figures when too few runs pair', async () => {
    mockApi({ device: [{ calendar_date: '2025-10-01', vo2max: 44.62, vo2max_reported: 45 }] })
    renderTrends()
    const section = await sectionNamed('VO2max')
    expect(section).toHaveTextContent(/is a model too/)
    expect(section).not.toHaveTextContent(/Paired with Garmin/)
  })

  it('reads the decoupling medians against the 5% line from the viewer’s own population', async () => {
    // Ten 40-minute runs at 6% to 15% and ten hour-long ones at 1% to 10%:
    // the population's median is 8%, the hour-long runs' 5.5%, both above.
    const runs = [
      ...Array.from({ length: 10 }, (_, i) =>
        trendPoint({ activity_id: `forty-${String(i)}`, start_time_utc: day(i), decoupling_pct: 6 + i, fit_seconds: 2400 }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        trendPoint({ activity_id: `hour-${String(i)}`, start_time_utc: day(20 + i), decoupling_pct: 1 + i, fit_seconds: 3600 }),
      ),
    ]
    mockApi({ trends: trendsFixture(runs) })
    const { unmount } = renderTrends()
    expect(await sectionNamed('Aerobic decoupling')).toHaveTextContent(
      'Over the 20 runs in the population the median reads +8.0%, above the 5% line conventionally taken as good aerobic durability; on the 10 of them of an hour or more it reads +5.5%, also above it.',
    )
    unmount()

    // Shift the hour-long runs down a point: 4.5% for them, under the line.
    mockApi({
      trends: trendsFixture(runs.map((r) => (r.fit_seconds === 3600 ? { ...r, decoupling_pct: (r.decoupling_pct ?? 0) - 1 } : r))),
    })
    renderTrends()
    expect(await sectionNamed('Aerobic decoupling')).toHaveTextContent(
      'the median reads +7.5%, above the 5% line conventionally taken as good aerobic durability; on the 10 of them of an hour or more it reads +4.5%, below it.',
    )
  })

  it('drops the decoupling medians when the population is too small to carry them', async () => {
    mockApi()
    renderTrends()
    const section = await sectionNamed('Aerobic decoupling')
    expect(section).not.toHaveTextContent(/in the population the median/)
    expect(section).not.toHaveTextContent(/percentage points apart/)
    // The population itself still stays in the open.
    expect(section).toHaveTextContent(/easy or steady runs of 40 minutes or more/i)
  })

  it('states how far apart the all-out and easy medians are on the viewer’s history', async () => {
    mockApi({
      trends: trendsFixture([
        ...Array.from({ length: 10 }, (_, i) =>
          trendPoint({ activity_id: `hard-${String(i)}`, start_time_utc: day(i), effort_tag: 'all_out', decoupling_pct: 10, is_aerobic_long_run: false }),
        ),
        ...Array.from({ length: 10 }, (_, i) =>
          trendPoint({ activity_id: `easy-${String(i)}`, start_time_utc: day(10 + i), effort_tag: 'easy', decoupling_pct: 8.5 }),
        ),
      ]),
    })
    renderTrends()
    expect(await sectionNamed('Aerobic decoupling')).toHaveTextContent(
      'it measures the session rather than the athlete, and on this history the median all-out session and the median easy one are 1.5 percentage points apart.',
    )
  })

  /** Twenty daily runs whose slope only wobbles and whose cadence level climbs. */
  const WOBBLE = [0.9, -1.1, 0.4, -0.2, 1.3, -0.7, -0.9, 0.6, 0.1, -1.2, 1.0, -0.3, 0.8, -0.5, 0.2, -0.8, 1.1, -0.4, 0.3, -0.6]
  const slopeAt = (i: number) => 12 + (WOBBLE[i] ?? 0)
  const levelAt = (i: number) => 160 + 0.3 * i + (i % 2 === 0 ? 1 : -1)
  const twenty = Array.from({ length: 20 }, (_, i) => i)

  it('states the slope’s trend against its own standard error, and the level’s beside it', async () => {
    mockApi({
      trends: trendsFixture(
        twenty.map((i) =>
          trendPoint({
            activity_id: `run-${String(i)}`,
            start_time_utc: day(i),
            cadence_slope_shrunk_spm_per_mps: slopeAt(i),
            cadence_at_median_spm: levelAt(i),
          }),
        ),
      ),
    })
    renderTrends()
    const section = await sectionNamed('Cadence slope')
    // The day number is a shift of the run index, so a trend on the index has the same t.
    const slopeT = Math.abs(linearTrend(twenty, twenty.map(slopeAt))?.t ?? Number.NaN)
    const levelT = Math.abs(linearTrend(twenty, twenty.map(levelAt))?.t ?? Number.NaN)
    expect(slopeT).toBeLessThan(2)
    expect(levelT).toBeGreaterThan(2)
    expect(section).toHaveTextContent(
      `Measured over the 20 runs that carry it, the trend in this shrunk slope is ${trimmedNumber(slopeT)} times its own standard error, which is not distinguishable from zero: it does not trend on this history.`,
    )
    expect(section).toHaveTextContent(
      `The readable form is the cadence chart above: at the median reference pace its level rises over this history, with a trend ${trimmedNumber(levelT)} times its own standard error over the 20 runs that carry it.`,
    )
    expect(section).not.toHaveTextContent(/improvement/i)
  })

  it('says every run takes the shared slope when the fit finds no spread between runs, not that there are too few', async () => {
    mockApi({
      trends: trendsFixture(
        twenty.map((i) =>
          trendPoint({
            activity_id: `run-${String(i)}`,
            start_time_utc: day(i),
            cadence_slope_shrunk_spm_per_mps: 12.5,
            cadence_at_median_spm: levelAt(i),
          }),
        ),
      ),
    })
    renderTrends()
    const section = await sectionNamed('Cadence slope')
    expect(section).toHaveTextContent(
      'Every one of the 20 runs that carry it takes the shared slope exactly, because their own slopes spread no further than their errors explain: it does not trend on this history.',
    )
    expect(section).not.toHaveTextContent(/needs at least/)
    expect(section).not.toHaveTextContent(/shrunk slope is 0 times/)
  })

  it('says a slope that does trend trends, in which direction, without calling it better', async () => {
    mockApi({
      trends: trendsFixture(
        twenty.map((i) =>
          trendPoint({
            activity_id: `run-${String(i)}`,
            start_time_utc: day(i),
            cadence_slope_shrunk_spm_per_mps: 15 - 0.2 * i + (i % 2 === 0 ? 0.5 : -0.5),
          }),
        ),
      ),
    })
    renderTrends()
    const section = await sectionNamed('Cadence slope')
    expect(section).toHaveTextContent(/times its own standard error: it falls over this history\./)
    expect(section).not.toHaveTextContent(/not distinguishable/)
    expect(section).not.toHaveTextContent(/improvement/i)
  })
})
