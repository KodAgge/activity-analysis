import { expect, test } from '@playwright/test'
import { coveringArea } from '../src/charts/routeMath'

/**
 * A covered route's map, end to end, against the real `/api/basemap` and
 * `/api/basemap/areas/{id}.pmtiles` endpoints.
 *
 * The area is the one `scripts/e2e-api-server.mjs` installs in the suite's
 * store in place of a fetched one: `fixtures/basemap-z0.pmtiles`, with
 * stand-in sprites and glyphs. `routeMap.spec.ts` covers the map reaching
 * `load` from responses it answers itself; this is the same map read
 * through the API's own byte-range serving.
 *
 * The run is chosen before the page opens, by the rule the hero itself
 * applies: `coveringArea` over the manifest's areas and the run's own
 * streams. Opening runs until one happens to show a map would have to wait
 * out the chunk, the header, the tiles and `load` on every uncovered run.
 * `/api/activities` rows carry no position, so each candidate's streams are
 * read, newest first, until one is covered.
 */

type Area = { id: string; west: number; south: number; east: number; north: number }
type Streams = { lat_deg: (number | null)[]; lon_deg: (number | null)[] }

test('a covered route loads its map from the app origin by range', async ({ page, request }) => {
  // MapLibre's chunk and worker are the largest things the dev server
  // transforms, and the first test to ask for them pays for it: under the
  // whole suite's load on a cold dev server, the lookup below and the map's
  // first load together outlasted the default 30 s once, while the test
  // passed on its own.
  test.setTimeout(90_000)
  const basemap = (await (await request.get('/api/basemap')).json()) as { areas: Area[] }
  expect(basemap.areas.length, 'the suite store has no basemap area: see scripts/e2e-api-server.mjs').toBeGreaterThan(0)

  const activities = (await (await request.get('/api/activities?sport=running&limit=50')).json()) as {
    items: { activity_id: string }[]
  }
  let covered: string | null = null
  for (const a of activities.items) {
    const response = await request.get(`/api/activities/${a.activity_id}/streams`)
    if (!response.ok()) continue
    const streams = (await response.json()) as Streams
    if (coveringArea(streams.lat_deg, streams.lon_deg, basemap.areas) !== null) {
      covered = a.activity_id
      break
    }
  }
  if (covered === null) throw new Error('no covered run among the newest 50: the manifest and the runs disagree')

  await page.route(
    (url) => url.hostname !== 'localhost' && url.hostname !== '127.0.0.1',
    (route) => route.abort(),
  )
  const ranges: number[] = []
  page.on('response', (r) => {
    if (r.url().includes('/api/basemap/areas/')) ranges.push(r.status())
  })

  await page.goto(`/activities/${covered}`)
  const hero = page.getByRole('radiogroup', { name: 'Map style' })
  await expect(hero).toBeVisible({ timeout: 60_000 })
  expect(ranges.length).toBeGreaterThan(0)
  expect(ranges.every((s) => s === 206)).toBe(true)
  await page.getByRole('radio', { name: 'Grey' }).check()
  await expect(page.getByRole('radio', { name: 'Grey' })).toBeChecked()
  await expect(hero).toBeVisible()
})
