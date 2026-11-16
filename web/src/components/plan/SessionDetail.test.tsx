import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import type { components } from '../../api/schema'
import { SessionDetail } from './SessionDetail'
import detailStyles from './SessionDetail.module.css'
import { KIND_MARK, kindSlotClass } from './sessionMarks'
import type { RunLoad } from './planLoadMath'
import { runsByLocalDay } from './planMath'
import type { ActivitySummary, Outcome, Session } from './planMath'

type S = components['schemas']

/*
 * A synthetic interval session on Tuesday 17 November, written the way the
 * training-plan skill asks: the warm-up spelled out, the effort out of 10,
 * and a step of each shape - a speed, a duration with no speed, and a heart
 * rate range.
 */
const INTERVALS: Session = {
  id: 'w1-intervals',
  date: '2026-11-17',
  kind: 'intervals',
  title: '6 × 800 m',
  description: 'Before the reps:\n- 2 km easy\n- 4 strides\n\nFeel: 7-8 out of 10, hard but controlled.',
  planned_distance_m: 10000,
  planned_duration_s: 3000,
  steps: [
    { role: 'warmup', repeat: 1, distance_m: 2500, speed: { low_mps: 2.5, high_mps: 2.7778 }, note: 'Easy, drills' },
    { role: 'work', repeat: 6, distance_m: 800, speed: { low_mps: 3.8462, high_mps: 3.9216 }, note: '7-8/10' },
    { role: 'recovery', repeat: 6, duration_s: 90, note: 'Walk or jog' },
    { role: 'cooldown', repeat: 1, distance_m: 1500, heart_rate: { low_bpm: 120, high_bpm: 140 } },
  ],
}

function run(id: string, start: string, distance: number): ActivitySummary {
  return { activity_id: id, start_time_utc: start, utc_offset_s: 3600, distance_m: distance } as unknown as ActivitySummary
}

/** Renders inside a router, since a run is a `Link`. */
function renderInRouter(node: ReactNode) {
  const rootRoute = createRootRoute({ component: () => node })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/'] }) })
  return render(<RouterProvider router={router} />)
}

function renderDetail(
  over: {
    outcome?: Outcome
    runs?: ActivitySummary[]
    session?: Session
    zoneBoundaries?: number[]
    runLoads?: RunLoad[]
  } = {},
) {
  return renderInRouter(
    <SessionDetail
      entry={{ session: over.session ?? INTERVALS, phase: 'build' }}
      outcome={over.outcome ?? null}
      runsByDay={runsByLocalDay(over.runs ?? [])}
      today={new Date(2026, 10, 14)}
      zoneBoundaries={over.zoneBoundaries ?? null}
      runLoads={over.runLoads ?? []}
    />,
  )
}

/** A stat in the head's row by its name: the value under it. */
function stat(name: string, scope: HTMLElement = document.body): string | null {
  return within(scope).getByText(name, { selector: 'dt' }).nextElementSibling?.textContent ?? null
}

async function steps(): Promise<HTMLElement[]> {
  return within(await screen.findByRole('list', { name: 'Steps' })).getAllByRole('listitem')
}

describe('SessionDetail', () => {
  it('states the day, the kind, the phase, the title and the whole description', async () => {
    renderDetail()

    const title = await screen.findByRole('heading', { name: '6 × 800 m' })
    expect(title).toBeInTheDocument()
    expect(screen.getByText(/Tuesday 17 November/)).toHaveTextContent(/^Tuesday 17 November$/)
    // The kind as its tag, in the kind's tint, and the week's phase as a stat.
    expect(screen.getByText('Intervals', { selector: 'span' })).toBeInTheDocument()
    expect(stat('Phase')).toBe('Build')
    expect(screen.getByText('Feel: 7-8 out of 10, hard but controlled.').tagName).toBe('P')
  })

  it('writes the description out as its structure: a label over its list', async () => {
    renderDetail()

    const label = await screen.findByText('Before the reps')
    expect(label.tagName).toBe('STRONG')
    const list = screen.getByRole('list', { name: 'Before the reps' })
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['2 km easy', '4 strides'])
  })

  it('draws the session as a workout profile named in words', async () => {
    renderDetail()
    expect(
      await screen.findByRole('img', {
        name: 'Workout profile: warm-up 2.5 km, 6 × 800 m at 4:15-4:20/km with 1:30 recoveries, cool-down 1.5 km.',
      }),
    ).toBeInTheDocument()
  })

  it('states the planned distance and duration', async () => {
    renderDetail()

    await screen.findByRole('heading', { name: '6 × 800 m' })
    expect(stat('Distance')).toBe('10 km')
    expect(stat('Time')).toBe('50 min')
    // "Planned" said once for the row, under it.
    expect(screen.getAllByText(/Planned/)).toHaveLength(1)
    expect(screen.getByText('Planned distance and time').tagName).toBe('P')
  })

  it('lists every step in order, each with its pace and its treadmill speed', async () => {
    renderDetail()

    const [warmup, work] = await steps()
    expect(warmup).toHaveTextContent('Warm-up')
    expect(warmup).toHaveTextContent('2.5 km')
    // 2.7778 to 2.5 m/s: 6:00 to 6:40 per km, 9.0 to 10.0 km/h.
    expect(warmup).toHaveTextContent('6:00-6:40/km')
    expect(warmup).toHaveTextContent('9.0-10.0 km/h')
    expect(warmup).toHaveTextContent('Easy, drills')
    expect(work).toHaveTextContent('Work')
    expect(work).toHaveTextContent('6 × 800 m')
    expect(work).toHaveTextContent('4:15-4:20/km')
    expect(work).toHaveTextContent('13.8-14.1 km/h')
    expect(work).toHaveTextContent('7-8/10')
  })

  it('names each unit once in its column, and keeps it in the cell for a screen reader', async () => {
    renderDetail()

    const [, work] = await steps()
    // The column header names the unit a phone's cells leave out of sight.
    const columns = screen.getByText('Pace', { selector: 'span' })
    expect(columns).toHaveTextContent('Pace /km')
    expect(columns.parentElement).toHaveTextContent('Pace /kmTreadmill km/hHeart rate bpm')
    // The cell's figure is its own text, its unit a span of its own after it.
    const pace = within(work as HTMLElement).getByText('4:15-4:20')
    expect(pace.tagName).toBe('DD')
    expect(pace).toHaveTextContent(/^4:15-4:20\/km$/)
    expect(stat('Treadmill', work as HTMLElement)).toBe('13.8-14.1 km/h')
  })

  it('marks each step with its kind of effort: the work in the kind of the session, the easy steps in the easy kind', async () => {
    renderDetail()

    const [warmup, work, recovery, cooldown] = await steps()
    const mark = (step: HTMLElement | undefined) => step?.querySelector(`.${KIND_MARK.swatch}`)?.getAttribute('class') ?? ''
    expect(mark(work)).toContain(kindSlotClass('intervals'))
    expect(mark(work)).not.toContain(detailStyles.markEasy)
    for (const easy of [warmup, recovery, cooldown]) {
      expect(mark(easy)).toContain(kindSlotClass('easy'))
      expect(mark(easy)).toContain(detailStyles.markEasy)
      // Only the work row is tinted.
      expect(easy?.classList.contains(KIND_MARK.tint)).toBe(false)
    }
  })

  it('a step with a duration and no speed shows its length and no pace', async () => {
    renderDetail()

    const recovery = (await steps())[2]
    expect(recovery).toHaveTextContent('Recovery')
    expect(recovery).toHaveTextContent('6 × 1:30')
    expect(recovery).toHaveTextContent('Walk or jog')
    expect(recovery).not.toHaveTextContent('/km')
    expect(recovery).not.toHaveTextContent('km/h')
  })

  it('a step with a heart rate range shows it, and no speed', async () => {
    renderDetail()

    const cooldown = (await steps())[3]
    expect(cooldown).toHaveTextContent('Cool-down')
    expect(cooldown).toHaveTextContent('120-140 bpm')
    expect(cooldown).not.toHaveTextContent('km/h')
    // Only a heart rate set: a phone lifts it onto the name line.
    expect(cooldown).toHaveAttribute('data-hr-only')
    const [, work] = await steps()
    expect(work).not.toHaveAttribute('data-hr-only')
  })

  it('names every target column in each step, a dash where the step sets none', async () => {
    renderDetail()

    const cooldown = (await steps())[3] as HTMLElement
    // In the table a desktop draws, the cool-down's pace and treadmill
    // columns hold a dash; its heart rate is its own.
    expect(stat('Pace', cooldown)).toBe('–')
    expect(stat('Treadmill', cooldown)).toBe('–')
    expect(stat('Heart rate', cooldown)).toBe('120-140 bpm')
  })

  it('a work step that sets no heart rate holds a dash', async () => {
    renderDetail()

    const work = (await steps())[1] as HTMLElement
    expect(stat('Heart rate', work)).toBe('–')
    expect(within(work).getByText('–').closest('[data-empty]')).not.toBeNull()
  })

  it('does not say a note that only repeats the role', async () => {
    const session: Session = {
      ...INTERVALS,
      steps: [{ role: 'strides', repeat: 4, duration_s: 20, note: 'strides' }, ...INTERVALS.steps],
    }
    renderDetail({ session })

    const strides = (await steps())[0] as HTMLElement
    expect(strides).toHaveTextContent('Strides')
    expect(strides).toHaveTextContent('4 × 20 s')
    expect(within(strides).getAllByText(/strides/i)).toHaveLength(1)
  })

  it("a past session gives Claude's verdict and note, the matched run and the day's other runs", async () => {
    renderDetail({
      outcome: { session_id: 'w1-intervals', verdict: 'partial', activity_ids: ['run-1'], note: 'The last two reps faded.' },
      runs: [run('run-1', '2026-11-17T06:30:00Z', 8400), run('run-2', '2026-11-17T17:00:00Z', 3000)],
    })

    const verdict = await screen.findByRole('heading', { name: "Claude's verdict" })
    const block = verdict.parentElement
    if (block === null) throw new Error('the verdict heading has no block')
    expect(block).toHaveTextContent('Partial')
    expect(block).toHaveTextContent('The last two reps faded.')
    const matched = within(block).getByRole('link')
    expect(matched).toHaveAttribute('href', '/activities/run-1')
    // 06:30 UTC at +1 h, and its distance.
    expect(matched).toHaveTextContent('07:30')
    expect(matched).toHaveTextContent('8.4 km')

    const others = screen.getByRole('heading', { name: 'Other runs on this day' }).parentElement
    if (others === null) throw new Error('the runs heading has no block')
    expect(within(others).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/activities/run-2'])
  })

  it('a matched run outside the loaded runs still links to it', async () => {
    renderDetail({
      outcome: { session_id: 'w1-intervals', verdict: 'moved', activity_ids: ['run-9'], note: '' },
    })

    const verdict = await screen.findByRole('heading', { name: "Claude's verdict" })
    expect(within(verdict.parentElement as HTMLElement).getByRole('link')).toHaveAttribute('href', '/activities/run-9')
  })

  it('a session with no outcome says nothing of a verdict, and lists the runs that day', async () => {
    renderDetail({ runs: [run('run-1', '2026-11-17T06:30:00Z', 8400)] })

    await screen.findByRole('heading', { name: '6 × 800 m' })
    expect(screen.queryByRole('heading', { name: "Claude's verdict" })).toBeNull()
    const runs = screen.getByRole('heading', { name: 'Runs on this day' }).parentElement
    expect(within(runs as HTMLElement).getByRole('link')).toHaveAttribute('href', '/activities/run-1')
  })

  it('a session with no steps and no plan figures shows its description alone', async () => {
    const rest: S['Session'] = { id: 'w1-rest', date: '2026-11-18', kind: 'rest', title: 'Rest', description: 'Walk if you like.', steps: [] }
    renderDetail({ session: rest })

    expect(await screen.findByText('Walk if you like.')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Steps' })).toBeNull()
    expect(screen.queryByText('Distance', { selector: 'dt' })).toBeNull()
    expect(screen.queryByText('Time', { selector: 'dt' })).toBeNull()
    expect(screen.queryByText(/Planned/)).toBeNull()
  })

  it('framed, as the dialog draws it, names its steps and its description', async () => {
    renderInRouter(
      <SessionDetail
        entry={{ session: INTERVALS, phase: 'build' }}
        outcome={null}
        runsByDay={runsByLocalDay([])}
        today={new Date(2026, 10, 14)}
        headingLevel={2}
        framed
      />,
    )

    expect(await screen.findByRole('heading', { level: 2, name: '6 × 800 m' })).toBeInTheDocument()
    const stepsHeading = screen.getByRole('heading', { level: 3, name: 'Steps' })
    // The heading stands in the steps' heading row, which the list follows in the same card.
    const stepsPart = stepsHeading.parentElement?.parentElement as HTMLElement
    expect(within(stepsPart).getByRole('list', { name: 'Steps' })).toBeInTheDocument()
    const description = screen.getByRole('heading', { level: 3, name: 'Description' }).parentElement as HTMLElement
    expect(description).toHaveTextContent('Feel: 7-8 out of 10, hard but controlled.')
  })

  const EASY: Session = {
    id: 'w1-easy',
    date: '2026-11-17',
    kind: 'easy',
    title: 'Easy',
    description: '',
    steps: [{ role: 'work', repeat: 1, distance_m: 8000, heart_rate: { high_bpm: 161 } }],
  }

  it('a ceiling reads "up to 161 bpm (Z2)"', async () => {
    renderDetail({ session: EASY, zoneBoundaries: [140, 167.4, 175, 185] })

    // The value, its unit and its zone are spans of one cell.
    expect(
      await screen.findByText((_, el) => el?.tagName === 'DD' && el.textContent === 'up to 161 bpm (Z2)'),
    ).toBeInTheDocument()
  })

  it('an easy session shows the share of the matched run at or under its ceiling', async () => {
    const load: RunLoad = {
      activity_id: 'a1',
      local_date: '2026-11-17',
      lthr_bpm: 170,
      trimp: 50,
      rest_bpm: 50,
      max_bpm: 200,
      rest_from_setting: false,
      max_from_setting: false,
      zone_seconds: [],
      hr_bpm: [150, 160, 170, 180],
      hr_seconds: [100, 100, 50, 50],
    }
    renderDetail({
      session: EASY,
      outcome: { session_id: 'w1-easy', verdict: 'done', note: '', activity_ids: ['a1'] } as unknown as Outcome,
      runLoads: [load],
    })

    expect(await screen.findByText('67% of the run at or under 161 bpm')).toBeInTheDocument()
  })
})
