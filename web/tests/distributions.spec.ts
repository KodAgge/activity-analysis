import type { Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { VARIABLES } from '../src/charts/distributionVariables'

/**
 * The browser suite for `/distributions`.
 *
 * Every test reads `/api/distributions` first and skips, naming the
 * endpoint, when it serves no runs, the way `phase4.spec.ts` guards on its
 * own endpoints: a store that has not been recomputed skips rather than
 * fails. Counts are computed from that live payload rather than pinned, for
 * the reason `smoke.spec.ts` gives.
 *
 * The phone tests run at 412px, the width `docs/reference/frontend.md`
 * measures the other views' phone layouts at. The sideways-scroll check
 * runs at 360px as well, and the tab-bar check at 360, 390 and 412px.
 */

interface PayloadRun {
  activity_id: string
  start_time_utc: string
  utc_offset_s: number | null
}

async function distributionRuns(page: Page): Promise<PayloadRun[]> {
  const body = (await (await page.request.get('/api/distributions')).json()) as { runs?: PayloadRun[] }
  return body.runs ?? []
}

const NEEDS_RUNS = 'needs runs a recompute has not written; /api/distributions serves none on this store'

/**
 * Navigates and waits for the chart, not just the frame around it: the
 * store-stale banner arrives after the first paint and moves everything
 * below it, for the reason `phase4.spec.ts`'s `openSettled` records.
 */
async function openSettled(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await page.getByRole('heading', { level: 1, name: 'Distributions' }).waitFor()
  // The controls render only once the runs have arrived; the heading is
  // there from the first paint. Under the whole suite's parallel load the
  // network could go idle before that render, and a measurement then found
  // no segmented controls at all.
  await page.getByRole('combobox', { name: 'Variable' }).waitFor()
  await page.waitForLoadState('networkidle')
}

async function documentOverflow(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: Math.round(document.documentElement.scrollWidth),
    clientWidth: document.documentElement.clientWidth,
  }))
}

/** The local calendar year of a run, the `localParts` rule: UTC shifted by the recorded offset, null as zero. */
function localYear(run: PayloadRun): number {
  return new Date(Date.parse(run.start_time_utc) + (run.utc_offset_s ?? 0) * 1000).getUTCFullYear()
}

/**
 * The index and value of the bucket holding the most runs, read from the
 * chart's own options. The canvas says nothing to the DOM; the visually
 * hidden options name each bucket and its bar, `5 to 6: All runs 42`.
 */
async function fullestBucket(chart: Locator): Promise<{ index: number; runs: number }> {
  const texts = await chart.getByRole('option').allTextContents()
  let best = { index: -1, runs: -1 }
  texts.forEach((text, index) => {
    const runs = Number(/(\d+)\s*$/.exec(text)?.[1] ?? '0')
    if (runs > best.runs) best = { index, runs }
  })
  if (best.index === -1) throw new Error('the chart has no bucket options')
  return best
}

/**
 * Taps the middle of bucket `index`'s slot. The x scale gives each of the
 * `count` buckets an equal slot across the plot, with half a slot of air at
 * either end (see `barScaleRange`), so slot i is centred at (i + 0.5) / count.
 */
async function tapBucket(page: Page, chart: Locator, index: number): Promise<void> {
  const count = await chart.getByRole('option').count()
  const plot = await chart.locator('.u-over').boundingBox()
  if (plot === null) throw new Error('the histogram has no plot area')
  await page.touchscreen.tap(plot.x + ((index + 0.5) / count) * plot.width, plot.y + plot.height * 0.9)
}

function radio(page: Page, group: string, name: string): Locator {
  return page.getByRole('group', { name: group }).getByRole('radio', { name })
}

/**
 * Each visible tab's label against the box it is given: a label cut to an
 * ellipsis has a `scrollWidth` wider than its `clientWidth`. A phone shows
 * four links and the More button; the three links behind More are hidden
 * until it is opened.
 */
async function tabLabels(page: Page): Promise<{ text: string; scrollWidth: number; clientWidth: number }[]> {
  return page
    .getByRole('navigation', { name: 'Views' })
    .locator('a:visible, button:visible')
    .evaluateAll((links) =>
      links.map((link) => {
        const label = [...link.querySelectorAll('span')].at(-1)
        return { text: label?.textContent ?? '', scrollWidth: label?.scrollWidth ?? 0, clientWidth: label?.clientWidth ?? 0 }
      }),
    )
}

for (const width of [360, 390, 412]) {
  test.describe(`the tab bar at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true })

    // The current tab's label is set bold, which is wider, so More is
    // measured while current, on both of the views behind it here.
    for (const path of ['/distributions?variable=distance', '/progression']) {
      test(`shows all five labels in full on ${path}`, async ({ page }) => {
        await page.goto(path)
        await page.getByRole('heading', { level: 1 }).waitFor()
        await page.waitForLoadState('networkidle')
        const labels = await tabLabels(page)
        expect(labels.map((label) => label.text)).toEqual(['Overview', 'Activities', 'Records', 'Trends', 'More'])
        for (const label of labels) {
          expect(label.scrollWidth, `"${label.text}" is cut short at ${String(width)}px`).toBeLessThanOrEqual(
            label.clientWidth,
          )
        }
      })
    }
  })
}

for (const width of [360, 412]) {
  test.describe(`at phone width ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 915 }, hasTouch: true, isMobile: true })

    test('no variable and no comparison scrolls the page sideways, and the segmented rows stay on one line', async ({
      page,
    }) => {
      test.skip((await distributionRuns(page)).length === 0, NEEDS_RUNS)
      // Nineteen settled page loads, about 1.5 s each on this machine.
      test.setTimeout(120_000)

      const pages = [
        ...VARIABLES.map((v) => `/distributions?variable=${v.id}`),
        // The comparisons add controls, and `periods` adds a whole second period picker.
        ...['periods', 'days', 'surface', 'years'].map((c) => `/distributions?variable=cadence_at_reference&compare=${c}`),
      ]
      for (const path of pages) {
        await openSettled(page, path)
        const overflow = await documentOverflow(page)
        expect(overflow.scrollWidth, `${path} scrolls sideways at ${String(width)}px`).toBeLessThanOrEqual(overflow.clientWidth)

        // A wrapped segmented control reads as two controls. Each segment's
        // top edge, measured, has to agree with the first one's.
        for (const legend of ['Bars', 'Days']) {
          const tops = await page
            .getByRole('group', { name: legend })
            .locator('label')
            .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)))
          expect(tops.length, `${legend} has segments on ${path}`).toBeGreaterThan(1)
          expect(new Set(tops).size, `${legend} wrapped onto a second line on ${path}`).toBe(1)
        }
      }
    })
  })
}

test.describe('at phone width', () => {
  test.use({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true })

  test('tapping a bucket selects it, lists its runs, and every row opens an activity', async ({ page }) => {
    test.skip((await distributionRuns(page)).length === 0, NEEDS_RUNS)

    await openSettled(page, '/distributions?variable=distance')
    const chart = page.getByRole('listbox', { name: /^Distance, runs per bucket$/ })
    await chart.locator('canvas').waitFor()
    await chart.scrollIntoViewIfNeeded()
    const { index, runs } = await fullestBucket(chart)
    expect(runs).toBeGreaterThan(0)

    await tapBucket(page, chart, index)

    await expect(chart.getByRole('option').nth(index)).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => new URL(page.url()).searchParams.get('bucket')).not.toBeNull()

    // One row per run in the bucket, each a link to that run's activity.
    const rows = page.locator('main a[href^="/activities/"]')
    await expect(rows).toHaveCount(runs)
    const hrefs = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? ''))
    for (const href of hrefs) expect(href).toMatch(/^\/activities\/[0-9a-f]{16}$/)

    await rows.first().tap()
    await page.waitForURL(`**${hrefs[0] ?? ''}`)
  })

  test('tapping the selected bucket again clears the selection', async ({ page }) => {
    test.skip((await distributionRuns(page)).length === 0, NEEDS_RUNS)

    await openSettled(page, '/distributions?variable=distance')
    const chart = page.getByRole('listbox', { name: /^Distance, runs per bucket$/ })
    await chart.locator('canvas').waitFor()
    await chart.scrollIntoViewIfNeeded()
    const { index } = await fullestBucket(chart)

    await tapBucket(page, chart, index)
    await expect.poll(() => new URL(page.url()).searchParams.get('bucket')).not.toBeNull()
    await tapBucket(page, chart, index)
    await expect.poll(() => new URL(page.url()).searchParams.get('bucket')).toBeNull()
    await expect(page.locator('main a[href^="/activities/"]')).toHaveCount(0)
  })
})

test('compare=years draws one chart per year the payload holds', async ({ page }) => {
  const runs = await distributionRuns(page)
  test.skip(runs.length === 0, NEEDS_RUNS)
  const years = [...new Set(runs.map(localYear))].sort((a, b) => a - b)

  await openSettled(page, '/distributions?variable=distance&compare=years')
  const charts = page.getByRole('listbox')
  await expect(charts).toHaveCount(years.length)
  // One per year, oldest first, each named for its year.
  const names = await charts.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''))
  expect(names).toEqual(years.map((year) => `Distance, ${String(year)}`))
})

test('a bare /distributions redirects to the default variable', async ({ page }) => {
  await page.goto('/distributions')
  await page.waitForURL('**/distributions?variable=distance')
})

test('the state chosen through the controls lives in the URL and survives a reload', async ({ page }) => {
  test.skip((await distributionRuns(page)).length === 0, NEEDS_RUNS)

  await openSettled(page, '/distributions?variable=distance')
  await page.getByLabel('Variable').selectOption('cadence_at_reference')
  await page.getByLabel('Compare').selectOption('periods')
  await radio(page, 'Bars', 'Kilometres').check({ force: true })
  await expect.poll(() => new URL(page.url()).searchParams.get('measure')).toBe('distance')

  // A bucket, chosen with the keyboard: the first chart is the overlay of
  // both periods, the first arrow after focus shows its first bucket, and
  // Enter selects it.
  const chart = page.getByRole('listbox').first()
  await chart.locator('canvas').waitFor()
  await chart.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Enter')
  await expect.poll(() => new URL(page.url()).searchParams.get('bucket')).not.toBeNull()

  const before = new URL(page.url()).searchParams
  expect(before.get('variable')).toBe('cadence_at_reference')
  expect(before.get('compare')).toBe('periods')
  // Comparing two periods from all time starts from the last 12 months.
  expect(before.get('period')).toBe('last_12_months')

  await page.reload()
  await page.getByRole('heading', { level: 1, name: 'Distributions' }).waitFor()
  await page.waitForLoadState('networkidle')

  const after = new URL(page.url()).searchParams
  expect([...after.entries()].sort()).toEqual([...before.entries()].sort())
  await expect(page.getByLabel('Variable')).toHaveValue('cadence_at_reference')
  await expect(page.getByLabel('Compare')).toHaveValue('periods')
  await expect(radio(page, 'Bars', 'Kilometres')).toBeChecked()
  const selected = page.getByRole('listbox').first().locator('[role="option"][aria-selected="true"]')
  await expect(selected).toHaveCount(1)
})
