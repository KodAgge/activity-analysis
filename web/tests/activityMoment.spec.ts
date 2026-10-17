import { expect, test } from '@playwright/test'
import type { APIRequestContext, ElementHandle, Locator, Page } from '@playwright/test'
import { fillTextCalls, installCanvasSpy } from './canvasSpy'
import { serveSyntheticRoute } from './syntheticRoute'

/**
 * The activity view keeps its route map in view beside the stream charts,
 * so the dot on the map and the chart being hovered share the screen - see
 * "Desktop layout" and the phone layout after it in
 * `docs/reference/frontend.md`.
 *
 * On desktop the hero is pinned in the left column and the four charts are
 * compressed so all of them fit beside it on one screen; on a phone the
 * hero stays pinned at the top and collapses to a third of the screen as
 * the page scrolls. The route view shares the hero but not the layout, so
 * its hero still scrolls away with the page.
 *
 * The run is an outdoor fixture with a covered map on the suite's store.
 * The fixtures hold no route, so the route view's test serves the synthetic
 * one of `syntheticRoute.ts`.
 */

/**
 * `174c6a0e5af5c4b4`, 2026-08-26, whose route's shape draws a phone hero
 * as tall as the screen is wide, which the phone tests need: a phone hero
 * is as tall as the route's shape asks, up to the full width, and the
 * collapse to a third only shows on a hero that starts out taller than a
 * third. The reference run's wide route draws a hero under a third at rest,
 * measured 217 px of an 844 px window, so it never collapses at all.
 */
const RUN = '174c6a0e5af5c4b4'

const section = (page: Page, name: string): Locator =>
  page.locator('section').filter({ has: page.getByRole('heading', { name, exact: true, level: 2 }) })

/**
 * Presses Tab until `target` is the focused element, up to `maxPresses`
 * times - a real keyboard Tab rather than a programmatic `.focus()`, which
 * a real browser does not treat as arriving "by keyboard" for
 * `:focus-visible` purposes. The exact number of stops ahead of the target
 * (the back control, the hero's own controls) is not this suite's to
 * track, so this walks to it rather than asserting a fixed count.
 */
async function tabUntilFocused(page: Page, target: Locator, maxPresses = 60): Promise<void> {
  for (let i = 0; i < maxPresses; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return
    await page.keyboard.press('Tab')
  }
  throw new Error('Tab did not reach the target element within the iteration budget')
}

/**
 * A tag's reason popover is never unmounted, only visually hidden behind a
 * `clip-path` - see `Tag.module.css`'s `.reason`. Playwright's own
 * `toBeVisible` looks at the bounding box and `visibility`, neither of
 * which that clip changes (the box stays 1x1), so shown-or-hidden here is
 * read off the popover's own width instead: 1px hidden, its real rendered
 * width once `.reasonVisible` applies.
 */
async function reasonWidth(reason: Locator): Promise<number> {
  const box = await reason.boundingBox()
  return box?.width ?? 0
}

/**
 * Fails the calling test, naming the cause, when RUN carries no
 * `kind: "effort"` tag. A run's effort classification is relative to the
 * athlete's whole history, and 86 of 307 runs of the real export carry no
 * effort tag at all (see `docs/reference/api.md`), so a change to the
 * classifier can drop RUN's; on the fixture store it reads `easy`, and a
 * test that skipped instead would stop covering the badge unnoticed.
 */
async function requireEffortTag(request: APIRequestContext): Promise<void> {
  const detail = (await (await request.get(`/api/activities/${RUN}`)).json()) as {
    derived?: { tags?: { kind: string }[] } | null
  }
  const hasEffortTag = (detail.derived?.tags ?? []).some((tag) => tag.kind === 'effort')
  expect(hasEffortTag, `${RUN} carries no effort tag, which these tests need`).toBe(true)
}

const STREAM_TITLES = ['Pace', 'Heart rate', 'Cadence', 'Elevation'] as const

/** Whether each stream chart drew the time axis's title on its canvas. */
async function drawsTimeAxis(page: Page): Promise<Record<string, boolean>> {
  const drawn: Record<string, boolean> = {}
  for (const name of STREAM_TITLES) {
    const canvas = section(page, name).locator('canvas')
    await canvas.waitFor()
    const handle = (await canvas.elementHandle()) as ElementHandle<HTMLCanvasElement>
    drawn[name] = (await fillTextCalls(handle)).some((call) => call.text === 'Elapsed time')
  }
  return drawn
}

/** Each stream section's top and height, in the order of `STREAM_TITLES`. */
async function streamBoxes(page: Page): Promise<number[][]> {
  return Promise.all(
    STREAM_TITLES.map(async (name) => {
      const box = (await section(page, name).boundingBox())!
      return [box.y, box.height]
    }),
  )
}

/** Resolves after the page has drawn `count` more frames. */
async function frames(page: Page, count: number): Promise<void> {
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise((resolve) => requestAnimationFrame(resolve))
  }, count)
}

/**
 * Where each stream chart's cursor line sits, in CSS pixels from the left
 * of its own plot, in the order of `STREAM_TITLES` - or `null` for a line
 * uPlot has hidden, which has no box.
 */
async function cursorOffsets(page: Page): Promise<(number | null)[]> {
  return Promise.all(
    STREAM_TITLES.map(async (name) => {
      const over = (await section(page, name).locator('.u-over').boundingBox())!
      const line = await section(page, name).locator('.u-cursor-x').boundingBox()
      return line === null ? null : Math.round(line.x - over.x)
    }),
  )
}

/** The height of a stream chart's plot area, uPlot's own overlay over it. */
async function plotHeight(page: Page, name: string): Promise<number> {
  const box = await section(page, name).locator('.u-over').boundingBox()
  return Math.round(box!.height)
}

test.describe('the activity view', () => {
  test('desktop: the map stays in view while the page scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`/activities/${RUN}`)
    const hero = page.getByRole('region', { name: 'Route', exact: true })
    await hero.waitFor()
    await page.getByRole('heading', { name: 'Splits', exact: true }).scrollIntoViewIfNeeded()
    const box = (await hero.boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(800)
  })

  test('desktop: all four charts fit on one screen beside the map', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`/activities/${RUN}`)
    await page.getByRole('region', { name: 'Route', exact: true }).waitFor()
    const pace = section(page, 'Pace')
    await pace.evaluate((el) => el.scrollIntoView({ block: 'start' }))
    const top = (await pace.boundingBox())!.y
    const bottom = (await section(page, 'Elevation').boundingBox())!
    // A pixel of slack: the section's top is fractional and a scroll offset
    // at a device pixel ratio of 1 is whole, so `block: 'start'` leaves it up
    // to a pixel above the window.
    expect(top).toBeGreaterThanOrEqual(-1)
    expect(bottom.y + bottom.height).toBeLessThanOrEqual(800)
  })

  test('desktop: the four charts share one time axis, under equal plots', async ({ page }) => {
    await installCanvasSpy(page)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`/activities/${RUN}`)
    await page.getByRole('region', { name: 'Route', exact: true }).waitFor()
    expect(await drawsTimeAxis(page)).toEqual({ Pace: false, 'Heart rate': false, Cadence: false, Elevation: true })
    // Equal plots, not equal charts: the bottom chart is taller by the axis.
    const plots = await Promise.all(STREAM_TITLES.map((name) => plotHeight(page, name)))
    expect(new Set(plots).size).toBe(1)
    // 68px here: 80px before the pace panel's note took its 32px and the
    // section gap out of the shared height (docs/reference/frontend.md, "Desktop layout").
    // An axis on every panel would leave about 32px, which this still rules out.
    expect(plots[0]).toBeGreaterThanOrEqual(60)
  })

  test('phone: every chart keeps its own time axis', async ({ page }) => {
    await installCanvasSpy(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/activities/${RUN}`)
    await page.getByRole('region', { name: 'Route', exact: true }).waitFor()
    expect(await drawsTimeAxis(page)).toEqual({ Pace: true, 'Heart rate': true, Cadence: true, Elevation: true })
  })

  test('phone: the map stays pinned at a third of the screen over the charts', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/activities/${RUN}`)
    const hero = page.getByRole('region', { name: 'Route', exact: true })
    await hero.waitFor()
    await section(page, 'Heart rate').evaluate((el) => el.scrollIntoView({ block: 'center' }))
    // The collapse is written in the frame after the scroll, so the height
    // is polled until it settles rather than read once after a fixed wait.
    await expect.poll(async () => (await hero.boundingBox())!.height).toBeLessThan(844 / 3 + 20)
    const box = (await hero.boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(-1)
    expect(box.height).toBeGreaterThan(844 / 3 - 20)
    const hr = (await section(page, 'Heart rate').boundingBox())!
    expect(hr.y).toBeGreaterThanOrEqual(box.y + box.height - 1)
  })

  test('hovering the pace chart shows a pace and marks the spot on the map', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`/activities/${RUN}`)
    await page.getByRole('region', { name: 'Route', exact: true }).waitFor()
    const pace = section(page, 'Pace')
    // The title block above the compact stream stack - place, route line,
    // stats, tags - can be taller than the viewport, so the pace
    // panel can start below the fold at the initial scroll position; every
    // other test in this file that reads a chart's own box scrolls it into
    // view first (see `plotHeight` above), and a hover needs the same.
    await pace.evaluate((el) => el.scrollIntoView({ block: 'start' }))
    const plot = pace.locator('.u-over')
    await plot.waitFor()

    // The always-visible average legend (`StreamPanelHeading` in
    // `charts/StreamPanel.tsx`) renders through the same `pace()`/
    // `heartRate()` formatters as the hovered moment, in a visibly
    // identical span - a bare text match on the pace/bpm pattern would
    // pass on the average alone even if the hover never fired at all. Only
    // the moment value renders inside an `aria-hidden="true"` span; the
    // average's own value span carries no such attribute. Scoping to it is
    // what actually proves the moment rendered, and asserting it is absent
    // before the hover is what proves this locator does not also catch the
    // average.
    const paceMoment = pace.locator('[aria-hidden="true"]').getByText(/^\d+:\d{2}\/km$/)
    const hr = section(page, 'Heart rate')
    const hrMoment = hr.locator('[aria-hidden="true"]').getByText(/^\d+ bpm$/)
    await expect(paceMoment).toHaveCount(0)
    await expect(hrMoment).toHaveCount(0)

    const box = await plot.boundingBox()
    await page.mouse.move(box!.x + box!.width * 0.4, box!.y + box!.height / 2)
    await expect(paceMoment).toBeVisible()
    await expect(page.getByTestId('moment-label')).toBeVisible()
    await expect(hrMoment).toBeVisible()
  })

  test('desktop: hovering a chart moves nothing on the page', async ({ page }) => {
    // The heading row used to stand 3.8px taller showing the average than
    // showing the value at the moment, so a hover moved every chart below
    // the hovered one, and a pointer near a plot's bottom edge crossed it
    // and back on every move.
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`/activities/${RUN}`)
    await page.getByRole('region', { name: 'Route', exact: true }).waitFor()
    const pace = section(page, 'Pace')
    await pace.evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await section(page, 'Elevation').locator('.u-over').waitFor()
    const atRest = await streamBoxes(page)

    const plot = (await pace.locator('.u-over').boundingBox())!
    await page.mouse.move(plot.x + plot.width * 0.4, plot.y + plot.height / 2)
    await expect(pace.locator('[aria-hidden="true"]').getByText(/^\d+:\d{2}\/km$/)).toBeVisible()
    expect(await streamBoxes(page)).toEqual(atRest)

    const elevation = section(page, 'Elevation')
    const elevationPlot = (await elevation.locator('.u-over').boundingBox())!
    await page.mouse.move(elevationPlot.x + elevationPlot.width * 0.4, elevationPlot.y + elevationPlot.height - 3)
    await expect(elevation.locator('[aria-hidden="true"]').getByText(/^-?\d+ m$/)).toBeVisible()
    expect(await streamBoxes(page)).toEqual(atRest)
  })

  test('desktop: a drag across a chart leaves the shared time axis alone', async ({ page }) => {
    // uPlot's default drag zooms the one chart dragged across, which left
    // the bottom chart's time axis, drawn once for all four, labelling a
    // range the other three did not show.
    await installCanvasSpy(page)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`/activities/${RUN}`)
    await page.getByRole('region', { name: 'Route', exact: true }).waitFor()
    await section(page, 'Pace').evaluate((el) => el.scrollIntoView({ block: 'start' }))
    const elevation = section(page, 'Elevation')
    const canvas = elevation.locator('canvas')
    await canvas.waitFor()
    const handle = (await canvas.elementHandle()) as ElementHandle<HTMLCanvasElement>
    const timeLabels = async () =>
      (await fillTextCalls(handle)).map((call) => call.text).filter((text) => /^\d+(:\d{2})+$/.test(text))
    // Settled once two reads a couple of frames apart agree: the chart is
    // drawn at its construction size first and again once its container
    // has been measured.
    await expect
      .poll(async () => {
        const first = await timeLabels()
        await frames(page, 2)
        return first.length > 0 && JSON.stringify(first) === JSON.stringify(await timeLabels())
      })
      .toBe(true)
    const before = await timeLabels()

    const plot = (await elevation.locator('.u-over').boundingBox())!
    await page.mouse.move(plot.x + plot.width * 0.3, plot.y + plot.height / 2)
    await page.mouse.down()
    await page.mouse.move(plot.x + plot.width * 0.5, plot.y + plot.height / 2, { steps: 5 })
    await page.mouse.up()
    await frames(page, 2)
    expect(await timeLabels()).toEqual(before)
  })

  test('desktop: every chart shows the replay head again once a hover that paused it leaves', async ({ page }) => {
    // uPlot hides the hovered chart's own cursor on `mouseleave`, after the
    // pointer's leave had already put it back at the head, so that one
    // chart lost its line while the other three kept theirs.
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`/activities/${RUN}`)
    await page.getByRole('region', { name: 'Route', exact: true }).waitFor()
    await section(page, 'Pace').evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await section(page, 'Elevation').locator('.u-over').waitFor()

    await page.getByRole('button', { name: 'Replay' }).click()
    const label = page.getByTestId('moment-label')
    await expect(label).toBeVisible()
    const hr = (await section(page, 'Heart rate').locator('.u-over').boundingBox())!
    await page.mouse.move(hr.x + hr.width / 2, hr.y + hr.height / 2)
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()

    // Out to the right-hand gutter, over no chart.
    await page.mouse.move(1275, hr.y + hr.height / 2)
    const [pace, ...rest] = await cursorOffsets(page)
    expect(pace).toBeGreaterThanOrEqual(0)
    expect(rest).toEqual(rest.map(() => pace))
  })

  test('phone: no gap opens under the hero with a notice above it', async ({ page }) => {
    // The collapse used to count from the top of the page, so with a
    // notice above the hero it shrank for 60px before the hero stuck, and
    // the gap under it grew by as much. Forced stale, so the notice is
    // there whatever the store's own state.
    await page.route('**/api/health', async (route) => {
      const response = await route.fetch()
      await route.fulfill({ response, json: { ...(await response.json()), stale: true } })
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/activities/${RUN}`)
    const hero = page.getByRole('region', { name: 'Route', exact: true })
    await hero.waitFor()
    await expect(page.getByRole('alert')).toBeVisible()
    const title = page.getByRole('heading', { level: 1 })
    const gap = async () => (await title.boundingBox())!.y - ((await hero.boundingBox())!.y + (await hero.boundingBox())!.height)
    const heroTop = (await hero.boundingBox())!.y
    expect(heroTop).toBeGreaterThan(20)
    const atRest = await gap()

    for (const y of [heroTop, heroTop + 40]) {
      await page.evaluate((to) => window.scrollTo(0, to), y)
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(y)
      await frames(page, 2)
      expect(Math.abs((await gap()) - atRest)).toBeLessThan(1)
    }
  })

  test('phone: a control reached with Shift+Tab is not left under the pinned hero', async ({ page, request }) => {
    // WCAG 2.4.11. A control already inside the window but under the
    // sticky hero counts as in view without the page's scroll padding, so
    // the browser left it there.
    await requireEffortTag(request)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/activities/${RUN}`)
    const hero = page.getByRole('region', { name: 'Route', exact: true })
    await hero.waitFor()
    await page.getByRole('heading', { name: 'Splits', exact: true }).waitFor()
    const badge = page.locator('[aria-label="Automatic effort tag"]').getByRole('button')

    // The badge 150px down the window, under the collapsed hero, and focus
    // on the control after it, placed without scrolling.
    await badge.evaluate((el) => {
      window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 150)
      const tabbable = [...document.querySelectorAll<HTMLElement>('a[href], button, summary, [tabindex]')].filter(
        (candidate) => candidate.tabIndex >= 0,
      )
      tabbable[tabbable.indexOf(el as HTMLElement) + 1]?.focus({ preventScroll: true })
    })
    await expect.poll(async () => (await hero.boundingBox())!.height).toBeLessThan(844 / 3 + 1)

    await page.keyboard.press('Shift+Tab')
    await expect(badge).toBeFocused()
    await frames(page, 2)
    const heroBox = (await hero.boundingBox())!
    expect((await badge.boundingBox())!.y).toBeGreaterThanOrEqual(heroBox.y + heroBox.height - 1)
  })

  test('pressing Replay moves the moment along the run', async ({ page }) => {
    await page.goto(`/activities/${RUN}`)
    await page.getByRole('button', { name: 'Replay' }).click()
    const label = page.getByTestId('moment-label')
    await expect(label).toBeVisible()
    const first = await label.textContent()
    // Web-first and retrying, rather than a fixed wait then one snapshot:
    // this polls until the label's text has actually moved on, so the
    // assertion is what proves the run advanced rather than a wall-clock
    // guess at how long a second of replay takes.
    await expect.poll(() => label.textContent()).not.toBe(first)
    await page.getByRole('button', { name: 'Pause' }).click()
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()
  })

  test('tabbing to the effort badge shows its reason, and Escape hides it without moving focus', async ({
    page,
    request,
  }) => {
    await requireEffortTag(request)
    await page.goto(`/activities/${RUN}`)
    const effort = page.locator('[aria-label="Automatic effort tag"]')
    const badge = effort.getByRole('button')
    await badge.waitFor()
    const reason = effort.getByRole('tooltip')
    expect(await reasonWidth(reason)).toBeLessThanOrEqual(2)

    await tabUntilFocused(page, badge)
    await expect(badge).toBeFocused()
    await expect.poll(() => reasonWidth(reason)).toBeGreaterThan(20)

    await page.keyboard.press('Escape')
    await expect(badge).toBeFocused()
    await expect.poll(() => reasonWidth(reason)).toBeLessThanOrEqual(2)
  })

  test('a mouse click on the effort badge hides its reason once the pointer leaves, past the grace period', async ({
    page,
    request,
  }) => {
    await requireEffortTag(request)
    await page.goto(`/activities/${RUN}`)
    const effort = page.locator('[aria-label="Automatic effort tag"]')
    const badge = effort.getByRole('button')
    await badge.waitFor()
    const reason = effort.getByRole('tooltip')

    await badge.click()
    await expect.poll(() => reasonWidth(reason)).toBeGreaterThan(20)

    await page.mouse.move(10, 10)
    await expect.poll(() => reasonWidth(reason)).toBeLessThanOrEqual(2)
  })
})

test('the route view is unchanged', async ({ page, request }) => {
  const { route } = await serveSyntheticRoute(page, request)

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/routes/${route.route_id}`)
  const hero = page.getByRole('region', { name: 'Route', exact: true })
  await hero.waitFor()
  await page.mouse.wheel(0, 1500)
  await expect.poll(async () => (await hero.boundingBox())!.y).toBeLessThan(0)
})
