import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import type { components } from '../api/schema'
import type { VolumeBarsProps } from '../charts/VolumeBars'
import { Overview } from './Overview'

vi.mock('../api/client', () => ({
  api: { GET: vi.fn() },
}))

/**
 * `VolumeBars` needs a real layout engine jsdom does not have (see its own
 * test file's comment on mocking `uplot`), and this file's job is to check
 * what *Overview* hands the chart, not how the chart draws it - that is
 * `VolumeBars.test.tsx`'s job. So the whole component is replaced with a
 * spy that records its props, the same boundary `AppShell.test.tsx` draws
 * around the API client rather than the network.
 *
 * `ZoneBar` is deliberately *not* mocked below: it is plain SVG with no
 * layout engine dependency, so rendering it for real and reading its own
 * caption text is a strictly stronger check of the "current settings"
 * wording than inspecting a prop would be.
 */
const { volumeBarsCalls } = vi.hoisted(() => ({
  volumeBarsCalls: [] as VolumeBarsProps[],
}))
vi.mock('../charts/VolumeBars', () => ({
  VolumeBars: (props: VolumeBarsProps) => {
    volumeBarsCalls.push(props)
    return <div data-testid="volume-bars-stub" />
  },
}))

type Overview = components['schemas']['Overview']
type PeriodBucket = components['schemas']['PeriodBucket']
type ZoneTotal = components['schemas']['ZoneTotal']

function week(period_start: string, runs: number, distance_m: number, moving_time_s: number): PeriodBucket {
  return { period_start, runs, distance_m, moving_time_s }
}

// A 16-week dense series with two weeks off: one buried in history (index 2,
// outside the last-12 window below) and one that is the *current* week
// (the last entry) - the real, live shape of 2026-08-31, where the newest
// week held no run at all. Distinguishing
// the two matters: it is the only way to tell "the full-history strip kept
// every zero" apart from "the twelve-week window happened to include one."
const WEEKS: PeriodBucket[] = [
  week('2026-05-04', 3, 15230, 5000),
  week('2026-05-11', 4, 21000, 6200),
  week('2026-05-18', 0, 0, 0),
  week('2026-05-25', 3, 18000, 5400),
  week('2026-06-01', 4, 19000, 5800),
  week('2026-06-08', 3, 17500, 5100),
  week('2026-06-15', 4, 20500, 6000),
  week('2026-06-22', 3, 16800, 4950),
  week('2026-06-29', 4, 21200, 6300),
  week('2026-07-06', 3, 15900, 4700),
  week('2026-07-13', 4, 19800, 5900),
  week('2026-07-20', 3, 17200, 5050),
  week('2026-07-27', 4, 20100, 5950),
  week('2026-08-03', 3, 16500, 4850),
  week('2026-08-10', 4, 18700, 5500),
  week('2026-08-17', 0, 0, 0),
]

// The real device's six configured boundaries (see zoneBoundaries.test.ts),
// giving seven zones. Zone 6 ("above maximum") is included here with 0
// seconds, matching the real payload: every activity's own `zone_time`
// writes a row for every zone, this one included, even when it holds no
// time (`analysis/zones.py`'s `zone_time` seeds a full `zone_count`-row
// frame before ever checking whether there is usable heart rate), so a
// `GROUP BY zone_index` sum never drops a zero-second zone that at least
// one activity actually wrote a row for. Confirmed directly against
// `data/derived/zone_time.parquet` and a live `/api/overview` response: all
// 223 activities in the real store write a zone-6 row of 0.0 seconds, so
// the real array always has all seven indices. An earlier version of this
// fixture omitted zone 6 on the false assumption that it was absent from
// real data - see the code review that caught it.
const BOUNDARIES = [104, 124, 145, 166, 186, 207]
const ZONES: ZoneTotal[] = [
  { zone_index: 0, seconds_s: 60 },
  { zone_index: 1, seconds_s: 300 },
  { zone_index: 2, seconds_s: 600 },
  { zone_index: 3, seconds_s: 900 },
  { zone_index: 4, seconds_s: 4200 },
  { zone_index: 5, seconds_s: 200 },
  { zone_index: 6, seconds_s: 0 },
]

function overviewFixture(overrides: Partial<Overview> = {}): Overview {
  return {
    weeks: WEEKS,
    months: [],
    zones: ZONES,
    zone_boundaries_bpm: BOUNDARIES,
    streak: { current_weeks: 8, longest_weeks: 26, longest_ended_week: '2025-11-17' },
    consistency: { weeks_considered: 52, weeks_with_a_run: 48 },
    first_run_local_date: '2023-11-13',
    // Not `2026-08-17`, the current (zero-run) week's Monday: WEEKS says
    // that week held no run, so the last real run falls inside the
    // previous, non-zero week instead. Unused by Overview.tsx today, but
    // there is no reason for the fixture to contradict its own WEEKS array.
    last_run_local_date: '2026-08-14',
    last_activity_local_date: '2026-08-18',
    ...overrides,
  }
}

function mockOverview(overview: Overview) {
  vi.mocked(api.GET).mockResolvedValue({
    data: overview,
    error: undefined,
    response: new Response(),
  } as Awaited<ReturnType<typeof api.GET>>)
}

function renderOverview() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <Overview />
    </QueryClientProvider>,
  )
}

/** The whole stat rail group for one label: its term, value and any detail. */
function statGroup(container: HTMLElement, label: string): HTMLElement {
  const labelEl = within(container).getByText(label)
  const wrapper = labelEl.closest('div')
  if (wrapper === null) throw new Error(`stat wrapper for "${label}" not found`)
  return wrapper
}

/** The rendered value next to a stat rail label, e.g. "This week" -> "0.00 km". */
function statValue(container: HTMLElement, label: string): string {
  const labelEl = within(container).getByText(label)
  const wrapper = labelEl.closest('div')
  if (wrapper === null) throw new Error(`stat wrapper for "${label}" not found`)
  const valueEl = wrapper.querySelector('dd')
  if (valueEl === null) throw new Error(`no value rendered for "${label}"`)
  return valueEl.textContent ?? ''
}

beforeEach(() => {
  vi.mocked(api.GET).mockReset()
  volumeBarsCalls.length = 0
})

describe('Overview', () => {
  it('shows the stat rail as this week, the last four weeks, the streaks and consistency as a count out of a count', async () => {
    mockOverview(overviewFixture())
    const { container } = renderOverview()
    await screen.findByText('This week')

    // "This week" is the *last* entry of the dense series, not the first -
    // and it is genuinely 0 here, as it was live on 2026-08-31.
    expect(statValue(container, 'This week')).toBe('0.00 km')
    // "Last 4 weeks" sums the last four entries (20100 + 16500 + 18700 + 0 =
    // 55300 m), not the first four and not the whole series.
    expect(statValue(container, 'Last 4 weeks')).toBe('55.30 km')
    expect(statValue(container, 'Current streak')).toBe('8 weeks')
    expect(statValue(container, 'Longest streak')).toBe('26 weeks')
    expect(within(container).getByText(/through 17 November 2025/)).toBeInTheDocument()

    // A count out of a count, never a percentage: 48 of 52 is a fact, 92%
    // is a rounding of it that invites comparing against a target nobody
    // set (see docs/reference/math/consistency.md).
    //
    // Scoped to the consistency stat and its own detail line, not to the
    // whole page. It used to assert no percentage appeared anywhere in the
    // document, which was always a wider claim than the rule it came from
    // and became wrong the moment the zone rows started reporting each
    // zone's share of the activity - a genuinely different metric that is
    // a percentage on purpose.
    const consistency = statGroup(container, 'Consistency')
    expect(statValue(container, 'Consistency')).toBe('48 of 52')
    expect(consistency.textContent).not.toMatch(/\d+(\.\d+)?%/)
  })

  it('gives the twelve-week chart only the last twelve entries, and the full-history strip every entry with zero weeks marked', async () => {
    mockOverview(overviewFixture())
    renderOverview()
    await screen.findByText('This week')

    expect(volumeBarsCalls).toHaveLength(2)
    const [twelveWeekCall, fullHistoryCall] = volumeBarsCalls
    if (twelveWeekCall === undefined || fullHistoryCall === undefined) {
      throw new Error('expected two VolumeBars renders')
    }

    expect(twelveWeekCall.periods).toHaveLength(12)
    expect(twelveWeekCall.periods).toEqual(WEEKS.slice(-12))
    // The week-off buried in history at index 2 is outside this window, so
    // this call alone cannot tell a full series from a filtered one - the
    // next assertion is what actually proves that.
    expect(twelveWeekCall.periods.some((p) => p.period_start === '2026-05-18')).toBe(false)

    expect(fullHistoryCall.periods).toHaveLength(WEEKS.length)
    expect(fullHistoryCall.periods).toEqual(WEEKS)
    // Both zero weeks - the one buried in history and the current one -
    // must still be present, not closed up into an unbroken-looking series.
    expect(fullHistoryCall.periods.filter((p) => p.runs === 0)).toHaveLength(2)
    expect(fullHistoryCall.markEmpty).toBe(true)

    // Both series are weekly, and the hover readout names the period from
    // this prop - a monthly label over a week's bar would misattribute
    // every number in it.
    expect(twelveWeekCall.bucket).toBe('week')
    expect(fullHistoryCall.bucket).toBe('week')

    // The x axis labels differ even though the bucket does not. Over three
    // years the full-history strip's bare day-and-month ticks repeat the
    // same twelve month names without saying which year; across twelve
    // weeks the year is never in doubt and the day is what locates a bar.
    expect(twelveWeekCall.axisLabel).not.toBe('monthYear')
    expect(fullHistoryCall.axisLabel).toBe('monthYear')
  })

  describe('the full-history trend', () => {
    beforeEach(() => {
      // Only the clock is faked, so the query's own timers still run. A
      // Wednesday inside WEEKS' last week, which is therefore in progress.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2026, 7, 19, 12))
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    async function trendProps(overrides: Partial<Overview> = {}) {
      mockOverview(overviewFixture(overrides))
      renderOverview()
      await screen.findByText('This week')
      const [twelveWeekCall, fullHistoryCall] = volumeBarsCalls
      return { twelveWeek: twelveWeekCall?.trend, fullHistory: fullHistoryCall?.trend }
    }

    it('draws a 9-week average on the full-history strip and not on the twelve weeks', async () => {
      const { twelveWeek, fullHistory } = await trendProps()
      expect(twelveWeek).toBeUndefined()
      expect(fullHistory?.window).toBe(9)
    })

    it('ends before the week in progress', async () => {
      // The last activity is in the current week (index 15), so the line
      // ends on the week before it.
      const { fullHistory } = await trendProps()
      expect(fullHistory?.lastIndex).toBe(14)
    })

    it('ends at the week holding the last activity when the store stops earlier', async () => {
      // An export that ends on 2026-07-30 knows nothing of the two weeks
      // after it, so the line stops in the week of 27 July, index 12.
      const { fullHistory } = await trendProps({ last_activity_local_date: '2026-07-30' })
      expect(fullHistory?.lastIndex).toBe(12)
    })

    it('says in the section note that the line is the 9-week average', async () => {
      await trendProps()
      expect(screen.getByText(/9-week average/)).toBeInTheDocument()
    })
  })

  it('pairs each zone with its own boundary and its own seconds, not a neighbour\'s, and captions the boundaries as configured today', async () => {
    // On real data this join is equivalent whether it is driven from
    // `zone_boundaries_bpm` or from `overview.zones` (see the comment in
    // `Overview.tsx`): both sides already carry all seven indices in
    // order. So this test does not - and cannot - discriminate between
    // those two ways of writing the join; it only pins that the join
    // itself is correct, i.e. that a given zone's rendered edges and
    // seconds are actually *its own* and not shifted from a neighbour.
    mockOverview(overviewFixture())
    const { container } = renderOverview()
    await screen.findByText(/as configured today/i)

    // Six rows from seven zones: the payload carries all seven indices, and
    // the band above the last boundary is not drawn - see
    // `isAboveConfiguredRange` in `charts/ZoneBar.tsx` for why that is a
    // structural rule rather than "hide an empty zone".
    expect(container.querySelectorAll('tbody tr')).toHaveLength(6)

    /** One zone's rendered cells, in column order, as trimmed text. */
    function cellsFor(zoneIndex: number): string[] {
      const row = container.querySelector(`tr[data-zone="${String(zoneIndex)}"]`)
      if (row === null) throw new Error(`zone ${String(zoneIndex)} was not rendered`)
      return Array.from(row.querySelectorAll('th, td'), (cell) => cell.textContent?.trim() ?? '')
    }

    // The edges and the duration read off the *same* row, exactly, rather
    // than as substring checks: a low/high swap or an off-by-one on either
    // side of the join would still leave every individual number present
    // somewhere in a looser check, just attached to the wrong zone or
    // transposed within one. The bar cell is empty text, hence the gap.
    expect(cellsFor(1)).toEqual(['Z1', '104-124', '', '5:00', '5%'])
    expect(cellsFor(4)).toEqual(['Z4', '166-186', '', '1:10:00', '67%'])
    // Zone 5 is the last one drawn, and it is drawn from its own edge pair
    // rather than inheriting zone 6's open end when that row disappeared.
    expect(cellsFor(5)).toEqual(['Z5', '186-207', '', '3:20', '3%'])
    expect(container.querySelector('tr[data-zone="6"]')).toBeNull()
  })

  it('names ingest rather than drawing an empty chart when the store has no activities', async () => {
    mockOverview(overviewFixture({ weeks: [], zones: [], zone_boundaries_bpm: [] }))
    const { container } = renderOverview()
    await screen.findByText('No training data yet')

    expect(screen.getAllByText(/ingest/i).length).toBeGreaterThan(0)
    expect(container.querySelector('svg')).toBeNull()
    expect(volumeBarsCalls).toHaveLength(0)
  })

  it('shows the real failure message when the backend is unreachable', async () => {
    vi.mocked(api.GET).mockRejectedValue(new TypeError('fetch failed'))
    renderOverview()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('fetch failed')
  })
})
