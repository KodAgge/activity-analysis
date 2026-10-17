import { expect, test } from '@playwright/test'
import { serveSyntheticRoute } from './syntheticRoute'

/**
 * A recurring route, followed end to end through the app: the Records
 * view's Routes section, the route view it links to, and one run on that
 * route opening its own activity, which names the route back.
 *
 * The fixture store holds no route - one takes three or more runs of one
 * loop - so the route's own responses are synthetic, three fixture runs
 * served as one route by `serveSyntheticRoute`; the runs' streams and the
 * rest of their detail come from the real API.
 *
 * The scatter mark count is checked against the runs the detail response
 * served rather than against a fixed number, for the reason every other
 * test in this suite reads its expectation from a response first: on a real
 * store a route gains a run every time the athlete runs it again.
 */

test('a route is followed from Records to the activity it recurs on', async ({ page, request }) => {
  const detail = await serveSyntheticRoute(page, request)
  const first = detail.route

  // The Records view, not a direct navigation to the route URL - the same
  // reason `smoke.spec.ts`'s `openActivityDetailByClicking` clicks a real
  // row rather than `page.goto`ing the destination: a route reachable only
  // by URL is a route a user could never actually get to.
  await page.goto('/records')
  const routesSection = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Routes', level: 2 }) })
  const firstRouteLink = routesSection.getByRole('link', { name: new RegExp(`^${escapeRegExp(first.name)}`) })
  await firstRouteLink.waitFor()
  await firstRouteLink.click()

  await page.waitForURL(`**/routes/${first.route_id}`)
  await expect(page.getByRole('heading', { name: first.name, level: 1 })).toBeVisible()

  // One scatter mark per run: `ProgressionScatter` tags each mark's own
  // shape (`<circle>` or `<path>`, never the surrounding `<a>`) with
  // `data-activity-id`, so this counts marks rather than links, the same
  // distinction `Route.test.tsx` and `ProgressionScatter.test.tsx` draw
  // between a link and the shape inside it.
  const scatter = page.getByRole('img', { name: `${first.name}, pace per run` })
  await scatter.waitFor()
  const marks = scatter.locator('[data-activity-id]')
  await expect(marks).toHaveCount(detail.runs.length)

  // One run's own mark opens its activity, which names the route back -
  // the round trip the brief asks for, checked with a real click rather
  // than a direct navigation to the activity's URL.
  const run = detail.runs[0]
  if (run === undefined) throw new Error('detail.runs.length > 0 but the first entry is undefined')
  const runLink = scatter.locator('a').filter({ has: page.locator(`[data-activity-id="${run.activity_id}"]`) })
  await runLink.click()

  await page.waitForURL(`**/activities/${run.activity_id}`)
  const routeLine = page.getByRole('link', { name: new RegExp(`^Route: ${escapeRegExp(first.name)}`) })
  await expect(routeLine).toBeVisible()

  // And the activity's own Route section draws the line this run followed,
  // the same trace the route view's hero drew from its reference run. The
  // SVG trace is what this checks: `RouteMap` draws it as its own underlay
  // and hides it with `visibility` once a covering basemap has loaded, so
  // it stays in the DOM either way - `smoke.spec.ts`'s "the route panel no
  // longer wastes half its width" measures the same element for the same
  // reason. `Route` draws one polyline per contiguous run of non-null
  // samples, so a run with a real GPS gap legitimately draws more than one;
  // the count checked here is "at least one", not a number the API states.
  const routeMap = page.locator('svg[aria-label="Route map"]')
  await routeMap.waitFor({ state: 'attached' })
  expect(await routeMap.locator('polyline').count()).toBeGreaterThan(0)
})

/** Escapes a string for use inside a `RegExp`, since a route's name is real data, not a literal. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
