import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import type { components } from '../api/schema'
import { NO_VALUE } from '../format'
import { AppShell } from './AppShell'

vi.mock('../api/client', () => ({
  api: { GET: vi.fn() },
}))

type Health = components['schemas']['Health']

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

function mockHealth(health: Health) {
  vi.mocked(api.GET).mockResolvedValue({
    data: health,
    error: undefined,
    response: new Response(),
  } as Awaited<ReturnType<typeof api.GET>>)
}

/**
 * AppShell is rendered as the root route's component, so its `Link`s need a
 * real (if tiny) router underneath them rather than a bare render: `Link`
 * resolves against the router context, and a router built with no routes at
 * all would make every assertion here vacuous.
 */
function renderShell(initialPath = '/') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  const rootRoute = createRootRoute({
    component: () => (
      <AppShell>
        <Outlet />
      </AppShell>
    ),
  })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <p>overview stub</p>,
  })
  const activitiesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/activities',
    component: () => <p>activities stub</p>,
  })
  const trendsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/trends',
    component: () => <p>trends stub</p>,
  })
  const progressionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/progression',
    // Permissive on purpose: the real route's validation is Progression's
    // own test's business; this tree only needs the search to survive.
    validateSearch: (search: Record<string, unknown>) => ({ distance: String(search.distance ?? '') }),
    component: () => <p>progression stub</p>,
  })
  const recordsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/records',
    component: () => <p>records stub</p>,
  })
  const routeViewRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/routes/$routeId',
    component: () => <p>route stub</p>,
  })
  const territoryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/territory',
    component: () => <p>territory stub</p>,
  })
  const routeTree = rootRoute.addChildren([
    territoryRoute,
    indexRoute,
    activitiesRoute,
    recordsRoute,
    routeViewRoute,
    trendsRoute,
    progressionRoute,
  ])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('AppShell', () => {
  beforeEach(() => {
    vi.mocked(api.GET).mockReset()
  })

  it('shows every view as a navigable link, Trends and Progression included', async () => {
    mockHealth(healthFixture())

    renderShell()

    expect(await screen.findByRole('link', { name: 'Overview' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Activities' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Records' })).toHaveAttribute('href', '/records')
    expect(screen.getByRole('link', { name: 'Trends' })).toHaveAttribute('href', '/trends')
    // The progression link names its default distance, so the address bar
    // never shows a bare `/progression` that the route would redirect anyway.
    expect(screen.getByRole('link', { name: 'Progression' })).toHaveAttribute('href', '/progression?distance=5k')
    // Phase 4 is routed: nothing in the nav is disabled any more.
    expect(screen.queryByText(/phase 4/)).toBeNull()
  })

  it('puts every destination in one named navigation landmark, in reading order', async () => {
    // The tab bar is the application's only navigation control now, and its
    // labels are the only text on it - each icon is `aria-hidden`, so a tab
    // that lost its label would still look like a tab and be unreachable by
    // name. Asserting the accessible names through the landmark is what
    // pins that, and the order is the order the views are meant to be read
    // in rather than an accident of markup.
    mockHealth(healthFixture())

    renderShell()

    const tabs = await screen.findByRole('navigation', { name: 'Views' })
    const names = within(tabs)
      .getAllByRole('link')
      .map((link) => link.textContent)
    expect(names).toEqual(['Overview', 'Activities', 'Records', 'Trends', 'Progression', 'Distributions', 'Territory'])
  })

  it('holds the last three behind a More tab that opens and closes their sheet', async () => {
    // On a phone the bar shows four tabs and More; the stylesheet hides
    // the sheet while closed, which jsdom does not apply, so this pins the
    // state the stylesheet keys on - the button's `aria-expanded` and the
    // sheet's class - and that the three links are the sheet's own.
    mockHealth(healthFixture())

    renderShell('/trends')

    const more = await screen.findByRole('button', { name: 'More' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    const sheet = document.getElementById(more.getAttribute('aria-controls') ?? '')
    expect(
      within(sheet ?? document.createElement('div'))
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Progression', 'Distributions', 'Territory'])
    fireEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(more).toHaveFocus()
    fireEvent.click(more)
    fireEvent.pointerDown(document.body)
    expect(more).toHaveAttribute('aria-expanded', 'false')
  })

  it('closes the sheet when one of its links is followed', async () => {
    mockHealth(healthFixture())

    renderShell('/trends')

    const more = await screen.findByRole('button', { name: 'More' })
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('link', { name: 'Territory' }))
    expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(await screen.findByText('territory stub')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Territory' })).toHaveAttribute('aria-current', 'page')
  })

  it('leads with the view, not with the store diagnostics', async () => {
    // The old shell opened every screen with a brand, a wrapping row of
    // text links and an activity count, so the first thing on a phone was
    // three rows of chrome and the screen's own title was the fourth. The
    // count is ambient and now sits at the end of the scroll: this pins
    // that the view's content precedes it in the document, which is what
    // decides both the reading order and the visual hierarchy.
    mockHealth(healthFixture())

    renderShell()

    const status = await screen.findByRole('status')
    const view = screen.getByText('overview stub')
    expect(view.compareDocumentPosition(status)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('marks the current view in the nav', async () => {
    mockHealth(healthFixture())

    renderShell('/trends')

    const trends = await screen.findByRole('link', { name: 'Trends' })
    expect(trends).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Progression' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current')
  })

  it('keeps Progression marked current at a distance other than the one the link points at', async () => {
    // The link carries `?distance=5k`. TanStack Router compares a link's
    // search against the location's by default, so at 10 km the view was
    // still Progression while the nav said nothing was.
    mockHealth(healthFixture())

    renderShell('/progression?distance=10k')

    const progression = await screen.findByRole('link', { name: 'Progression' })
    expect(progression).toHaveAttribute('aria-current', 'page')
    expect(progression).toHaveAttribute('href', '/progression?distance=5k')
    expect(screen.getByRole('link', { name: 'Trends' })).not.toHaveAttribute('aria-current')
  })

  it('marks Records current on a route view, which is reached from its Routes section', async () => {
    mockHealth(healthFixture())

    renderShell('/routes/0a1b2c3d4e5f6a7b')

    const records = await screen.findByRole('link', { name: 'Records' })
    expect(records).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Activities' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current')
  })

  it('leaves Records unmarked on a view that is neither Records nor a route', async () => {
    mockHealth(healthFixture())

    renderShell('/trends')

    expect(await screen.findByRole('link', { name: 'Records' })).not.toHaveAttribute('aria-current')
  })

  it('warns and names recompute when a stored version does not match the expected one', async () => {
    mockHealth(
      healthFixture({
        stored_ingest_versions: [1],
        expected_ingest_version: 2,
        stale: true,
      }),
    )

    renderShell()

    const warning = await screen.findByRole('alert')
    // One line on screen, the rest a disclosure away. The message used to be
    // five lines of prose in a card floating over the Overview's bar chart,
    // which cost that chart its zero line; folding it is what let it move
    // back into the scroll without taking a plot with it.
    const summary = within(warning).getByText('The store is stale')
    expect(summary.tagName).toBe('SUMMARY')
    // Both halves of the fix survive the fold, not just the first: a
    // `recompute` alone leaves the running server serving exactly what it
    // was serving before, so a message that stopped at the first command
    // would send the reader back to the same unchanged number.
    expect(warning).toHaveTextContent(/activity-analysis recompute/)
    expect(warning).toHaveTextContent(/restart/)
    expect(warning).toHaveTextContent(/activity-analysis serve/)
  })

  it('announces the fix as well as the problem, not only once the disclosure is opened', async () => {
    mockHealth(healthFixture({ stale: true }))

    renderShell()

    const warning = await screen.findByRole('alert')
    // A closed `<details>` keeps its body out of the accessibility tree, so
    // a remedy that lives only inside it is never part of what the alert
    // announces. Some copy of both commands has to sit outside it.
    const announced = within(warning).getByText(/recompute.*restart.*serve/)
    expect(announced.closest('details')).toBeNull()
  })

  it('renders no warning when the stored and expected versions match', async () => {
    mockHealth(healthFixture())

    renderShell()

    // Wait for the health query to resolve before asserting on its absence,
    // or a pending query would make this pass for the wrong reason.
    await screen.findByRole('link', { name: 'Overview' })
    // `role="status"` is the stable handle for the live-updating count,
    // rather than coupling this test to a presentational CSS class.
    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('1944 activities')

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the no-value glyph, never a fabricated 0, when the activities count is missing from the response', async () => {
    // `counts` is a plain `dict[str, int]`, so `noUncheckedIndexedAccess`
    // types `counts.activities` as possibly `undefined` even though the
    // real server always populates it - `?? 0` would show that missing key
    // exactly the way it shows a genuinely empty store, which is the bug
    // this pins against.
    mockHealth(healthFixture({ counts: {} }))

    renderShell()

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent(`${NO_VALUE} activities`)
    expect(status).not.toHaveTextContent('0 activities')
  })

  it('shows the real failure message when the backend is unreachable, not a generic fallback', async () => {
    // openapi-fetch does not resolve a rejected fetch() as { error: ... };
    // it rethrows it, so an unreachable backend surfaces as a real Error
    // rejection, not a {"detail": ...} body. This is the shape a mutation to
    // `describeApiError(null)` (or similar) would still pass 50/50 against,
    // since it never touches this path at all - it has to be tested through
    // the banner itself, against the real rejection shape, or it can regress
    // silently.
    vi.mocked(api.GET).mockRejectedValue(new TypeError('fetch failed'))

    renderShell()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('fetch failed')
    expect(alert).not.toHaveTextContent('an unknown error')
  })
})
