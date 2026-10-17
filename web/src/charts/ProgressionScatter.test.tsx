import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import type { components } from '../api/schema'
import { ProgressionScatter } from './ProgressionScatter'
import { LADDER_LABEL_DY } from './progressionMath'
import styles from './ProgressionScatter.module.css'

type ProgressionPoint = components['schemas']['ProgressionPoint']
type RouteRun = components['schemas']['RouteRun']

/** The shape of one `/api/progression/5k` item: the fastest clean 5 km, a synthetic 25:00 at an even 5:00/km. */
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

const LADDER: ProgressionPoint[] = [
  point({ activity_id: 'first', start_time_utc: '2024-03-01T08:00:00Z', elapsed_time_s: 1560, is_record: true }),
  point({ activity_id: 'slower', start_time_utc: '2024-06-01T08:00:00Z', elapsed_time_s: 1600, is_record: false }),
  point({
    activity_id: 'treadmill',
    start_time_utc: '2024-09-01T08:00:00Z',
    elapsed_time_s: 1300,
    is_eligible: false,
    is_record: false,
    ineligible_reason: 'treadmill: distance is from an uncalibrated footpod',
  }),
  point({ activity_id: 'fastest', start_time_utc: '2025-10-12T16:00:00Z', elapsed_time_s: 1500, is_record: true }),
]

/**
 * A memory router underneath, because every point is a link into
 * `/activities/$activityId` and `Link` resolves against the router
 * context. The detail route renders a marker so a test can see the
 * navigation land.
 */
function renderScatter(points: ProgressionPoint[], showIneligible = true) {
  return renderInRouter(
    <ProgressionScatter points={points} distanceM={5000} showIneligible={showIneligible} ariaLabel="5 km progression" />,
  )
}

function renderInRouter(chart: ReactNode) {
  const rootRoute = createRootRoute()
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => chart,
  })
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/activities/$activityId',
    component: () => <p>detail view</p>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { ...utils, router }
}

/**
 * The scatter under a toggle for `showIneligible`, so one test can take the
 * panel from its empty state to a drawn one without remounting the
 * component - which is the path a reader takes with the page's checkbox.
 */
function renderToggleableScatter(points: ProgressionPoint[]) {
  function Toggleable() {
    const [showIneligible, setShowIneligible] = useState(false)
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setShowIneligible((previous) => !previous)
          }}
        >
          toggle ineligible
        </button>
        <ProgressionScatter points={points} distanceM={5000} showIneligible={showIneligible} ariaLabel="5 km progression" />
      </>
    )
  }
  const rootRoute = createRootRoute()
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Toggleable })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

function circles(container: HTMLElement): SVGCircleElement[] {
  return Array.from(container.querySelectorAll('circle[data-activity-id]'))
}

function circleFor(container: HTMLElement, activityId: string): SVGCircleElement {
  const circle = container.querySelector<SVGCircleElement>(`circle[data-activity-id="${activityId}"]`)
  if (circle === null) throw new Error(`no point for ${activityId}`)
  return circle
}

/**
 * jsdom lays nothing out and reports zero for every height, so the flip
 * between a readout above its point and one below it cannot be exercised
 * without supplying the two measurements the component reads: the panel's
 * `clientHeight` and the readout's `offsetHeight`. Both are stubbed on the
 * prototype and told apart by the readout's own test id. Returns the
 * restore function, so one test's stub cannot leak into the next.
 */
function measureHeights(panelHeightPx: number, readoutHeightPx: number): () => void {
  const proto = HTMLElement.prototype
  const originalClient = Object.getOwnPropertyDescriptor(proto, 'clientHeight')
  const originalOffset = Object.getOwnPropertyDescriptor(proto, 'offsetHeight')
  const isReadout = (element: HTMLElement) => element.dataset.testid === 'progression-readout'
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isReadout(this) ? readoutHeightPx : panelHeightPx
    },
  })
  Object.defineProperty(proto, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isReadout(this) ? readoutHeightPx : panelHeightPx
    },
  })
  return () => {
    // `Reflect.deleteProperty` rather than `delete`, which TypeScript
    // refuses on a readonly DOM property. jsdom does define both, so this
    // branch is the belt-and-braces one.
    if (originalClient === undefined) Reflect.deleteProperty(proto, 'clientHeight')
    else Object.defineProperty(proto, 'clientHeight', originalClient)
    if (originalOffset === undefined) Reflect.deleteProperty(proto, 'offsetHeight')
    else Object.defineProperty(proto, 'offsetHeight', originalOffset)
  }
}

describe('ProgressionScatter', () => {
  it('renders a faster effort at a greater y than a slower one, so it sits lower on the chart', async () => {
    const { container } = renderScatter(LADDER)
    await screen.findByRole('img', { name: '5 km progression' })
    const fast = Number(circleFor(container, 'fastest').getAttribute('cy'))
    const slow = Number(circleFor(container, 'slower').getAttribute('cy'))
    expect(fast).toBeGreaterThan(slow)
  })

  it('draws records in the accent colour and visually apart from ordinary efforts', async () => {
    const { container } = renderScatter(LADDER)
    await screen.findByRole('img', { name: '5 km progression' })
    const record = circleFor(container, 'fastest')
    const ordinary = circleFor(container, 'slower')
    expect(record.getAttribute('data-record')).toBe('true')
    expect(record.getAttribute('fill')).toBe('var(--accent)')
    expect(ordinary.getAttribute('data-record')).toBe('false')
    expect(ordinary.getAttribute('fill')).not.toBe('var(--accent)')
    expect(Number(record.getAttribute('r'))).toBeGreaterThan(Number(ordinary.getAttribute('r')))
  })

  it('connects the records with a running-best staircase', async () => {
    const { container } = renderScatter(LADDER)
    await screen.findByRole('img', { name: '5 km progression' })
    const stair = container.querySelector('[data-testid="staircase"]')
    if (stair === null) throw new Error('no staircase drawn')
    const points = (stair.getAttribute('points') ?? '').trim().split(' ')
    // Two records: the first, held across to the second's day, then down
    // to it. The second is also the last effort, so there is nothing to
    // hold it out to - three vertices.
    expect(points).toHaveLength(3)
  })

  it('draws an ineligible effort in a distinct muted style and never as a record, even when it is the fastest', async () => {
    // The treadmill effort above is 1300 s, faster than every record. A
    // chart that marked records from the times would crown it.
    const { container } = renderScatter(LADDER)
    await screen.findByRole('img', { name: '5 km progression' })
    const treadmill = circleFor(container, 'treadmill')
    expect(treadmill.getAttribute('data-eligible')).toBe('false')
    expect(treadmill.getAttribute('data-record')).toBe('false')
    expect(treadmill.getAttribute('fill')).not.toBe('var(--accent)')
    expect(treadmill.getAttribute('fill')).not.toBe(circleFor(container, 'slower').getAttribute('fill'))
  })

  it('hides the ineligible efforts when asked, and only them', async () => {
    const { container } = renderScatter(LADDER, false)
    await screen.findByRole('img', { name: '5 km progression' })
    // Sorted, because the DOM order is the paint order rather than the
    // payload order - records are drawn last so a later ordinary effort
    // cannot cover one. `progressionMath.test.ts` pins that ordering; what
    // this test is about is which points survive the toggle.
    expect(circles(container).map((c) => c.getAttribute('data-activity-id')).sort()).toEqual([
      'fastest',
      'first',
      'slower',
    ])
  })

  it('paints the records last, so an ordinary effort beside one cannot cover it', async () => {
    const { container } = renderScatter(LADDER)
    await screen.findByRole('img', { name: '5 km progression' })
    const drawn = circles(container).map((c) => c.getAttribute('data-activity-id'))
    expect(drawn).toEqual(['treadmill', 'slower', 'first', 'fastest'])
  })

  it('renders a sole eligible effort as a record, as the tagger now does', async () => {
    const { container } = renderScatter([point({ is_record: true })])
    await screen.findByRole('img', { name: '5 km progression' })
    expect(circleFor(container, 'fastest').getAttribute('data-record')).toBe('true')
    expect(container.querySelector('[data-testid="staircase"]')).not.toBeNull()
  })

  it('labels the time axis with times and the date axis with dates', async () => {
    const { container } = renderScatter(LADDER)
    await screen.findByRole('img', { name: '5 km progression' })
    const labels = Array.from(container.querySelectorAll('text'), (t) => t.textContent ?? '')
    expect(labels.some((l) => /^\d+:\d\d$/.test(l))).toBe(true)
    expect(labels.some((l) => /^\d{4}$|^[A-Z][a-z]{2} \d{4}$/.test(l))).toBe(true)
  })

  it('shows the activity name, time, pace, heart rate and locality on hover, in a readout that adds no height', async () => {
    const { container } = renderScatter(LADDER)
    const chart = await screen.findByRole('img', { name: '5 km progression' })
    const wrap = chart.parentElement
    if (wrap === null) throw new Error('the chart has no wrapper')
    // jsdom has no layout, so the height is 0 before and after by
    // construction; the browser suite measures the real thing. What this
    // pins is the structural half: the readout lives inside the panel,
    // absolutely positioned, not in the page flow.
    const before = wrap.getBoundingClientRect().height
    expect(screen.queryByTestId('progression-readout')).toBeNull()

    act(() => {
      fireEvent.mouseEnter(circleFor(container, 'fastest'))
    })

    const readout = screen.getByTestId('progression-readout')
    expect(readout).toHaveTextContent('Run')
    expect(readout).toHaveTextContent('25:00')
    expect(readout).toHaveTextContent('5:00/km')
    expect(readout).toHaveTextContent('160 bpm')
    expect(readout).toHaveTextContent('Jönköping')
    expect(readout).toHaveTextContent('Record')
    expect(wrap.contains(readout)).toBe(true)
    expect(readout.getAttribute('aria-hidden')).toBe('true')
    expect(wrap.getBoundingClientRect().height).toBe(before)

    act(() => {
      fireEvent.mouseLeave(circleFor(container, 'fastest'))
    })
    expect(screen.queryByTestId('progression-readout')).toBeNull()
  })

  it('says why an ineligible effort does not count, and shows the glyph for a missing heart rate', async () => {
    // The fixture is the API's own string for `contains_jump`
    // (`api/queries.py`), and it is displayed verbatim rather than
    // rewritten: the reason is the analysis layer's prose and this chart
    // does not parse it. What is asserted here is the verbatim display, not
    // the wording - the string is the analysis layer's to change, and it
    // did change, from `GPS jump` to this, once the frontend copy had
    // stopped naming a cause the flag does not establish.
    const { container } = renderScatter([
      point({ activity_id: 'x', is_eligible: false, is_record: false, avg_hr_bpm: null, locality: null,
        ineligible_reason: 'a jump in the recorded distance' }),
    ])
    await screen.findByRole('img', { name: '5 km progression' })
    act(() => {
      fireEvent.mouseEnter(circleFor(container, 'x'))
    })
    const readout = screen.getByTestId('progression-readout')
    expect(readout).toHaveTextContent('a jump in the recorded distance')
    expect(readout).toHaveTextContent('–')
    expect(readout).not.toHaveTextContent('0 bpm')
  })

  it('names a record and an ineligible effort in the link, since the readout is hidden from a screen reader', async () => {
    const { container } = renderScatter(LADDER)
    await screen.findByRole('img', { name: '5 km progression' })

    const label = (id: string) => circleFor(container, id).closest('a')?.getAttribute('aria-label')
    expect(label('first')).toMatch(/, 26:00, record$/)
    expect(label('slower')).toMatch(/, 26:40$/)
    expect(label('treadmill')).toMatch(/, 21:40, not eligible: treadmill: distance is from an uncalibrated footpod$/)
  })

  it('says when an eligible point holds a jump the measured speed confirmed', async () => {
    // A half marathon the jump check flagged and the speed check cleared: eligible, and a record.
    const { container } = renderScatter([
      point({ activity_id: 'blip', contains_jump: true, is_eligible: true, is_record: true }),
    ])
    await screen.findByRole('img', { name: '5 km progression' })
    const link = circleFor(container, 'blip').closest('a')
    expect(link?.getAttribute('aria-label')).toMatch(
      /, record, the recorded distance jumped, but the measured speed confirms it$/,
    )
    act(() => {
      fireEvent.mouseEnter(circleFor(container, 'blip'))
    })
    const readout = screen.getByTestId('progression-readout')
    expect(readout).toHaveTextContent('Counted: the recorded distance jumped, but the measured speed confirms it')
    expect(readout).not.toHaveTextContent('Not eligible')
  })

  it('navigates to the activity when a point is clicked', async () => {
    const { container, router } = renderScatter(LADDER)
    await screen.findByRole('img', { name: '5 km progression' })
    const link = circleFor(container, 'fastest').closest('a')
    if (link === null) throw new Error('the point is not a link')
    expect(link.getAttribute('href')).toBe('/activities/fastest')

    fireEvent.click(link)

    await screen.findByText('detail view')
    expect(router.state.location.pathname).toBe('/activities/fastest')
  })

  it('draws date ticks for a distance whose only effort falls mid-month', async () => {
    // The shape of the sparse long distances: one half marathon, mid-month,
    // here on 2025-03-16. The layout pads by 14 days either side, so the axis
    // spans 2 to 30 March and holds no first of the month - which used to leave
    // the date axis blank while the time axis ticked normally.
    const { container } = renderScatter([point({ start_time_utc: '2025-03-16T09:00:00Z', elapsed_time_s: 7200 })])
    await screen.findByRole('img', { name: '5 km progression' })
    const labels = Array.from(container.querySelectorAll('text'), (t) => t.textContent ?? '')
    expect(labels.filter((l) => /^\d{1,2} [A-Z][a-z]{2}$/.test(l)).length).toBeGreaterThan(0)
  })

  it('positions the readout with a clamped pixel offset, not the point\'s raw percentage', async () => {
    // The clamp is what keeps the rightmost point's readout inside the
    // panel; unclamped, half of it joined the document's scrollable area
    // and widened the page at phone width. jsdom reports zero for every
    // measured width, which `clampReadoutLeft` degenerates to passing the
    // offset through - so what is asserted here is the unit, px rather
    // than a percentage, and the browser suite measures the real clamp.
    const { container } = renderScatter(LADDER)
    await screen.findByRole('img', { name: '5 km progression' })
    act(() => {
      fireEvent.mouseEnter(circleFor(container, 'fastest'))
    })
    const readout = screen.getByTestId('progression-readout')
    // Both in panel pixels. `top` was a percentage of the old fixed
    // viewBox; the viewBox is the panel's own measured size now, so the
    // point's y is already the pixel it is drawn at and there is nothing to
    // convert.
    expect(readout.style.left).toMatch(/^-?[\d.]+px$/)
    expect(readout.style.top).toMatch(/^-?[\d.]+px$/)
  })

  it('flips the readout below a point too near the top edge to fit it above, once the heights are measurable', async () => {
    // A desktop panel, 360px tall, with a readout of about 150px. jsdom
    // reports zero for the width, so the chart falls back to its default
    // plot width and lays the points out in the stubbed height. The
    // inverted time axis puts
    // `slower`, the slowest effort in the ladder, nearest the top, where
    // the readout does not fit above it; `treadmill` is the fastest and
    // sits lowest, with room to spare.
    const restore = measureHeights(360, 150)
    try {
      const { container } = renderScatter(LADDER)
      await screen.findByRole('img', { name: '5 km progression' })

      act(() => {
        fireEvent.mouseEnter(circleFor(container, 'slower'))
      })
      expect(screen.getByTestId('progression-readout').className).toContain(styles.readoutBelow)

      act(() => {
        fireEvent.mouseLeave(circleFor(container, 'slower'))
        fireEvent.mouseEnter(circleFor(container, 'treadmill'))
      })
      expect(screen.getByTestId('progression-readout').className).not.toContain(styles.readoutBelow)
    } finally {
      restore()
    }
  })

  it('flips at phone width a point it leaves above itself on a desktop panel', async () => {
    // The regression the old viewBox fraction hid: at a 390px viewport the
    // panel is about 157px tall, so the very point that has 300px of room
    // above it on a desktop panel has about 110px here and the roughly
    // 150px readout ran off the panel's top edge and over the legend. As a
    // fraction of a fixed viewBox the two are identical, so no threshold on
    // it could tell them apart.
    const restore = measureHeights(157, 150)
    try {
      const { container } = renderScatter(LADDER)
      await screen.findByRole('img', { name: '5 km progression' })
      act(() => {
        fireEvent.mouseEnter(circleFor(container, 'treadmill'))
      })
      expect(screen.getByTestId('progression-readout').className).toContain(styles.readoutBelow)
    } finally {
      restore()
    }
  })

  it('keeps the readout above its point while nothing has been measured, as in jsdom', async () => {
    // The degeneration has to be the desktop placement rather than a flip,
    // or every readout would start below its point on the first paint of a
    // hover and jump once the measurement arrived.
    const { container } = renderScatter(LADDER)
    await screen.findByRole('img', { name: '5 km progression' })
    act(() => {
      fireEvent.mouseEnter(circleFor(container, 'slower'))
    })
    expect(screen.getByTestId('progression-readout').className).not.toContain(styles.readoutBelow)
  })

  it('measures a panel that first mounts after an absence, so the readout still flips at phone width', async () => {
    // Every effort here is ineligible, so the first render states an
    // absence and no panel exists to measure. Showing them mounts the panel
    // as a new element, and a measurement taken only on the component's
    // first mount would leave its size at zero: the readout would then
    // never flip below its point, however little room there is above it.
    const ineligible = LADDER.map((p) => ({ ...p, is_eligible: false, is_record: false, ineligible_reason: 'treadmill' }))
    const restore = measureHeights(157, 150)
    try {
      const { container } = renderToggleableScatter(ineligible)
      expect(await screen.findByRole('note')).toHaveTextContent(/ineligible/)
      fireEvent.click(screen.getByRole('button', { name: 'toggle ineligible' }))
      await screen.findByRole('img', { name: '5 km progression' })
      act(() => {
        fireEvent.mouseEnter(circleFor(container, 'treadmill'))
      })
      expect(screen.getByTestId('progression-readout').className).toContain(styles.readoutBelow)
    } finally {
      restore()
    }
  })

  it('states the absence in words when the toggle has hidden every effort there is', async () => {
    renderScatter([point({ is_eligible: false, is_record: false, ineligible_reason: 'treadmill' })], false)
    expect(await screen.findByRole('note')).toHaveTextContent(/ineligible/)
  })
})

/** One run on a 7.46 km loop, in the shape `/api/routes/{route_id}` serves it. */
function run(overrides: Partial<RouteRun> = {}): RouteRun {
  return {
    activity_id: 'loop-best',
    start_time_utc: '2025-05-01T07:00:00Z',
    utc_offset_s: 7200,
    name: 'Morning Run',
    distance_m: 7456,
    elapsed_time_s: 2236.8,
    speed_mps: 1000 / 300,
    direction: 'forward',
    eligible: true,
    ineligible_reason: null,
    rank: 1,
    is_record: true,
    ...overrides,
  }
}

/**
 * Five runs on one loop, oldest first as the API orders them. Three records
 * - one of them run the other way round - one ordinary reverse run, and one
 * ineligible run that is faster than all of them, which a chart deciding
 * records from the speeds would crown.
 */
const LOOP: RouteRun[] = [
  run({ activity_id: 'loop-first', start_time_utc: '2024-04-01T07:00:00Z', speed_mps: 3.0, rank: 3, is_record: true }),
  run({
    activity_id: 'loop-reverse',
    start_time_utc: '2024-07-01T07:00:00Z',
    speed_mps: 2.9,
    direction: 'reverse',
    rank: 4,
    is_record: false,
  }),
  run({
    activity_id: 'loop-reverse-best',
    start_time_utc: '2024-10-01T07:00:00Z',
    speed_mps: 3.1,
    direction: 'reverse',
    rank: 2,
    is_record: true,
  }),
  run({
    activity_id: 'loop-jump',
    start_time_utc: '2025-02-01T07:00:00Z',
    speed_mps: 4.0,
    eligible: false,
    ineligible_reason: 'a jump in the recorded distance',
    rank: null,
    is_record: false,
  }),
  run(),
]

function renderRouteScatter(runs: RouteRun[], showIneligible = true) {
  return renderInRouter(
    <ProgressionScatter kind="route" runs={runs} showIneligible={showIneligible} ariaLabel="Loop progression" />,
  )
}

function markFor(container: HTMLElement, activityId: string): SVGElement {
  const mark = container.querySelector<SVGElement>(`[data-activity-id="${activityId}"]`)
  if (mark === null) throw new Error(`no mark for ${activityId}`)
  return mark
}

/**
 * Where a mark is centred, whatever its shape: a circle states it, and a
 * diamond is the mean of its four vertices, read back out of its path.
 */
function centreOf(mark: SVGElement): { x: number; y: number } {
  if (mark.tagName === 'circle') {
    return { x: Number(mark.getAttribute('cx')), y: Number(mark.getAttribute('cy')) }
  }
  const numbers = (mark.getAttribute('d') ?? '').match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g)?.map(Number) ?? []
  if (numbers.length !== 8) throw new Error(`expected a four-vertex path, got ${mark.getAttribute('d') ?? 'none'}`)
  const xs = numbers.filter((_, i) => i % 2 === 0)
  const ys = numbers.filter((_, i) => i % 2 === 1)
  const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length
  return { x: mean(xs), y: mean(ys) }
}

function staircaseVertices(container: HTMLElement): { x: number; y: number }[] {
  const stair = container.querySelector('[data-testid="staircase"]')
  if (stair === null) throw new Error('no staircase drawn')
  return (stair.getAttribute('points') ?? '')
    .trim()
    .split(' ')
    .map((pair) => {
      const [x, y] = pair.split(',').map(Number)
      if (x === undefined || y === undefined) throw new Error(`malformed vertex ${pair}`)
      return { x, y }
    })
}

describe('ProgressionScatter over a route', () => {
  it('draws one mark per run, with pace on the same axis as the distance chart: the fastest lowest', async () => {
    const three = LOOP.filter((r) => ['loop-first', 'loop-reverse', 'loop-best'].includes(r.activity_id))
    const { container } = renderRouteScatter(three)
    await screen.findByRole('img', { name: 'Loop progression' })

    expect(container.querySelectorAll('[data-activity-id]')).toHaveLength(3)
    // 5:00/km, 5:33/km and 5:45/km. The axis is the distance chart's own,
    // which puts a faster value lower and says so with `FASTER` under the
    // ladder, so the ordering on screen is pace order.
    const best = centreOf(markFor(container, 'loop-best')).y
    const first = centreOf(markFor(container, 'loop-first')).y
    const slowest = centreOf(markFor(container, 'loop-reverse')).y
    expect(best).toBeGreaterThan(first)
    expect(first).toBeGreaterThan(slowest)
  })

  it('labels the ladder in pace, which a mark sits on at 1000 / speed seconds', async () => {
    const { container } = renderRouteScatter(LOOP)
    await screen.findByRole('img', { name: 'Loop progression' })
    const labels = Array.from(container.querySelectorAll('text'), (t) => t.textContent ?? '')
    // The 5:00/km run sits exactly on the 5:00 rule the ladder draws.
    const rule = Array.from(container.querySelectorAll('text')).find((t) => t.textContent === '5:00')
    expect(labels).toContain('5:00')
    if (rule === undefined) throw new Error('no 5:00 rule')
    expect(Number(rule.getAttribute('y')) - LADDER_LABEL_DY).toBeCloseTo(centreOf(markFor(container, 'loop-best')).y, 6)
  })

  it('draws a reverse run in a different shape, not only a different colour, and keys both directions', async () => {
    const { container } = renderRouteScatter(LOOP)
    await screen.findByRole('img', { name: 'Loop progression' })

    const forward = markFor(container, 'loop-first')
    const reverse = markFor(container, 'loop-reverse-best')
    expect(forward.getAttribute('data-direction')).toBe('forward')
    expect(reverse.getAttribute('data-direction')).toBe('reverse')
    expect(reverse.tagName).not.toBe(forward.tagName)
    // Both are records, so they share a colour: the shape is what tells them apart.
    expect(reverse.getAttribute('fill')).toBe(forward.getAttribute('fill'))
    // A screen reader cannot see a shape, so the link says it in words, the
    // key's own.
    expect(reverse.closest('a')?.getAttribute('aria-label')).toMatch(/, Reverse, record$/)

    const key = screen.getByRole('list', { name: 'Directions' })
    const items = Array.from(key.querySelectorAll('li'))
    expect(items.map((li) => li.textContent)).toEqual(['Forward', 'Reverse'])
    const [forwardItem, reverseItem] = items
    if (forwardItem === undefined || reverseItem === undefined) throw new Error('the key lists two directions')
    expect(forwardItem.querySelector('svg')?.firstElementChild?.tagName).toBe(forward.tagName)
    expect(reverseItem.querySelector('svg')?.firstElementChild?.tagName).toBe(reverse.tagName)
  })

  it('runs the staircase through exactly the stored records', async () => {
    const { container } = renderRouteScatter(LOOP)
    await screen.findByRole('img', { name: 'Loop progression' })

    const vertices = staircaseVertices(container)
    const records = ['loop-first', 'loop-reverse-best', 'loop-best'].map((id) => centreOf(markFor(container, id)))
    for (const record of records) {
      expect(vertices.some((v) => Math.abs(v.x - record.x) < 1e-6 && Math.abs(v.y - record.y) < 1e-6)).toBe(true)
    }
    // Every level the line holds at is a record's pace, and no other run's.
    const levels = [...new Set(vertices.map((v) => v.y.toFixed(6)))].sort()
    expect(levels).toEqual(records.map((r) => r.y.toFixed(6)).sort())
  })

  it('draws an ineligible faster run off the staircase, and says why it does not count', async () => {
    const { container } = renderRouteScatter(LOOP)
    await screen.findByRole('img', { name: 'Loop progression' })

    const jump = markFor(container, 'loop-jump')
    expect(jump.getAttribute('data-eligible')).toBe('false')
    expect(jump.getAttribute('data-record')).toBe('false')
    const jumpY = centreOf(jump).y
    expect(jumpY).toBeGreaterThan(centreOf(markFor(container, 'loop-best')).y)
    expect(staircaseVertices(container).some((v) => Math.abs(v.y - jumpY) < 1e-6)).toBe(false)

    act(() => {
      fireEvent.mouseEnter(jump)
    })
    expect(screen.getByTestId('progression-readout')).toHaveTextContent('Not eligible: a jump in the recorded distance')
  })

  it("names each mark's direction and status in words, since the readout is hidden from a screen reader", async () => {
    const { container } = renderRouteScatter(LOOP)
    await screen.findByRole('img', { name: 'Loop progression' })

    const label = (id: string) => markFor(container, id).closest('a')?.getAttribute('aria-label')
    expect(label('loop-best')).toBe('Thu 01 May 2025 09:00, 5:00/km, Forward, record')
    expect(label('loop-reverse')).toMatch(/, Reverse$/)
    expect(label('loop-jump')).toMatch(/, Forward, not eligible: a jump in the recorded distance$/)
  })

  it('reads out the date, the pace, the distance and the direction of a run', async () => {
    const { container } = renderRouteScatter(LOOP)
    await screen.findByRole('img', { name: 'Loop progression' })

    act(() => {
      fireEvent.mouseEnter(markFor(container, 'loop-best'))
    })
    const readout = screen.getByTestId('progression-readout')
    expect(readout).toHaveTextContent('Thu 01 May 2025 09:00')
    expect(readout).toHaveTextContent('5:00/km')
    expect(readout).toHaveTextContent('7.46 km')
    expect(readout).toHaveTextContent('Forward')
    expect(readout).toHaveTextContent('Record')
    expect(readout).not.toHaveTextContent('Not eligible')

    act(() => {
      fireEvent.mouseLeave(markFor(container, 'loop-best'))
      fireEvent.mouseEnter(markFor(container, 'loop-reverse'))
    })
    expect(screen.getByTestId('progression-readout')).toHaveTextContent('Reverse')
  })

  it('links each run to its activity', async () => {
    const { container, router } = renderRouteScatter(LOOP)
    await screen.findByRole('img', { name: 'Loop progression' })
    const link = markFor(container, 'loop-reverse').closest('a')
    if (link === null) throw new Error('the mark is not a link')
    fireEvent.click(link)
    await screen.findByText('detail view')
    expect(router.state.location.pathname).toBe('/activities/loop-reverse')
  })

  it('hides the ineligible runs when asked, and names runs rather than efforts when that hides them all', async () => {
    const { container, unmount } = renderRouteScatter(LOOP, false)
    await screen.findByRole('img', { name: 'Loop progression' })
    expect(container.querySelector('[data-activity-id="loop-jump"]')).toBeNull()
    expect(container.querySelectorAll('[data-activity-id]')).toHaveLength(4)
    unmount()

    renderRouteScatter([LOOP[3] ?? run()], false)
    expect(await screen.findByRole('note')).toHaveTextContent('Every run on this route is ineligible')
  })
})

describe('ProgressionScatter focus ring', () => {
  /*
   * The keyboard focus ring is `.point:focus-visible circle, path` in the
   * stylesheet, setting the stroke. jsdom neither computes `:focus-visible`
   * nor applies CSS modules, so what is asserted is the mechanism that lets
   * the rule win at all: an inline `style` declaration beats any
   * non-`!important` stylesheet rule, so a mark whose stroke is inline can
   * never show the ring. A presentation attribute is the weakest author
   * style there is, so the rule overrides it - which is where the paint
   * has to live.
   */
  it.each([
    ['a distance chart', () => renderScatter(LADDER), '5 km progression'],
    ['a route chart', () => renderRouteScatter(LOOP), 'Loop progression'],
  ] as const)('leaves every mark\'s paint to presentation attributes on %s, so the focus rule can override it', async (_name, draw, label) => {
    const { container } = draw()
    await screen.findByRole('img', { name: label })
    const marks = Array.from(container.querySelectorAll<SVGElement>('[data-activity-id]'))
    expect(marks.length).toBeGreaterThan(0)
    for (const mark of marks) {
      expect(mark.getAttribute('style')).toBeNull()
      expect(mark.getAttribute('fill')).toMatch(/^var\(--[a-z0-9-]+\)$|^none$/)
      expect(mark.getAttribute('stroke')).toMatch(/^var\(--[a-z0-9-]+\)$|^none$/)
      expect(mark.getAttribute('stroke-width')).not.toBeNull()
    }
  })
})
