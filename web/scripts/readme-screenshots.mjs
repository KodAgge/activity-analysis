/**
 * The README's screenshots, taken from the demo store.
 *
 * Not part of any check: run it when a view the README shows changes, then
 * look at every image before committing it. The images are part of the
 * public history, and the privacy scan cannot read pixels.
 *
 * Usage, from the repository root (see docs/reference/demo-store.md):
 *
 *   uv run python scripts/build_demo_store.py <root> --end <date>
 *   uv run activity-analysis tiles --root <root>
 *   (cd web && npm run build)
 *   uv run activity-analysis serve --root <root> --port 8130
 *   node web/scripts/readme-screenshots.mjs [screen ...]
 *
 * Each screen is one 1280 x 800 viewport at twice the device scale, written to
 * docs/images/<screen>.png, or .jpg for a screen with a map: a basemap
 * compresses badly as PNG, and at 2x one ran over 500 KiB. A viewport rather
 * than the full page keeps each image to what a reader takes in at once.
 */
import { mkdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const BASE = 'http://127.0.0.1:8130'
const OUT = fileURLToPath(new URL('../../docs/images/', import.meta.url))

/**
 * The reference fixture, 2026-08-28, the run the documentation is written
 * against. Found by its start rather than its id: the demo store ingests the
 * fixtures under its own athlete, so their ids differ from the fixture
 * store's.
 */
async function referenceRun() {
  const response = await fetch(`${BASE}/api/activities?limit=200&start=2026-08-28&end=2026-08-28`)
  const page = await response.json()
  const run = page.items.find((item) => item.start_time_utc === '2026-08-28T18:19:14Z')
  if (run === undefined) throw new Error('the reference fixture run is not in this store')
  return run.activity_id
}

/** The demo store's busiest route, read from the server rather than named. */
async function busiestRoute() {
  const response = await fetch(`${BASE}/api/routes`)
  const routes = await response.json()
  const items = Array.isArray(routes) ? routes : routes.items
  if (!items?.length) throw new Error('the store has no routes: is it the demo store?')
  return items.reduce((best, route) => (route.run_count > best.run_count ? route : best)).route_id
}

/**
 * Each screen's path; whether it draws a map, which loads after the page
 * settles, since the map's own style switch appears only once MapLibre has
 * fired `load`; and the section heading to scroll to the top first, when
 * the view's opening section is not the one worth showing.
 */
const SCREENS = {
  // The view's reason for existing, rather than the VO2max chart it opens on.
  trends: { path: () => '/trends', section: 'Heart rate at the reference paces' },
  overview: { path: () => '/' },
  activity: { path: async () => `/activities/${await referenceRun()}`, map: true },
  progression: { path: () => '/progression?distance=5k' },
  route: { path: async () => `/routes/${await busiestRoute()}`, map: true },
  // The demo's runs are a few fixture loops, so distance comes in clumps;
  // pace spreads, and the years show the trend.
  distributions: { path: () => '/distributions?variable=pace&compare=years' },
  territory: { path: () => '/territory', map: true },
}

const wanted = process.argv.slice(2)
const names = wanted.length > 0 ? wanted : Object.keys(SCREENS)

await mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
})
const page = await context.newPage()

for (const name of names) {
  const screen = SCREENS[name]
  if (screen === undefined) {
    console.error(`unknown screen: ${name}`)
    process.exitCode = 1
    continue
  }
  await page.goto(`${BASE}${await screen.path()}`, { waitUntil: 'networkidle' })
  if (screen.map) {
    await page.getByRole('radiogroup', { name: 'Map style' }).first().waitFor({ timeout: 60_000 })
  }
  if (screen.section) {
    const heading = page.getByRole('heading', { name: screen.section, exact: true })
    await heading.evaluate((node) => window.scrollBy(0, node.getBoundingClientRect().top - 32))
  }
  // uPlot draws on a mount effect after its ResizeObserver first fires, and
  // the map's tiles fade in, so `networkidle` alone can catch either mid-draw.
  await page.waitForTimeout(2000)
  const file = `${OUT}${name}.${screen.map ? 'jpg' : 'png'}`
  await page.screenshot(screen.map ? { path: file, type: 'jpeg', quality: 85 } : { path: file })
  console.log(`${file} ${Math.round((await stat(file)).size / 1024)} KiB`)
}

await browser.close()
