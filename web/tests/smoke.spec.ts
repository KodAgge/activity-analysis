import type { ElementHandle, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { paceAxisSplits, paceTick, paceYRange } from '../src/charts/streamPanelMath'
import { calendarDate, distance, distanceKeyLabel } from '../src/format'
import { arcCalls, fillTextCalls, installCanvasSpy } from './canvasSpy'

/**
 * The end-to-end smoke suite: one test per view, plus the three tests the
 * task brief singles out because each encodes a fault that measurement
 * caught rather than a test - see `docs/reference/frontend.md`'s "Traps"
 * for the write-up of each one.
 *
 * ## This suite has now run
 *
 * The missing system libraries that kept Chromium from launching here
 * (`error while loading shared libraries: libnspr4.so`, from twenty-six
 * missing packages) are installed as of 2026-09-02, and `npm run
 * test:e2e` runs all seven tests against the real API server and the real
 * Vite dev server. Two assertions did not survive first contact with a real
 * browser - both were defects in the test, not in the application; see the
 * fixes and their comments at "the overview renders its stat rail with real
 * numbers" and "the weekly history marks the weeks with no run" below - and
 * every other assertion, canvas-reading ones included, is now something
 * that has actually been seen to pass rather than reasoned about from the
 * source that produced the pixels.
 *
 * ## Why this suite reads canvas pixels
 *
 * uPlot (see docs/reference/frontend.md) draws every chart on a `<canvas>`
 * with no DOM fallback text, so an axis tick or a drawn mark is only ever a
 * pixel. `./canvasSpy.ts` intercepts the drawing calls themselves rather
 * than either skipping those assertions or trusting the source code that
 * produced the pixels - see its own header comment for the mechanics and
 * for how it copes with React `StrictMode` double-invoking a chart's mount
 * effect in development.
 *
 * ## Why figures are fetched live rather than hardcoded
 *
 * `/api/overview`'s weekly and monthly series are dense and grow with the
 * calendar (see docs/reference/api.md), so a count fixed in this file would
 * start failing the day after it was measured, for no reason connected to
 * the thing under test. Every assertion below that depends on such a count
 * fetches it from the running server first and computes its expectation
 * from that response, the same way `docs/reference/api.md`'s own figures
 * are captioned as measurements rather than promises. The activity ids
 * below are the exception: they name runs of the committed fixtures,
 * `data/examples`, which the suite's store is ingested from (see
 * `playwright.config.ts`) and which do not move, so pinning their reference
 * values (the 5-rep pattern, the 4:12 split, the 4:00 top tick) is safe.
 */

/** `6116b2e90f551a6c`, 2026-08-25: the one interval session both highlighted tests use - 14 recorded laps, pattern `-WRWRWRWRWR---`, 5 reps. */
const INTERVAL_ACTIVITY_ID = '6116b2e90f551a6c'
const INTERVAL_ACTIVITY_LOCAL_DATE = '2026-08-25'
/**
 * The reference activity of `docs/reference/test-fixtures.md`: 7.46 km on
 * 2026-08-28 at 6:33/km, eight laps from 6:16 to 6:57, a full seven-zone
 * distribution and a route whose bounding box is taller than it is wide.
 * The one the maintainer's screenshots were taken of, so every figure below
 * is comparable with them.
 */
const REFERENCE_ACTIVITY = '854fd775d479ca9f'

/**
 * The run shown as a treadmill run, `174c6a0e5af5c4b4`, 2026-08-26. The
 * fixtures hold no treadmill run, so `asTreadmillRun` turns this outdoor
 * one into one in the browser.
 */
const TREADMILL_ACTIVITY_ID = '174c6a0e5af5c4b4'
const TREADMILL_ACTIVITY_LOCAL_DATE = '2026-08-26'

/**
 * Serves `activityId` as a treadmill run: its detail says indoor, with no
 * GPS and no place, and its streams carry no position - what
 * `analysis/metrics.py` writes for a run recorded on a treadmill, whose
 * derivation the Python suite covers. Everything else is the run's own
 * response, fetched from the server and changed only in those fields, so
 * what is under test is the view's treadmill branch and nothing invented.
 *
 * Returns the place the run really has, so a test can assert that the view
 * does not show it.
 */
async function asTreadmillRun(page: Page, activityId: string): Promise<{ locality: string; country: string }> {
  const real = { locality: '', country: '' }
  await page.route(`**/api/activities/${activityId}`, async (route) => {
    const response = await route.fetch()
    const detail = (await response.json()) as {
      derived: { metrics: Record<string, unknown> } | null
    }
    const metrics = detail.derived?.metrics
    if (metrics === undefined) throw new Error(`${activityId} has no derived metrics to rewrite`)
    real.locality = String(metrics.locality)
    real.country = String(metrics.country)
    Object.assign(metrics, { is_indoor: true, has_gps: false, locality: null, country: null })
    await route.fulfill({ response, json: detail })
  })
  await page.route(`**/api/activities/${activityId}/streams`, async (route) => {
    const response = await route.fetch()
    const streams = (await response.json()) as { lat_deg: unknown[]; lon_deg: unknown[] }
    await route.fulfill({
      response,
      json: { ...streams, lat_deg: streams.lat_deg.map(() => null), lon_deg: streams.lon_deg.map(() => null) },
    })
  })
  return real
}

function weeksLabel(count: number): string {
  return `${String(count)} week${count === 1 ? '' : 's'}`
}

/**
 * Reaches an activity's detail view by clicking its row in the browser
 * rather than `page.goto`ing the detail URL directly - see C1 in the final
 * whole-branch review: every test in this suite used to reach
 * `/activities/$activityId` this second way, which is exactly what let a
 * completely unreachable detail view (no row `<Link>` anywhere in the
 * application, so a user who opened the app could never actually get
 * there) pass this suite. A real click on the real row's link is the one
 * path that fails the way a user's would if that link ever disappeared
 * again.
 *
 * `localDate` narrows the browser to the one calendar day this specific
 * historical activity was recorded on, via the same `from`/`to` filters
 * `docs/reference/api.md` documents, so the click target does not have to
 * fight the default sort and page size to find one specific activity among
 * however many now exist - the browser defaults to `sport=running`, but
 * `sport=all` here since neither reference activity is guaranteed to be a
 * run (the treadmill one is; nothing about the technique requires it).
 */
async function openActivityDetailByClicking(page: Page, activityId: string, localDate: string): Promise<void> {
  const to = new Date(`${localDate}T00:00:00Z`)
  to.setUTCDate(to.getUTCDate() + 1)
  await page.goto(`/activities?sport=all&from=${localDate}&to=${to.toISOString().slice(0, 10)}`)
  await page.locator(`a[href="/activities/${activityId}"]`).click()
  await page.waitForURL(`**/activities/${activityId}`)
}

/**
 * The activity feed's cards.
 *
 * The browser is no longer a table: it is a `<ul aria-label="Activities">`
 * of cards, each an `<li>` holding a headline, a meta line and a 2x2 stat
 * block. Named through the list's own accessible name rather than through a
 * class or a positional `nth-child`, because a name is the one thing about
 * the markup that a redesign has to keep in order to stay usable, and every
 * selector in this file that broke on the rebuild was positional.
 */
function feedCards(page: Page) {
  return page.getByRole('list', { name: 'Activities' }).getByRole('listitem')
}

/**
 * One stat's value out of a card, by the label over it.
 *
 * `Stat` (components/Stat.tsx) renders `<dt>` and `<dd>` as *siblings*
 * inside a wrapping `<div>`, so the value is a following sibling of its
 * label rather than a child of anything shared - the same xpath the
 * overview's own stat-rail test uses, for the same structural reason.
 *
 * Resolves to one element per card it is given, so a single card yields one
 * value and the whole feed yields the column of them, in feed order.
 */
function cardStat(cards: ReturnType<typeof feedCards>, label: string) {
  return cards.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd')
}

/**
 * Opens the filter sheet, and waits until its controls are really there.
 *
 * The eleven filter controls now live behind one disclosure, and the
 * `<form>` carries the `hidden` attribute while closed - so they are out of
 * the accessibility tree and out of the tab order, not merely scrolled
 * past. That is deliberate (the nine stacked controls used to fill the
 * whole first phone screen), and it is why every test below that drives a
 * filter has to open the sheet first. `toHaveValue` on a hidden `<select>`
 * still passes, so a test that only reads a control is not a test that the
 * control is reachable: `selectOption` and `fill` are, because Playwright
 * checks actionability for them.
 */
async function openFilters(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Filters/ }).click()
  await expect(page.getByLabel('Sport')).toBeVisible()
}

/** A chart's `<section>`, located by the heading it is titled with. */
function chartSection(page: Page, heading: string) {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: heading }) })
}

/** A box in page coordinates. */
interface Box {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The box of a chart's **plot area** - uPlot's own `.u-over` - inside the
 * section titled `heading`.
 *
 * **The canvas box is not the plot box.** That is the one fact this branch
 * kept re-learning, in three separate faults: the readout was positioned
 * from `cursor.left` without the plot's own left offset and sat 50px off
 * the pointer; a clamp test hovered 4px inside the *canvas* to reach the
 * extremes; and the phone-width hover guard did the same with fractions of
 * the canvas width. uPlot insets its plot area by the y-axis gutter (its
 * default axis `size` is 50 CSS px) and by whatever `padding` the chart
 * passes - `[16, 8, 0, 0]` for `VolumeBars` - so on a 390px viewport the
 * plot spans roughly `[50, width - 8]` of a canvas under 400px wide, and
 * both 2% and 98% of the canvas fall outside it. Outside the plot
 * `cursor.idx` is null, `VolumeBars` clears its hover state, and there is
 * deliberately no readout at all: a hover positioned against the canvas
 * asserts nothing while looking like it does.
 *
 * So every pointer position in this suite is taken from this box. There is
 * one lookup rather than one per test precisely so a fourth instance
 * cannot be written.
 */
async function plotArea(page: Page, heading: string): Promise<Box> {
  const over = chartSection(page, heading).locator('.u-over')
  await over.waitFor()
  const box = await over.boundingBox()
  if (box === null) throw new Error(`the chart headed "${heading}" has no plot area`)
  return box
}

/** A point `fraction` of the way across a plot area, inset so the extremes stay inside it. */
function alongPlot(plot: Box, fraction: number): { x: number; y: number } {
  const inset = 2
  return {
    x: plot.x + inset + fraction * (plot.width - 2 * inset),
    y: plot.y + plot.height * 0.5,
  }
}

test('the overview renders its stat rail with real numbers', async ({ page, request }) => {
  const overview = await (await request.get('/api/overview')).json()
  const weeks = overview.weeks as { period_start: string; runs: number; distance_m: number }[]
  const thisWeek = weeks.at(-1)
  const lastFourWeeks = weeks.slice(-4)
  const lastFourDistanceM = lastFourWeeks.reduce((sum, week) => sum + week.distance_m, 0)

  await page.goto('/')

  // Each stat is one `<dt>` inside a wrapping `<div>` (`StatRail.tsx`'s
  // `Stat`), followed by one `<dd>` holding the value and, when the stat
  // carries one, a second `<dd>` holding the detail - `following-sibling`
  // rather than a child selector because the `<dt>` and its `<dd>`s are
  // siblings, not nested. A single helper for the whole group, rather than
  // one for the value alone, is what keeps this from repeating the exact
  // bug this test used to have: the value locator used to be reused,
  // unexamined, for the detail assertion below, because both look like
  // "the text after this label" until you check which element each actually
  // lives in.
  const statGroup = (label: string) => page.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd')
  const statValue = (label: string) => statGroup(label).first()
  const statDetail = (label: string) => statGroup(label).nth(1)

  // `distance(...)`, not a hand-reconstructed `` `${distanceKm(...)} km` ``:
  // an earlier version of this assertion recomputed StatRail's own
  // unit-composition expression on the expectation side, so a component
  // that regressed to that exact bug (I3: the bare `– km` staple) would
  // reconstruct the identical bug here and the two would still match. This
  // way there is one composition, not two independently written copies of
  // it, so a wiring bug - the component reading the wrong field, say -
  // still fails this the same way it always did, from the real API
  // response's own numbers. The null-guard branch `distance` itself covers
  // is not exercised here regardless of which form this assertion takes:
  // the current week in a live store is always a real, dense-series entry
  // with a numeric `distance_m`, never null - `format/index.test.ts` and
  // `StatRail.test.tsx` are what actually pin that branch.
  await expect(statValue('This week')).toHaveText(distance(thisWeek?.distance_m ?? null))
  await expect(statValue('Last 4 weeks')).toHaveText(
    distance(lastFourWeeks.length > 0 ? lastFourDistanceM : null),
  )
  await expect(statValue('Current streak')).toHaveText(weeksLabel(overview.streak.current_weeks as number))
  await expect(statValue('Longest streak')).toHaveText(weeksLabel(overview.streak.longest_weeks as number))
  if (overview.streak.longest_ended_week !== null) {
    await expect(statDetail('Longest streak')).toHaveText(
      `through ${calendarDate(overview.streak.longest_ended_week as string)}`,
    )
  }
  await expect(statValue('Consistency')).toHaveText(
    `${String(overview.consistency.weeks_with_a_run)} of ${String(overview.consistency.weeks_considered)}`,
  )
  // `Consistency`'s detail is a static caption (`StatRail.tsx` never varies
  // it), but it is still a second `<dd>` this test's own helper can now
  // reach, and the earlier bug class here was exactly an assertion that
  // silently checked the wrong element - covering the one other stat that
  // always renders a detail costs one line.
  await expect(statDetail('Consistency')).toHaveText('weeks with a run')
})

test('the weekly history marks the weeks with no run', async ({ page, request }) => {
  const overview = await (await request.get('/api/overview')).json()
  const weeks = overview.weeks as { runs: number }[]
  const emptyIndices = weeks.reduce<number[]>((acc, week, index) => {
    if (week.runs === 0) acc.push(index)
    return acc
  }, [])
  // A real training history has weeks off, which is what makes the mark
  // worth drawing - 16 of 148 weeks of the real export when this was
  // written, current week included. The fixtures' own series runs from
  // their first week to the current one, and every week after their last
  // run is empty.
  expect(emptyIndices.length).toBeGreaterThan(0)

  await installCanvasSpy(page)
  await page.goto('/')

  // Scoped to the "Full history" section specifically, not "Last 12 weeks" -
  // both charts pass `markEmpty`, but only the full series is what this
  // test's premise is about.
  const fullHistorySection = page.locator('section', {
    has: page.getByRole('heading', { name: 'Full history' }),
  })
  const fullHistoryCanvas = fullHistorySection.locator('canvas')
  await expect(fullHistoryCanvas).toBeVisible()
  // Give `UPlot.tsx`'s `ResizeObserver` a moment to settle on the container's
  // real size before reading what got drawn - the canvas spy records every
  // draw for the life of the page, so a premature read risks catching an
  // intermediate layout pass rather than the final one.
  await page.waitForTimeout(250)

  // Locator.elementHandle() types generically as HTMLElement | SVGElement,
  // since Playwright cannot see that `.locator('canvas')` above already
  // pins the tag; this is a real `<canvas>` structurally, so this narrows
  // the type it hands `arcCalls` rather than widening that helper's own
  // signature to accept less than it means to.
  const canvasHandle = (await fullHistoryCanvas.elementHandle()) as ElementHandle<HTMLCanvasElement> | null
  if (canvasHandle === null) throw new Error('the full-history chart never mounted a canvas')

  // CONFIRMED against a real browser (chromium, 2026-09-02): `UPlot.tsx`
  // constructs every chart at a fixed `options.width: 600` / `height: 240`,
  // then its `ResizeObserver` corrects to the container's real size and
  // calls `setSize`, which redraws every mark - at a genuinely different
  // position, not a repeat of the same layout, because the container's real
  // size differs from 600x240. `dedupeArcs` (`canvasSpy.ts`) only collapses
  // an exact repeat of an *unchanged* layout, not a redraw at a *different*
  // size, so a naive read here recorded nearly twice as many marks as there
  // were empty weeks: both the transient 600x240 draw's marks and the final
  // layout's own. `arcCalls` tags every call with the draw generation it belongs to
  // (`clearRect` delimits one uPlot redraw from the next) and keeps only
  // the canvas's most recent generation, which is what makes `marks` below
  // exactly the final layout's marks rather than both draws'.
  //
  // The mark is an `arc`, not a `fillRect`, and that is the assertion as
  // much as the count is: a week off is drawn as an **open ring resting on
  // the baseline**, because a zero-height bar with a tick over it and a bar
  // too short to see are the same picture. `VolumeBars`'s own bars are
  // `arcTo` corners on a filled path and its zero rule is the one remaining
  // `fillRect`, so every `arc` on this canvas is an empty-week mark.
  const marks = await arcCalls(canvasHandle)
  expect(marks.length).toBe(emptyIndices.length)

  // A ring, not a dot: the geometry is an outer diameter with a hole in it,
  // so every mark has a real radius. `emptyMarkGeometry` clamps the stroke
  // to the radius at its 3px floor, which is the one case a ring resolves
  // into a solid dot - still an arc, still a positive radius.
  for (const mark of marks) expect(mark.radius).toBeGreaterThan(0)

  // uPlot draws bars left to right in array order, so a mark's x position is
  // monotonic in its week's index - the highest-index empty week is
  // necessarily the mark with the largest x. When the current week (the
  // last index) is itself empty, as it is on the fixtures' store from the
  // week after their last run on, its mark should sit at the chart's
  // right-hand edge; a store with a run this week has no mark there, which
  // is why this half of the test is conditional.
  if (emptyIndices.at(-1) === weeks.length - 1) {
    const canvasWidth = await fullHistoryCanvas.evaluate((el) => (el as HTMLCanvasElement).width)
    const rightmostMarkX = Math.max(...marks.map((mark) => mark.x))
    expect(rightmostMarkX).toBeGreaterThan(canvasWidth * 0.9)
  }
})

/** The fixtures' one activity that is not a run: `garmin/breathing.fit`, a breathing session. */
const OTHER_SPORT = 'training'

test('the browser filters by sport and the URL carries it', async ({ page, request }) => {
  const sports = (await (await request.get('/api/sports')).json()) as { sport: string | null; count: number }[]
  const other = sports.find((entry) => entry.sport === OTHER_SPORT)
  if (other === undefined) throw new Error(`fixture assumption: the store has a ${OTHER_SPORT} bucket`)

  await page.goto('/activities')
  await openFilters(page)
  const sportSelect = page.getByLabel('Sport')
  await expect(sportSelect).toHaveValue('running')

  await sportSelect.selectOption(OTHER_SPORT)

  await expect.poll(() => new URL(page.url()).searchParams.get('sport')).toBe(OTHER_SPORT)
  await expect(page.getByText(`of ${String(other.count)}`)).toBeVisible()
})

test('a filtered URL pasted fresh restores the same view', async ({ page, request }) => {
  const sports = (await (await request.get('/api/sports')).json()) as { sport: string | null; count: number }[]
  const other = sports.find((entry) => entry.sport === OTHER_SPORT)
  if (other === undefined) throw new Error(`fixture assumption: the store has a ${OTHER_SPORT} bucket`)

  // A full navigation, not a client-side one - this is "pasted", not "clicked".
  await page.goto(`/activities?sport=${OTHER_SPORT}`)

  // Through the sheet, not around it. `toHaveValue` passes on a `hidden`
  // control, so reading the closed sheet's `<select>` would keep passing
  // even if the disclosure stopped rendering its contents at all - and what
  // "restores the same view" means is that a reader who opens the filters
  // sees the filter the URL named.
  await openFilters(page)
  await expect(page.getByLabel('Sport')).toHaveValue(OTHER_SPORT)
  await expect(page.getByText(`of ${String(other.count)}`)).toBeVisible()
})

test('the detail view of a treadmill run states why it has no route', async ({ page }) => {
  await asTreadmillRun(page, TREADMILL_ACTIVITY_ID)
  await openActivityDetailByClicking(page, TREADMILL_ACTIVITY_ID, TREADMILL_ACTIVITY_LOCAL_DATE)

  // Named from its own visible heading now, not from an `aria-label` no
  // sighted reader could see, so this locator also proves the heading is
  // on the page.
  const routeSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Route' }) })
  await expect(routeSection.getByRole('note')).toHaveText(
    'This is a treadmill run: distance is measured by a footpod rather than GPS, so there is no route to draw.',
  )
  await expect(routeSection.locator('svg')).toHaveCount(0)
})

test('an interval session leads with its recorded laps', async ({ page }) => {
  await openActivityDetailByClicking(page, INTERVAL_ACTIVITY_ID, INTERVAL_ACTIVITY_LOCAL_DATE)

  // This leads because `derived.tags`
  // carries an `intervals` effort tag, not because of a manual-lap count -
  // 9 of this activity's 14 laps are `distance`-triggered reps, and the
  // 5 `manual` laps are the recoveries between them.
  const lapsTab = page.getByRole('tab', { name: /^Laps/ })
  await expect(lapsTab).toHaveText('Laps · 5 reps')
  await expect(lapsTab).toHaveAttribute('aria-selected', 'true')

  // lap_index 2, the first `R` in `-WRWRWRWRWR---`: avg_speed_mps 3.963,
  // which is 4:12/km - read positionally off `rep_pattern`, never
  // re-derived from lap speed or cadence (see splitsMath.ts and
  // docs/reference/frontend.md's "Traps").
  const firstRepRow = page.locator('tr[data-role="rep"]').first()
  await expect(firstRepRow).toContainText('Rep 1')
  await expect(firstRepRow).toContainText('4:12/km')
})

test('the pace panel does not spend its height on a standstill', async ({ page, request }) => {
  const streams = (await (await request.get(`/api/activities/${INTERVAL_ACTIVITY_ID}/streams`)).json()) as {
    speed_mps: (number | null)[]
    paused: (boolean | null)[]
    outage: (boolean | null)[]
  }
  const masked = streams.speed_mps.map((value, index) =>
    streams.paused[index] === true || streams.outage[index] === true ? null : value,
  )
  const nonNull = masked.filter((value): value is number => value !== null)
  if (nonNull.length === 0) throw new Error('fixture assumption: the reference activity has speed samples')
  const dataMin = Math.min(...nonNull)
  const dataMax = Math.max(...nonNull)

  // The same pure math the panel itself uses (see streamPanelMath.ts),
  // fed the same live data, so this expectation cannot drift from the
  // production code path - only from the response actually changing.
  const [scaleMin, scaleMax] = paceYRange(masked, streams.paused, streams.outage, dataMin, dataMax)
  const splits = paceAxisSplits(scaleMin, scaleMax)
  const topTickSpeed = splits.at(-1)
  if (topTickSpeed === undefined) {
    throw new Error('fixture assumption: the pace axis has at least one gridline')
  }
  const expectedTopTick = paceTick(topTickSpeed)

  await installCanvasSpy(page)
  await openActivityDetailByClicking(page, INTERVAL_ACTIVITY_ID, INTERVAL_ACTIVITY_LOCAL_DATE)

  const paceCanvas = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Pace', exact: true }) })
    .locator('canvas')
  await expect(paceCanvas).toBeVisible()
  // See the equivalent wait in "the weekly history marks the weeks with no
  // run" above - the same ResizeObserver settling concern applies here.
  await page.waitForTimeout(250)

  const canvasHandle = (await paceCanvas.elementHandle()) as ElementHandle<HTMLCanvasElement> | null
  if (canvasHandle === null) throw new Error('the pace panel never mounted a canvas')

  // Narrowed to the y-axis's own tick labels, which are `m:ss` strings.
  //
  // Two other pieces of text share this canvas and neither is a tick. The
  // average's value used to be drawn here as `avg 6:01/km` and is now
  // rendered in the panel's heading instead, in the DOM - see the
  // dashed-average test above. The axis labels added on 2026-09-03 (`min/km`
  // on the y axis, `Elapsed time` on the x) *are* drawn on canvas, by
  // uPlot's own axis renderer, and `min/km` sits at the very top of the
  // y-axis gutter - above every tick. Selecting on the tick's own shape
  // rather than excluding today's known non-ticks means a third such label
  // cannot silently become "the topmost tick" the way this one just did.
  //
  // This panel is also subject to the resize double-draw described in "the
  // weekly history marks the weeks with no run" above: measured directly,
  // the transient 600x240 layout and the settled one together draw 41
  // labels here, not the ~20 a single layout draws. Before `fillTextCalls`
  // isolated the latest draw generation, this specific assertion still
  // happened to land on the right answer regardless - the y-axis's tick
  // *values* do not depend on canvas width, so "4:00" is the smallest-y
  // label in both the transient and the settled draw, and picking the
  // global minimum across both finds it either way - but that was the
  // double-count passing by coincidence, not the test isolating one draw.
  // `fillTextCalls` now does that isolation itself, so `labels` here is one
  // draw's worth for the same reason "the weekly history" test's marks are.
  const labels = (await fillTextCalls(canvasHandle)).filter((call) => /^\d+:\d\d$/.test(call.text))
  expect(labels.length).toBeGreaterThan(0)
  // The topmost tick is whichever label has the smallest canvas y - y grows
  // downward, and a left-side y-axis's labels sit within the plot's
  // vertical span, strictly above the bottom-side x-axis's own row. No
  // assumption about uPlot's internal text alignment is needed beyond that.
  const topmost = labels.reduce((min, call) => (call.y < min.y ? call : min))
  expect(topmost.text).toBe(expectedTopTick)
  // Pinned directly too: measured 2026-08-25,
  // and this activity's recorded data does not change with the calendar.
  expect(topmost.text).toBe('4:00')
})

test('every stream chart is titled and its axes are labelled', async ({ page }) => {
  await installCanvasSpy(page)
  // The maintainer's item: "the graphs in the activities don't have titles,
  // or axis labels". Before this every chart section carried an `aria-label` and no
  // visible heading, and uPlot's `axis.label` was unset on all six axes.
  await page.goto(`/activities/${REFERENCE_ACTIVITY}`)
  await page.getByRole('heading', { name: 'Splits' }).waitFor()

  for (const title of ['Pace', 'Heart rate', 'Cadence', 'Elevation']) {
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  }

  // The axis labels are canvas text, so they are read back off the drawing
  // calls rather than the DOM - the same technique the pace-axis test uses.
  const paceSection = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Pace', exact: true }) })
  const canvas = paceSection.locator('canvas')
  await expect(canvas).toHaveCount(1)
  const handle = await canvas.elementHandle()
  if (handle === null) throw new Error('the pace panel drew no canvas')

  const drawn = (await fillTextCalls(handle as ElementHandle<HTMLCanvasElement>)).map((call) => call.text)
  // The unit on the y axis. `min/km` is the one unit that is not the stored
  // one: the axis is linear in speed and only its tick labels are pace.
  expect(drawn).toContain('min/km')

  // The quantity on the x axis. Beside the pinned desktop map the four
  // panels share one time axis and only the bottom one draws it (see
  // `activityMoment.spec.ts`), so it is read off the elevation panel.
  const elevationCanvas = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Elevation', exact: true }) })
    .locator('canvas')
  const elevationHandle = await elevationCanvas.elementHandle()
  if (elevationHandle === null) throw new Error('the elevation panel drew no canvas')
  const elevationDrawn = (await fillTextCalls(elevationHandle as ElementHandle<HTMLCanvasElement>)).map(
    (call) => call.text,
  )
  expect(elevationDrawn).toContain('Elapsed time')
})

test('the average is a dashed line with its value beside the chart, not printed over the trace', async ({ page }) => {
  await installCanvasSpy(page)
  // Two of the maintainer's items at once: the average should be dashed, and its
  // label used to be drawn inside the plot two pixels above the line, where
  // it collided with the trace on any run finishing near its own average.
  await page.goto(`/activities/${REFERENCE_ACTIVITY}`)
  const paceSection = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Pace', exact: true }) })
  await paceSection.locator('canvas').waitFor()

  // The value is in the DOM, where a canvas stroke cannot reach it. 6:40/km
  // is the speed trace's own mean; the header's 6:33/km is the run's
  // distance over its moving time (docs/reference/frontend.md).
  await expect(paceSection.getByText(/^average/)).toBeVisible()
  await expect(paceSection.getByText(/^average/)).toContainText('6:40/km')

  // And it is not drawn on the canvas at all any more.
  const handle = await paceSection.locator('canvas').elementHandle()
  if (handle === null) throw new Error('the pace panel drew no canvas')
  const drawn = (await fillTextCalls(handle as ElementHandle<HTMLCanvasElement>)).map((call) => call.text)
  expect(drawn.filter((text) => text.startsWith('avg '))).toHaveLength(0)
})

/**
 * A desktop window tall enough for the activity view's stream plots to be
 * their full 120px, the plot of the 200px panel the pace-axis tests below
 * were written against.
 *
 * Beside the pinned map the panels are compressed to fit four on one
 * screen (`views/ActivityDetail.module.css`'s `.pinned`), which at the
 * default 1280x720 leaves the pace plot 60px and a thinner ladder than the
 * one these tests pin. The plots are full height from a 960px window up.
 */
const FULL_HEIGHT_PANELS = { width: 1280, height: 1200 }

test('the pace axis labels never collide, and step evenly', async ({ page }) => {
  await installCanvasSpy(page)
  // The maintainer's item: "numbers shouldn't overlap". The cause is the
  // reciprocal - the axis is linear in speed and the labels are round
  // paces, so equal pace steps converge towards the slow end however good
  // the step is.
  await page.setViewportSize(FULL_HEIGHT_PANELS)
  await page.goto(`/activities/${REFERENCE_ACTIVITY}`)

  const paceLabels = await paceAxisLabels(page)
  expect(paceLabels.length).toBeGreaterThanOrEqual(2)

  // No two labels within one 12px em box of each other. Canvas coordinates
  // are scaled by the device pixel ratio and a font size is not, so the
  // gaps are converted before being compared against a font-derived
  // threshold - see `paceLabelGapsCss`.
  expect(Math.min(...(await paceLabelGapsCss(page, paceLabels)))).toBeGreaterThanOrEqual(14)

  // And they step evenly in pace, which greedy dropping would not do: on
  // this run it would keep 6:00, 7:00, 8:00, 9:00 and 11:00 and skip 10:00
  // for no reason a reader can see.
  const seconds = paceLabels.map((call) => {
    const [minutes, secs] = call.text.split(':')
    return Number(minutes) * 60 + Number(secs)
  })
  const steps = seconds.slice(1).map((value, i) => value - (seconds[i] ?? 0))
  expect(new Set(steps).size).toBe(1)
})

/**
 * The vertical gaps between consecutive pace-axis labels, in **CSS**
 * pixels.
 *
 * Everything the canvas spy records is in canvas coordinates, which uPlot
 * scales by the device pixel ratio; the 14px separation these gaps are
 * compared against is one CSS em box of uPlot's 12px axis font plus air.
 * At the default `deviceScaleFactor` of 1 the two units coincide, which is
 * exactly how a thinning bug that only bites on a HiDPI display survived
 * both this suite and the unit tests - so the conversion is explicit here
 * and the ratio is read from the browser rather than assumed.
 */
async function paceLabelGapsCss(page: Page, labels: { y: number }[]): Promise<number[]> {
  const ratio = await page.evaluate(() => window.devicePixelRatio)
  return labels.slice(1).map((call, i) => (call.y - (labels[i]?.y ?? 0)) / ratio)
}

/** The pace panel's y-axis tick labels, sorted down the axis. */
async function paceAxisLabels(page: Page): Promise<{ text: string; x: number; y: number }[]> {
  const paceSection = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Pace', exact: true }) })
  await paceSection.locator('canvas').waitFor()
  const handle = await paceSection.locator('canvas').elementHandle()
  if (handle === null) throw new Error('the pace panel drew no canvas')
  const ratio = await page.evaluate(() => window.devicePixelRatio)
  return (await fillTextCalls(handle as ElementHandle<HTMLCanvasElement>))
    .filter((call) => /^\d+:\d\d$/.test(call.text) && call.x < 60 * ratio)
    .sort((a, b) => a.y - b.y)
}

test.describe('on a HiDPI display', () => {
  test.use({ deviceScaleFactor: 2 })

  test('the pace axis labels still do not collide', async ({ page }) => {
    // The case a `deviceScaleFactor` of 1 cannot reach. `u.bbox.height` is
    // in canvas pixels, so at ratio 2 the plot's 140 CSS px measures 280
    // and every label gap doubles with it: the reference activity's
    // tightest 11.4 CSS px gap arrived at the thinning as 22.8, cleared the
    // 14px threshold, and nothing was thinned - while on screen the bottom
    // two labels overlapped exactly as the maintainer reported.
    await page.setViewportSize(FULL_HEIGHT_PANELS)
    await installCanvasSpy(page)
    await page.goto(`/activities/${REFERENCE_ACTIVITY}`)

    const paceLabels = await paceAxisLabels(page)
    expect(paceLabels.length).toBeGreaterThanOrEqual(2)
    expect(Math.min(...(await paceLabelGapsCss(page, paceLabels)))).toBeGreaterThanOrEqual(14)
  })
})

test('a splits table separates its laps by pace instead of drawing eight identical bars', async ({ page }) => {
  // The maintainer's item: "the bars are too even". Scaled to zero, this run's
  // eight laps (6:16 to 6:57 per kilometre) span 90.1% to 100.0% of their
  // cell - a 9.9-point spread nobody can read.
  await page.goto(`/activities/${REFERENCE_ACTIVITY}`)
  await page.getByRole('heading', { name: 'Splits' }).waitFor()
  await page.getByRole('tab', { name: /^Per km/ }).click()

  const bars = page.locator('tbody [data-testid="pace-bar"]')
  await expect(bars.first()).toBeVisible()
  const widths = await bars.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width))

  expect(widths.length).toBeGreaterThanOrEqual(4)
  const widest = Math.max(...widths)
  const narrowest = Math.min(...widths)
  // The widest bar is several times the narrowest, rather than within a
  // tenth of it.
  expect(widest / narrowest).toBeGreaterThan(3)
  // And the narrowest is still drawn, rather than being nothing at all.
  expect(narrowest).toBeGreaterThan(0)
})

test("a split's pace stays inside its own cell", async ({ page }) => {
  // The overlap in the maintainer's screenshot: the bar's width is a percentage of
  // its container, so the fastest split's bar filled the pace cell and
  // pushed the number out onto the heart-rate column under `nowrap`.
  await page.goto(`/activities/${REFERENCE_ACTIVITY}`)
  await page.getByRole('heading', { name: 'Splits' }).waitFor()

  const overflowing = await page.locator('table td').evaluateAll((cells) =>
    cells.filter((cell) => cell.scrollWidth > cell.clientWidth + 1).length,
  )
  expect(overflowing).toBe(0)
})

test('the zone distribution reads as rows with real durations, not a stretched bar', async ({ page }) => {
  // The maintainer's item: "the time in zone graph is ugly and too wide". The old
  // one set `preserveAspectRatio="none"` on a 101.5x10 viewBox rendered at
  // 1024x32, stretching its own digits 3.15x more horizontally than
  // vertically, and showed no durations at all.
  await page.goto(`/activities/${REFERENCE_ACTIVITY}`)
  const zones = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Time in zone' }) })
  await zones.getByRole('table').waitFor()

  // Six rows from the device's seven zones, each with its own boundary
  // range and duration. The band above the last boundary is not drawn: the
  // boundaries run to 207 against a configured maximum of 207, so it means
  // "above your own maximum" and held 0 s across all 223 activities with
  // zone data in the real export.
  await expect(zones.locator('tbody tr')).toHaveCount(6)
  await expect(zones.locator('tr[data-zone="6"]')).toHaveCount(0)
  await expect(zones.getByText('Z6')).toHaveCount(0)
  await expect(zones.locator('tr[data-zone="3"]')).toContainText('145-166')
  await expect(zones.locator('tr[data-zone="3"]')).toContainText('33:59')

  // **And this is not "hide an empty zone".** Zone 5 is empty on this
  // activity too and still reads as a zero, not as "none" - the maintainer's
  // annotation - because a run that never reached 186 bpm is a measurement
  // the reader should see. Only the unreachable band goes.
  await expect(zones.locator('tr[data-zone="5"]')).toContainText('0:00')

  // No SVG, so nothing can be non-uniformly scaled.
  await expect(zones.locator('svg')).toHaveCount(0)

  // The numbers right-align, which is what makes their tabular figures pay
  // off down a column. Declared unqualified (`.time`, `.share`), these lost
  // on specificity to the table's own `.table th, .table td` shorthand and
  // rendered left-aligned - the same class of defect as the alignment
  // assertion on the activities list below, so it is checked the same way.
  const alignments = await zones
    .locator('tr[data-zone="3"] td')
    .evaluateAll((cells) => cells.map((cell) => getComputedStyle(cell).textAlign))
  // Boundary range, bar, time, share.
  expect(alignments).toEqual(['left', 'left', 'right', 'right'])
})

test("an hour-plus zone total stays inside its own cell", async ({ page }) => {
  // The Time column is a fixed width under `table-layout: fixed`, and
  // `duration()` switches to `h:mm:ss` past an hour, so a column sized for
  // `mm:ss` spills the number into Share - the overlapping-numbers fault
  // this branch exists to fix, reintroduced. The Overview's zone rows are
  // the case that reaches it: they sum every activity in the store, so
  // their totals are the longest strings this table ever renders.
  await page.goto('/')
  const zones = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Time in zone' }) })
  await zones.getByRole('table').waitFor()

  const times = await zones.locator('tbody td.mono').evaluateAll((cells) =>
    cells
      .filter((cell) => /^\d+:\d\d(:\d\d)?$/.test(cell.textContent?.trim() ?? ''))
      .map((cell) => ({
        text: cell.textContent?.trim() ?? '',
        overflow: cell.scrollWidth - cell.clientWidth,
      })),
  )

  // The assertion is only meaningful if the wide form is actually on screen:
  // a store whose largest zone total is under an hour would pass a
  // too-narrow column for the wrong reason.
  expect(times.some((cell) => /^\d+:\d\d:\d\d$/.test(cell.text))).toBe(true)
  expect(times.filter((cell) => cell.overflow > 1)).toEqual([])
})

test('the route panel no longer wastes half its width', async ({ page }) => {
  // The maintainer's item: "there's lots of whitespace to the right of the route".
  // Measured before the change at full width: the panel rendered 1024x600
  // with the trace occupying 440x517, so 584px sat empty beside it.
  await page.goto(`/activities/${REFERENCE_ACTIVITY}`)
  // The trace's own SVG, visible or not. On a covered route with a fetched
  // basemap, `RouteMap` draws the same `Route` as its underlay and hides it
  // with `visibility` once the map has loaded, which keeps its box; the
  // visible "Route map" is then `RouteMap`'s empty label overlay, which has
  // no polyline to measure. The SVG is the one element that holds the
  // trace in both cases, before the map loads and after, and it is what
  // sizes the panel either way.
  const route = page.locator('svg[aria-label="Route map"]')
  await route.waitFor({ state: 'attached' })

  // The trace's group, not its first `<polyline>`: a run coloured by pace
  // draws one polyline per pace piece, and the first is a few seconds of
  // the run, 0.3% of the panel's width on this one.
  const measured = await route.evaluate((svg) => {
    const panel = svg.getBoundingClientRect()
    const trace = svg.querySelector('g')?.getBoundingClientRect()
    return { panelW: panel.width, traceW: trace?.width ?? 0 }
  })

  // The trace now fills most of the panel's width rather than under half.
  // Measured on this activity at 1280x720: 0.733, against 0.43 before the
  // change. It cannot reach 1.0 and should not - the viewBox carries a
  // deliberate pad so the trace never touches the panel's own edges.
  expect(measured.traceW / measured.panelW).toBeGreaterThan(0.65)
})

test('hovering a weekly bar reports that week, without resizing the chart', async ({ page }) => {
  // The maintainer's item: show the value of a bar on hover. The constraint is the
  // resize loop uPlot's own legend caused - a readout in normal flow beside
  // the observed box feeds its height back into `setSize` forever - so this
  // asserts the chart's height is unmoved after a hover sweep, which is the
  // half of that contract jsdom cannot check.
  await page.goto('/')
  const chart = chartSection(page, 'Last 12 weeks').locator('canvas')
  await chart.waitFor()

  const before = await chart.evaluate((el) => el.getBoundingClientRect().height)
  const plot = await plotArea(page, 'Last 12 weeks')

  const first = alongPlot(plot, 0.6)
  await page.mouse.move(first.x, first.y)
  // By its own test id, not by the "moving" line: that line renders only
  // for a period that had runs, and some of the current twelve weeks are
  // weeks off, so keying on it is a timebomb that fires when a zero-run
  // week next reaches whichever index the pointer lands on as the window
  // rolls forward - a calendar-dependent failure in a test about the
  // chart's height. The test id exists in every state.
  const readout = page.getByTestId('volume-readout')
  await expect(readout).toBeVisible()

  // Sweep across the whole plot: one legend-height per observation was the
  // original failure mode, so many hovers is the case that exposed it.
  for (let i = 0; i <= 15; i++) {
    const point = alongPlot(plot, i / 15)
    await page.mouse.move(point.x, point.y)
    await expect(readout).toBeVisible()
  }
  await expect(chart).toBeVisible()
  const after = await chart.evaluate((el) => el.getBoundingClientRect().height)
  expect(after).toBe(before)
})

test('the hover readout sits on the bar it describes, and never leaves the panel', async ({ page }) => {
  // Two faults at once, both invisible to jsdom because both are geometry.
  // `u.cursor.left` is measured from uPlot's plotting area, which it insets
  // by the y-axis gutter, while the readout is positioned against the
  // panel; passed through unshifted it sat about 50px - most of a bar - to
  // the left of the bar whose numbers it was showing. And centred on the
  // pointer with no clamp, half of it hung outside the panel at either end
  // of the chart, into a `.chart` that sets no `overflow`.
  await page.goto('/')
  const panel = chartSection(page, 'Last 12 weeks').locator('canvas')
  await panel.waitFor()

  const box = await panel.boundingBox()
  if (box === null) throw new Error('the weekly chart has no box')

  // Every pointer position here comes from the *plot area*, never from the
  // canvas box the panel's own bounds are measured against - see
  // `plotArea`, which is where that distinction is written down. The inset
  // it exists for is the very thing the offset half of this test is about.
  const plot = await plotArea(page, 'Last 12 weeks')

  /** The readout's box after moving the pointer `fraction` across the plot, in page coordinates. */
  const readoutAt = async (fraction: number): Promise<{ left: number; right: number; centre: number }> => {
    const point = alongPlot(plot, fraction)
    await page.mouse.move(point.x, point.y)
    // Located by its own test id rather than by the "moving" line it used
    // to be keyed on. That line only renders for a period that had runs,
    // and the clamp assertions below hover the first and *last* bars - some
    // of the current twelve weeks are weeks off, so keying on it made the
    // right-edge assertion unreachable rather than failing.
    const readout = page.getByTestId('volume-readout')
    await expect(readout).toBeVisible()
    const rect = await readout.boundingBox()
    if (rect === null) throw new Error('the readout has no box')
    return { left: rect.x, right: rect.x + rect.width, centre: rect.x + rect.width / 2 }
  }

  // Mid-plot, where no clamp applies: the readout is centred on the
  // pointer rather than a bar-width away from it.
  const middle = await readoutAt(0.5)
  expect(Math.abs(middle.centre - alongPlot(plot, 0.5).x)).toBeLessThan(8)

  // And at both extremes it stays inside the panel.
  for (const fraction of [0, 1]) {
    const readout = await readoutAt(fraction)
    expect(readout.left).toBeGreaterThanOrEqual(box.x - 1)
    expect(readout.right).toBeLessThanOrEqual(box.x + box.width + 1)
  }
})

test('the application never scrolls sideways on a phone-width viewport', async ({ page }) => {
  // Found in a browser sweep rather than reported: `AppShell`'s header was
  // a nowrap flex row whose brand and status were both `white-space:
  // nowrap`, giving it a 606px intrinsic floor that forced the whole
  // document wider at every viewport under it.
  await page.setViewportSize({ width: 390, height: 844 })

  // The content that carries each page's width, named per page rather than
  // as one union: the overview's is a chart canvas, the browser's is a feed
  // card, and the detail view's is the splits table - the widest thing on
  // the page and the one that actually caught the 429px document below. A
  // union locator would have been satisfied by the detail view's *route*
  // canvas, which arrives before the splits do, and the wait would have
  // gone quietly back to being the coin flip this comment exists about.
  const widthCarrier: [string, () => ReturnType<typeof page.locator>][] = [
    ['/', () => page.locator('canvas').first()],
    ['/activities', () => feedCards(page).first()],
    [`/activities/${REFERENCE_ACTIVITY}`, () => page.locator('tbody tr').first()],
  ]

  for (const [path, ready] of widthCarrier) {
    await page.goto(path)
    await page.locator('h1').first().waitFor()
    // An `<h1>` renders before the data does - every view on this list
    // paints its heading while its own requests are still in flight, and
    // the widest thing on each page arrives with those requests. Measuring
    // at the heading therefore measures a page that is not yet the page
    // the user sees, and the result is a coin flip rather than a check:
    // measured 3 passes and 1 failure over four isolated runs of this test
    // against the same build, with the failure reporting a 429px document
    // in a 390px viewport on the detail path and the passes catching that
    // same page before its splits table existed. So wait for the content
    // that carries the width, not just for the frame around it.
    await ready().waitFor()
    await page.waitForLoadState('networkidle')

    // Every element that overflows must be inside something that scrolls
    // it - the wide splits table is meant to scroll inside its own
    // wrapper, and that is not the same as the page sliding sideways.
    //
    // The whole document, not `main *`: `AppShell` puts `<header>` as a
    // *sibling* of `<main>`, so a query rooted at `main` never visits the
    // brand, the nav or the status - the three children whose nowrap
    // min-content sum was the measured 606px floor this test exists for.
    const escaping = await page.evaluate(() =>
      [...document.querySelectorAll('body *')].filter((el) => {
        if (el.getBoundingClientRect().right <= document.documentElement.clientWidth + 1) return false
        let ancestor = el.parentElement
        while (ancestor !== null) {
          if (['auto', 'scroll', 'hidden'].includes(getComputedStyle(ancestor).overflowX)) return false
          ancestor = ancestor.parentElement
        }
        return true
      }).length,
    )
    expect(escaping, `${path} has an element escaping the viewport`).toBe(0)
    // `scrollWidth`, not the body's own box. `body` is a block with `width:
    // auto` and `.shell`/`.header` are block-level flex containers, so
    // every one of those boxes stays at the width available however far its
    // items overflow: the pre-fix header widened the *document* while
    // `body.getBoundingClientRect().right` read 390 either way, making that
    // assertion a constant rather than a check.
    const overflow = await page.evaluate(() => ({
      scrollWidth: Math.round(document.documentElement.scrollWidth),
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(overflow.scrollWidth, `${path} scrolls sideways`).toBeLessThanOrEqual(overflow.clientWidth)
  }

  // Hovering is a state this test never used to enter, and the hover
  // readout is the one thing on the page that is positioned from a pointer
  // coordinate: unclamped, half of it hung past the panel's right edge into
  // a `.chart` with no `overflow`, which at this width is enough to widen
  // the document itself.
  await page.goto('/')
  const plot = await plotArea(page, 'Last 12 weeks')
  const readout = page.getByTestId('volume-readout')

  for (const fraction of [0, 0.5, 1]) {
    const point = alongPlot(plot, fraction)
    await page.mouse.move(point.x, point.y)
    // The readout has to actually be on screen for this to be measuring
    // anything. Positioned by fractions of the *canvas* instead, 0 and 1
    // both landed outside the plot area on a 390px viewport, where
    // `cursor.idx` is null and no readout renders - so the two positions
    // the clamp exists for asserted nothing at all, and only the midpoint,
    // where the clamp never binds, was ever exercised.
    await expect(readout).toBeVisible()
    const overflow = await page.evaluate(() => ({
      scrollWidth: Math.round(document.documentElement.scrollWidth),
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(
      overflow.scrollWidth,
      `hovering at ${String(fraction)} of the plot area widened the document`,
    ).toBeLessThanOrEqual(overflow.clientWidth)
  }
})

test('the activities list is scannable: short dates, aligned stat columns, no cadence or ascent', async ({ page }) => {
  // Phone width, because that is the width every claim in this test is
  // about. The table this feed replaced fitted two of its five columns at
  // 412px and hid the other three inside an unsignposted horizontal
  // scroller, so "scannable" was only ever true on a desktop.
  await page.setViewportSize({ width: 412, height: 900 })
  await page.goto('/activities')
  const cards = feedCards(page)
  await cards.first().waitFor()

  // Short, fixed-width stamps. It is the card's `<h2>` headline now rather
  // than a date cell, because the wall clock is the one thing that actually
  // differs between two of this athlete's runs - the 307 real runs hold
  // exactly two distinct names. The long form made the old column's width
  // swing between "Friday 21 August" and "Wednesday 26 August"; the same
  // argument now applies to a heading that has to sit beside two badges.
  const firstDate = await cards.first().getByRole('heading', { level: 2 }).innerText()
  expect(firstDate).toMatch(/^[A-Z][a-z]{2} \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}/)

  // Which fields exist, asked of the sort chips that replaced the sortable
  // column headers. One array in `Activities.tsx` drives both the chips and
  // the card's stat block, so a field cannot be sortable without being
  // shown or shown without being sortable - and that is exactly why asking
  // the chips is still asking about the card's contents.
  //
  // The active chip's rendered text carries the visually hidden direction
  // word that replaced `aria-sort` (a `columnheader` is the only thing that
  // can carry `aria-sort`, and there is no longer one), so it comes off
  // before the comparison - the caret beside it is drawn rather than a text
  // character and contributes nothing here. Lower-cased for the same reason
  // as before: the assertion is about which fields exist, not their casing.
  const chips = await page.getByRole('group', { name: 'Sort activities' }).getByRole('button').allInnerTexts()
  const trimmed = chips.map((text) => text.replace(/ascending|descending/g, '').trim().toLowerCase())
  expect(trimmed).toEqual(['date', 'distance', 'moving time', 'pace', 'heart rate'])

  // What replaced right-aligned cells.
  //
  // `Stat` sets `proportional-nums` and `text-align: start` on purpose - a
  // stat value is a headline number rather than a column entry, and tabular
  // figures buy alignment at the cost of fitting. The alignment the old
  // assertion was really about did not go away, it moved: the four stats
  // are a two-column grid, so every "Distance" value in the feed starts at
  // the same x as every other, and so does every "Moving time". That is the
  // property a reader scans down, and it is measured here rather than
  // inferred from a CSS declaration - measured 2026-09-13 at 412px, the
  // left column starts at x 41 and the right at x 214 on every card.
  const sampled = Math.min(await cards.count(), 5)
  expect(sampled).toBeGreaterThan(1)
  for (const label of ['Distance', 'Moving time', 'Pace', 'Heart rate']) {
    const xs: number[] = []
    for (let i = 0; i < sampled; i++) {
      const box = await cardStat(cards.nth(i), label).boundingBox()
      if (box === null) throw new Error(`the ${label} stat of card ${String(i)} has no box`)
      xs.push(Math.round(box.x))
    }
    expect(new Set(xs).size, `${label} does not start at one x down the feed: ${xs.join(', ')}`).toBe(1)
  }

  // And all five fields are on the phone, which is the whole point of the
  // rebuild: the table put Moving time, Pace and Heart rate off the right
  // edge at this width. Each value's own right edge, not the card's - a
  // card that fits while its contents are clipped inside it would pass a
  // check on the card alone.
  const viewportWidth = page.viewportSize()?.width ?? 0
  for (const label of ['Distance', 'Moving time', 'Pace', 'Heart rate']) {
    const box = await cardStat(cards.first(), label).boundingBox()
    if (box === null) throw new Error(`the ${label} stat has no box`)
    expect(box.x + box.width, `${label} runs off the right edge at phone width`).toBeLessThanOrEqual(
      viewportWidth,
    )
  }
})

test('the records view names a record per distance, with the jump-flagged efforts excluded', async ({
  page,
  request,
}) => {
  // The rule that decides these numbers is the analysis layer's, and it is
  // not a formality: the real export's five fastest 400 m efforts all carry
  // `contains_jump`, the quickest faster than anyone has run 400 m. This asserts against
  // the endpoint's own answer rather than a hardcoded time, so it stays true
  // if the athlete beats one - but it does pin the rule, by checking the
  // rendered 400 m record against the store's fastest *eligible* effort
  // rather than its fastest effort.
  const records = (await (await request.get('/api/records')).json()) as {
    items: { distance_key: string; elapsed_time_s: number; effort_count: number }[]
  }
  test.skip(records.items.length === 0, 'the store holds no eligible best efforts')

  await page.goto('/records')
  await page.getByRole('heading', { name: 'Records', level: 1 }).waitFor()

  // The ladder is a grouped inset list now, not a table: an `<ol>` under
  // its own uppercase band, because six equal columns is not a phone row
  // and the old table hid heart rate off the right edge behind an
  // `overflow-x` wrapper. `<ol>` rather than `<ul>` because the order is
  // data, which is what the next assertion checks.
  const rows = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Best efforts' }) })
    .getByRole('listitem')
  await expect(rows).toHaveCount(records.items.length)

  // Shortest distance first, so the ladder reads down. Through the rendered
  // label rather than the `data-distance-key` the rows used to carry: the
  // label is what a reader actually sees, `distanceKeyLabel` is one-to-one
  // over the store's keys, and this way the assertion also pins that a key
  // the label table does not list (the real export held nineteen against
  // the analysis layer's nine) still renders as something rather than nothing.
  //
  // The label is the first child of the row's own link, which is the one
  // thing about this row that is the same at both widths: above 60rem the
  // row flattens to a single line, but only `grid-template-areas` changes -
  // the DOM order, and so the reading order and the accessible name, are
  // identical. A first *line* of rendered text would not have been, and
  // this project runs its browser suite at desktop width.
  const renderedLabels = await rows.locator(':scope > * > *:first-child').allInnerTexts()
  expect(renderedLabels).toEqual(records.items.map((item) => distanceKeyLabel(item.distance_key)))

  // A pace beside every time, which is what makes the ladder comparable.
  const rowTexts = await rows.allInnerTexts()
  for (const [index, text] of rowTexts.entries()) {
    expect(text, `row ${String(index)} (${renderedLabels[index] ?? '?'}) has no pace`).toContain('/km')
  }

  // And the page says why a record can be slower than the fastest effort in
  // the store, rather than leaving a reader to distrust it. The page names
  // what the flag is defined on, an advance in the recorded distance, and
  // names no cause - see "The flag names no cause" in docs/reference/frontend.md.
  // `.first()` because the eligibility rule appears in the prose note and,
  // on an empty store, in the absence reason too.
  await expect(page.getByText(/jump in the recorded distance/i).first()).toBeVisible()
})

test('a record links to the activity that set it', async ({ page }) => {
  await page.goto('/records')

  // The whole row is the link, which is what the chevron on it means: a
  // 64 dp slot whose only hit target is a date string looks tappable and is
  // not. So this is the row's own link rather than a link inside a cell.
  const link = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Best efforts' }) })
    .getByRole('listitem')
    .first()
    .getByRole('link')
  await link.waitFor()
  const href = await link.getAttribute('href')
  expect(href).toMatch(/^\/activities\/[0-9a-f]{16}$/)

  await link.click()
  await expect(page.getByRole('heading', { name: 'Splits' })).toBeVisible()
})

test('the browser marks the runs that set records and can show only those', async ({
  page,
  request,
}) => {
  const withPr = (await (
    await request.get('/api/activities?sport=running&has_pr=true&limit=1')
  ).json()) as { total: number }
  const withoutPr = (await (
    await request.get('/api/activities?sport=running&has_pr=false&limit=1')
  ).json()) as { total: number }
  const all = (await (await request.get('/api/activities?sport=running&limit=1')).json()) as {
    total: number
  }
  // The two halves partition the list, which is what makes the filter a
  // filter rather than a search.
  expect(withPr.total + withoutPr.total).toBe(all.total)
  test.skip(withPr.total === 0, 'the store holds no personal records')

  await page.goto('/activities')
  const cards = feedCards(page)
  await cards.first().waitFor()
  await openFilters(page)
  await page.getByLabel('Records').selectOption('true')

  await expect(page).toHaveURL(/has_pr=true/)
  const badges = cards.locator('[title^="Personal record"]')
  await expect(badges.first()).toBeVisible()
  // Every visible card carries a badge, since every one of them set a record.
  await expect(badges).toHaveCount(await cards.count())
  // And the badge names the distances rather than saying only "PR" - one
  // fixture run, the interval session, set nine at once.
  expect(await badges.first().innerText()).toMatch(/^PR \S/)
})

test('the range filters take kilometres and minutes and put SI in the URL', async ({ page }) => {
  // The URL and the API carry metres and seconds like every other quantity
  // in this project; a reader thinks in kilometres and minutes. The
  // conversion happens once, at the control, so a shared link and an API
  // request say the same thing.
  await page.goto('/activities')
  const cards = feedCards(page)
  await cards.first().waitFor()
  const unfiltered = await cards.count()
  await openFilters(page)

  await page.getByLabel('Distance, minimum').fill('8')
  await expect(page).toHaveURL(/min_distance_m=8000/)
  await expect(cards.first()).toBeVisible()
  const filtered = await cards.count()
  expect(filtered).toBeLessThanOrEqual(unfiltered)

  // Every remaining card really is at least 8 km. By the stat's own label
  // rather than by an `nth-child` position: the four stats are a 2x2 block
  // and their order is a layout decision, so a positional selector here
  // would be asserting the distance against whichever number happened to
  // sit second - which is how this file's selectors became fragile in the
  // first place.
  const distances = await cardStat(cards, 'Distance').allInnerTexts()
  expect(distances).toHaveLength(filtered)
  for (const text of distances) {
    expect(Number.parseFloat(text)).toBeGreaterThanOrEqual(8)
  }

  await page.getByLabel('Moving time, minimum').fill('60')
  await expect(page).toHaveURL(/min_moving_time_s=3600/)

  // A handle back at its bottom stop removes the filter rather than setting
  // it to zero, which would look identical until the URL is shared.
  await page.getByLabel('Distance, minimum').fill('0')
  await expect(page).not.toHaveURL(/min_distance_m/)
})

test('the distance slider\'s top stop means "and above" and removes the bound', async ({ page }) => {
  // Six of the 307 runs of the real export are longer than 20 km, so a
  // slider that capped at its top stop would hide real runs from a reader
  // who had asked for none to be hidden. The label says so.
  await page.goto('/activities?max_distance_m=12000')
  await feedCards(page).first().waitFor()
  await openFilters(page)

  await page.getByLabel('Distance, maximum').fill('20')
  await expect(page).not.toHaveURL(/max_distance_m/)
  await expect(page.getByText('20 km+')).toBeVisible()
})

test('the pace chip sorts fastest first and says so with its arrow', async ({ page }) => {
  await page.goto('/activities')
  const cards = feedCards(page)
  await cards.first().waitFor()

  // The sort left the table header for a chip row under the title, and the
  // chip is still a button named for its field - so this selector is one of
  // the few in this file the rebuild did not touch.
  const paceChip = page.getByRole('button', { name: /^Pace/ })
  await paceChip.click()
  // Sorted by the speed pace is the reciprocal of - no pace is stored.
  await expect(page).toHaveURL(/sort=avg_speed_mps/)
  await expect(page).toHaveURL(/order=desc/)

  // The arrow describes the field's own unit, not the query's direction: a
  // caret pointing down here would say the slowest run is on top while the
  // fastest one is.
  //
  // It is a drawn caret now rather than the text character `▲`, so this
  // asks the two things that actually decide which way it points: the
  // `data-direction` the component sets from its one `sortState` call, and
  // the rotation the stylesheet keys off it. The path itself is drawn
  // pointing down and `ascending` turns it through 180°, so the computed
  // transform is the assertion that the reader sees an up-caret - a
  // `data-direction` that no rule acted on would otherwise pass this.
  const mark = paceChip.locator('svg[data-direction]')
  await expect(mark).toHaveAttribute('data-direction', 'ascending')
  const rotation = await mark.evaluate((el) => getComputedStyle(el).transform)
  expect(rotation, 'the ascending caret is not turned through 180°').toBe('matrix(-1, 0, 0, -1, 0, 0)')
  // `aria-sort` is the one thing a table's death took with it - only a
  // `columnheader` can carry it. Two things from the same single
  // `sortState` call replace it, so they cannot disagree: the pressed state
  // and a visually hidden direction word in the chip's accessible name.
  // "ascending", under `order=desc`, because descending speed is ascending
  // pace - the same inversion the arrow above states.
  await expect(paceChip).toHaveAttribute('aria-pressed', 'true')
  await expect(paceChip).toHaveAccessibleName('Pace ascending')

  // And the rendered paces really do ascend down the page, ignoring the
  // cards with no recorded speed.
  const paces = (await cardStat(cards, 'Pace').allInnerTexts())
    .map((text) => /^(\d+):(\d\d)/.exec(text.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]) * 60 + Number(match[2]))
  expect(paces).toEqual([...paces].sort((a, b) => a - b))
})

test('the detail view says where the run happened', async ({ page, request }) => {
  // Resolved offline from the first fixed position against a bundled
  // GeoNames extract, because a real store's positions are where its athlete
  // runs and a geocoding API would send them to a third party - the same
  // reasoning that keeps a fetched basemap's requests on the app's origin.
  const detail = (await (await request.get(`/api/activities/${REFERENCE_ACTIVITY}`)).json()) as {
    derived: { metrics: { locality: string | null; country: string | null } } | null
  }
  const locality = detail.derived?.metrics.locality
  test.skip(locality === null || locality === undefined, 'this activity has no resolved place')

  await page.goto(`/activities/${REFERENCE_ACTIVITY}`)
  await page.getByRole('heading', { name: 'Route' }).waitFor()
  await expect(page.getByText(locality as string, { exact: false }).first()).toBeVisible()
})

test('a treadmill run says nothing about where it happened, rather than guessing', async ({
  page,
}) => {
  // It has no position at all - 86 of the 307 runs of the real export are
  // in that position, and an invented place would be worse than none.
  const real = await asTreadmillRun(page, TREADMILL_ACTIVITY_ID)
  await page.goto(`/activities/${TREADMILL_ACTIVITY_ID}`)
  await page.getByRole('heading', { name: 'Route' }).waitFor()
  await expect(page.getByText(/footpod rather than GPS/)).toBeVisible()

  // Not the place the outdoor run this was made from really has, so the
  // view is not reading it from anywhere but the detail it was served.
  expect(real.country).not.toBe('')
  const header = page.locator('header').last()
  await expect(header).not.toContainText(real.locality)
  await expect(header).not.toContainText(real.country)
  await expect(header).not.toContainText('near ')
})

test('a trend chart labels a band that contains every mark it draws', async ({ page }) => {
  // The coverage gap this closes was a real bug, twice over. `paddedRange`
  // returned a *range* and left the ticks to uPlot, which places nice
  // increments inside a range - a different question from covering one - so
  // the two diverged: measured on the heart rate chart of the real export,
  // the lowest labelled rule sat above the lowest marks by more than a third
  // of the rules' own span, leaving that data with no rule and no label
  // under it.
  // Nothing in this suite would have caught it, because an axis tick on a
  // uPlot chart is only ever a pixel.
  //
  // `axisScale` now solves the bounds and the ticks together, and this is
  // the end-to-end statement of what that guarantees: every mark drawn sits
  // inside the labelled band. It reads both off the canvas rather than off
  // the source that produced them.
  await installCanvasSpy(page)
  await page.goto('/trends')

  const chart = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Heart rate at the reference paces' }) })
    .locator('canvas')
  await expect(chart).toBeVisible()
  // The same ResizeObserver settling wait the other canvas tests take; see
  // "the weekly history marks the weeks with no run" above.
  await page.waitForTimeout(400)

  const canvasHandle = (await chart.elementHandle()) as ElementHandle<HTMLCanvasElement> | null
  if (canvasHandle === null) throw new Error('the heart rate trend never mounted a canvas')

  // The y ticks are the only text on this canvas shaped `<number> bpm`: the
  // x axis draws `Mon YYYY` and there is no axis title on any trend chart.
  const ticks = (await fillTextCalls(canvasHandle)).filter((call) => /^\d+ bpm$/.test(call.text))
  expect(ticks.length).toBeGreaterThanOrEqual(3)

  // Every mark is an `arc`: the series is a scatter, and the one other arc
  // on the canvas is the latest-observation marker, which is a mark too.
  const marks = await arcCalls(canvasHandle)
  expect(marks.length).toBeGreaterThan(0)

  // A tick's text is drawn on its own baseline, so the topmost tick has the
  // smallest y and the bottommost the largest. Canvas y grows downward, so
  // the labelled band runs from the topmost tick's y to the bottommost's.
  const tickYs = ticks.map((t) => t.y)
  const bandTop = Math.min(...tickYs)
  const bandBottom = Math.max(...tickYs)

  // A tick's baseline sits a little below the rule it names, because text is
  // drawn from its baseline rather than its centre. Half a line of the 11px
  // axis font at this device pixel ratio is the tolerance that buys back,
  // measured rather than guessed: the alternative is asserting nothing at
  // the two ends, which is exactly where the bug was.
  const ratio = await page.evaluate(() => window.devicePixelRatio)
  const baselineSlack = 6 * ratio

  for (const mark of marks) {
    expect(mark.y).toBeGreaterThanOrEqual(bandTop - mark.radius - baselineSlack)
    expect(mark.y).toBeLessThanOrEqual(bandBottom + mark.radius + baselineSlack)
  }
})
