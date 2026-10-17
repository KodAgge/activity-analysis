/**
 * Phone-viewport screenshot harness for the Strava-bar design work.
 *
 * Not part of `npm run check`: this is a design tool, not a test. It drives
 * the same Playwright the e2e suite uses, against the dev server that must
 * already be running, and writes one full-page PNG per named screen so a
 * critic can put ours beside Strava's at the same pixel width.
 *
 * Usage: node scripts/shoot.mjs [out-dir] [screen ...]
 *
 * The out-dir defaults to `web/.design-work/screens`, resolved against this
 * file rather than the working directory. The captures show whatever store
 * the dev server's API serves, which can be a real athlete's runs, and that
 * directory is gitignored. `SHOOT_BASE` points it at another dev server,
 * such as the end-to-end suite's over the fixture store.
 *
 * Full page by default. `--viewport` captures one phone screen's worth
 * instead, which is the only way to see a fixed bottom tab bar: a full-page
 * capture scrolls past it and it lands nowhere in the image.
 */
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, devices } from '@playwright/test'

const BASE = process.env.SHOOT_BASE ?? 'http://localhost:5173'

/**
 * The reference activity: 7456.06 m on 2026-08-28, the run CLAUDE.md quotes
 * and the one the fixture documentation is written against.
 *
 * The id this file named first was of a short run with no GPS, so every
 * capture taken through it was of the no-route absence state rather than
 * of the screen. Content identity is derived from the athlete and the start
 * minute, so an id is only ever verifiable against a running store:
 * `/api/activities/<id>` reports the distance and the start, and that is
 * the check worth doing before trusting an id copied from anywhere.
 */
const REFERENCE_ACTIVITY = '854fd775d479ca9f'

const SCREENS = {
  overview: '/',
  activities: '/activities',
  detail: `/activities/${REFERENCE_ACTIVITY}`,
  records: '/records',
  trends: '/trends',
  progression: '/progression?distance=5k',
}

const args = process.argv.slice(2).filter((arg) => arg !== '--viewport')
const fullPage = !process.argv.includes('--viewport')
const outDir = args[0] ?? fileURLToPath(new URL('../.design-work/screens', import.meta.url))
const wanted = args.slice(1)
const screens = wanted.length > 0 ? wanted : Object.keys(SCREENS)

await mkdir(outDir, { recursive: true })

const browser = await chromium.launch()
const context = await browser.newContext({
  ...devices['Pixel 7'],
  // Strava's own screenshots here are 1080 CSS px wide at 3x; matching the
  // scale factor rather than the device's default keeps text weight
  // comparable when the two are put side by side.
  deviceScaleFactor: 3,
})
const page = await context.newPage()

for (const name of screens) {
  const path = SCREENS[name]
  if (path === undefined) {
    console.error(`unknown screen: ${name}`)
    process.exitCode = 1
    continue
  }
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
  // uPlot draws on a mount effect after its ResizeObserver first fires, so
  // `networkidle` alone can catch a chart mid-blank.
  await page.waitForTimeout(1200)
  // A full-page capture stitches the viewport as it scrolls, so a fixed
  // element paints once, at the bottom of the *first* viewport, and lands in
  // the middle of the finished image. On a long page the tab bar therefore
  // appears to cut the content in half - an artefact of the capture that a
  // reader of the image cannot distinguish from a layout fault. Hiding it
  // shifts nothing, because the scroll container reserves its height as
  // padding rather than relying on the bar's own box. Use `--viewport` when
  // the bar itself is the subject.
  if (fullPage) {
    await page.locator('nav[aria-label="Views"]').evaluateAll((nodes) => {
      for (const node of nodes) node.style.display = 'none'
    })
  }
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage })
  console.log(`${outDir}/${name}.png`)
}

await browser.close()
