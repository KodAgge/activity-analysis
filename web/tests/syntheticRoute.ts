import type { APIRequestContext, Page } from '@playwright/test'
import type { components } from '../src/api/schema'

type RouteSummary = components['schemas']['RouteSummary']
type RouteDetail = components['schemas']['RouteDetail']
type RouteRun = components['schemas']['RouteRun']
type ActivityDetail = components['schemas']['ActivityDetail']

/**
 * A recurring route the fixture store cannot hold, served from the real
 * runs it is made of.
 *
 * `analysis.routes` groups a route only from three or more runs of one
 * loop, and no three fixture runs follow one, so the store's `/api/routes`
 * is empty. The route view and its links are frontend behaviour all the
 * same, so this answers the route-shaped responses with `page.route` -
 * `/api/routes`, `/api/routes/<id>`, and each member's own
 * `/api/activities/<id>` with its `route` filled in - and leaves every other
 * request, the members' streams and the rest of their detail included, to
 * the real API.
 *
 * The route is three of the fixture runs, put together by the rules
 * `analysis/routes.py` and `api/queries.py` state rather than by hand: the
 * earliest run's id is the route's, the name is the members' place and
 * median distance, a run's speed is its distance over its elapsed time, and
 * a record is a run faster than every earlier one. The reference run, the
 * medoid the map draws, is the reference fixture. Every member is served
 * as eligible and as run the same way round, which is all this needs.
 */
const MEMBERS = ['381b23089a38ec5d', '0af80b91f3c92e34', '854fd775d479ca9f'] as const
const REFERENCE = '854fd775d479ca9f'

/**
 * Installs the synthetic route on `page` and returns what `/api/routes/<id>`
 * now serves it. Only the page sees it: `request` and `page.request` go
 * around `page.route`, so a test reads the route from this return value.
 */
export async function serveSyntheticRoute(page: Page, request: APIRequestContext): Promise<RouteDetail> {
  const details = await Promise.all(
    MEMBERS.map(async (id) => (await (await request.get(`/api/activities/${id}`)).json()) as ActivityDetail),
  )

  let fastest = 0
  const runs: RouteRun[] = details.map(({ summary }) => {
    const distance = summary.distance_m ?? 0
    const elapsed = summary.elapsed_time_s ?? 0
    const speed = distance / elapsed
    const isRecord = speed > fastest
    fastest = Math.max(fastest, speed)
    return {
      activity_id: summary.activity_id,
      start_time_utc: summary.start_time_utc,
      utc_offset_s: summary.utc_offset_s,
      name: summary.name,
      distance_m: distance,
      elapsed_time_s: elapsed,
      speed_mps: speed,
      direction: 'forward',
      eligible: true,
      ineligible_reason: null,
      rank: null,
      is_record: isRecord,
    }
  })
  const bySpeed = [...runs].sort((a, b) => b.speed_mps - a.speed_mps)
  for (const run of runs) run.rank = bySpeed.indexOf(run) + 1

  const distances = runs.map((run) => run.distance_m).sort((a, b) => a - b)
  const median = distances[Math.floor(distances.length / 2)] ?? 0
  const locality = details[0]?.derived?.metrics.locality ?? null
  const first = runs[0]
  const last = runs.at(-1)
  const record = bySpeed[0]
  if (first === undefined || last === undefined || record === undefined) throw new Error('the route has no runs')

  const summary: RouteSummary = {
    route_id: first.activity_id,
    name: `${locality ?? 'Route'} ${(median / 1000).toFixed(1)} km`,
    locality,
    run_count: runs.length,
    median_distance_m: median,
    first_run_utc: first.start_time_utc,
    last_run_utc: last.start_time_utc,
    record_speed_mps: record.speed_mps,
    record_activity_id: record.activity_id,
    record_start_time_utc: record.start_time_utc,
    record_utc_offset_s: record.utc_offset_s,
  }
  const detail: RouteDetail = { route: summary, reference_activity_id: REFERENCE, runs }

  await page.route('**/api/routes', (route) => route.fulfill({ json: [summary] }))
  await page.route(`**/api/routes/${summary.route_id}`, (route) => route.fulfill({ json: detail }))
  for (const run of runs) {
    await page.route(`**/api/activities/${run.activity_id}`, async (route) => {
      const response = await route.fetch()
      const activity = (await response.json()) as ActivityDetail
      activity.route = {
        route_id: summary.route_id,
        name: summary.name,
        run_count: summary.run_count,
        rank: run.rank,
        direction: run.direction,
      }
      await route.fulfill({ response, json: activity })
    })
  }
  return detail
}
