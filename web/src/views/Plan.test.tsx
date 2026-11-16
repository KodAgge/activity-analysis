import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { validatePlanSearch } from '../api/planSearch'
import type { components } from '../api/schema'
import { Plan } from './Plan'

type S = components['schemas']
type PlanSummary = S['PlanSummary']
type PlanDetail = S['PlanDetail']
type PlanVersion = S['PlanVersion']
type Session = S['Session']

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))
vi.mock('../api/client', () => ({ api: { GET: getMock } }))

/*
 * A synthetic 5 km goal, built like `tests/test_plan_models.py`'s
 * `five_week_draft`: five Monday weeks from 8 February to a race on
 * Saturday 13 March, week 4 an outline. Version 1 is accepted with a
 * 25:00 target; version 2 is pending, moves the target to 25:15 and cuts
 * week 2.
 */
const GOAL_ID = '5k-2027-03-13'

function session(id: string, date: string, over: Partial<Session> = {}): Session {
  return { id, date, kind: 'easy', title: 'Easy', description: 'Conversational.', steps: [], ...over }
}

function weeks(): S['Week'][] {
  const starts = ['2027-02-08', '2027-02-15', '2027-02-22', '2027-03-01', '2027-03-08']
  return starts.map((start, i) => ({
    start_date: start,
    phase: i === 4 ? 'taper' : 'build',
    focus: 'Volume',
    planned_distance_m: 30000,
    detailed: i !== 3,
    sessions:
      i === 3
        ? []
        : i === 4
          ? [session('w5-race', '2027-03-13', { kind: 'race', title: 'Race' })]
          : [
              session(`w${String(i + 1)}-easy`, addDays(start, 1)),
              ...(i === 0 ? [INTERVALS] : []),
              session(`w${String(i + 1)}-long`, addDays(start, 6), {
                kind: 'long',
                title: '13 km easy',
                description: 'Keep it conversational, then strides.',
                steps: [
                  { role: 'work', repeat: 1, distance_m: 13000, speed: { low_mps: 2.6667, high_mps: 2.8571 } },
                  { role: 'work', repeat: 4, duration_s: 20, heart_rate: { low_bpm: 150, high_bpm: 170 } },
                ],
              }),
            ],
  }))
}

/** Week 1's Thursday intervals, the session the detail tests open. */
const INTERVALS: Session = {
  id: 'w1-intervals',
  date: '2027-02-11',
  kind: 'intervals',
  title: '6 × 800 m',
  description: 'Warm up with 2 km easy and four strides. Feel: 7-8 out of 10.',
  planned_distance_m: 10000,
  steps: [
    { role: 'warmup', repeat: 1, distance_m: 2500 },
    { role: 'work', repeat: 6, distance_m: 800, speed: { low_mps: 3.8462, high_mps: 3.9216 }, note: '7-8/10' },
    { role: 'recovery', repeat: 6, duration_s: 90 },
  ],
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function planVersion(over: {
  number: number
  targetS?: number
  createdAt?: string
  dataThrough?: string | null
  changes?: S['ChangeEntry'][]
  goalId?: string
  distanceM?: number
  raceDate?: string
  estimateS?: number | null
  checkpoints?: S['Checkpoint'][]
  summary?: string
  reasoning?: string
}): PlanVersion {
  const distanceM = over.distanceM ?? 5000
  return {
    goal: {
      goal_id: over.goalId ?? GOAL_ID,
      distance_m: distanceM,
      target_time_s: over.targetS ?? 1500,
      race_date: over.raceDate ?? '2027-03-13',
      surface: 'track',
    },
    constraints: { runs_per_week: 3 },
    assessment: {
      summary: over.summary ?? 'Within reach but not yet likely.',
      estimate_s: over.estimateS === undefined ? 1520 : over.estimateS,
      estimate_reasoning: over.reasoning ?? 'The best-effort prediction improved by 15 s in two weeks.',
      verdict: 'possible',
      citations: [
        { label: 'Predictions on 5 February', pointer: '/predictions/items/0' },
        { label: 'Weekly distance, weeks 46 and 47', pointer: '/weeks/0' },
      ],
    },
    weeks: weeks(),
    changes: over.changes ?? [],
    outcomes: [],
    checkpoints: over.checkpoints ?? [],
    result: null,
    provenance: {
      number: over.number,
      revises: over.number > 1 ? over.number - 1 : null,
      // Noon UTC, so the browser's local date is the same day in any zone
      // from UTC-11 to UTC+11 and the test does not depend on the machine.
      created_at: over.createdAt ?? '2027-02-06T12:00:00Z',
      data_through: over.dataThrough === undefined ? '2027-02-05' : over.dataThrough,
      snapshot: [
        { distance_key: '5k', distance_m: distanceM, model: 'riegel', predicted_time_s: 1548, low_s: null, high_s: null },
        {
          distance_key: '5k',
          distance_m: distanceM,
          model: 'ordinary_runs',
          predicted_time_s: 1652,
          low_s: 1578,
          high_s: 1730,
        },
      ],
    },
  }
}

const ACCEPTED_V1 = planVersion({ number: 1 })
const PENDING_V2_BASE = planVersion({
  number: 2,
  targetS: 1515,
  createdAt: '2027-02-18T12:00:00Z',
  dataThrough: '2027-02-18',
  changes: [
    { title: 'Week 2 cut from 32 to 26 km', reason: 'The easy run on 18 February was missed.', session_ids: [], goal_change: false },
    { title: 'Threshold replaces tempo reps', reason: 'The third rep faded.', session_ids: [], goal_change: false },
    { title: 'Target moved to 25:15', reason: 'The time trial is the better guide.', session_ids: [], goal_change: true },
  ],
})
/** Version 2 also shortens week 2's Tuesday run, so it changes one session. */
const PENDING_V2: PlanVersion = {
  ...PENDING_V2_BASE,
  weeks: PENDING_V2_BASE.weeks.map((w) => ({
    ...w,
    sessions: w.sessions.map((s) => (s.id === 'w2-easy' ? { ...s, title: 'Easy, shorter' } : s)),
  })),
}

function summary(over: Partial<PlanSummary> = {}): PlanSummary {
  return {
    goal_id: GOAL_ID,
    status: 'active',
    distance_m: 5000,
    target_time_s: 1500,
    race_date: '2027-03-13',
    accepted_version: 1,
    pending_version: 2,
    ...over,
  }
}

/** A version as a fixture states it: without an expected line unless the test gives one. */
type EntryFixture = Omit<S['PlanVersionEntry'], 'expected_prediction'> & Partial<Pick<S['PlanVersionEntry'], 'expected_prediction'>>

function detail(versions: EntryFixture[], over: Partial<PlanDetail> = {}): PlanDetail {
  return {
    goal_id: GOAL_ID,
    status: 'active',
    versions: versions.map((v) => ({ expected_prediction: [], ...v })),
    ...over,
  }
}

const REVISED: PlanDetail = detail([
  { number: 1, status: 'accepted', plan: ACCEPTED_V1 },
  { number: 2, status: 'proposed', plan: PENDING_V2 },
])

/** One run's stored load: its TRIMP, 50 minutes in zones 1 and 2, no histogram. */
function runLoad(id: string, date: string, trimp: number | null): S['RunLoad'] {
  return {
    activity_id: id,
    local_date: date,
    lthr_bpm: 172,
    trimp,
    rest_bpm: 50,
    max_bpm: 200,
    rest_from_setting: false,
    max_from_setting: false,
    zone_seconds: trimp === null ? [] : [1800, 1200, 0, 0, 0],
    hr_bpm: [],
    hr_seconds: [],
  }
}

/** A threshold estimate whose zones end at 140, 152, 162 and 172 bpm. */
const THRESHOLD: S['Threshold'] = {
  current: { lthr_bpm: 172, boundaries_bpm: [140, 152, 162, 172] },
}

/**
 * `/api/plans` answers `plans`; `/api/plans/{goal_id}` answers the matching
 * detail or a 404; `/api/activities` answers the `runs` whose UTC date is
 * in `[from, to)` as one page; `/api/training-load` answers `loads` and `weeks`,
 * `/api/threshold` `threshold`, `/api/predictions/history` `history` at
 * whatever distance is asked, and `/api/fitness` no VO2max at all.
 */
function mockPlans(
  plans: PlanSummary[],
  details: PlanDetail[],
  runs: S['ActivitySummary'][] = [],
  {
    loads = [],
    weeks = [],
    threshold = THRESHOLD,
    history = [],
  }: {
    loads?: S['RunLoad'][]
    weeks?: S['LoadWeek'][]
    threshold?: S['Threshold']
    history?: S['PredictionHistoryPoint'][]
  } = {},
): void {
  getMock.mockImplementation((path: string, init?: MockInit) => {
    const ok = (data: unknown) => Promise.resolve({ data, error: undefined, response: new Response() })
    if (path === '/api/training-load') return ok({ days: [], weeks, runs: loads })
    if (path === '/api/predictions/history') {
      return ok({ distance_m: init?.params?.query?.distance_m, points: history })
    }
    if (path === '/api/threshold') return ok(threshold)
    if (path === '/api/fitness') return ok({ items: [], device: [] })
    if (path === '/api/activities') {
      const { from, to } = init?.params?.query ?? {}
      const items = runs.filter((r) => {
        const date = r.start_time_utc.slice(0, 10)
        return (from === undefined || date >= from) && (to === undefined || date < to)
      })
      const page = { total: items.length, limit: 200, offset: 0, items }
      return Promise.resolve({ data: page, error: undefined, response: new Response() })
    }
    if (path === '/api/plans') {
      return Promise.resolve({ data: { items: plans }, error: undefined, response: new Response() })
    }
    if (path === '/api/plans/{goal_id}') {
      const found = details.find((d) => d.goal_id === init?.params?.path?.goal_id)
      if (found !== undefined) return Promise.resolve({ data: found, error: undefined, response: new Response() })
      return Promise.resolve({
        data: undefined,
        error: { detail: 'no plan named that' },
        response: new Response(null, { status: 404 }),
      })
    }
    return Promise.resolve({ data: undefined, error: { detail: `unmocked ${path}` }, response: new Response() })
  })
}

/** What the mocked client is handed: a path's parameters and a query. */
interface MockInit {
  params?: { path?: { goal_id?: string }; query?: { from?: string; to?: string; distance_m?: number } }
}

function renderPlan(path: string, today: Date) {
  const rootRoute = createRootRoute()
  const component = () => <Plan today={today} />
  const planRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/plan',
    validateSearch: validatePlanSearch,
    component,
  })
  const goalRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/plan/$goalId',
    validateSearch: validatePlanSearch,
    component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([planRoute, goalRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { ...result, router }
}

/**
 * The page's header block: the `<header>` around the goal's `<h1>`. Not
 * found by the `banner` role, which a `<header>` inside the shell's
 * `<main>` does not carry.
 */
async function findHeader(): Promise<HTMLElement> {
  const title = await screen.findByRole('heading', { level: 1 })
  const header = title.closest('header')
  if (header === null) throw new Error('the title is not inside a header')
  return header
}

/**
 * The `<section>` under an `<h2>`. `PlanCard` names no region, so the
 * section is found through its own heading.
 */
/**
 * Matches a step's target by its whole text: a cell sets its unit and zone
 * in spans of their own, `150-170`, ` bpm`, ` (Z4)`.
 */
function targetText(text: string) {
  return (_: string, el: Element | null) => el?.tagName === 'DD' && el.textContent === text
}

async function findSection(title: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { level: 2, name: title })
  const section = heading.closest('section')
  if (section === null) throw new Error(`${title} is not inside a section`)
  return section
}

beforeEach(() => {
  getMock.mockReset()
})

/** One run's predictions at the goal distance, in the CET of the runs above. */
function historyPoint(start: string, bestS: number | null, ordinaryS: number | null): S['PredictionHistoryPoint'] {
  return {
    activity_id: start,
    start_time_utc: start,
    utc_offset_s: 3600,
    best_efforts_vdot: bestS === null ? null : 38,
    best_efforts_s: bestS,
    ordinary_runs_s: ordinaryS,
    ordinary_runs_low_s: ordinaryS === null ? null : ordinaryS - 60,
    ordinary_runs_high_s: ordinaryS === null ? null : ordinaryS + 60,
  }
}

/** One run before the plan's first week, then three in its first two weeks, newest 25:45. */
const HISTORY = [
  historyPoint('2027-02-01T06:30:00Z', 1580, 1660),
  historyPoint('2027-02-09T06:30:00Z', 1555, 1650),
  historyPoint('2027-02-16T06:30:00Z', 1548, 1645),
  historyPoint('2027-02-18T06:30:00Z', 1545, 1640),
]

/** The distances `/api/predictions/history` was asked for, in order. */
function historyRequests(): number[] {
  return getMock.mock.calls
    .filter(([path]) => path === '/api/predictions/history')
    .map(([, init]) => (init as MockInit).params?.query?.distance_m ?? Number.NaN)
}

/** Text drawn for the eye only, such as the feasibility scale's step names, which repeat the word. */
const HIDDEN = '[aria-hidden="true"], [aria-hidden="true"] *'
describe('Plan', () => {
  it('the header states the goal, the countdown and Claude\'s estimate', async () => {
    mockPlans([summary()], [REVISED], [], { history: HISTORY })
    renderPlan('/plan', new Date(2027, 1, 19))

    // The pending version is shown, so the target is its 25:15.
    expect(await screen.findByRole('heading', { level: 1, name: '5 km under 25:15' })).toBeInTheDocument()
    const header = await findHeader()
    expect(header).toHaveTextContent('Track')
    expect(header).toHaveTextContent('13 March')
    expect(header).toHaveTextContent('22 days to go')
    // 5000 m in 1515 s is 5:03/km, one of the race's facts beside the date
    // and the surface; the countdown stands as the race day's value.
    const facts = within(header).getAllByRole('listitem').map((li) => li.textContent)
    expect(facts.slice(0, 3)).toEqual(['13 March', 'Track', 'Target pace 5:03/km'])
    expect(within(header).getByText('Race day').nextSibling).toHaveTextContent('22 days to go')
    // The newest run's best-efforts time, 1545 s, and Claude's 1520 s. The
    // version's own snapshot, 1548 s, is not read.
    await waitFor(() =>
      expect(within(header).getByText('Predicted today, best efforts').nextSibling).toHaveTextContent('25:45'),
    )
    expect(within(header).getByText("Claude's estimate").nextSibling).toHaveTextContent('25:20')
    expect(header).not.toHaveTextContent('25:48')
    // The ordinary-run prediction is not the plan's evidence: the header
    // carries no time of its own for it.
    expect(header).not.toHaveTextContent(/ordinary/i)
    expect(header).not.toHaveTextContent('27:20')
    expect(header).toHaveTextContent('Written by Claude on 18 February from runs through 18 February')
  })

  it('a plan with no estimate yet names the time trial that will set it', async () => {
    // The trial is week 2's Tuesday, 16 February, named by a checkpoint.
    const trial = planVersion({
      number: 1,
      estimateS: null,
      checkpoints: [{ session_id: 'w2-easy', description: '3 km time trial', target_time_s: 690 }],
    })
    const plan: PlanVersion = {
      ...trial,
      weeks: trial.weeks.map((w) => ({
        ...w,
        sessions: w.sessions.map((s) => (s.id === 'w2-easy' ? { ...s, kind: 'time_trial', title: 'Time trial' } : s)),
      })),
    }
    mockPlans([summary({ pending_version: null })], [detail([{ number: 1, status: 'accepted', plan }])])
    renderPlan('/plan', new Date(2027, 1, 12))

    const header = await findHeader()
    expect(within(header).getByText("Claude's estimate").nextSibling).toHaveTextContent(
      'Set by the time trial on 16 February',
    )
  })

  it('a race-week revision with no estimate names the race, not the trial it already judged', async () => {
    // The trial was week 2's Tuesday, 16 February; the data runs through Monday 8 March.
    const trial = planVersion({
      number: 2,
      estimateS: null,
      dataThrough: '2027-03-08',
      checkpoints: [{ session_id: 'w2-easy', description: '3 km time trial', target_time_s: 690 }],
    })
    const plan: PlanVersion = {
      ...trial,
      weeks: trial.weeks.map((w) => ({
        ...w,
        sessions: w.sessions.map((s) => (s.id === 'w2-easy' ? { ...s, kind: 'time_trial', title: 'Time trial' } : s)),
      })),
    }
    mockPlans([summary({ pending_version: null })], [detail([{ number: 2, status: 'accepted', plan }])])
    renderPlan('/plan', new Date(2027, 2, 9))

    const header = await findHeader()
    expect(within(header).getByText("Claude's estimate").nextSibling).toHaveTextContent('Set by the race on 13 March')
  })

  it('a plan with no estimate and no time trial says there is no estimate yet', async () => {
    const plan = planVersion({ number: 1, estimateS: null })
    mockPlans([summary({ pending_version: null })], [detail([{ number: 1, status: 'accepted', plan }])])
    renderPlan('/plan', new Date(2027, 1, 12))

    const header = await findHeader()
    expect(within(header).getByText("Claude's estimate").nextSibling).toHaveTextContent('No estimate yet')
  })

  it('the header says the race has passed instead of counting below zero', async () => {
    mockPlans([summary()], [REVISED])
    renderPlan('/plan', new Date(2027, 2, 14))

    const header = await findHeader()
    expect(header).toHaveTextContent('Race day has passed. Record the result with /training-plan in Claude Code.')
    expect(header).not.toHaveTextContent(/-\d+ days?/)
    expect(header).not.toHaveTextContent('to go')
  })

  it('a closed goal shows its result instead of asking for it', async () => {
    const closing: PlanVersion = {
      ...ACCEPTED_V1,
      result: { time_s: 1490, achieved: true, note: 'Even splits all the way.' },
      provenance: { ...ACCEPTED_V1.provenance, number: 2, revises: 1, data_through: '2027-03-13' },
    }
    mockPlans(
      [summary({ status: 'closed', accepted_version: 2, pending_version: null })],
      [
        detail(
          [
            { number: 1, status: 'superseded', plan: ACCEPTED_V1 },
            { number: 2, status: 'accepted', plan: closing },
          ],
          { status: 'closed' },
        ),
      ],
    )
    renderPlan('/plan', new Date(2027, 2, 14))

    const header = await findHeader()
    expect(header).toHaveTextContent('Result 24:50 · Achieved')
    expect(header).toHaveTextContent('Even splits all the way.')
    expect(header).not.toHaveTextContent('Race day has passed')
    expect(header).not.toHaveTextContent('/training-plan')
  })

  it('a missed result says so', async () => {
    const closing: PlanVersion = { ...ACCEPTED_V1, result: { time_s: 1560, achieved: false, note: '' } }
    mockPlans(
      [summary({ status: 'closed', pending_version: null })],
      [detail([{ number: 1, status: 'accepted', plan: closing }], { status: 'closed' })],
    )
    renderPlan('/plan', new Date(2027, 2, 14))

    const header = await findHeader()
    expect(header).toHaveTextContent('Result 26:00 · Missed')
  })

  it('an archived goal says so in place of the countdown, and asks for no result', async () => {
    const archived = detail([{ number: 1, status: 'accepted', plan: ACCEPTED_V1 }], { status: 'archived' })
    mockPlans([summary({ status: 'archived', pending_version: null })], [archived])
    renderPlan('/plan', new Date(2027, 2, 14))

    const header = await findHeader()
    const facts = within(header).getAllByRole('listitem').map((li) => li.textContent)
    expect(facts.slice(0, 3)).toEqual(['13 March', 'Track', 'Target pace 5:00/km'])
    expect(within(header).getByText('Goal').nextSibling).toHaveTextContent('Archived')
    expect(header).not.toHaveTextContent('Race day has passed')
    expect(header).not.toHaveTextContent('to go')
  })

  it('an archived goal counts no days down before its race either', async () => {
    const archived = detail([{ number: 1, status: 'accepted', plan: ACCEPTED_V1 }], { status: 'archived' })
    mockPlans([summary({ status: 'archived', pending_version: null })], [archived])
    renderPlan('/plan', new Date(2027, 1, 19))

    const header = await findHeader()
    expect(header).toHaveTextContent('13 March')
    expect(within(header).getByText('Goal').nextSibling).toHaveTextContent('Archived')
    expect(header).not.toHaveTextContent('to go')
  })

  it('the provenance line flags data older than a week', async () => {
    mockPlans([summary({ pending_version: null })], [detail([{ number: 1, status: 'accepted', plan: ACCEPTED_V1 }])])
    renderPlan('/plan', new Date(2027, 1, 19))

    const header = await findHeader()
    expect(header).toHaveTextContent(
      'Written by Claude on 6 February from runs through 5 February, 14 days before today',
    )
  })

  it('the provenance line says nothing of age for data within a week', async () => {
    mockPlans([summary({ pending_version: null })], [detail([{ number: 1, status: 'accepted', plan: ACCEPTED_V1 }])])
    renderPlan('/plan', new Date(2027, 1, 12))

    const header = await findHeader()
    expect(header).toHaveTextContent('from runs through 5 February')
    expect(header).not.toHaveTextContent('before today')
  })

  it('a pending proposal lists its changes with the goal change first', async () => {
    mockPlans([summary()], [REVISED])
    renderPlan('/plan', new Date(2027, 1, 19))

    const panel = await findSection('Proposed: version 2')
    expect(panel).toHaveTextContent('3 changes')
    const items = within(panel).getAllByRole('listitem')
    expect(items.map((li) => within(li).getByRole('heading', { level: 3 }).textContent)).toEqual([
      'Target moved to 25:15',
      'Week 2 cut from 32 to 26 km',
      'Threshold replaces tempo reps',
    ])
    expect(within(items[0] as HTMLElement).getByText('Goal change')).toBeInTheDocument()
    expect(items[1]).toHaveTextContent('The easy run on 18 February was missed.')
    // The same titles at a glance above, numbered alike, for the eye only:
    // a screen reader meets each once, as its change's heading.
    const glance = within(panel).getAllByRole('list', { hidden: true })[0] as HTMLElement
    expect(glance).toHaveAttribute('aria-hidden', 'true')
    expect(within(glance).getAllByRole('listitem', { hidden: true }).map((li) => li.textContent)).toEqual([
      '1Target moved to 25:15Goal change',
      '2Week 2 cut from 32 to 26 km',
      '3Threshold replaces tempo reps',
    ])
    expect(panel).toHaveTextContent(
      `Accept or reject in Claude Code, or run uv run activity-analysis plan accept ${GOAL_ID}`,
    )
    expect(panel).not.toHaveTextContent('archives')
  })

  it('a new goal\'s proposal says accepting archives the active goal', async () => {
    const newGoal = '10k-2028-04-08'
    const proposed = planVersion({ number: 1, goalId: newGoal, distanceM: 10000, targetS: 2700, raceDate: '2028-04-08' })
    mockPlans(
      [
        summary({ goal_id: newGoal, status: 'proposed', accepted_version: null, pending_version: 1 }),
        summary({ pending_version: null }),
      ],
      [detail([{ number: 1, status: 'proposed', plan: proposed }], { goal_id: newGoal, status: 'proposed' })],
    )
    renderPlan('/plan', new Date(2027, 1, 19))

    expect(await screen.findByRole('heading', { level: 1, name: '10 km under 45:00' })).toBeInTheDocument()
    const panel = await findSection('Proposed: version 1')
    expect(panel).toHaveTextContent(`Accepting it archives ${GOAL_ID}.`)
    // The race is in another year, so its date carries the year.
    expect(await findHeader()).toHaveTextContent('8 April 2028')
    // The active goal is one link away.
    const others = await findSection('Other goals')
    expect(within(others).getByRole('link')).toHaveAttribute('href', `/plan/${GOAL_ID}`)
  })

  it("another goal's badge states its distance as its title does, to the tenth of a kilometre", async () => {
    const archived = '1500m-2026-09-12'
    mockPlans(
      [
        summary({ pending_version: null }),
        summary({
          goal_id: archived,
          status: 'archived',
          distance_m: 1500,
          target_time_s: 270,
          race_date: '2026-09-12',
          pending_version: null,
        }),
      ],
      [detail([{ number: 1, status: 'accepted', plan: ACCEPTED_V1 }])],
    )
    renderPlan('/plan', new Date(2027, 1, 19))

    const link = within(await findSection('Other goals')).getByRole('link')
    expect(link).toHaveTextContent('1.5 km under 4:30')
    expect(link.querySelector('[aria-hidden="true"]')).toHaveTextContent(/^1\.5k$/)
  })

  it('with no plans the page says how to start one', async () => {
    mockPlans([], [])
    renderPlan('/plan', new Date(2027, 1, 19))

    const note = await screen.findByRole('note')
    expect(note).toHaveTextContent('No training plan yet.')
    expect(note).toHaveTextContent(
      'Plans are written by Claude Code from a checkout of this repository: run /training-plan there.',
    )
  })

  it('?version=1 shows the accepted version instead of the pending one', async () => {
    mockPlans([summary()], [REVISED])
    renderPlan(`/plan/${GOAL_ID}?version=1`, new Date(2027, 1, 19))

    expect(await screen.findByRole('heading', { level: 1, name: '5 km under 25:00' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 2, name: /Proposed/ })).toBeNull()
    expect(await findHeader()).toHaveTextContent('Version 1 · Accepted.')
  })

  it('?version=N points at a pending proposal the page is not showing', async () => {
    mockPlans([summary()], [REVISED])
    renderPlan(`/plan/${GOAL_ID}?version=1`, new Date(2027, 1, 19))

    const notice = await screen.findByRole('link', { name: 'Version 2 is proposed and waiting for your decision.' })
    expect(notice).toHaveAttribute('href', `/plan/${GOAL_ID}`)
  })

  it('the proposal itself carries no notice pointing at itself', async () => {
    mockPlans([summary()], [REVISED])
    renderPlan(`/plan/${GOAL_ID}?version=2`, new Date(2027, 1, 19))

    await findHeader()
    expect(screen.queryByText(/is proposed and waiting for your decision/)).toBeNull()
  })

  it('the calendar asks for the runs across the plan and files them by local day', async () => {
    // 06:30 UTC at +01:00 is the morning of Tuesday 9 February.
    const ran = {
      activity_id: 'run-17',
      start_time_utc: '2027-02-09T06:30:00Z',
      utc_offset_s: 3600,
      distance_m: 7100,
    } as S['ActivitySummary']
    mockPlans([summary()], [REVISED], [ran])
    renderPlan('/plan', new Date(2027, 1, 19))

    const calendar = await findSection('Calendar')
    const link = await within(calendar).findByRole('link', { name: /7\.1 km/ })
    expect(link).toHaveAttribute('href', '/activities/run-17')
    const requested = getMock.mock.calls
      .filter((c) => c[0] === '/api/activities')
      .map((c) => (c[1] as { params: { query: unknown } }).params.query)
    // The plan's own span; the lead-in asks for the weeks before it apart.
    expect(requested).toContainEqual({
      sport: 'running',
      from: '2027-02-08',
      to: '2027-03-15',
      limit: 200,
      offset: 0,
    })
  })

  it('the calendar says the runs are loading while /api/activities has not answered', async () => {
    mockPlans([summary()], [REVISED])
    const answer = getMock.getMockImplementation()
    if (answer === undefined) throw new Error('mockPlans set no implementation')
    getMock.mockImplementation((path: string, init?: unknown) =>
      path === '/api/activities' ? new Promise(() => {}) : answer(path, init),
    )
    renderPlan('/plan', new Date(2027, 1, 19))

    const calendar = await findSection('Calendar')
    expect(within(calendar).getByRole('status')).toHaveTextContent('Loading the runs done on these days.')
    // The plan's own sessions are drawn meanwhile.
    expect(calendar).toHaveTextContent('13 km easy')
  })

  it('the weekly distance chart draws no run bars while the runs load, rather than zeros', async () => {
    mockPlans([summary()], [REVISED])
    const answer = getMock.getMockImplementation()
    if (answer === undefined) throw new Error('mockPlans set no implementation')
    getMock.mockImplementation((path: string, init?: unknown) =>
      path === '/api/activities' ? new Promise(() => {}) : answer(path, init),
    )
    renderPlan('/plan', new Date(2027, 1, 19))

    const volume = await findSection('Weekly distance')
    expect(within(volume).getByRole('status')).toHaveTextContent('Loading the runs done on these days.')
    expect(volume.querySelectorAll('[data-bar="planned"]')).toHaveLength(5)
    expect(volume.querySelectorAll('[data-bar="run"]')).toHaveLength(0)
  })

  it('the weekly distance chart sets the runs done against the plan, week by week', async () => {
    // 7.1 km in week 1 and 5 km in week 2; on 19 February weeks 1 and 2 have
    // begun and weeks 3 to 5 have not.
    const runs = [
      { activity_id: 'a', start_time_utc: '2027-02-09T06:30:00Z', utc_offset_s: 3600, distance_m: 7100 },
      { activity_id: 'b', start_time_utc: '2027-02-16T06:30:00Z', utc_offset_s: 3600, distance_m: 5000 },
    ] as S['ActivitySummary'][]
    mockPlans([summary()], [REVISED], runs)
    renderPlan('/plan', new Date(2027, 1, 19))

    const volume = await findSection('Weekly distance')
    const chart = await within(volume).findByRole('img', { name: /W1: 30\.0 km planned, 7\.1 km run/ })
    expect(chart.getAttribute('aria-label')).toContain('W2: 30.0 km planned, 5.0 km run')
    expect(volume.querySelectorAll('[data-bar="run"]')).toHaveLength(2)
    expect(within(volume).queryByRole('status')).toBeNull()
  })

  it('the trajectory draws the shown version\'s expected line against the measured ones and the target', async () => {
    const expected = [
      { local_date: '2027-02-21', time_s: 1540 },
      { local_date: '2027-03-13', time_s: 1520 },
    ]
    const revised = detail([
      { number: 1, status: 'accepted', plan: ACCEPTED_V1 },
      { number: 2, status: 'proposed', plan: PENDING_V2, expected_prediction: expected },
    ])
    mockPlans([summary()], [revised], [], { history: HISTORY })
    renderPlan('/plan', new Date(2027, 1, 19))

    const section = await findSection('Trajectory')
    expect(section).toHaveTextContent('5 km')
    // The measured lines start six weeks before the first week, so the run
    // on 1 February, before the plan, is the line the plan starts from.
    const chart = await within(section).findByRole('img', { name: /best efforts 26:20 on 1 Feb to 25:45 on 18 Feb/ })
    const name = chart.getAttribute('aria-label') ?? ''
    // The shown proposal's line starts at its data_through, 18 February,
    // on the newest run on or before that day: 25:45.
    expect(name).toContain('expected 25:45 on 18 Feb to 25:20 on 13 Mar')
    expect(name).toContain('ordinary runs 27:40 on 1 Feb to 27:20 on 18 Feb')
    expect(within(section).getByText('Target 25:15')).toBeInTheDocument()
    // The prediction history is asked for at the goal's own distance.
    expect(historyRequests()).toEqual([5000])
  })

  it('says the measured predictions are loading, and starts no expected line on a guess meanwhile', async () => {
    const expected = [{ local_date: '2027-02-21', time_s: 1540 }]
    mockPlans([summary({ pending_version: null })], [detail([{ number: 1, status: 'accepted', plan: ACCEPTED_V1, expected_prediction: expected }])])
    const answer = getMock.getMockImplementation()
    if (answer === undefined) throw new Error('mockPlans set no implementation')
    getMock.mockImplementation((path: string, init?: unknown) =>
      path === '/api/predictions/history' ? new Promise(() => {}) : answer(path, init),
    )
    renderPlan('/plan', new Date(2027, 1, 19))

    const section = await findSection('Trajectory')
    expect(within(section).getByRole('status')).toHaveTextContent('Loading the measured predictions.')
    // Not Claude's estimate at data_through: the series value is not known yet.
    expect(within(section).getByRole('img').getAttribute('aria-label')).toContain('expected 25:40 on 21 Feb;')
    const outlook = await findSection('VO2max outlook')
    expect(outlook).toHaveTextContent('Loading the measured predictions.')
  })

  it('says the measured predictions could not be loaded', async () => {
    mockPlans([summary({ pending_version: null })], [detail([{ number: 1, status: 'accepted', plan: ACCEPTED_V1 }])])
    const answer = getMock.getMockImplementation()
    if (answer === undefined) throw new Error('mockPlans set no implementation')
    getMock.mockImplementation((path: string, init?: unknown) =>
      path === '/api/predictions/history'
        ? Promise.resolve({ data: undefined, error: { detail: 'store unreadable' }, response: new Response(null, { status: 503 }) })
        : answer(path, init),
    )
    renderPlan('/plan', new Date(2027, 1, 19))

    const section = await findSection('Trajectory')
    await waitFor(() =>
      expect(within(section).getByRole('status')).toHaveTextContent('The measured predictions could not be loaded: store unreadable'),
    )
  })

  it('starts a goal under a kilometre at Claude\'s estimate, asking for no history', async () => {
    const plan = planVersion({ number: 1, distanceM: 800, targetS: 150 })
    const expected = [{ local_date: '2027-02-21', time_s: 160 }]
    mockPlans([summary({ pending_version: null, distance_m: 800 })], [detail([{ number: 1, status: 'accepted', plan, expected_prediction: expected }])])
    renderPlan('/plan', new Date(2027, 1, 19))

    const section = await findSection('Trajectory')
    expect(within(section).getByRole('img').getAttribute('aria-label')).toContain('expected 25:20 on 5 Feb to 2:40 on 21 Feb')
    expect(within(section).queryByRole('status')).toBeNull()
    expect(historyRequests()).toEqual([])
  })

  it('asks for no history for a goal past 100 km, which the API refuses', async () => {
    const plan = planVersion({ number: 1, distanceM: 160934, targetS: 86400 })
    const expected = [{ local_date: '2027-02-21', time_s: 90000 }]
    mockPlans([summary({ pending_version: null, distance_m: 160934 })], [detail([{ number: 1, status: 'accepted', plan, expected_prediction: expected }])])
    renderPlan('/plan', new Date(2027, 1, 19))

    const section = await findSection('Trajectory')
    expect(within(section).queryByRole('status')).toBeNull()
    expect(historyRequests()).toEqual([])
  })

  it('draws a 7.5 km goal', async () => {
    const plan = planVersion({ number: 1, distanceM: 7500, targetS: 2400 })
    mockPlans([summary({ pending_version: null, distance_m: 7500 })], [detail([{ number: 1, status: 'accepted', plan }])], [], {
      history: HISTORY,
    })
    renderPlan('/plan', new Date(2027, 1, 19))

    const section = await findSection('Trajectory')
    await within(section).findByRole('img', { name: /best efforts/ })
    expect(historyRequests()).toEqual([7500])
  })

  it('the calendar marks the sessions a shown proposal changes, and only then', async () => {
    mockPlans([summary()], [REVISED])
    const { unmount } = renderPlan('/plan', new Date(2027, 1, 19))

    const calendar = await findSection('Calendar')
    const changedDay = within(calendar).getByText('Easy, shorter').closest('li')
    expect(changedDay).toHaveTextContent('Changed in this proposal')
    unmount()

    renderPlan(`/plan/${GOAL_ID}?version=1`, new Date(2027, 1, 19))
    expect(await findSection('Calendar')).not.toHaveTextContent('Changed in this proposal')
  })

  it('an unknown version number falls back to the default version', async () => {
    mockPlans([summary()], [REVISED])
    renderPlan(`/plan/${GOAL_ID}?version=9`, new Date(2027, 1, 19))

    expect(await screen.findByRole('heading', { level: 1, name: '5 km under 25:15' })).toBeInTheDocument()
  })

  it('the assessment gives the summary, the verdict, the reasoning and what it cites', async () => {
    mockPlans([summary()], [REVISED])
    renderPlan('/plan', new Date(2027, 1, 19))

    const assessment = await findSection('Assessment')
    expect(assessment).toHaveTextContent('Within reach but not yet likely.')
    expect(within(assessment).getByText('Possible', { ignore: HIDDEN })).toBeInTheDocument()
    // The verdict is on feasibility, not a field named Target.
    expect(within(assessment).getByText('Possible', { ignore: HIDDEN }).parentElement).toHaveTextContent('Feasibility Possible')
    expect(assessment).not.toHaveTextContent('Target')
    expect(assessment).toHaveTextContent('The best-effort prediction improved by 15 s in two weeks.')
    expect(assessment).toHaveTextContent('Predictions on 5 February')
    expect(assessment).toHaveTextContent('Weekly distance, weeks 46 and 47')
  })

  it('the assessment shows the verdict and keeps the reasoning and citations in a closed disclosure', async () => {
    const plan = planVersion({
      number: 1,
      summary: 'Verdict:\n- Possible, about 2% to find\n\nWhy it can work:\n- Volume holds',
    })
    mockPlans([summary({ pending_version: null })], [detail([{ number: 1, status: 'accepted', plan }])])
    renderPlan('/plan', new Date(2027, 1, 6))

    const assessment = await findSection('Assessment')
    expect(within(assessment).getByRole('list', { name: 'Verdict' }).closest('details')).toBeNull()
    const why = assessment.querySelector('details')
    expect(why?.open).toBe(false)
    expect(why).toHaveTextContent('Why this verdict')
    expect(why).toHaveTextContent('Volume holds')
    expect(why).toHaveTextContent('The best-effort prediction improved by 15 s in two weeks.')
    expect(why).toHaveTextContent('Cited: Predictions on 5 February')
  })

  it('reads top to bottom: the header with its phases, calendar, next session, its steps and its description, assessment, then the charts', async () => {
    mockPlans([summary()], [REVISED])
    const { container } = renderPlan('/plan', new Date(2027, 1, 19))

    await findSection('Trajectory')
    const titles = Array.from(container.querySelectorAll('h2')).map((h) => h.textContent ?? '')
    // The session details and the next week are on paper only.
    expect(titles.filter((t) => t !== 'Session details' && !t.startsWith('Week of '))).toEqual([
      'Estimated 5 km time',
      'Proposed: version 2',
      'Calendar',
      'Next session',
      'Steps',
      'Description',
      'Assessment',
      'The 8 weeks before the plan',
      'Weekly distance',
      'Weekly load',
      'Heart-rate mix',
      'Fitness and fatigue',
      'VO2max outlook',
      'Weekly intensity mix',
      'Target paces',
      'Trajectory',
      'History',
    ])
    // The phase strip is in the header, under the goal, and before the proposal.
    const phases = screen.getByRole('img', { name: /^Plan phases/ })
    const header = await findHeader()
    const title = within(header).getByRole('heading', { level: 1 })
    const proposal = await findSection('Proposed: version 2')
    expect(header).toContainElement(phases)
    expect(title.compareDocumentPosition(phases) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(phases.compareDocumentPosition(proposal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("draws the runs' load over the plan's span, and labels a heart rate target with the current zones", async () => {
    const load = runLoad('run-a', '2027-02-09', 120)
    mockPlans([summary()], [REVISED], [], { loads: [load] })
    renderPlan('/plan?session=w1-long', new Date(2027, 1, 19))

    const weekly = await findSection('Weekly load')
    await waitFor(() => expect(weekly.querySelectorAll('[data-bar="run"]')).toHaveLength(2))
    expect(within(weekly).getByRole('status')).toHaveTextContent('This version predates heart-rate planning.')
    expect(within(weekly).getByRole('img').getAttribute('aria-label')).toContain('W1: 120 run.')
    const mix = await findSection('Heart-rate mix')
    expect(mix.querySelectorAll('[data-bar="run"][data-week="1"]')).toHaveLength(1)
    // The span's last Sunday, since this endpoint's `to` is inclusive.
    const asked = getMock.mock.calls.filter((c) => c[0] === '/api/training-load').map((c) => c[1])
    // Six weeks before the plan's first Monday, for the fitness chart's lead-in.
    expect(asked).toContainEqual({ params: { query: { from: '2026-12-28', to: '2027-03-14' } } })
    // The versions carry no zones of their own, so the current estimate's label the strides.
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(targetText('150-170 bpm (Z4)'))).toBeInTheDocument()
  })

  it("labels a heart rate target with the version's own zones over the current estimate's", async () => {
    // Zones that end at 160, 165, 170 and 180 bpm put the strides' 170 bpm
    // top in zone 3; the current estimate's would put it in zone 4.
    const stamped: PlanVersion = {
      ...ACCEPTED_V1,
      provenance: { ...ACCEPTED_V1.provenance, zone_boundaries_bpm: [160, 165, 170, 180] },
    }
    mockPlans([summary({ pending_version: null })], [detail([{ number: 1, status: 'accepted', plan: stamped }])])
    renderPlan('/plan?session=w1-long', new Date(2027, 1, 19))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(targetText('150-170 bpm (Z3)'))).toBeInTheDocument()
  })

  it('keeps the stored run load when the threshold request fails', async () => {
    const load = runLoad('run-a', '2027-02-09', 120)
    mockPlans([summary()], [REVISED], [], { loads: [load] })
    const answer = getMock.getMockImplementation()
    getMock.mockImplementation((path: string, init?: MockInit) =>
      path === '/api/threshold'
        ? Promise.resolve({ data: undefined, error: { detail: 'boom' }, response: new Response(null, { status: 500 }) })
        : answer?.(path, init),
    )
    renderPlan('/plan', new Date(2027, 1, 19))

    const weekly = await findSection('Weekly load')
    await waitFor(() => expect(weekly.querySelectorAll('[data-bar="run"]')).toHaveLength(2))
  })

  it('draws the run TRIMP without a threshold estimate, and says the heart-rate mix has no zones', async () => {
    const loads = [runLoad('run-a', '2027-02-09', 120)]
    mockPlans([summary()], [REVISED], [], { loads, threshold: { current: null } })
    renderPlan('/plan', new Date(2027, 1, 19))

    const weekly = await findSection('Weekly load')
    await waitFor(() => expect(weekly.querySelectorAll('[data-bar="run"]')).toHaveLength(2))
    expect(within(weekly).getByRole('status')).toHaveTextContent('This version predates heart-rate planning.')
    const mix = await findSection('Heart-rate mix')
    expect(
      await within(mix).findByText('This version predates heart-rate planning. No threshold estimate yet.'),
    ).toBeInTheDocument()
    const outlook = await findSection('VO2max outlook')
    expect(within(outlook).getByText('No version of this plan carries a VO2max outlook.')).toBeInTheDocument()
  })

  it('draws measured fitness and fatigue and what the version expects, with race-morning form', async () => {
    const stamped: PlanVersion = {
      ...ACCEPTED_V1,
      provenance: {
        ...ACCEPTED_V1.provenance,
        expected_load: {
          start: { local_date: '2027-02-07', ctl: 40, atl: 50, form: -10 },
          race_morning: { local_date: '2027-03-12', ctl: 43, atl: 35, form: 8 },
          weeks: [
            { week_start: '2027-02-08', days: 7, trimp: 300, ctl_mean: 41, atl_mean: 46, form_mean: -5 },
            { week_start: '2027-02-15', days: 7, trimp: 310, ctl_mean: 42, atl_mean: 44, form_mean: -2 },
          ],
          bridged_from: [],
        },
      },
    }
    const measured = (start: string, ctl: number): S['LoadWeek'] => ({
      week_start: start,
      days: 7,
      trimp: 7 * ctl,
      ctl_mean: ctl,
      atl_mean: ctl + 5,
      form_mean: -5,
      distance_m: 0,
    })
    mockPlans([summary({ pending_version: null })], [detail([{ number: 1, status: 'accepted', plan: stamped }])], [], {
      weeks: [measured('2027-01-25', 38), measured('2027-02-01', 39)],
    })
    renderPlan('/plan', new Date(2027, 1, 19))

    const card = await findSection('Fitness and fatigue')
    await waitFor(() => expect(card.querySelectorAll('[data-mark="measured"]')).toHaveLength(2))
    expect(card.querySelectorAll('[data-mark="expected"]')).toHaveLength(2)
    expect(within(card).getByText('Form on race morning')).toBeInTheDocument()
    expect(within(card).getByText('+8.0')).toBeInTheDocument()
  })

  it('asks for the measured weeks from where an earlier expected series starts', async () => {
    // A queued goal proposed long before its first week: its expected series,
    // bridged from another plan, starts well over six weeks before the plan.
    const queued: PlanVersion = {
      ...ACCEPTED_V1,
      provenance: {
        ...ACCEPTED_V1.provenance,
        expected_load: {
          start: { local_date: '2026-12-01', ctl: 40, atl: 50, form: -10 },
          race_morning: { local_date: '2027-03-12', ctl: 43, atl: 35, form: 8 },
          weeks: [{ week_start: '2026-11-30', days: 7, trimp: 300, ctl_mean: 41, atl_mean: 46, form_mean: -5 }],
          bridged_from: ['earlier'],
        },
      },
    }
    mockPlans([summary({ pending_version: null })], [detail([{ number: 1, status: 'accepted', plan: queued }])])
    renderPlan('/plan', new Date(2027, 1, 19))

    await findSection('Fitness and fatigue')
    const asked = getMock.mock.calls.filter((c) => c[0] === '/api/training-load').map((c) => c[1])
    expect(asked).toContainEqual({ params: { query: { from: '2026-11-30', to: '2027-03-14' } } })
  })

  it('plans the weekly load in TRIMP from the stamped TRIMP per minute', async () => {
    const stamped: PlanVersion = {
      ...ACCEPTED_V1,
      weeks: ACCEPTED_V1.weeks.map((w, i) => (i === 1 ? { ...w, planned_zone_minutes: [60, 30, 0, 10, 0] } : w)),
      provenance: { ...ACCEPTED_V1.provenance, trimp_per_minute: [1, 1.5, 2, 2.5, 3] },
    }
    mockPlans([summary({ pending_version: null })], [detail([{ number: 1, status: 'accepted', plan: stamped }])])
    renderPlan('/plan', new Date(2027, 1, 19))

    const weekly = await findSection('Weekly load')
    expect(
      within(weekly).getByText(
        "Planned against run TRIMP. Planned TRIMP is the plan's minutes in each zone times your recent TRIMP per minute in that zone.",
      ),
    ).toBeInTheDocument()
    await waitFor(() => expect(weekly.querySelectorAll('[data-bar="planned"]')).toHaveLength(1))
    expect(within(weekly).getByRole('img').getAttribute('aria-label')).toContain('W2: 130 planned')
  })

  it('draws no planned TRIMP for a version with zone minutes but no TRIMP per minute, and says so', async () => {
    const unstamped: PlanVersion = {
      ...ACCEPTED_V1,
      weeks: ACCEPTED_V1.weeks.map((w, i) => (i === 1 ? { ...w, planned_zone_minutes: [60, 30, 0, 10, 0] } : w)),
    }
    mockPlans(
      [summary({ pending_version: null })],
      [detail([{ number: 1, status: 'accepted', plan: unstamped }])],
      [],
      { loads: [runLoad('run-a', '2027-02-09', 120)] },
    )
    renderPlan('/plan', new Date(2027, 1, 19))

    const weekly = await findSection('Weekly load')
    await waitFor(() => expect(weekly.querySelectorAll('[data-bar="run"]')).toHaveLength(2))
    expect(weekly.querySelectorAll('[data-bar="planned"]')).toHaveLength(0)
    expect(within(weekly).getByRole('status')).toHaveTextContent('This version predates planned TRIMP')
  })

  it('leaves a week whose runs all lack heart rate without a run bar', async () => {
    mockPlans([summary()], [REVISED], [], {
      loads: [runLoad('run-a', '2027-02-09', 120), runLoad('run-b', '2027-02-16', null)],
    })
    renderPlan('/plan', new Date(2027, 1, 19))

    const weekly = await findSection('Weekly load')
    await waitFor(() => expect(weekly.querySelectorAll('[data-bar="run"]')).toHaveLength(1))
    expect(weekly.querySelectorAll('[data-bar="run"][data-week="2"]')).toHaveLength(0)
    const mix = await findSection('Heart-rate mix')
    expect(mix.querySelectorAll('[data-bar="run"][data-week="2"]')).toHaveLength(0)
  })

  it('the lead-in asks for the eight weeks before the plan and stacks their runs by their tags', async () => {
    const run = (id: string, date: string, distanceM: number, tags: string[], prKeys: string[] = []) =>
      ({
        activity_id: id,
        start_time_utc: `${date}T07:00:00Z`,
        utc_offset_s: 3600,
        distance_m: distanceM,
        pr_distance_keys: prKeys,
        effort_tags: tags,
      }) as S['ActivitySummary']
    const runs = [
      run('a', '2026-12-15', 8000, ['easy']),
      run('b', '2027-01-31', 16000, ['steady', 'long_run']),
      run('c', '2027-02-03', 5000, ['all_out'], ['5k']),
    ]
    mockPlans([summary({ pending_version: null })], [detail([{ number: 1, status: 'accepted', plan: ACCEPTED_V1 }])], runs)
    renderPlan('/plan', new Date(2027, 1, 6))

    const leadIn = await findSection('Your last 8 weeks')
    const requested = getMock.mock.calls
      .filter((c) => c[0] === '/api/activities')
      .map((c) => (c[1] as { params: { query: unknown } }).params.query)
    expect(requested).toContainEqual({ sport: 'running', from: '2026-12-14', to: '2027-02-08', limit: 200, offset: 0 })
    // The stat row, each figure's label then its value.
    await within(leadIn).findByText('A week')
    const figures = Array.from(leadIn.querySelectorAll('dl > div')).map((d) => d.textContent)
    expect(figures).toEqual(['A week3.6 km', 'Runs a week0.4', 'Longest run16.0 km', 'Quality session1'])
    const segment = (week: string) =>
      Array.from(leadIn.querySelectorAll(`[data-week="${week}"][data-segment]`)).map((r) => r.getAttribute('data-segment'))
    expect(segment('1')).toEqual(['easy'])
    expect(segment('7')).toEqual(['long'])
    expect(segment('8')).toEqual(['all_out'])
    expect(within(leadIn).getByText('PR 5.0 km')).toBeInTheDocument()
    // The tags ride on the list: no run's detail is asked for.
    expect(getMock.mock.calls.filter((c) => c[0] === '/api/activities/{activity_id}')).toEqual([])
  })

  it('the next session gives its day, kind, description and steps in pace', async () => {
    mockPlans([summary()], [REVISED])
    // Friday 19 February: the next session is week 2's long run on Sunday 29.
    renderPlan('/plan', new Date(2027, 1, 19))

    const next = await findSection('Next session')
    expect(next).toHaveTextContent('Sunday 21 February')
    expect(next).toHaveTextContent('Long run')
    expect(within(next).getByRole('heading', { level: 3, name: '13 km easy' })).toBeInTheDocument()
    // Its description on the card after it, which names the session.
    const description = await findSection('Description')
    expect(description).toHaveTextContent('13 km easy, as Claude wrote it.')
    expect(description).toHaveTextContent('Keep it conversational, then strides.')
    expect(next).not.toHaveTextContent('Keep it conversational, then strides.')
    expect(next).toHaveTextContent('13 km')
    // Its steps on the card between them, as the dialog sets them.
    const steps = await findSection('Steps')
    expect(within(steps).getByRole('list', { name: 'Steps' })).toBeInTheDocument()
    // 2.6667 to 2.8571 m/s is 6:15 to 5:50 per km.
    expect(steps).toHaveTextContent('5:50-6:15/km')
    expect(steps).toHaveTextContent('4 × 20 s')
    expect(steps).toHaveTextContent('150-170 bpm')
  })

  it('history lists every version newest first, each linking to itself', async () => {
    mockPlans([summary()], [REVISED])
    renderPlan('/plan', new Date(2027, 1, 19))

    const history = await findSection('History')
    const links = within(history).getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      `/plan/${GOAL_ID}?version=2`,
      `/plan/${GOAL_ID}?version=1`,
    ])
    expect(links[0]).toHaveTextContent('Version 2')
    expect(links[0]).toHaveTextContent('Proposed')
    expect(links[0]).toHaveTextContent('Target moved to 25:15')
    expect(links[1]).toHaveTextContent('Accepted')
    expect(links[0]).toHaveAttribute('aria-current', 'page')
  })

  it('an unknown goal id is stated, not an error', async () => {
    mockPlans([summary()], [REVISED])
    renderPlan('/plan/nope', new Date(2027, 1, 19))

    expect(await screen.findByRole('heading', { level: 1, name: 'No such plan' })).toBeInTheDocument()
  })
})

describe('Plan session detail', () => {
  // Saturday 6 February, before the plan's first week.
  const TODAY = new Date(2027, 1, 6)

  it('?session=w1-intervals opens that session in a dialog', async () => {
    mockPlans([summary()], [REVISED])
    renderPlan('/plan?session=w1-intervals', TODAY)

    const dialog = await screen.findByRole('dialog', { name: '6 × 800 m' })
    expect(dialog).toHaveAttribute('open')
    expect(dialog).toHaveTextContent('Thursday 11 February')
    expect(within(dialog).getByText('Intervals', { selector: 'span' })).toBeInTheDocument()
    expect(within(dialog).getByText('Phase', { selector: 'dt' }).nextElementSibling).toHaveTextContent('Build')
    expect(dialog).toHaveTextContent('Warm up with 2 km easy and four strides. Feel: 7-8 out of 10.')
    expect(dialog).toHaveTextContent('4:15-4:20/km')
    expect(dialog).toHaveTextContent('13.8-14.1 km/h')
  })

  it('Escape closes it and clears the param', async () => {
    mockPlans([summary()], [REVISED])
    const { router } = renderPlan('/plan?session=w1-intervals', TODAY)

    const dialog = await screen.findByRole('dialog', { name: '6 × 800 m' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(router.state.location.search).toEqual({})
  })

  it('the close button closes it and gives focus to the session in the calendar', async () => {
    mockPlans([summary()], [REVISED])
    const { router } = renderPlan('/plan?session=w1-intervals', TODAY)

    const dialog = await screen.findByRole('dialog', { name: '6 × 800 m' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(router.state.location.search).toEqual({})
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Thursday 11 February, Intervals/ }))
  })

  it('a session clicked in the calendar opens, is named in the URL, and closing goes back', async () => {
    mockPlans([summary()], [REVISED])
    const { router } = renderPlan('/plan?version=1', TODAY)

    fireEvent.click(await screen.findByRole('button', { name: /^Thursday 11 February, Intervals/ }))
    const dialog = await screen.findByRole('dialog', { name: '6 × 800 m' })
    expect(router.state.location.search).toEqual({ version: 1, session: 'w1-intervals' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // Back to the entry it was opened from, so the browser's back button
    // does not reopen it.
    await waitFor(() => expect(router.state.location.search).toEqual({ version: 1 }))
    expect(router.history.canGoBack()).toBe(false)
  })

  it('the browser going back closes it', async () => {
    mockPlans([summary()], [REVISED])
    const { router } = renderPlan('/plan', TODAY)

    fireEvent.click(await screen.findByRole('button', { name: /^Thursday 11 February, Intervals/ }))
    await screen.findByRole('dialog', { name: '6 × 800 m' })
    router.history.back()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('an unknown session id opens nothing', async () => {
    mockPlans([summary()], [REVISED])
    renderPlan('/plan?session=w9-nothing', TODAY)

    await findSection('Calendar')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('the next session is written out by the same detail, with its phase', async () => {
    mockPlans([summary()], [REVISED])
    renderPlan('/plan', new Date(2027, 1, 10))

    const next = await findSection('Next session')
    expect(next).toHaveTextContent('Thursday 11 February')
    expect(within(next).getByText('Intervals', { selector: 'span' })).toBeInTheDocument()
    expect(within(next).getByText('Phase', { selector: 'dt' }).nextElementSibling).toHaveTextContent('Build')
    expect(await findSection('Steps')).toHaveTextContent('13.8-14.1 km/h')
  })

  it('the print appendix gives every detailed session in date order', async () => {
    mockPlans([summary()], [REVISED])
    renderPlan('/plan', TODAY)

    const appendix = await findSection('Session details')
    expect(within(appendix).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Easy',
      '6 × 800 m',
      '13 km easy',
      'Easy, shorter',
      '13 km easy',
      'Easy',
      '13 km easy',
      'Race',
    ])
    expect(appendix).toHaveTextContent('Warm up with 2 km easy and four strides.')
    expect(appendix).toHaveTextContent('13.8-14.1 km/h')
  })
})

describe("Plan: Claude's structured prose", () => {
  it('the assessment sets out a structured summary and reasoning as labelled lists', async () => {
    const plan = planVersion({
      number: 1,
      summary: 'Where you stand:\n- Fitter than in May\n- Volume steady at 35 km a week',
      reasoning: 'From the store:\n- The 5 km best effort\n\nFrom you:\n- The race course measured 80 m long',
    })
    mockPlans([summary({ pending_version: null })], [detail([{ number: 1, status: 'accepted', plan }])])
    renderPlan('/plan', new Date(2027, 1, 6))

    const assessment = await findSection('Assessment')
    const stand = within(assessment).getByRole('list', { name: 'Where you stand' })
    expect(within(stand).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Fitter than in May',
      'Volume steady at 35 km a week',
    ])
    expect(within(assessment).getByRole('list', { name: 'From the store' })).toHaveTextContent('The 5 km best effort')
    expect(within(assessment).getByRole('list', { name: 'From you' })).toHaveTextContent('The race course measured 80 m long')
    expect(within(assessment).getByText('From you').tagName).toBe('STRONG')
  })

  it("a change's reason is set out as its structure", async () => {
    const plan = planVersion({
      number: 2,
      changes: [
        {
          title: 'Week 2 cut',
          reason: 'Why:\n- The easy run on 18 February was missed\n- The Achilles was sore',
          session_ids: [],
          goal_change: false,
        },
      ],
    })
    mockPlans([summary()], [detail([{ number: 1, status: 'accepted', plan: ACCEPTED_V1 }, { number: 2, status: 'proposed', plan }])])
    renderPlan('/plan', new Date(2027, 1, 6))

    const proposal = await findSection('Proposed: version 2')
    const why = within(proposal).getByRole('list', { name: 'Why' })
    expect(within(why).getAllByRole('listitem')).toHaveLength(2)
  })
})
