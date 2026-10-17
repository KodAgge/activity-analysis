import { Outlet, createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router'
import { activitySearchRedirectTarget, validateActivitySearch } from './api/activitySearch'
import { distributionSearchRedirectTarget, validateDistributionSearch } from './api/distributionSearch'
import { progressionSearchRedirectTarget, validateProgressionSearch } from './api/progressionSearch'
import { territorySearchRedirectTarget, validateTerritorySearch } from './api/territorySearch'
import { AppShell } from './components/AppShell'
import { ActivityDetail } from './views/ActivityDetail'
import { Activities } from './views/Activities'
import { Distributions } from './views/Distributions'
import { Overview } from './views/Overview'
import { Progression } from './views/Progression'
import { Records } from './views/Records'
import { RouteDetail } from './views/RouteDetail'
import { Territory } from './views/Territory'
import { Trends } from './views/Trends'

const rootRoute = createRootRoute({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
})

/**
 * Inline stubs, deliberately not real view components: tasks 5, 6 and 7 each
 * add one of `views/Overview.tsx`, `views/Activities.tsx` and
 * `views/ActivityDetail.tsx` and swap the stub below for a real import. A
 * stub file already sitting at that path would turn each of those additions
 * into a modification and bury the real component in a diff of deletions.
 *
 * Tasks 5, 6 and 7 have landed, so the index, `/activities` and
 * `/activities/$activityId` routes below are all real imports now.
 */
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Overview,
})

const activitiesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/activities',
  validateSearch: validateActivitySearch,
  /**
   * `validateSearch`'s return value narrows the type of `useSearch()`, but
   * TanStack Router merges it back over the raw parent search rather than
   * replacing it (see the comment on `validateActivitySearch`). In practice
   * that merge already self-corrects a key this route's validator sets to a
   * *different* valid value - a clamped `limit=9999` already reads as `200`
   * on the merged `search` a component would see, because the validated
   * value wins the merge for a key both sides share. It does not correct a
   * key the validator drops entirely - an unknown param, a non-numeric
   * `limit`, an invalid enum or date - because then there is no validated
   * value to win with, and the raw one survives untouched. Either way, the
   * *URL itself* never changes on its own: a limit of `9999` in the address
   * bar stays `9999` even though the app is really using `200`, which is
   * wrong to bookmark or share, and a genuinely dropped key stays visible
   * and sticky through `navigate({ search: prev => ... })`.
   *
   * `beforeLoad` runs after `validateSearch` but before anything renders, so
   * redirecting here - only when `activitySearchRedirectTarget` says the
   * URL's own raw search actually differs from its validated form - is what
   * makes the address bar and every downstream `useSearch()` agree with
   * each other and with what `queries.activities` actually requests, not
   * just the one request it itself builds.
   */
  beforeLoad: ({ location }) => {
    const target = activitySearchRedirectTarget(location.search)
    if (target !== null) {
      throw redirect({ to: '/activities', search: target, replace: true })
    }
  },
  component: Activities,
})

const activityDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/activities/$activityId',
  component: ActivityDetail,
})

/**
 * Declared after `/activities/$activityId` and matched on a literal path, so
 * there is no ambiguity between them: `/records` is not a child of
 * `/activities` and cannot be read as an activity id.
 */
const recordsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/records',
  component: Records,
})

/**
 * One route, reached from the Records view's Routes section and from the
 * route line on each of its runs. Declared after `/records`, on a literal
 * `/routes` prefix that nothing else uses, so it cannot be read as an
 * activity id or collide with another view.
 */
const routeDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/routes/$routeId',
  component: RouteDetail,
})

/**
 * Literal paths declared after `/activities/$activityId`, exactly as
 * `/records` is and for the same reason: neither can be read as an
 * activity id.
 */
const trendsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/trends',
  component: Trends,
})

const progressionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/progression',
  validateSearch: validateProgressionSearch,
  /**
   * The same pair as `/activities` above, for the same reason: validation
   * alone leaves a bare `/progression` in the address bar while the chart
   * shows 5 km, and leaves an unknown key sticky. The redirect makes the URL
   * say what the view shows, once - `validateProgressionSearch` is
   * idempotent, so the destination validates to itself.
   */
  beforeLoad: ({ location }) => {
    const target = progressionSearchRedirectTarget(location.search)
    if (target !== null) {
      throw redirect({ to: '/progression', search: target, replace: true })
    }
  },
  component: Progression,
})

/**
 * Declared after `/progression`, on its own literal path: the third route
 * with typed search state, `validateSearch` plus `beforeLoad` redirect
 * exactly as `/activities` and `/progression` are.
 */
const distributionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/distributions',
  validateSearch: validateDistributionSearch,
  beforeLoad: ({ location }) => {
    const target = distributionSearchRedirectTarget(location.search)
    if (target !== null) {
      throw redirect({ to: '/distributions', search: target, replace: true })
    }
  },
  component: Distributions,
})

/**
 * The claimed ground. Its one search key, `region`, is optional - the
 * default is the largest region, which only the payload knows - so the
 * redirect only strips an unknown key or an empty region.
 */
const territoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/territory',
  validateSearch: validateTerritorySearch,
  beforeLoad: ({ location }) => {
    const target = territorySearchRedirectTarget(location.search)
    if (target !== null) {
      throw redirect({ to: '/territory', search: target, replace: true })
    }
  },
  component: Territory,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  activitiesRoute,
  activityDetailRoute,
  recordsRoute,
  routeDetailRoute,
  trendsRoute,
  progressionRoute,
  distributionsRoute,
  territoryRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
