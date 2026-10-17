import { readFileSync } from 'node:fs'
import type { Page, Route } from '@playwright/test'
import { expect, test } from '@playwright/test'

/**
 * The map reaching MapLibre's `load` in a real browser, with nothing read
 * from the store's basemap.
 *
 * `basemap.spec.ts` reads the area `scripts/e2e-api-server.mjs` installs in
 * the end-to-end store through the API's own serving; this test does not.
 * It answers `/api/basemap` with one synthetic area around the reference
 * activity and serves that area's archive, sprite and glyphs from fixtures,
 * so it holds whatever basemap the API behind the dev server has.
 * The "Map style" switch renders only after `load`, which needs the style,
 * the sprite, the archive's header and the viewport's tiles, all decoded in
 * MapLibre's web worker. A worker that fails to start leaves the bare trace
 * and no switch, which is how this test fails.
 *
 * `fixtures/basemap-z0.pmtiles` is the single zoom 0 tile of an extract
 * around the fixture runs; `fixtures/README.md` records its provenance. Every
 * request to a host other than the dev server is aborted, so the test
 * sends nothing off the machine even if a style URL were to name one.
 */

/** The reference activity of `docs/reference/test-fixtures.md`, the one `smoke.spec.ts` uses. */
const REFERENCE_ACTIVITY = '854fd775d479ca9f'

const ARCHIVE = readFileSync(new URL('./fixtures/basemap-z0.pmtiles', import.meta.url))

/** A valid 1 x 1 transparent PNG: the sprite sheet of an empty sprite index. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

/** The fixture archive's own header bounds, which hold the reference activity's route. */
const AREA = { id: 'fixture', west: 14.05, south: 57.7, east: 14.3, north: 57.85 }

/**
 * The archive by byte range, as `FileResponse` serves the real one.
 *
 * The `pmtiles` reader rejects a 200 whose body is longer than the range it
 * asked for, taking it for a server without byte serving.
 */
async function serveByRange(route: Route, body: Buffer) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers()['range'] ?? '')
  const headers = { 'content-type': 'application/vnd.pmtiles', 'accept-ranges': 'bytes' }
  if (match === null) {
    await route.fulfill({ status: 200, body, headers })
    return
  }
  const start = Number(match[1])
  const end = Math.min(match[2] ? Number(match[2]) : body.length - 1, body.length - 1)
  await route.fulfill({
    status: 206,
    body: body.subarray(start, end + 1),
    headers: { ...headers, 'content-range': `bytes ${String(start)}-${String(end)}/${String(body.length)}` },
  })
}

async function serveFixtureBasemap(page: Page): Promise<string[]> {
  const requested: string[] = []
  await page.route(
    (url) => url.hostname !== 'localhost' && url.hostname !== '127.0.0.1',
    (route) => route.abort(),
  )
  await page.route('**/api/basemap', (route) =>
    route.fulfill({ json: { areas: [AREA], attribution: 'fixture &copy; OpenStreetMap' } }),
  )
  await page.route('**/api/basemap/areas/*.pmtiles', (route) => serveByRange(route, ARCHIVE))
  await page.route('**/api/basemap/assets/**', (route) => {
    const path = new URL(route.request().url()).pathname
    requested.push(path)
    if (path.endsWith('.json')) return route.fulfill({ json: {} })
    if (path.endsWith('.png')) return route.fulfill({ body: PNG_1X1, contentType: 'image/png' })
    // A glyph range: an empty protobuf is a valid message holding no glyphs.
    return route.fulfill({ body: Buffer.alloc(0), contentType: 'application/x-protobuf' })
  })
  return requested
}

test('a covered route loads its map from fixtures, and a flavour switch keeps it', async ({ page }) => {
  // A cold dev server's first MapLibre chunk and worker; see the same
  // allowance in `basemap.spec.ts`.
  test.setTimeout(90_000)
  const requested = await serveFixtureBasemap(page)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto(`/activities/${REFERENCE_ACTIVITY}`)
  const style = page.getByRole('radiogroup', { name: 'Map style' })
  // Chunk, worker, style, sprite, header and one tile, cold in a dev server.
  await expect(style).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('route-underlay')).toBeHidden()

  const grey = page.getByRole('radio', { name: 'Grey' })
  await grey.check()
  await expect(grey).toBeChecked()
  await expect.poll(() => requested.some((p) => p.endsWith('/sprites/v4/grayscale.json'))).toBe(true)
  await expect(style).toBeVisible()
  await expect(page.getByTestId('route-underlay')).toBeHidden()
  expect(errors).toEqual([])
})
