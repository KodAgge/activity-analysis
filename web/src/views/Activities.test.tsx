import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ALL_SPORTS, UNKNOWN_SPORT } from '../api/activitySearch'
import { api } from '../api/client'
import type { components } from '../api/schema'
import { NO_VALUE, duration, formatLocal, formatLocalShort } from '../format'
import { router } from '../router'

vi.mock('../api/client', () => ({
  api: { GET: vi.fn() },
}))

type ActivitySummary = components['schemas']['ActivitySummary']
type ActivityPage = components['schemas']['ActivityPage']
type SportCount = components['schemas']['SportCount']
type Health = components['schemas']['Health']

/**
 * Shaped from the generated `ActivitySummary` type, matching the
 * `/api/activities` payload checked against a running server, with the
 * 2026-08-28 reference fixture's own values: every field the endpoint
 * actually sends, not a subset a test happens to read.
 */
function activityFixture(overrides: Partial<ActivitySummary> = {}): ActivitySummary {
  return {
    activity_id: '854fd775d479ca9f',
    start_time_utc: '2026-08-28T18:19:14Z',
    utc_offset_s: 7200,
    sport: 'running',
    recorded_sport: 'running',
    sub_sport: 'generic',
    name: 'Run',
    distance_m: 7456.06,
    elapsed_time_s: 2931.205,
    timer_time_s: 2931.205,
    moving_time_s: 2931.0,
    ascent_m: 56.0,
    descent_m: 52.0,
    avg_speed_mps: 2.544,
    max_speed_mps: 2.855,
    avg_hr_bpm: 156.0,
    max_hr_bpm: 172.0,
    avg_cadence_spm: 162.75,
    calories: 660.0,
    source: 'strava_fit',
    pr_distance_keys: [],
    ...overrides,
  }
}

function pageFixture(items: ActivitySummary[], overrides: Partial<ActivityPage> = {}): ActivityPage {
  return { total: items.length, limit: 50, offset: 0, items, ...overrides }
}

// Matches the real /api/sports shape checked against a running server: sport
// values with counts, plus a null bucket when GPX ingestion has produced one.
function sportsFixture(overrides: SportCount[] = []): SportCount[] {
  return overrides.length > 0
    ? overrides
    : [
        { sport: 'running', count: 307 },
        { sport: 'walking', count: 804 },
        { sport: null, count: 3 },
      ]
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

type ApiGetResult = Awaited<ReturnType<typeof api.GET>>

function jsonResult<T>(data: T): ApiGetResult {
  return { data, error: undefined, response: new Response() } as ApiGetResult
}

/**
 * `Activities` fires three independent queries once mounted inside the real
 * app shell: `/api/health` (from `AppShell`, the root route's own
 * component), `/api/sports` and `/api/activities`. One shared mock keyed on
 * the request path is what lets a single render exercise all three without
 * conflating their responses.
 */
/** Every path `mockApi` has been asked for, in order, so a test can count requests rather than infer them from render output. */
const requestedPaths: string[] = []

function mockApi(opts: { activities?: ActivityPage; sports?: SportCount[]; health?: Health } = {}) {
  vi.mocked(api.GET).mockImplementation((path) => {
    requestedPaths.push(path)
    if (path === '/api/sports') return Promise.resolve(jsonResult(opts.sports ?? sportsFixture()))
    if (path === '/api/activities') return Promise.resolve(jsonResult(opts.activities ?? pageFixture([])))
    if (path === '/api/health') return Promise.resolve(jsonResult(opts.health ?? healthFixture()))
    // Anything else - the detail route's own `/api/activities/{id}` and
    // `/api/activities/{id}/streams` included - is deliberately left
    // pending rather than answered from this fixture set, which knows
    // nothing about a detail response's shape. A test that navigates to
    // the detail view only needs to prove the navigation happened, not
    // render the page it lands on.
    return new Promise(() => undefined)
  })
}

/**
 * Mounts the real route tree - the same one `main.tsx` renders - on a memory
 * history at `path`, so `getRouteApi('/activities')` inside `Activities.tsx`
 * resolves against a real matched route rather than a hand-rolled stand-in
 * that could silently drift from `router.tsx`'s actual `validateSearch` and
 * `beforeLoad`.
 */
function renderActivitiesAt(path: string) {
  const testRouter = createRouter({
    routeTree: router.routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  )
  return testRouter
}

/** How many `/api/activities` requests have actually gone out, which is what a per-keystroke navigation multiplies. */
function activitiesRequestCount(): number {
  return requestedPaths.filter((path) => path === '/api/activities').length
}

/**
 * The feed, and the cards in it.
 *
 * The list was an HTML table until the Strava-look rebuild and these
 * helpers were `findTable`/`findDataRows`; every assertion in this file
 * that used to reach for a `<td>` now reaches for a card's own heading or
 * one of its four stats. The assertions themselves are unchanged - what a
 * card must say, and must never say, is the same list it was.
 */
async function findFeed(): Promise<HTMLElement> {
  return screen.findByRole('list', { name: 'Activities' })
}

/**
 * The cards, waited for as *cards* rather than as a list that may not hold
 * any yet.
 *
 * This used to await the feed and then reach for its items synchronously,
 * which is a race: the list element commits before the items inside it do,
 * so `getAllByRole` threw on the gap instead of waiting through it. It
 * passed alone and in most full runs, and failed roughly one full run in
 * five under parallel load - the gap widens when the machine is busy. A
 * retrying query removes the race rather than widening the tolerance.
 */
async function findCards(): Promise<HTMLElement[]> {
  const feed = await findFeed()
  return within(feed).findAllByRole('listitem')
}

async function findFirstCard(): Promise<HTMLElement> {
  const [card] = await findCards()
  if (card === undefined) throw new Error('no activity card rendered')
  return card
}

/** A card's date headline: the one thing on it that is a link into the detail view. */
function headlineOf(card: HTMLElement): HTMLElement {
  return within(card).getByRole('heading', { level: 2 })
}

/**
 * One card's stat, by the name above it.
 *
 * By label, not by position, for the reason the old `cellUnder` gave: the
 * fields changed once already (cadence and ascent left the list on
 * 2026-09-02) and every positional index in this file silently pointed one
 * field off, which is the drift the single `FIELDS` list exists to
 * prevent.
 */
function statOf(card: HTMLElement, label: string): HTMLElement {
  const terms = Array.from(card.querySelectorAll('dt'))
  const term = terms.find((element) => element.textContent?.trim() === label)
  if (term === undefined) throw new Error(`no stat labelled "${label}"`)
  const value = term.nextElementSibling
  if (!(value instanceof HTMLElement)) throw new Error(`the stat labelled "${label}" has no value`)
  return value
}

/** The sort chips, by the field each one names, with the arrow and its spoken word stripped off. */
function sortChipLabels(): string[] {
  const bar = screen.getByRole('group', { name: 'Sort activities' })
  return within(bar)
    .getAllByRole('button')
    .map((chip) => (chip.textContent ?? '').replace(/(ascending|descending)/, '').trim())
}

/**
 * Which way the caret on a sort chip points.
 *
 * The chips carried `▲`/`▼` as text until the polish round, when both
 * marks became one drawn caret rotated by the stylesheet - the Filters
 * control beside them draws its chevron, and a filled Unicode triangle
 * sitting low on the baseline is a second glyph system on one row of
 * controls. `data-direction` is what the rotation is keyed off, so it is
 * also the honest thing to assert: it is the markup the visible mark's
 * orientation is derived from, not a test-only hook.
 */
function markDirection(chip: HTMLElement): string | null {
  return chip.querySelector('svg[data-direction]')?.getAttribute('data-direction') ?? null
}

/**
 * Opens the filter sheet, the way a reader does.
 *
 * The filters are behind a disclosure now, so they are genuinely not in
 * the accessibility tree until it is opened - which is the point of the
 * rebuild, and is why every filter test presses this first rather than
 * reaching straight for a control.
 */
async function openFilters(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /^Filters/ }))
}

beforeEach(() => {
  vi.mocked(api.GET).mockReset()
  requestedPaths.length = 0
})

describe('Activities', () => {
  it('leads each card with the local date, never the activity name', async () => {
    const run = activityFixture({ name: 'Run' })
    mockApi({ activities: pageFixture([run]) })

    renderActivitiesAt('/activities')

    const headline = headlineOf(await findFirstCard())

    // The headline is the local wall clock this run's own utc_offset_s
    // produces - built through the same `formatLocalShort` the card itself
    // must call, so a mutation to the card's date arithmetic (not just to
    // whether a date renders at all) fails this.
    expect(headline).toHaveTextContent(formatLocalShort(run.start_time_utc, run.utc_offset_s))

    // And it is the *short* form. The long one made the stamp's width
    // swing between "Sunday 3 May" and "Wednesday 26 August", so nothing
    // lined up down the page - the maintainer's item 5. Asserting the long form is
    // absent is what stops it drifting back.
    expect(headline).not.toHaveTextContent(formatLocal(run.start_time_utc, run.utc_offset_s))
    expect(headline.textContent).toMatch(/^[A-Z][a-z]{2} \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}/)

    // "Run" is the name of 172 of the 307 real runs and must never appear
    // as a card's identity: the browser is date-led, not name-led. The card's own quiet line carries the
    // *sport* ("Running"), which is a different string and a different
    // fact, and is the thing that distinguishes a run from a walk once the
    // sport filter is widened.
    expect(screen.queryByText('Run', { exact: true })).not.toBeInTheDocument()
  })

  it('links a card to its own detail view, and clicking it actually navigates there', async () => {
    // C1: this is the one route into the deepest view in the application.
    // A card rendered with no `<Link>` at all, or one whose href points at
    // the wrong activity, or one that gets swallowed by a JS-only
    // `onClick` a keyboard user cannot reach, all fail this the same way -
    // no link with the right href is found. The card is clickable across
    // its whole face now, but that is a stretched `::after` on this very
    // anchor rather than a synthetic handler, which is what keeps the
    // browser's "open in new tab" and a screen reader's link list working.
    const run = activityFixture({ activity_id: 'a1b2c3d4e5f6a7b8' })
    mockApi({ activities: pageFixture([run]) })

    const testRouter = renderActivitiesAt('/activities')

    const card = await findFirstCard()
    const link = within(card).getByRole('link')
    expect(link).toHaveAttribute('href', '/activities/a1b2c3d4e5f6a7b8')

    fireEvent.click(link)

    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/activities/a1b2c3d4e5f6a7b8')
    })
  })

  it('shows the name filter already in the URL, so a shared filtered link arrives filtered', async () => {
    mockApi({ activities: pageFixture([]) })

    renderActivitiesAt('/activities?q=Treadmill')
    await openFilters()

    expect(await screen.findByLabelText('Name contains')).toHaveValue('Treadmill')
  })

  it('collapses a typed word into one history entry and one request, while still writing it to the URL', async () => {
    // F3: `patch` used to navigate on every keystroke with no `replace`, so
    // typing a word left one history entry and one cached `/api/activities`
    // request per character. Browser Back then needed a press per
    // character to leave the page, and the detail view's own back button -
    // which exists to restore a filtered list - landed on a half-typed
    // filter.
    mockApi({ activities: pageFixture([]) })

    const testRouter = renderActivitiesAt('/activities')
    await openFilters()
    const box = await screen.findByLabelText('Name contains')
    await waitFor(() => {
      expect(activitiesRequestCount()).toBe(1)
    })
    const entriesBefore = testRouter.history.length

    fireEvent.change(box, { target: { value: 'T' } })
    fireEvent.change(box, { target: { value: 'Tr' } })
    fireEvent.change(box, { target: { value: 'Tre' } })

    // The box itself tracks every keystroke even though the URL does not.
    expect(box).toHaveValue('Tre')

    // Shareable: the committed value still lands in the URL.
    await waitFor(() => {
      expect(testRouter.state.location.search).toMatchObject({ q: 'Tre' })
    })

    expect(activitiesRequestCount()).toBe(2)
    expect(testRouter.history.length).toBe(entriesBefore)
  })

  it('renders Treadmill as a badge, driven by sub_sport rather than the (possibly null) name', async () => {
    // name is deliberately null here: if the badge were wired to `name`
    // instead of `sub_sport`, this row would show no badge at all, which is
    // exactly the bug this fixture is built to catch. Every other field is
    // synthetic in the shape of a real treadmill payload (checked against a
    // running server): a treadmill has no GPS, so ascent_m and descent_m
    // are genuinely null here, not just left at the base fixture's outdoor
    // values.
    const treadmillRun = activityFixture({
      activity_id: 'c0ffeec0ffeec0ff',
      sub_sport: 'treadmill',
      name: null,
      start_time_utc: '2026-04-18T15:00:00Z',
      distance_m: 7500.0,
      elapsed_time_s: 2400.0,
      timer_time_s: 2400.0,
      moving_time_s: 2400.0,
      ascent_m: null,
      descent_m: null,
      avg_speed_mps: 3.125,
      max_speed_mps: 3.5,
      avg_hr_bpm: 160.0,
      max_hr_bpm: 180.0,
      avg_cadence_spm: 166.0,
      calories: 600.0,
    })
    mockApi({ activities: pageFixture([treadmillRun]) })

    renderActivitiesAt('/activities')

    await findFeed()
    expect(await screen.findByText('Treadmill')).toBeInTheDocument()
  })

  it('renders a null channel as the no-value glyph, never a zero', async () => {
    // The shape of a real run recorded with no speed at all,
    // so max_speed_mps is null right alongside avg_speed_mps - the same
    // sensor is missing both, and leaving max_speed_mps at the base
    // fixture's outdoor value would claim a maximum of a speed that was
    // never recorded. No heart rate; cadence and ascent both present.
    const noHr = activityFixture({
      avg_speed_mps: null,
      max_speed_mps: null,
      avg_hr_bpm: null,
      max_hr_bpm: null,
      avg_cadence_spm: 160.0,
      ascent_m: 16.0,
    })
    mockApi({ activities: pageFixture([noHr]) })

    renderActivitiesAt('/activities')

    const card = await findFirstCard()
    expect(statOf(card, 'Pace')).toHaveTextContent(NO_VALUE)
    expect(statOf(card, 'Heart rate')).toHaveTextContent(NO_VALUE)
    // The card's own recorded values must not be swallowed by whatever
    // renders the nulls beside them.
    expect(statOf(card, 'Distance')).not.toHaveTextContent(NO_VALUE)
    expect(statOf(card, 'Moving time')).not.toHaveTextContent(NO_VALUE)
  })

  it('carries no cadence or ascent field at all, on the card or in the sort', async () => {
    // The maintainer's instruction of 2026-09-02: both are on the activity itself,
    // and a list entry is for the few numbers you scan a list by. Asserted
    // rather than merely deleted, because the pair drifting back in is
    // exactly what a later "just add one more" change would do. The
    // no-value rendering of both is still covered - on the detail view,
    // where they still appear.
    mockApi({ activities: pageFixture([activityFixture({})]) })
    renderActivitiesAt('/activities')

    const card = await findFirstCard()
    const statLabels = Array.from(card.querySelectorAll('dt')).map((dt) => dt.textContent?.trim() ?? '')
    expect(statLabels).not.toContain('Cadence')
    expect(statLabels).not.toContain('Ascent')
    // The date is the headline rather than a stat, so the card's four
    // stats are the other four fields, in `FIELDS` order.
    expect(statLabels).toEqual(['Distance', 'Moving time', 'Pace', 'Heart rate'])

    // And the sort chips are the same list with the date back on the
    // front: one `FIELDS` array drives both, so a field can never be
    // sortable without being shown or shown without being sortable.
    expect(sortChipLabels()).toEqual(['Date', 'Distance', 'Moving time', 'Pace', 'Heart rate'])
  })

  it('renders a bare no-value glyph for a null distance, never the glyph with "km" stapled on', async () => {
    // `toHaveTextContent(NO_VALUE)` elsewhere in this file only checks for
    // a substring, which "– km" would also satisfy - this is the specific
    // assertion that catches a unit stapled onto the glyph, the same class
    // of bug `paceCell` above was already written to avoid.
    const noDistance = activityFixture({ distance_m: null })
    mockApi({ activities: pageFixture([noDistance]) })

    renderActivitiesAt('/activities')

    const card = await findFirstCard()
    expect(statOf(card, 'Distance').textContent).toBe(NO_VALUE)
  })

  it('renders the no-value glyph for a null moving time, never a fabricated zero', async () => {
    // The shape of a real non-running activity, strength training, with
    // synthetic values: the derived layer covers
    // running only, so the LEFT JOIN behind this field leaves it null for
    // 1637 of 1944 real activities - the majority of what is on screen with
    // the sport filter widened to "all". A fallback of '0:00' here would
    // claim the athlete moved for no time at all, a claim about their
    // training rather than a formatting slip - which is exactly the
    // mutation this test is built to catch (see the task report).
    const strengthTraining = activityFixture({
      activity_id: 'b0b0b0b0b0b0b0b0',
      sport: 'training',
      sub_sport: 'strength_training',
      name: 'Strength',
      distance_m: 0.0,
      elapsed_time_s: 3600.0,
      timer_time_s: 3600.0,
      moving_time_s: null,
      ascent_m: null,
      descent_m: null,
      avg_speed_mps: 0.0,
      max_speed_mps: null,
      avg_hr_bpm: 100.0,
      max_hr_bpm: 140.0,
      avg_cadence_spm: null,
      calories: 350.0,
    })
    mockApi({ activities: pageFixture([strengthTraining]) })

    renderActivitiesAt('/activities?sport=all')

    const movingTime = statOf(await findFirstCard(), 'Moving time')
    expect(movingTime).toHaveTextContent(NO_VALUE)
    expect(movingTime).not.toHaveTextContent('0:00')
  })

  it('renders the no-value glyph for a null cadence reading, on the same non-running activity', async () => {
    // Grounded in the same real cause as the moving-time test above, not a
    // separate coincidence: avg_cadence_spm is null on every one of the 439
    // real "training" activities (and every cycling, golf and
    // alpine_skiing one too) - the sensor this project's cadence column
    // reads is a running footpod/accelerometer metric, never populated for
    // a sport that does not use one.
    const strengthTraining = activityFixture({
      activity_id: 'b0b0b0b0b0b0b0b0',
      sport: 'training',
      sub_sport: 'strength_training',
      name: 'Strength',
      distance_m: 0.0,
      elapsed_time_s: 3600.0,
      timer_time_s: 3600.0,
      moving_time_s: null,
      ascent_m: null,
      descent_m: null,
      avg_speed_mps: 0.0,
      max_speed_mps: null,
      avg_hr_bpm: 100.0,
      max_hr_bpm: 140.0,
      avg_cadence_spm: null,
      calories: 350.0,
    })
    mockApi({ activities: pageFixture([strengthTraining]) })

    renderActivitiesAt('/activities?sport=all')

    const card = await findFirstCard()
    // Retargeted from the cadence column, which this list no longer
    // carries, to the pace stat on the same fixture - the rule under test
    // is "a null renders as the glyph, never a fabricated zero with a unit
    // stapled on", and it is the same rule either way. The null cadence
    // and ascent renderings moved to `ActivityDetail.test.tsx`, which is
    // where those two are now shown.
    expect(statOf(card, 'Pace')).toHaveTextContent(NO_VALUE)
    expect(statOf(card, 'Pace')).not.toHaveTextContent('0:00')
    expect(statOf(card, 'Moving time')).toHaveTextContent(NO_VALUE)
    expect(statOf(card, 'Moving time')).not.toHaveTextContent('0:00')
  })

  it('marks a GPX-sourced row with a null utc_offset_s as UTC, never guessing the local hour', async () => {
    const gpxRun = activityFixture({ source: 'gpx', utc_offset_s: null })
    mockApi({ activities: pageFixture([gpxRun]) })

    renderActivitiesAt('/activities')

    const headline = headlineOf(await findFirstCard())
    expect(headline).toHaveTextContent('UTC')
    expect(headline).toHaveTextContent(formatLocalShort(gpxRun.start_time_utc, null))
  })

  it('pairs the "Moving time" sort chip to the field its own stat renders, so the two cannot drift apart silently', async () => {
    // Real numbers from fixture activity 6116b2e90f551a6c (see the task
    // report): elapsed time and the derived layer's moving time genuinely
    // disagree by close to 6.5 minutes on this run, which is exactly what
    // makes this assertion able to fail - a header/cell pair that quietly
    // reverted to elapsed_time_s would still render *a* duration, just the
    // wrong one, and a header renamed back to "Elapsed time" without
    // touching the cell would not be found at all.
    const activity = activityFixture({ elapsed_time_s: 3711.567, moving_time_s: 3318.0 })
    mockApi({ activities: pageFixture([activity]) })

    renderActivitiesAt('/activities')

    const card = await findFirstCard()
    // The chip and the stat are named from one `label`, so the field the
    // chip sorts by is by construction the field the stat shows - and
    // `statOf` throws rather than passing if the card stops showing a
    // field the sort still offers.
    expect(sortChipLabels()).toContain('Moving time')
    const stat = statOf(card, 'Moving time')

    expect(stat).toHaveTextContent(duration(3318.0))
    expect(stat).not.toHaveTextContent(duration(3711.567))
  })

  it('sorts by moving_time_s when the "Moving time" header is clicked, not by elapsed_time_s (I2)', async () => {
    // docs/reference/api.md closes `sort` to four columns, moving_time_s
    // among them since I2. A column whose `sortKey` reverted to
    // 'elapsed_time_s' - the exact defect the final review found - would
    // put that string in the URL instead.
    mockApi({ activities: pageFixture([activityFixture()]) })

    const testRouter = renderActivitiesAt('/activities')

    await findFeed()
    fireEvent.click(screen.getByRole('button', { name: /Moving time/ }))

    expect(testRouter.state.location.search).toMatchObject({ sort: 'moving_time_s' })
  })

  it("offers the sport filter's options from /api/sports, counts included, with the unknown sentinel for the null bucket", async () => {
    mockApi({
      sports: [
        { sport: 'running', count: 307 },
        { sport: 'cycling', count: 261 },
        { sport: null, count: 3 },
      ],
    })

    renderActivitiesAt('/activities')
    await openFilters()

    // `findByRole` alone would resolve against the very first render, before
    // the sports query settles - the combobox exists from the first tick
    // regardless of its options. Waiting for a specific option that can only
    // exist once `/api/sports` has resolved is what actually waits for it.
    // The option is title-cased through `format.sportLabel`, which is the
    // same spelling a card's own quiet line uses: one name per sport
    // across the product, rather than `running` here and `Running` there.
    await screen.findByRole('option', { name: /Running \(307\)/ })
    const select = screen.getByRole('combobox', { name: 'Sport' })
    const options = within(select).getAllByRole('option') as HTMLOptionElement[]
    const byValue = new Map(options.map((option) => [option.value, option.textContent]))

    expect(byValue.get(ALL_SPORTS)).toContain('571') // 307 + 261 + 3
    expect(byValue.get('running')).toContain('307')
    expect(byValue.get('cycling')).toContain('261')
    expect(byValue.get(UNKNOWN_SPORT)).toContain('3')
    // A hardcoded list would not have known about a sport this store never
    // reported, e.g. one the fixture above never mentions.
    expect(byValue.has('golf')).toBe(false)
  })

  it('degrades the sport filter rather than hiding the whole browser when /api/sports fails (M8)', async () => {
    // An earlier version returned early on this error, hiding the table,
    // the row and every other filter underneath a failure that only ever
    // affected the sport dropdown - a nicety lost, not the whole page.
    const run = activityFixture()
    vi.mocked(api.GET).mockImplementation((path) => {
      if (path === '/api/sports') return Promise.reject(new Error('sports endpoint down'))
      if (path === '/api/activities') return Promise.resolve(jsonResult(pageFixture([run])))
      if (path === '/api/health') return Promise.resolve(jsonResult(healthFixture()))
      return new Promise(() => undefined)
    })

    renderActivitiesAt('/activities')

    expect(await screen.findByRole('alert')).toHaveTextContent('sports endpoint down')

    // The activity page loaded and rendered despite the sports failure.
    expect(await findCards()).toHaveLength(1)
  })

  it('writes a changed filter to the URL without discarding the filters already there', async () => {
    mockApi({ activities: pageFixture([]) })

    const testRouter = renderActivitiesAt('/activities?sport=running&from=2024-01-01')
    // An empty page under a filter renders the no-match state, never a feed.
    // Waiting for a feed here used to sit out the whole 4 s `findBy` timeout
    // and leave this test under a second of its 5 s budget.
    await screen.findByText(/matched these filters/i)
    await openFilters()
    await screen.findByRole('combobox', { name: 'Source' })

    const sourceSelect = screen.getByRole('combobox', { name: 'Source' })
    fireEvent.change(sourceSelect, { target: { value: 'gpx' } })

    expect(testRouter.state.location.search).toEqual({
      sport: 'running',
      from: '2024-01-01',
      source: 'gpx',
      offset: 0,
    })
  })

  it('reports an empty store, not "no match", when the query is unfiltered and the page is empty', async () => {
    mockApi({ activities: pageFixture([], { total: 0 }) })

    renderActivitiesAt('/activities?sport=all')

    expect(await screen.findByText(/no activities in it/i)).toBeInTheDocument()
    expect(screen.queryByText(/matched these filters/i)).not.toBeInTheDocument()
  })

  it('reports no match for the filters, not an empty store, when a filter is active and the page is empty', async () => {
    mockApi({ activities: pageFixture([], { total: 0 }) })

    // The default sport filter (running) is itself a filter: an empty page
    // under it says nothing about whether the store as a whole is empty.
    renderActivitiesAt('/activities?sport=running')

    expect(await screen.findByText(/matched these filters/i)).toBeInTheDocument()
    expect(screen.queryByText(/no activities in it/i)).not.toBeInTheDocument()
  })

  it('reports no match, not an empty store, when only a distance bound empties the page', async () => {
    // The unfiltered check used to name six filter keys by hand and none of
    // the five this branch added, so `min_distance_m=999000` over a full
    // store read "This store has no activities in it. Ingest a Strava
    // export to get started."
    mockApi({ activities: pageFixture([], { total: 0 }) })

    renderActivitiesAt('/activities?sport=all&min_distance_m=999000')

    expect(await screen.findByText(/matched these filters/i)).toBeInTheDocument()
    expect(screen.queryByText(/no activities in it/i)).not.toBeInTheDocument()
  })

  it('says the page is past the end, instead of a pager reading backwards, when offset exceeds total', async () => {
    // A bookmarked deep-page URL reloaded after the store shrank, or after
    // that URL's filters started matching fewer rows: rows matched, none
    // are on this page. Rendering the table anyway - the pre-fix
    // behaviour, restored by dropping the `page.items.length === 0` branch
    // from `emptyState` - gives headers over an empty body and a pager
    // reading "401-307 of 307", a range that runs backwards. Both
    // assertions below fail under that mutation: a table is present and
    // no message is.
    mockApi({ activities: pageFixture([], { total: 307, offset: 400, limit: 50 }) })

    const testRouter = renderActivitiesAt('/activities?sport=running&offset=400')

    expect(await screen.findByText(/past the end of the results/i)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Activities' })).not.toBeInTheDocument()
    expect(screen.queryByText('401-307 of 307')).not.toBeInTheDocument()

    // The way out has to actually work: page one is one click away.
    fireEvent.click(screen.getByRole('button', { name: /back to the first page/i }))
    await waitFor(() => {
      expect(testRouter.state.location.search).toMatchObject({ offset: 0 })
    })
  })
  it('sorts pace by the speed it is the reciprocal of, fastest run first', async () => {
    // No pace is stored anywhere (CLAUDE.md, "Never store pace"), so the
    // Pace header sorts by `avg_speed_mps`. Descending speed is ascending
    // pace, which is what puts the fastest run on top - the maintainer's choice, and
    // the same "biggest number first" behaviour every other column has.
    mockApi({ activities: pageFixture([activityFixture({})]) })
    const testRouter = renderActivitiesAt('/activities')

    await findFeed()
    fireEvent.click(screen.getByRole('button', { name: /^Pace/ }))

    await waitFor(() => {
      expect(testRouter.state.location.search).toMatchObject({
        sort: 'avg_speed_mps',
        order: 'desc',
      })
    })
  })

  it("flips the pace chip's arrow, because descending speed is ascending pace", async () => {
    // A ▼ beside Pace under `order=desc` would tell the reader the slowest
    // run is on top while the fastest one is. Every other field can show
    // the query's own direction; this one cannot.
    mockApi({ activities: pageFixture([activityFixture({})]) })
    renderActivitiesAt('/activities?sport=running&sort=avg_speed_mps&order=desc')

    await findFeed()
    const paceChip = screen.getByRole('button', { name: /^Pace/ })
    expect(markDirection(paceChip)).toBe('ascending')

    // And the date field, which sorts by the unit it displays, is not
    // flipped - nor does an inactive chip carry a caret at all.
    const dateChip = screen.getByRole('button', { name: /^Date/ })
    expect(markDirection(dateChip)).toBeNull()
  })

  it('announces the pace sort in the displayed unit too, so what is spoken agrees with the arrow', async () => {
    // Under `order=desc` on avg_speed_mps the fastest run is on top, which
    // in pace is ascending. A screen reader told "descending" here hears
    // the opposite of what the caret on the chip shows a sighted reader.
    // The caret is `aria-hidden` and the word beside it is what is
    // announced, and both come from one `sortState` call so they cannot
    // disagree.
    mockApi({ activities: pageFixture([activityFixture({})]) })
    renderActivitiesAt('/activities?sport=running&sort=avg_speed_mps&order=desc')

    await findFeed()
    const paceChip = screen.getByRole('button', { name: 'Pace ascending' })
    expect(paceChip).toHaveAttribute('aria-pressed', 'true')
    expect(markDirection(paceChip)).toBe('ascending')

    // Every inactive chip says so, rather than announcing a stale direction.
    const dateChip = screen.getByRole('button', { name: 'Date' })
    expect(dateChip).toHaveAttribute('aria-pressed', 'false')
  })

  it('announces a non-inverted sort in the query direction, so only pace is flipped', async () => {
    mockApi({ activities: pageFixture([activityFixture({})]) })
    renderActivitiesAt('/activities?sport=running&sort=distance_m&order=desc')

    await findFeed()
    const distanceChip = screen.getByRole('button', { name: 'Distance descending' })
    expect(distanceChip).toHaveAttribute('aria-pressed', 'true')
    expect(markDirection(distanceChip)).toBe('descending')
  })

  it('sorts heart rate by heart rate', async () => {
    mockApi({ activities: pageFixture([activityFixture({})]) })
    const testRouter = renderActivitiesAt('/activities')

    await findFeed()
    fireEvent.click(screen.getByRole('button', { name: /^Heart rate/ }))

    await waitFor(() => {
      expect(testRouter.state.location.search).toMatchObject({ sort: 'avg_hr_bpm' })
    })
  })

  it('writes SI to the URL from the kilometre slider', async () => {
    // The URL and the API carry SI like every other quantity in this
    // project; a reader thinks in kilometres. The conversion happens once,
    // at the control, so a shared link and an API request say the same
    // thing.
    mockApi({ activities: pageFixture([activityFixture({})]) })
    const testRouter = renderActivitiesAt('/activities')
    await findFeed()
    await openFilters()

    fireEvent.change(screen.getByLabelText('Distance, minimum'), { target: { value: '5' } })

    await waitFor(() => {
      expect(testRouter.state.location.search).toMatchObject({ min_distance_m: 5000 })
    })
  })

  it('writes SI to the URL from the minutes slider', async () => {
    mockApi({ activities: pageFixture([activityFixture({})]) })
    const testRouter = renderActivitiesAt('/activities')
    await findFeed()
    await openFilters()

    fireEvent.change(screen.getByLabelText('Moving time, minimum'), { target: { value: '45' } })

    await waitFor(() => {
      expect(testRouter.state.location.search).toMatchObject({ min_moving_time_s: 2700 })
    })
  })

  it('removes the upper bound when the top handle sits at its stop', async () => {
    // The stop means "and above", not 20 km: six of the 307 real runs are
    // longer than that, the longest by more than a quarter, so a slider
    // that capped there would hide real runs from a reader who asked for
    // none to be hidden.
    mockApi({ activities: pageFixture([activityFixture({})]) })
    const testRouter = renderActivitiesAt('/activities?max_distance_m=12000')
    await findFeed()
    await openFilters()

    fireEvent.change(screen.getByLabelText('Distance, maximum'), { target: { value: '20' } })

    await waitFor(() => {
      expect(testRouter.state.location.search.max_distance_m).toBeUndefined()
    })
  })

  it('renders a filter set in the URL back as kilometres and minutes', async () => {
    mockApi({ activities: pageFixture([activityFixture({})]) })
    renderActivitiesAt('/activities?sport=running&min_distance_m=7500&max_moving_time_s=2700')
    await findFeed()
    await openFilters()

    expect(screen.getByLabelText('Distance, minimum')).toHaveValue('7.5')
    expect(screen.getByLabelText('Moving time, maximum')).toHaveValue('45')
  })

  it('dragging a bound back to the bottom stop removes it rather than setting it to zero', async () => {
    // A zero-metre floor is a filter that matches everything, which looks
    // identical to no filter until the reader shares the URL or wonders why
    // it is still in the address bar.
    mockApi({ activities: pageFixture([activityFixture({})]) })
    const testRouter = renderActivitiesAt('/activities?sport=running&min_distance_m=7500')
    await findFeed()
    await openFilters()

    fireEvent.change(screen.getByLabelText('Distance, minimum'), { target: { value: '0' } })

    await waitFor(() => {
      expect(testRouter.state.location.search).not.toHaveProperty('min_distance_m')
    })
  })

  it('dragging the upper bound to the bottom stop writes a ceiling of zero, not no ceiling', async () => {
    // Only the *top* stop means "and no bound"; the bottom of the upper
    // handle's travel is a real ceiling of zero, which matches nothing.
    // Coercing it away left the readout saying "0 km to 0 km" over a feed
    // showing every activity - the one state where the control lies about
    // what the feed is.
    mockApi({ activities: pageFixture([activityFixture({})]) })
    const testRouter = renderActivitiesAt('/activities?max_distance_m=12000')
    await findFeed()
    await openFilters()

    fireEvent.change(screen.getByLabelText('Distance, maximum'), { target: { value: '0' } })

    await waitFor(() => {
      expect(testRouter.state.location.search).toMatchObject({ max_distance_m: 0 })
    })
    expect(screen.getByLabelText('Distance, maximum')).toHaveValue('0')
  })

  it('collapses one drag into one history entry and one request, like the name box', async () => {
    // A drag fires a change per step, so the fault the numeric boxes had -
    // `patch` called from the control's own `onChange`, one history entry
    // and one `/api/activities` request per event - is worse here, not
    // better: Back would need a press per notch to leave the page. The
    // browser test sets the value in one event and so would never see it.
    mockApi({ activities: pageFixture([activityFixture({})]) })

    const testRouter = renderActivitiesAt('/activities')
    await openFilters()
    const handle = await screen.findByLabelText('Distance, minimum')
    await waitFor(() => {
      expect(activitiesRequestCount()).toBe(1)
    })
    const entriesBefore = testRouter.history.length

    for (const km of ['1', '2', '3', '4', '5']) {
      fireEvent.change(handle, { target: { value: km } })
    }

    // The handle itself tracks every step even though the URL does not.
    expect(handle).toHaveValue('5')

    await waitFor(() => {
      expect(testRouter.state.location.search).toMatchObject({ min_distance_m: 5000 })
    })

    expect(activitiesRequestCount()).toBe(2)
    expect(testRouter.history.length).toBe(entriesBefore)
  })

  it('does not reimpose an upper bound the reader removed when the other handle moves', async () => {
    // `[0, undefined]` and `[0, 20]` are the same filter, and the draft
    // round-trips through the URL as the former. A control that read the
    // round trip as a navigation would snap the open bound shut mid-drag.
    mockApi({ activities: pageFixture([activityFixture({})]) })
    const testRouter = renderActivitiesAt('/activities?sport=running&min_distance_m=3000')
    await findFeed()
    await openFilters()

    fireEvent.change(screen.getByLabelText('Distance, minimum'), { target: { value: '8' } })

    await waitFor(() => {
      expect(testRouter.state.location.search).toMatchObject({ min_distance_m: 8000 })
    })
    expect(testRouter.state.location.search).not.toHaveProperty('max_distance_m')
  })

  it('marks a row that set a personal record, and names the distances', async () => {
    // One real activity in the store set a 1k, a 1mi and a 3k record at
    // once, so "PR" alone throws information away.
    mockApi({
      activities: pageFixture([activityFixture({ pr_distance_keys: ['1k', '1mi', '3k'] })]),
    })
    renderActivitiesAt('/activities')

    const card = await findFirstCard()
    const badge = within(card).getByText(/^PR 1k 1mi 3k$/)
    expect(badge).toBeInTheDocument()
    // Titled with the distances as well, which is what a reader gets on
    // hover and what the browser suite locates the badge by.
    expect(badge).toHaveAttribute('title', 'Personal record at 1k, 1mi, 3k')
  })

  it('marks no badge on a row that set no record', async () => {
    mockApi({ activities: pageFixture([activityFixture({ pr_distance_keys: [] })]) })
    renderActivitiesAt('/activities')

    const card = await findFirstCard()
    expect(within(card).queryByText(/^PR/)).toBeNull()
  })

  it('lands the reader on activities, with every filter behind one disclosure', async () => {
    // The whole point of the rebuild. Nine labelled form controls used to
    // stand between the title and the first activity, which at 412px is
    // the entire first screen: a list of 307 runs that opened on a filter
    // panel. `hidden` rather than merely styled out, so the controls are
    // genuinely out of the accessibility tree and out of the tab order
    // until the reader asks for them.
    mockApi({ activities: pageFixture([activityFixture({})]) })
    renderActivitiesAt('/activities')

    await findFeed()
    const toggle = screen.getByRole('button', { name: /^Filters/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('combobox', { name: 'Sport' })).toBeNull()

    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('combobox', { name: 'Sport' })).toBeInTheDocument()
    // Every control keeps its accessible name inside the sheet: moving one
    // behind a disclosure does not exempt it from being reachable by name.
    expect(screen.getByRole('slider', { name: 'Distance, minimum' })).toBeInTheDocument()
    expect(screen.getByLabelText('Name contains')).toBeInTheDocument()
  })

  it('says how many filters are narrowing the feed, since the sheet that holds them is closed', async () => {
    // A reader arriving on a shared filtered link sees a short feed. With
    // the controls hidden, this count is the only thing that says why -
    // and the endpoint's own default sport is not one of them, or every
    // unfiltered landing would claim a filter.
    mockApi({ activities: pageFixture([activityFixture({})]) })
    renderActivitiesAt('/activities?sport=running&min_distance_m=15000&q=Run')

    await findFeed()
    expect(screen.getByRole('button', { name: 'Filters 2' })).toBeInTheDocument()
  })

  it('counts no filter on an unfiltered landing, because the default sport is not a choice', async () => {
    mockApi({ activities: pageFixture([activityFixture({})]) })
    renderActivitiesAt('/activities')

    await findFeed()
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument()
  })

  it('keeps a half-typed filter when the sheet is closed and reopened', async () => {
    // The sheet is hidden rather than unmounted precisely because
    // `useTypedFilter` holds an uncommitted draft: a reader who closes the
    // panel mid-word would otherwise lose it, and the debounce means a
    // short word may not have reached the URL yet either.
    mockApi({ activities: pageFixture([activityFixture({})]) })
    renderActivitiesAt('/activities')

    await findFeed()
    await openFilters()
    fireEvent.change(screen.getByLabelText('Name contains'), { target: { value: 'Tre' } })

    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    await openFilters()

    expect(screen.getByLabelText('Name contains')).toHaveValue('Tre')
  })

  it('filters to the runs that set a record, and writes it to the URL', async () => {
    mockApi({ activities: pageFixture([activityFixture({})]) })
    const testRouter = renderActivitiesAt('/activities')
    await findFeed()
    await openFilters()

    fireEvent.change(screen.getByRole('combobox', { name: 'Records' }), {
      target: { value: 'true' },
    })

    await waitFor(() => {
      expect(testRouter.state.location.search).toMatchObject({ has_pr: true })
    })
  })
})
