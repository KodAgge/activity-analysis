import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

/**
 * The browser suite for `/territory`, against the fixture store, whose five
 * loop runs claim ground in one region.
 *
 * Every test reads `/api/territory` first and skips, naming the endpoint,
 * when it serves no regions - a store recomputed before the territory
 * tables existed - as `distributions.spec.ts` guards on its own endpoint.
 * Figures are read from that payload rather than pinned, for the reason
 * `smoke.spec.ts` gives.
 *
 * The map reaches MapLibre's `load` whether or not `activity-analysis
 * tiles` has run: with no fetched area its style is a background alone,
 * and the ground still draws on it. The suite's store has the one stand-in
 * area `scripts/e2e-api-server.mjs` installs.
 */

// Each test waits for MapLibre's `load`, which on a cold dev server first
// pays for its chunk and worker; see the allowance in `basemap.spec.ts`.
test.describe.configure({ timeout: 90_000 })

interface Payload {
  total_area_m2: number
  regions: { region_id: string; name: string }[]
}

async function territory(page: Page): Promise<Payload> {
  return (await (await page.request.get('/api/territory')).json()) as Payload
}

const NEEDS_REGIONS = 'needs claimed ground a recompute has not written; /api/territory serves no regions on this store'

/** Navigates and waits for the map's `load`, after which its style switch appears. */
async function openSettled(page: Page, path = '/territory'): Promise<void> {
  await page.goto(path)
  await page.getByRole('heading', { level: 1, name: 'Territory' }).waitFor()
  await page.getByRole('radiogroup', { name: 'Map style' }).waitFor({ timeout: 30_000 })
  await page.waitForLoadState('networkidle')
}

test('states the total, draws the map of the largest place and moves to another', async ({ page }) => {
  const payload = await territory(page)
  test.skip(payload.regions.length === 0, NEEDS_REGIONS)
  await openSettled(page)

  const total = (payload.total_area_m2 / 1e6).toFixed(2)
  await expect(page.getByText('Claimed ground', { exact: true }).locator('xpath=..')).toContainText(`${total} km²`)

  const largest = payload.regions[0]
  if (largest === undefined) throw new Error('unreachable')
  await expect(page.getByRole('img', { name: `Map of the ground claimed in ${largest.name}` })).toBeVisible()

  const places = page.getByRole('group', { name: 'Place' }).getByRole('radio')
  await expect(places).toHaveCount(payload.regions.length > 1 ? payload.regions.length : 0)
  const second = payload.regions[1]
  if (second === undefined) return
  await page.getByRole('group', { name: 'Place' }).getByText(second.name, { exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`region=${second.region_id}`))
  await expect(page.getByRole('img', { name: `Map of the ground claimed in ${second.name}` })).toBeVisible()
})

test('draws the growth chart', async ({ page }) => {
  test.skip((await territory(page)).regions.length === 0, NEEDS_REGIONS)
  await openSettled(page)
  const growth = page.getByRole('img', { name: /^Claimed ground after each of \d+ claiming runs/ })
  await expect(growth.locator('canvas')).toHaveCount(1)
})

for (const width of [360, 412]) {
  test.describe(`at phone width ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true })

    test('does not scroll sideways, and reaches Territory through More', async ({ page }) => {
      test.skip((await territory(page)).regions.length === 0, NEEDS_REGIONS)
      await openSettled(page)
      const overflow = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])
      expect(overflow[0], `/territory scrolls sideways at ${String(width)}px`).toBeLessThanOrEqual(overflow[1] ?? 0)

      const nav = page.getByRole('navigation', { name: 'Views' })
      await expect(nav.getByRole('link', { name: 'Territory' })).toBeHidden()
      await page.goto('/')
      await nav.getByRole('button', { name: 'More' }).click()
      await nav.getByRole('link', { name: 'Territory' }).click()
      await expect(page).toHaveURL(/\/territory/)
      await expect(nav.getByRole('link', { name: 'Territory' })).toBeHidden()
    })
  })
}
