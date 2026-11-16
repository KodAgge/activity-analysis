import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../../api/schema'
import { PlanCalendar } from './PlanCalendar'
import { runsByLocalDay } from './planMath'

type S = components['schemas']
type Session = S['Session']
type PlanVersion = S['PlanVersion']
type ActivitySummary = S['ActivitySummary']

/*
 * Four synthetic Monday weeks from 16 November: weeks 1 to 3 detailed,
 * week 4 an outline. Week 1 holds a Tuesday interval session, a Wednesday
 * rest day and a Sunday long run.
 */
function session(id: string, date: string, over: Partial<Session> = {}): Session {
  return { id, date, kind: 'easy', title: 'Easy', description: '', steps: [], ...over }
}

const INTERVALS = session('w1-int', '2026-11-17', {
  kind: 'intervals',
  title: '6 × 800 m',
  steps: [
    { role: 'warmup', repeat: 1, duration_s: 900 },
    { role: 'work', repeat: 6, distance_m: 800, speed: { low_mps: 3.8462, high_mps: 3.9216 } },
  ],
})

function version(outcomes: S['Outcome'][] = []): PlanVersion {
  return {
    weeks: [
      {
        start_date: '2026-11-16',
        phase: 'build',
        focus: 'Volume',
        planned_distance_m: 30000,
        detailed: true,
        sessions: [
          INTERVALS,
          session('w1-rest', '2026-11-18', { kind: 'rest', title: 'Rest' }),
          session('w1-long', '2026-11-22', { kind: 'long', title: 'Long run', planned_distance_m: 12000 }),
        ],
      },
      {
        start_date: '2026-11-23',
        phase: 'build',
        focus: 'Volume',
        planned_distance_m: 32000,
        detailed: true,
        sessions: [session('w2-easy', '2026-11-24', { planned_distance_m: 7000 })],
      },
      {
        start_date: '2026-11-30',
        phase: 'specific',
        focus: 'Race pace',
        planned_distance_m: 33000,
        detailed: true,
        sessions: [session('w3-easy', '2026-12-01')],
      },
      {
        start_date: '2026-12-07',
        phase: 'sharpen',
        focus: 'Speed and a time trial',
        planned_distance_m: 30000,
        detailed: false,
        sessions: [],
      },
    ],
    outcomes,
  } as unknown as PlanVersion
}

function run(id: string, start: string, distance: number): ActivitySummary {
  return { activity_id: id, start_time_utc: start, utc_offset_s: 3600, distance_m: distance } as unknown as ActivitySummary
}

/** Renders the calendar inside a router, since every run is a `Link`. */
function renderCalendar(props: {
  version: PlanVersion
  runs?: ActivitySummary[]
  changed?: Set<string>
  today?: Date
  runsLoading?: boolean
  runsError?: string | null
  onOpenSession?: (id: string) => void
}) {
  const rootRoute = createRootRoute({
    component: () => (
      <PlanCalendar
        version={props.version}
        runsByDay={runsByLocalDay(props.runs ?? [])}
        changed={props.changed ?? new Set()}
        today={props.today ?? new Date(2026, 10, 27)}
        runsLoading={props.runsLoading}
        runsError={props.runsError}
        onOpenSession={props.onOpenSession ?? (() => {})}
      />
    ),
  })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/'] }) })
  return render(<RouterProvider router={router} />)
}

/** The app's desktop width, at which the calendar is a grid rather than a list. */
function atDesktopWidth(): void {
  stubMedia((query) => query === '(min-width: 60rem)')
}

/** A narrow page that is being printed: the grid is kept, as on paper. */
function whenPrinting(): void {
  stubMedia((query) => query === 'print')
}

/** Stubs `matchMedia`, answering each single-condition query of the comma-separated list. */
function stubMedia(matches: (condition: string) => boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.split(', ').some(matches),
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

/** A day's cell, found by the full date it names for a screen reader. */
async function findDay(name: string): Promise<HTMLElement> {
  return screen.findByRole('cell', { name: new RegExp(name) })
}

describe('PlanCalendar', () => {
  it('draws a mini workout profile in every running session, in the grid and the phone list alike', async () => {
    for (const layout of [atDesktopWidth, () => {}]) {
      layout()
      const { unmount } = renderCalendar({ version: version() })
      const buttons = await screen.findAllByRole('button', { name: /,/ })
      const profiles = buttons.map((b) => b.querySelector('svg[aria-hidden="true"] [data-mark="segment"]') !== null)
      // Intervals, the long run and the week 2 easy run have something to
      // draw; the rest day and the easy run with no distance do not.
      expect(buttons.map((b) => b.dataset.sessionId)).toEqual(['w1-int', 'w1-rest', 'w1-long', 'w2-easy', 'w3-easy'])
      expect(profiles).toEqual([true, false, true, true, false])
      unmount()
      vi.unstubAllGlobals()
    }
  })

  it("a day shows its planned session, the run done that day and Claude's verdict", async () => {
    atDesktopWidth()
    renderCalendar({
      version: version([{ session_id: 'w1-int', verdict: 'done', activity_ids: ['run-1'], note: 'All six on pace.' }]),
      runs: [run('run-1', '2026-11-17T06:30:00Z', 8400)],
    })

    const tuesday = await findDay('Tuesday 17 November')
    expect(tuesday).toHaveTextContent('6 × 800 m')
    // The work step's 3.8462 to 3.9216 m/s, as paces.
    expect(tuesday).toHaveTextContent('4:15-4:20')
    const link = within(tuesday).getByRole('link')
    expect(link).toHaveAttribute('href', '/activities/run-1')
    expect(link).toHaveTextContent('8.4 km')
    expect(within(tuesday).getByText('Done')).toBeInTheDocument()
    // The glyph is visible and hidden from a screen reader, which reads the word.
    expect(within(tuesday).getByText('✓')).toHaveAttribute('aria-hidden', 'true')
  })

  it('gives every verdict its own mark and word', async () => {
    atDesktopWidth()
    const sessions = ['w1-int', 'w1-long', 'w2-easy', 'w3-easy', 'w1-rest']
    const verdicts = ['done', 'partial', 'missed', 'moved', 'replaced'] as const
    renderCalendar({
      version: version(sessions.map((id, i) => ({ session_id: id, verdict: verdicts[i] ?? 'done', activity_ids: [], note: '' }))),
      today: new Date(2026, 11, 5),
    })

    expect(await findDay('Tuesday 17 November')).toHaveTextContent('Done')
    expect(await findDay('Sunday 22 November')).toHaveTextContent('Partial')
    expect(await findDay('Tuesday 24 November')).toHaveTextContent('Missed')
    expect(await findDay('Tuesday 1 December')).toHaveTextContent('Moved')
    expect(await findDay('Wednesday 18 November')).toHaveTextContent('Replaced')
    const glyphs = ['✓', '½', '✗', '→', '⇄']
    const grid = screen.getByRole('table')
    for (const glyph of glyphs) expect(within(grid).getByText(glyph)).toHaveAttribute('aria-hidden', 'true')
  })

  it('an unplanned run on a rest day is shown', async () => {
    atDesktopWidth()
    renderCalendar({ version: version(), runs: [run('run-2', '2026-11-18T16:00:00Z', 5000)] })

    const wednesday = await findDay('Wednesday 18 November')
    expect(wednesday).toHaveTextContent('Rest')
    expect(within(wednesday).getByRole('link')).toHaveAttribute('href', '/activities/run-2')
    expect(wednesday).toHaveTextContent('5.0 km')
  })

  it('a day with two runs shows both', async () => {
    atDesktopWidth()
    renderCalendar({
      version: version(),
      runs: [run('am', '2026-11-19T06:00:00Z', 5000), run('pm', '2026-11-19T17:00:00Z', 3000)],
    })

    const thursday = await findDay('Thursday 19 November')
    expect(within(thursday).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      '/activities/am',
      '/activities/pm',
    ])
  })

  it('a session the proposal changes is marked as changed', async () => {
    atDesktopWidth()
    renderCalendar({ version: version(), changed: new Set(['w2-easy']) })

    expect(await findDay('Tuesday 24 November')).toHaveTextContent('Changed in this proposal')
    expect(await findDay('Tuesday 1 December')).not.toHaveTextContent('Changed in this proposal')
  })

  it('an outline week shows its phase and distance, not days', async () => {
    atDesktopWidth()
    renderCalendar({ version: version() })

    const header = await screen.findByRole('rowheader', { name: /Week 4/ })
    const row = header.closest('tr')
    if (row === null) throw new Error('the week header is not in a row')
    const cells = within(row).getAllByRole('cell')
    expect(cells).toHaveLength(1)
    expect(cells[0]).toHaveAttribute('colspan', '7')
    expect(row).toHaveTextContent('Sharpen')
    expect(row).toHaveTextContent('Speed and a time trial')
    expect(row).toHaveTextContent('30 km')
    expect(cells[0]).toHaveTextContent('Sessions are written out when the week comes within three weeks.')
  })

  it("today's cell is marked", async () => {
    atDesktopWidth()
    renderCalendar({ version: version(), today: new Date(2026, 10, 27) })

    const friday = await findDay('Friday 27 November')
    expect(friday).toHaveAttribute('aria-current', 'date')
    expect(screen.getAllByRole('cell').filter((c) => c.getAttribute('aria-current') !== null)).toHaveLength(1)
  })

  it('the weeks state their phase and planned distance', async () => {
    atDesktopWidth()
    renderCalendar({ version: version() })

    const header = await screen.findByRole('rowheader', { name: /Week 1/ })
    expect(header).toHaveTextContent('Build')
    expect(header).toHaveTextContent('30 km')
  })

  it('a week heads with its dates, a dash per session and the sessions run and distance as counts', async () => {
    atDesktopWidth()
    renderCalendar({
      version: version([
        { session_id: 'w1-int', verdict: 'done', activity_ids: ['run-1'], note: '' },
        { session_id: 'w1-long', verdict: 'missed', activity_ids: [], note: '' },
      ]),
      runs: [run('run-1', '2026-11-17T06:30:00Z', 8400)],
      today: new Date(2026, 10, 27),
    })

    const week1 = await screen.findByRole('rowheader', { name: /Week 1/ })
    expect(week1).toHaveTextContent('16-22 Nov')
    // The rest day is no session to run, and a missed one is not run.
    expect(within(week1).getByRole('img')).toHaveAccessibleName('Week 1: 1 of 2 sessions run')
    expect(week1.querySelectorAll('[data-state="done"]')).toHaveLength(1)
    expect(week1).toHaveTextContent('Sessions 1/2')
    // Run against planned once the week has begun, as the weekly distance chart has it.
    expect(week1).toHaveTextContent('Distance 8.4/30 km')
    expect(screen.getByRole('rowheader', { name: /Week 2/ })).toHaveTextContent('Distance 0.0/32 km')
    // A week not begun states the plan's distance alone, and its dates across a month's end.
    const week3 = screen.getByRole('rowheader', { name: /Week 3/ })
    expect(week3).toHaveTextContent('30 Nov - 6 Dec')
    expect(week3).toHaveTextContent('Distance 33 km')
    // An outline week has no sessions to count.
    const week4 = screen.getByRole('rowheader', { name: /Week 4/ })
    expect(within(week4).queryByRole('img')).toBeNull()
    expect(week4).not.toHaveTextContent('Sessions')
  })

  it.each([
    ['still loading', { runsLoading: true }],
    ['unavailable', { runsError: 'HTTP 500' }],
  ])('a begun week states the planned distance alone while the runs are %s', async (_, state) => {
    atDesktopWidth()
    // The runs have not arrived, so none are filed by day.
    renderCalendar({ version: version(), today: new Date(2026, 10, 27), ...state })

    const week1 = await screen.findByRole('rowheader', { name: /Week 1/ })
    expect(week1).toHaveTextContent('Distance 30 km')
    expect(week1).not.toHaveTextContent('/30 km')
    expect(screen.getByRole('rowheader', { name: /Week 2/ })).toHaveTextContent('Distance 32 km')
  })

  it('on a phone each week has the same head, its number as the heading', async () => {
    // The day before the plan begins, so no week has a distance run yet.
    renderCalendar({ version: version(), today: new Date(2026, 10, 15) })

    const week1 = await screen.findByRole('heading', { level: 3, name: /Week 1/ })
    expect(week1).toHaveTextContent('Build')
    const head = week1.closest('li')
    if (head === null) throw new Error('the week heading is not in a list item')
    // The plan has not begun, so the next session to run is week 1's first.
    expect(within(head).getAllByRole('img')[0]).toHaveAccessibleName('Week 1: 0 of 2 sessions run, 6 × 800 m next')
    expect(head).toHaveTextContent('Distance 30 km')
  })

  it("the next session to run is its week's current dash, and the mark moves on as sessions are judged", async () => {
    atDesktopWidth()
    const { unmount } = renderCalendar({ version: version(), today: new Date(2026, 10, 15) })
    const before = await screen.findByRole('rowheader', { name: /Week 1/ })
    expect(Array.from(before.querySelectorAll('[data-state]')).map((d) => d.getAttribute('data-state'))).toEqual([
      'current',
      'todo',
    ])
    // No other week has a current dash.
    expect(screen.getAllByRole('table')[0]?.querySelectorAll('[data-state="current"]')).toHaveLength(1)
    unmount()

    // The intervals judged run, the long run is next.
    renderCalendar({
      version: version([{ session_id: 'w1-int', verdict: 'done', activity_ids: [], note: '' }]),
      today: new Date(2026, 10, 18),
    })
    const after = await screen.findByRole('rowheader', { name: /Week 1/ })
    expect(Array.from(after.querySelectorAll('[data-state]')).map((d) => d.getAttribute('data-state'))).toEqual([
      'done',
      'current',
    ])
    expect(within(after).getByRole('img')).toHaveAccessibleName('Week 1: 1 of 2 sessions run, Long run next')
  })

  it('a session states its planned distance, and the pace of its first paced work step beside it', async () => {
    atDesktopWidth()
    const v = version()
    const week3 = v.weeks[2]
    if (week3 === undefined) throw new Error('no week 3')
    week3.sessions = [
      session('w3-tempo', '2026-12-01', {
        kind: 'tempo',
        title: 'Long run with 3 km steady',
        planned_distance_m: 17000,
        steps: [
          { role: 'work', repeat: 1, distance_m: 14000 },
          { role: 'work', repeat: 1, distance_m: 3000, speed: { low_mps: 3.125, high_mps: 3.2258 } },
        ],
      } as Partial<Session>),
    ]
    renderCalendar({ version: v })

    expect(await findDay('Tuesday 1 December')).toHaveTextContent('17 km · 5:10-5:20')
    // With no paced step, the distance alone; with no planned distance, the pace alone.
    expect(await findDay('Sunday 22 November')).toHaveTextContent(/Long run 12 km$/)
    expect(await findDay('Tuesday 17 November')).toHaveTextContent(/6 × 800 m 4:15-4:20$/)
  })

  it('gives the width to the weekdays that hold something and shrinks the rest to their dates, alike in every week', async () => {
    atDesktopWidth()
    renderCalendar({ version: version() })

    const headers = await screen.findAllByRole('columnheader')
    const byDay = new Map(headers.map((h) => [h.textContent, h.className]))
    // Sessions fall on Tuesday, Wednesday and Sunday in some week.
    const wide = ['Tue', 'Wed', 'Sun'].map((d) => byDay.get(d))
    const narrow = ['Mon', 'Thu', 'Fri', 'Sat'].map((d) => byDay.get(d))
    expect(new Set(wide).size).toBe(1)
    expect(new Set(narrow).size).toBe(1)
    expect(wide[0]).not.toBe(narrow[0])
  })

  it('on a phone the calendar is a list of the days with a session or a run, grouped by week', async () => {
    renderCalendar({
      version: version([{ session_id: 'w1-int', verdict: 'partial', activity_ids: ['run-1'], note: '' }]),
      runs: [run('run-1', '2026-11-17T06:30:00Z', 8400), run('run-3', '2026-11-20T06:30:00Z', 4000)],
      changed: new Set(['w2-easy']),
    })

    expect(screen.queryByRole('table')).toBeNull()
    const week1 = await screen.findByRole('heading', { level: 3, name: /Week 1/ })
    const list = week1.closest('li')
    if (list === null) throw new Error('the week heading is not in a list item')
    const days = within(list).getAllByRole('listitem')
    // Tuesday's intervals, Wednesday's rest, Friday's unplanned run and Sunday's long run.
    expect(days.map((d) => d.querySelector('time')?.textContent)).toEqual([
      'Tuesday 17 November',
      'Wednesday 18 November',
      'Friday 20 November',
      'Sunday 22 November',
    ])
    expect(days[0]).toHaveTextContent('Partial')
    expect(within(days[2] as HTMLElement).getByRole('link')).toHaveAttribute('href', '/activities/run-3')
    const week2 = screen.getByRole('heading', { level: 3, name: /Week 2/ }).closest('li')
    if (week2 === null) throw new Error('the week heading is not in a list item')
    expect(week2).toHaveTextContent('Changed in this proposal')
    // The outline week is still there, as its phase and distance.
    const week4 = screen.getByRole('heading', { level: 3, name: /Week 4/ })
    expect(week4.closest('li')).toHaveTextContent('Speed and a time trial')
  })

  it('keeps the grid when a narrow page is printed', async () => {
    whenPrinting()
    renderCalendar({ version: version(), runs: [] })

    expect(await screen.findByRole('table')).toBeInTheDocument()
    // The phone list heads each week with an h3; the grid does not.
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull()
  })

  it('says the runs are still loading, and keeps the plan drawn meanwhile', async () => {
    atDesktopWidth()
    renderCalendar({ version: version(), runsLoading: true })

    expect(await screen.findByText('Loading the runs done on these days.')).toBeInTheDocument()
    expect(await findDay('Tuesday 17 November')).toHaveTextContent('6 × 800 m')
  })

  it('says nothing of loading once the runs are in', async () => {
    atDesktopWidth()
    renderCalendar({ version: version() })

    await findDay('Tuesday 17 November')
    expect(screen.queryByText('Loading the runs done on these days.')).toBeNull()
  })

  it("on a phone today's day says Today in words, not only with its disc", async () => {
    renderCalendar({ version: version(), today: new Date(2026, 10, 17) })

    const week1 = await screen.findByRole('heading', { level: 3, name: /Week 1/ })
    const today = week1.closest('li')?.querySelector('[aria-current="date"]')
    if (today === null || today === undefined) throw new Error("today's day is not marked")
    expect(today.querySelector('time')).toHaveTextContent('Tuesday 17 November')
    expect(today).toHaveTextContent(/^Today/)
    // Only today's day says it.
    expect(screen.getAllByText('Today')).toHaveLength(1)
  })

  it('a session is a button named by its date and title, and a click opens it', async () => {
    atDesktopWidth()
    const opened: string[] = []
    renderCalendar({ version: version(), onOpenSession: (id) => opened.push(id) })

    const button = await screen.findByRole('button', { name: /^Tuesday 17 November, Intervals: 6 × 800 m/ })
    // A native button, so Enter and Space open it as a click does.
    expect(button.tagName).toBe('BUTTON')
    expect(button).toHaveAttribute('type', 'button')
    fireEvent.click(button)
    expect(opened).toEqual(['w1-int'])
    // Every planned session is one, rest days included.
    expect(screen.getByRole('button', { name: /^Wednesday 18 November, Rest: Rest/ })).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(5)
  })

  it('on a phone a session is a button too', async () => {
    const opened: string[] = []
    renderCalendar({ version: version(), onOpenSession: (id) => opened.push(id) })

    fireEvent.click(await screen.findByRole('button', { name: /^Sunday 22 November, Long run: Long run/ }))
    expect(opened).toEqual(['w1-long'])
  })

  it("a session's button still carries its verdict and its change for a screen reader", async () => {
    atDesktopWidth()
    renderCalendar({
      version: version([{ session_id: 'w1-int', verdict: 'done', activity_ids: [], note: '' }]),
      changed: new Set(['w1-int']),
    })

    const button = await screen.findByRole('button', { name: /Tuesday 17 November/ })
    expect(button).toHaveAccessibleName(/Done/)
    expect(button).toHaveAccessibleName(/Changed in this proposal/)
  })
})
