import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { distanceKeyLabel } from '../src/format'

/**
 * The browser suite for the phase 4 views, `/trends` and `/progression`.
 *
 * ## What runs, and what guards itself
 *
 * All four phase 4 endpoints serve rows on the fixture store the suite runs
 * against, so every test here runs except one: the test asserting the
 * absence states skips itself by name, because it needs a store with **no**
 * phase 4 rows and this one has them.
 *
 * The tests that read `/api/trends`, `/api/fitness` or
 * `/api/progression/{distance_key}` still guard on exactly the endpoints
 * their own assertions read, and skip naming which was empty, so a store
 * that has not been recomputed skips rather than fails.
 *
 * Figures are fetched live rather than pinned, for the reason
 * `smoke.spec.ts` gives: the phase 4 tables grow with every recompute.
 */

/**
 * Which of the phase 4 endpoints actually carry rows, so a test can skip on
 * exactly the ones its own assertions read and say which was empty.
 *
 * Guarding on the wrong endpoint is not hypothetical here: the efficiency
 * fits and the fitness series fill different tables, so `/api/trends` can
 * carry rows while `/api/fitness` is still empty. A test that counts five
 * canvases and looks
 * for the VO2max caveat, but skips only on `/api/trends`, un-skips in that
 * window and fails with four canvases and no caveat, because `Trends`
 * renders `Absent` in place of the chart when the fitness payload is empty.
 */
async function emptyEndpoints(page: Page, paths: readonly string[]): Promise<string[]> {
  const empty: string[] = []
  for (const path of paths) {
    const body = (await (await page.request.get(path)).json()) as { items?: unknown[] }
    if ((body.items ?? []).length === 0) empty.push(path)
  }
  return empty
}

/** The skip reason, naming the endpoints that are still empty rather than skipping bare. */
function needsRows(empty: string[]): string {
  return `needs rows a recompute has not written; still empty on this store: ${empty.join(', ')}`
}

async function progressionRows(page: Page, key: string): Promise<{ items: { activity_id: string; is_record: boolean; is_eligible: boolean; elapsed_time_s: number }[]; effort_count: number; eligible_count: number }> {
  return (await (await page.request.get(`/api/progression/${key}`)).json()) as never
}

/** The distances `/api/records` lists, shortest first - the picker's own source. */
async function recordDistanceKeys(page: Page): Promise<string[]> {
  const records = (await (await page.request.get('/api/records')).json()) as { items: { distance_key: string }[] }
  return records.items.map((r) => r.distance_key)
}

/**
 * Navigates and waits for the page to stop moving under the pointer.
 *
 * `AppShell`'s store-stale banner is rendered from the `/api/health`
 * response, so it arrives after the first paint and inserts a multi-line
 * alert above `<main>`: measured in Chromium at 390px, the chart's first
 * point moved down 140px when it appeared. A test that locates a point and
 * then hovers it can have the point slide out from under the pointer in
 * between, and the hover-only readout then never appears at all. This is
 * the same trap `smoke.spec.ts` records for its own overflow test - wait
 * for the content, not just for the frame around it.
 */
async function openSettled(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await page.locator('h1').first().waitFor()
  await page.waitForLoadState('networkidle')
}

/**
 * Waits until `document.querySelectorAll(selector)`'s count is at least
 * `minimum` and unchanged across two consecutive animation frames - "every
 * chart on the screen has settled", read from outside, without this caller
 * having to know how many charts there are or find each one's own `Absent`
 * message to confirm it rendered instead of a legend.
 *
 * Not a fixed count: how many of a given kind of element the settled page
 * carries can be a fact about the store rather than about the page (see
 * the trend-legend test below), and asserting an exact number here would
 * make this helper hang for the full timeout on a store where that number
 * is legitimately different.
 */
async function waitForStableCount(page: Page, selector: string, minimum: number): Promise<void> {
  await page.waitForFunction(
    ({ selector, minimum }) => {
      const state = window as typeof window & { __stableCount?: number }
      const count = document.querySelectorAll(selector).length
      if (count < minimum) {
        state.__stableCount = undefined
        return false
      }
      const stable = state.__stableCount === count
      state.__stableCount = count
      return stable
    },
    { selector, minimum },
    { polling: 'raf' },
  )
}

/**
 * The hover readout's box, or null when it is not on the page.
 *
 * Read in one `evaluate` rather than through a locator, because
 * `Locator.boundingBox()` *waits* for a missing element instead of
 * reporting its absence: polling it would block on the inner call for the
 * whole action timeout rather than retrying. The readout is hover-only and
 * unmounts the moment the pointer leaves, so "absent right now" is an
 * ordinary state a caller has to be able to see and retry on.
 */
async function readoutBox(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="progression-readout"]')
    if (el === null) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
}

async function documentOverflow(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: Math.round(document.documentElement.scrollWidth),
    clientWidth: document.documentElement.clientWidth,
  }))
}

/**
 * The distance picker.
 *
 * It used to be a `<select>`, and is now a `<fieldset>` of radio chips -
 * one of a set is exactly what a distance is, and native radios give
 * arrow-key navigation, a group name and a checked state without a line of
 * JavaScript. A `<legend>` names the `<fieldset>`, which is a `group` in
 * the accessibility tree, so `getByLabel('Distance')` no longer resolves to
 * anything: a group is not a labelled control.
 */
function distancePicker(page: Page) {
  return page.getByRole('group', { name: 'Distance' })
}

/** The distance the picker is actually showing as chosen. */
function chosenDistance(page: Page) {
  return distancePicker(page).getByRole('radio', { checked: true })
}

/** `#bd1f44` as the browser reports a computed colour. */
function hexToRgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return `rgb(${String(r)}, ${String(g)}, ${String(b)})`
}

// ---------------------------------------------------------------------------
// Hold on any store.
// ---------------------------------------------------------------------------

test('the nav links both phase 4 views, and the progression link carries its default distance', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Trends' }).click()
  await page.waitForURL('**/trends')
  await expect(page.getByRole('heading', { level: 1, name: 'Trends' })).toBeVisible()

  await page.getByRole('link', { name: 'Progression' }).click()
  await page.waitForURL('**/progression?distance=5k')
  await expect(page.getByRole('heading', { level: 1, name: 'Progression' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Progression' })).toHaveAttribute('aria-current', 'page')
})

test('a bare /progression redirects to the default distance, so the address bar says what the chart shows', async ({ page }) => {
  await page.goto('/progression')
  await page.waitForURL('**/progression?distance=5k')
  await expect(chosenDistance(page)).toHaveValue('5k')
})

test('the distance picker lists exactly the distances with records, and never marathon', async ({ page }) => {
  const keys = await recordDistanceKeys(page)
  expect(keys.length).toBeGreaterThan(0)
  // The premise of the whole picker: the extractor knows marathon, the
  // store has no effort at it (no run is that long), so `/api/records`
  // does not list it.
  expect(keys).not.toContain('marathon')

  await page.goto('/progression?distance=5k')
  const picker = distancePicker(page)
  // The chips carry the labels and the radios inside them carry the keys,
  // so both halves of "exactly the distances with records" are asserted:
  // the keys the control will navigate to, in the endpoint's own order, and
  // the words a reader picks between.
  await expect(picker.getByRole('radio')).toHaveCount(keys.length)
  const values = await picker
    .getByRole('radio')
    .evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value))
  expect(values).toEqual(keys)
  await expect(picker.locator('label')).toHaveText(keys.map(distanceKeyLabel))
})

test('switching the distance changes the URL and the counts', async ({ page }) => {
  const keys = await recordDistanceKeys(page)
  const other = keys.find((k) => k !== '5k')
  if (other === undefined) throw new Error('fixture assumption: the store has records at more than one distance')
  const five = await progressionRows(page, '5k')
  const next = await progressionRows(page, other)

  await page.goto('/progression?distance=5k')
  // The counts moved into the chart section's own caption, which leads with
  // the fact a reader needs before the numbers mean anything - the axis is
  // inverted, so an improvement descends. The distance left the caption
  // because it is the section's title now.
  const counts = page.getByText(/efforts, \d+ eligible/)
  await expect(counts).toContainText(`${String(five.effort_count)} efforts`)

  // The pill, not the radio inside it. The input is clipped to 1px so the
  // keyboard still drives the group natively, which means its own `<label>`
  // is what a pointer lands on - and a pointer landing on the pill is what
  // a reader does. Identified by the radio it contains rather than by its
  // text, because the labels are substrings of one another: `5 km` is
  // inside `15 km`.
  await distancePicker(page)
    .locator('label')
    .filter({ has: page.locator(`input[value="${other}"]`) })
    .click()

  await expect.poll(() => new URL(page.url()).searchParams.get('distance')).toBe(other)
  await expect(counts).toContainText(`${String(next.effort_count)} efforts`)
})

test('a distance the store has no efforts at is a stated absence, not an empty chart', async ({ page }) => {
  await page.goto('/progression?distance=marathon')
  await expect(page.getByRole('note')).toContainText('No efforts at Marathon')
  await expect(page.locator('svg[role="img"]')).toHaveCount(0)
  // The picker lists the distances `/api/records` has rows for, and
  // marathon is not one of them - so the view appends the URL's own key
  // rather than showing a chosen chip that is not there. The control and
  // the address bar have to agree even when the address bar is wrong.
  await expect(chosenDistance(page)).toHaveValue('marathon')
})

test('on a store with no phase 4 rows, both views state the absence in words', async ({ page }) => {
  // The mirror of the row-dependent guards, and it needs the same care: this
  // asserts both absence notes and zero canvases, so it holds only while
  // *both* endpoints are empty. Guarded on `/api/trends` alone it would run
  // with a filled `/api/fitness` and fail on the missing VO2max note.
  const empty = await emptyEndpoints(page, ['/api/trends', '/api/fitness'])
  test.skip(
    empty.length < 2,
    `the phase 4 tables have rows now (${['/api/trends', '/api/fitness'].filter((p) => !empty.includes(p)).join(', ')}); the absence state is covered by the unit tests`,
  )

  await page.goto('/trends')
  const notes = page.getByRole('note')
  await expect(notes.filter({ hasText: /No efficiency fit/ })).toBeVisible()
  await expect(notes.filter({ hasText: /No VO2max/ })).toBeVisible()
  await expect(page.locator('canvas')).toHaveCount(0)
})

test('neither phase 4 page scrolls sideways at the width that caught the previous branch', async ({ page }) => {
  // 606px is the header's old intrinsic floor (see `smoke.spec.ts`); 390px
  // is a phone in portrait.
  for (const width of [606, 390]) {
    await page.setViewportSize({ width, height: 900 })
    for (const path of ['/trends', '/progression?distance=5k']) {
      await page.goto(path)
      await page.locator('h1').first().waitFor()
      await page.waitForLoadState('networkidle')
      const overflow = await documentOverflow(page)
      expect(overflow.scrollWidth, `${path} at ${String(width)}px scrolls sideways`).toBeLessThanOrEqual(
        overflow.clientWidth,
      )
    }
  }
})

// ---------------------------------------------------------------------------
// Need real rows; skip, by name, until plans 008 and 009 have landed.
// ---------------------------------------------------------------------------

test('/trends draws all three reference-pace series and the model-output caveat is visible', async ({ page }) => {
  // Both endpoints: the legend and the canvas count come from `/api/trends`,
  // the fifth canvas and the caveat from `/api/fitness`.
  const empty = await emptyEndpoints(page, ['/api/trends', '/api/fitness'])
  test.skip(empty.length > 0, needsRows(empty))
  const trends = (await (await page.request.get('/api/trends')).json()) as {
    references: { slow_mps: number; median_mps: number; fast_mps: number }
  }

  await page.goto('/trends')
  const hrLegend = page.getByRole('list', { name: 'Heart rate at the reference paces legend' })
  // Four entries: three smoothed lines plus the one raw scatter for the
  // median reference, which is there so the smoothing cannot hide its own
  // inputs. Three scatters behind three lines would rebuild the band.
  await expect(hrLegend.getByRole('listitem')).toHaveCount(4)
  await expect(hrLegend.getByText(/per run/)).toHaveCount(1)
  // The labels are paces computed from the payload's own reference speeds.
  for (const mps of [trends.references.slow_mps, trends.references.median_mps, trends.references.fast_mps]) {
    const seconds = Math.round(1000 / mps)
    const label = `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}/km`
    // Exact: the median label also appears inside the scatter's own
    // "<pace>/km, per run" entry, so a substring match resolves to two.
    await expect(hrLegend.getByText(label, { exact: true })).toBeVisible()
  }
  await expect(page.getByText(/level is a model output/i)).toBeVisible()
  // Four charts, not five: VO2max, heart rate, cadence and decoupling. The
  // cadence slope states its finding and draws nothing, because the
  // quantity does not trend - see `docs/reference/frontend.md`.
  await expect(page.locator('canvas')).toHaveCount(4)
})

test('the decoupling chart draws its 5% durability line and names its population', async ({ page }) => {
  const empty = await emptyEndpoints(page, ['/api/trends'])
  test.skip(empty.length > 0, needsRows(empty))

  await page.goto('/trends')
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Aerobic decoupling' }) })
  await section.locator('canvas').waitFor()

  // The rule is drawn and named, rather than left as an unexplained
  // horizontal line that reads as a second series drawn flat.
  await expect(section.getByText('5% durability')).toBeVisible()
  // And the population is stated, because this is the only series on the
  // page sampled on a population of its own.
  await expect(section.getByText(/easy or steady runs of 40 minutes or more/i)).toBeVisible()
})

test('every trend line on the screen is drawn at one width, so weight never encodes an ordering', async ({ page }) => {
  const empty = await emptyEndpoints(page, ['/api/trends', '/api/fitness'])
  test.skip(empty.length > 0, needsRows(empty))

  await openSettled(page, '/trends')

  // Read off the legend swatches, which carry the same width the canvas
  // strokes: weight used to encode the ordering - a 1px line against a
  // 2.4px one for two positions on one ordinal scale - and no longer does.
  //
  // **Across every trend legend on the page, not the cadence one alone.**
  // The reference-pace charts now draw their outer two series as an
  // envelope rather than as lines, so that chart contributes one line
  // swatch where it used to contribute three, and asking a single chart for
  // three would be asking for an encoding the screen deliberately dropped.
  // The claim is unchanged and is now tested over more of the screen: the
  // VO2max chart's two smoothed series, Garmin's own line when a Garmin
  // export is ingested, the decoupling line and the two reference-pace
  // subjects are five or six lines across four charts, and no two of them
  // may differ in weight.
  const SWATCH_SELECTOR = 'ul[aria-label$="legend"] span[style*="border-top-width"]'
  const swatches = page.locator(SWATCH_SELECTOR)
  // `openSettled` waits for the network, not for React to have committed
  // every chart's own legend, and the four charts render on their own
  // schedule as their queries land - reading widths right after only the
  // first swatch existed caught this mid-mount and undercounted (seen
  // directly: two swatches instead of the settled page's five).
  //
  // Not a fixed `toHaveCount(5)`, though: how many swatches the settled
  // page carries is a fact about the store, not the page.
  // `TrendChart.tsx` renders `Absent` with no legend at all when a chart
  // has no values, and the decoupling chart's population - easy or steady
  // runs of 40 minutes or more with a decoupling average (`Trends.tsx`) -
  // is a data-dependent subset that a recompute can empty. `toHaveCount(5)`
  // would then hang for the full timeout on a store the old, looser
  // `>= 3` check tolerated just fine. Waiting for the count to stop moving
  // instead needs no fixed number: two consecutive animation frames
  // reporting the same swatch count is what "every chart has either
  // rendered its legend or its own `Absent`" looks like from outside.
  await waitForStableCount(page, SWATCH_SELECTOR, 3)
  const widths = await swatches.evaluateAll((els) => els.map((el) => getComputedStyle(el).borderTopWidth))
  expect(widths.length).toBeGreaterThanOrEqual(3)
  expect(new Set(widths).size).toBe(1)
})

test('hovering a trend chart leaves its height unchanged', async ({ page }) => {
  // The heart rate chart is `/api/trends` alone, but the page it is measured
  // on renders the VO2max chart too, and a height assertion wants the whole
  // page in its filled state.
  const empty = await emptyEndpoints(page, ['/api/trends', '/api/fitness'])
  test.skip(empty.length > 0, needsRows(empty))

  await openSettled(page, '/trends')
  const chart = page.getByRole('img', { name: 'Heart rate at the reference paces' })
  await chart.locator('canvas').waitFor()
  // The heart rate chart is the third section now rather than the first, so
  // it sits below the fold: `boundingBox` reports page coordinates while
  // `mouse.move` takes viewport ones, and without this the pointer went to
  // a point that was over nothing and the readout never appeared. Same
  // class of trap as `openSettled`'s own, one scroll position further on.
  await chart.scrollIntoViewIfNeeded()
  await page.waitForTimeout(250)
  const before = await chart.boundingBox()
  if (before === null) throw new Error('the heart rate chart has no box')

  const over = chart.locator('.u-over')
  const plot = await over.boundingBox()
  if (plot === null) throw new Error('the heart rate chart has no plot area')
  await page.mouse.move(plot.x + plot.width * 0.5, plot.y + plot.height * 0.5)
  await expect(page.getByTestId('trend-readout')).toBeVisible()

  const after = await chart.boundingBox()
  expect(after?.height).toBe(before.height)
})

test('/progression renders its records in the accent colour, lower than slower efforts', async ({ page }) => {
  const five = await progressionRows(page, '5k')
  test.skip(five.items.length === 0, needsRows(['/api/progression/5k']))
  const record = five.items.find((p) => p.is_record)
  const slower = five.items.find((p) => p.is_eligible && !p.is_record && record !== undefined && p.elapsed_time_s > record.elapsed_time_s)
  if (record === undefined || slower === undefined) throw new Error('fixture assumption: 5 km has a record and a slower eligible effort')

  await openSettled(page, '/progression?distance=5k')
  const recordPoint = page.locator(`circle[data-activity-id="${record.activity_id}"]`)
  const slowerPoint = page.locator(`circle[data-activity-id="${slower.activity_id}"]`)
  await expect(recordPoint).toHaveAttribute('data-record', 'true')

  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())
  await expect(recordPoint).toHaveCSS('fill', hexToRgb(accent))
  await expect(slowerPoint).not.toHaveCSS('fill', hexToRgb(accent))

  // Faster sits lower: a greater cy.
  const recordY = Number(await recordPoint.getAttribute('cy'))
  const slowerY = Number(await slowerPoint.getAttribute('cy'))
  expect(recordY).toBeGreaterThan(slowerY)
})

test('the ineligible toggle changes the number of rendered points', async ({ page }) => {
  const five = await progressionRows(page, '5k')
  test.skip(five.items.length === 0, needsRows(['/api/progression/5k']))
  expect(five.effort_count).toBeGreaterThan(five.eligible_count)

  await openSettled(page, '/progression?distance=5k')
  const points = page.locator('circle[data-activity-id]')
  await expect(points).toHaveCount(five.effort_count)

  await page.getByRole('checkbox', { name: 'Show ineligible efforts' }).uncheck()

  await expect(points).toHaveCount(five.eligible_count)
  await expect(page.locator('circle[data-eligible="false"]')).toHaveCount(0)
})

test('a progression readout stays inside the viewport at phone width, at either edge of the chart', async ({ page }) => {
  const five = await progressionRows(page, '5k')
  test.skip(five.items.length === 0, needsRows(['/api/progression/5k']))

  // Centred on its point with `translateX(-50%)`, so half the box hangs
  // either side: unclamped, the rightmost point's half joined the
  // document's scrollable area - measured 644px of document in a 606px
  // viewport, and 436px in a 390px one - and the time, pace and heart rate
  // rows sat off screen. The vertical half of the same trap: the flip to
  // below the point was a fraction of the viewBox, which at 390px is a
  // panel about 157px tall, so a readout of roughly 150px started above
  // the panel's own top edge.
  for (const width of [606, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await openSettled(page, '/progression?distance=5k')
    const circles = page.locator('circle[data-activity-id]')
    await circles.first().waitFor()
    // Into the middle of the window before any point is measured. A pointer
    // move takes viewport coordinates, so a point below the fold, or under
    // the phone tab bar fixed along the bottom at 390px, is one no move can
    // reach, and a poll that retries an unreachable point only waits out
    // the test's timeout.
    await page
      .locator('svg[role="img"]')
      .evaluate((el) => el.scrollIntoView({ block: 'center' }))

    // Every point's centre, measured, because **DOM order is no longer
    // chart order**: `inPaintOrder` draws the nine records last so that an
    // ordinary effort from the following week cannot cover one, which means
    // `circles.first()` is neither the earliest effort nor the leftmost
    // mark. Taking the extremes by DOM position silently stopped testing
    // the clamp this test exists for - it was hovering two arbitrary
    // interior points - and `.hover()` then failed outright, because the
    // leftmost mark is a record whose 6px disc covers the 3.5px one that
    // happened to be first in the document.
    const centres = await circles.evaluateAll((els) =>
      els.map((el) => {
        const box = el.getBoundingClientRect()
        return {
          id: el.getAttribute('data-activity-id'),
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
        }
      }),
    )
    expect(centres.length).toBeGreaterThan(1)

    // The two horizontal extremes for the clamp, and the slowest effort for
    // the flip: the time axis is inverted, so the slowest is the one point
    // guaranteed to sit nearest the panel's top edge.
    const slowest = five.items.reduce((worst, item) =>
      item.elapsed_time_s > worst.elapsed_time_s ? item : worst,
    )
    const slowestCentre = centres.find((c) => c.id === slowest.activity_id)
    if (slowestCentre === undefined) throw new Error('the slowest effort drew no point')
    // Probes are identified by activity id rather than by the coordinates
    // measured above, because those coordinates go stale - see the poll.
    const probes: [string, string][] = [
      ['leftmost', centres.reduce((a, b) => (b.x < a.x ? b : a)).id ?? ''],
      ['rightmost', centres.reduce((a, b) => (b.x > a.x ? b : a)).id ?? ''],
      ['slowest', slowest.activity_id],
    ]

    for (const [which, activityId] of probes) {
      // Away from every point first, so each hover below is a genuine
      // enter. Without it the pointer can already be sitting on another
      // circle from the previous probe (or from the previous viewport
      // width, since the cursor survives `goto`), and the readout then
      // unmounts and remounts as the hover moves between the two - a
      // window in which it is briefly visible with no layout box at all.
      await page.mouse.move(0, 0)
      await expect(page.getByTestId('progression-readout')).toHaveCount(0)

      const where = `the ${which} point at ${String(width)}px`
      // Polled, because the readout appears on the pointer landing rather
      // than on the navigation settling, and it unmounts and remounts as the
      // pointer crosses between points.
      //
      // **The pointer move is inside the poll, not before it.** The panel
      // re-lays-out under load, the scatter sizing itself from its own
      // viewBox, and a pointer that landed before that leaves no enter
      // behind it. Nothing then re-triggers one, so polling the readout
      // alone only waits out its own timeout and reports an absence that a
      // second move would have fixed. Found when an unrelated test was
      // added to this suite and the worker scheduling shifted underneath
      // these two.
      //
      // **And the point is re-measured inside the poll too, which is the
      // other half of the same fault.** Moving the pointer again to a
      // coordinate read before that re-layout retries the same wrong place
      // for the whole timeout: the mark is no longer there, so no number of
      // retries can land on it. Measured on a loaded machine, the full
      // suite failed this test on every run while the test alone passed on
      // every run. Reading the mark's own centre each time is what makes
      // the retry a retry rather than a repeat.
      //
      // The pointer is put where the mark is, rather than asked for a
      // locator's own hover: points overlap by design in a 225-point cloud,
      // and which of two overlapping marks answers is the browser's
      // decision to make, not a reason to refuse the action. What is
      // asserted below is where the readout lands, which is a fact about
      // the x the pointer is at.
      // Asserted rather than annotated: the poll's closure assigns it, which
      // control-flow analysis cannot see, so an annotated `= null` would
      // narrow to null and the checks below would see `never`.
      let box = null as Awaited<ReturnType<typeof readoutBox>>
      await expect
        .poll(async () => {
          const centre = await page
            .locator(`circle[data-activity-id="${activityId}"]`)
            .evaluate((el) => {
              const r = el.getBoundingClientRect()
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
            })
          await page.mouse.move(centre.x, centre.y)
          box = await readoutBox(page)
          return box !== null
        }, { message: `no readout appeared for ${where}` })
        .toBe(true)
      if (box === null) throw new Error(`the readout for ${where} has no box`)
      expect(box.x, `readout left edge, ${where}`).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width, `readout right edge, ${where}`).toBeLessThanOrEqual(width)
      expect(box.y, `readout top edge, ${where}`).toBeGreaterThanOrEqual(0)
      const overflow = await documentOverflow(page)
      expect(overflow.scrollWidth, `hovering widened the document, ${where}`).toBeLessThanOrEqual(
        overflow.clientWidth,
      )
    }
  }
})

test('hovering a progression point shows its readout without moving the panel, and clicking it opens the activity', async ({ page }) => {
  const five = await progressionRows(page, '5k')
  test.skip(five.items.length === 0, needsRows(['/api/progression/5k']))
  const record = five.items.find((p) => p.is_record)
  if (record === undefined) throw new Error('fixture assumption: 5 km has a record')

  await openSettled(page, '/progression?distance=5k')
  const panel = page.locator('svg[role="img"]').locator('xpath=..')
  const before = await panel.boundingBox()
  if (before === null) throw new Error('the scatter has no panel')

  // **Every mark stays hit-testable, and the staircase is what could stop
  // one being so.** It is drawn last, over the cloud, so it would take the
  // pointer on any point it crosses; `pointer-events: none` is what keeps
  // it decoration rather than a target, and nothing else in the file says
  // so. Asked of every point's own centre rather than of the staircase's
  // computed style, because what matters is the outcome: a centre that
  // lands on a neighbouring point's link is an ordinary consequence of 225
  // marks in one plot and still produces a readout, while a centre landing
  // on the staircase or on nothing is a point a reader cannot interrogate.
  // Measured 2026-09-13: 225 of 225 centres resolve to a point's link, at
  // 1280x720 and at 412x900 alike.
  //
  // **The panel is scrolled into view first, and it has to be.**
  // `document.elementFromPoint` takes viewport coordinates and returns null
  // for anything outside it, so on an unscrolled 1280x720 page - where this
  // chart starts 440px down - 196 of the 225 marks answer null because they
  // are below the fold, not because anything covers them. Reading that as a
  // failure is a test reporting a bug that is not there. Scrolling first is
  // also what `.hover()` does before it acts, so this measures the page in
  // the state a hover actually happens in.
  await panel.scrollIntoViewIfNeeded()
  const reach = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth
    const viewportHeight = document.documentElement.clientHeight
    const circles = [...document.querySelectorAll('circle[data-activity-id]')]
    const offScreen: string[] = []
    const covered: string[] = []
    for (const circle of circles) {
      const box = circle.getBoundingClientRect()
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      const id = circle.getAttribute('data-activity-id') ?? '?'
      if (x < 0 || y < 0 || x > viewportWidth || y > viewportHeight) {
        offScreen.push(id)
        continue
      }
      const hit = document.elementFromPoint(x, y)
      if (hit === null || hit.closest('a[href^="/activities/"]') === null) covered.push(id)
    }
    return { total: circles.length, offScreen, covered }
  })
  expect(reach.covered, 'these marks cannot be hovered: something is drawn over them').toEqual([])
  // And the whole cloud really was measured, rather than the assertion above
  // passing over an empty set because everything had scrolled away.
  expect(reach.offScreen, 'these marks were off screen, so nothing was asserted about them').toEqual([])
  expect(reach.total).toBe(five.items.length)

  const point = page.locator(`circle[data-activity-id="${record.activity_id}"]`)
  const readout = page.getByTestId('progression-readout')
  // Re-hovered on each attempt, for the reason the viewport test above
  // records at length: a single `hover()` can measure the point and then
  // move the pointer to where it used to be.
  await expect.poll(async () => {
    await point.hover()
    return readout.count()
  }, { message: 'no readout appeared for the record point' }).toBeGreaterThan(0)
  await expect(readout).toBeVisible()
  await expect(readout).toContainText('Record')
  await expect(readout).toContainText(/\/km/)
  const after = await panel.boundingBox()
  expect(after?.height).toBe(before.height)

  await point.click()
  await page.waitForURL(`**/activities/${record.activity_id}`)
})

test("the VO2max chart draws Garmin's own line and readout when a Garmin export is ingested", async ({ page }) => {
  const real = (await (await page.request.get('/api/fitness')).json()) as {
    items: { start_time_utc: string; hr_vo2max_smoothed: number | null }[]
    device: { calendar_date: string; vo2max: number; vo2max_reported: number }[]
  }
  test.skip(real.items.length === 0, needsRows(['/api/fitness']))
  // Garmin's own VO2max comes from a Garmin Connect account export's
  // metrics files, which the fixtures do not include, so the device series
  // is synthetic: one day per fixture run with an estimate, each reading
  // that run's own smoothed heart rate estimate, so it sits inside the
  // chart's range. The rest of the payload is the server's.
  const device = real.items
    .filter((item) => item.hr_vo2max_smoothed !== null)
    .map((item) => ({
      calendar_date: item.start_time_utc.slice(0, 10),
      vo2max: item.hr_vo2max_smoothed ?? 0,
      vo2max_reported: Math.round(item.hr_vo2max_smoothed ?? 0),
    }))
  const fitness = { ...real, device: real.device.length > 0 ? real.device : device }
  await page.route('**/api/fitness', (route) => route.fulfill({ json: fitness }))

  await page.goto('/trends')
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'VO2max' }) })
  await expect(section.getByRole('list', { name: /legend$/ })).toContainText('Garmin (watch)')
  const latest = fitness.device.at(-1)?.vo2max_reported
  await expect(section.getByText('as the watch shows it')).toBeVisible()
  await expect(section.getByText(String(latest), { exact: true })).toBeVisible()
})
