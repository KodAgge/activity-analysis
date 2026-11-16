import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Clicks one of the header's PDF buttons with the print dialog stubbed
 * out, then lays the page out for paper. `afterprint` never fires under the
 * stub, so the mode the button set holds while the test reads the page.
 * The plan's two PDFs are in the `Print or save as PDF` group, the next
 * week's in the group named after it.
 */
async function printFromButton(
  page: Page,
  button: 'As shown' | 'With every session' | 'PDF',
  group = 'Print or save as PDF',
): Promise<void> {
  await page.evaluate(() => {
    window.print = () => undefined
  })
  await page.getByRole('group', { name: group }).getByRole('button', { name: button, exact: true }).click()
  await page.emulateMedia({ media: 'print' })
}

/**
 * The plan view as it prints. The e2e store holds one accepted plan, seeded
 * by `scripts/e2e-api-server.mjs` from `tests/fixtures/plan-draft.json`; the
 * browser's clock is fixed so the page does not drift with the calendar.
 */
test('the plan prints without navigation and with the whole calendar', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-29T12:00:00'))
  await page.goto('/plan')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.setViewportSize({ width: 794, height: 1123 })
  await page.emulateMedia({ media: 'print' })

  await expect(page.getByRole('navigation')).toBeHidden()
  await expect(page.getByRole('group', { name: 'Print or save as PDF' })).toBeHidden()
  // The grid, never the phone list, with all five weeks.
  const rows = page.getByRole('row').filter({ has: page.getByRole('rowheader') })
  await expect(rows).toHaveCount(5)
  for (let i = 0; i < 5; i++) await expect(rows.nth(i)).toBeVisible()

  // The charts redraw at print width, so their drawing is 1:1 with the page
  // rather than shrunk from the screen's width.
  const widths = await page.locator('svg[viewBox]').evaluateAll((els) =>
    els.map((el) => Number(el.getAttribute('viewBox')?.split(' ')[2])).filter((w) => w > 100),
  )
  expect(widths.length).toBeGreaterThan(1)
  for (const w of widths) expect(w).toBeLessThanOrEqual(700)

  const pdf = await page.pdf({ format: 'A4' })
  expect(pdf.length).toBeGreaterThan(10_000)
})

test('the plan has a button on screen for each of its two PDFs', async ({ page }) => {
  await page.goto('/plan')
  const pdf = page.getByRole('group', { name: 'Print or save as PDF' })
  await expect(pdf.getByRole('button')).toHaveText(['As shown', 'With every session'])
})

test('the short PDF prints the page as shown, without the session details', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-29T12:00:00'))
  await page.goto('/plan')
  const goal = await page.getByRole('heading', { level: 1 }).textContent()
  await printFromButton(page, 'As shown')

  expect(await page.title()).toBe(`Plan, ${goal ?? ''}`)
  const appendix = page.getByRole('heading', { level: 2, name: 'Session details' })
  await expect(appendix).toBeHidden()
  await expect(page.getByRole('heading', { level: 2, name: 'Next session' })).toBeVisible()
  // The assessment's reasoning stays closed, as on screen.
  await expect(page.getByText('A synthetic estimate for the end-to-end store.')).toBeHidden()

  // The page is put back once the dialog closes, and a print from the
  // browser's own menu, which sets no mode, is the short one too.
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
  expect(await page.title()).toBe('activity-analysis')
  await expect(appendix).toBeHidden()
})

test('the week PDF prints the header and the next week only', async ({ page }) => {
  // A Saturday: the next week is the one starting on Monday 31 August.
  await page.clock.setFixedTime(new Date('2026-08-29T12:00:00'))
  await page.goto('/plan')
  const goal = await page.getByRole('heading', { level: 1 }).textContent()
  const week = page.getByRole('heading', { level: 2, name: 'Week of 31 Aug to 6 Sep' })
  await expect(week).toBeHidden()

  await printFromButton(page, 'PDF', 'Week of 31 Aug')
  expect(await page.title()).toBe(`Plan, ${goal ?? ''}, week of 31 Aug`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(week).toBeVisible()
  const section = page.locator('section', { has: week })
  await expect(section).toContainText('Build. Test where the athlete stands')
  await expect(section.getByRole('heading', { level: 3 })).toHaveText([
    'Easy run',
    'Five kilometre time trial',
    'Long run',
  ])
  await expect(section.getByRole('img', { name: /^Workout profile: / })).toHaveCount(3)
  // Nothing else of the page is on the paper.
  for (const name of ['Next session', 'Assessment', 'Weekly distance', 'Session details']) {
    await expect(page.getByRole('heading', { level: 2, name })).toBeHidden()
  }
  await expect(page.getByRole('table')).toBeHidden()

  await expect(page.locator('footer')).toHaveCount(1)
  await expect(page.locator('footer')).toBeHidden()

  // The header and three sessions fill two pages, with no blank one after.
  const pdf = await page.pdf({ format: 'A4' })
  expect(pdf.toString('latin1').match(/\/Count (\d+)/)?.[1]).toBe('2')
})

test('the next week copies as text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.clock.setFixedTime(new Date('2026-08-29T12:00:00'))
  await page.goto('/plan')
  const group = page.getByRole('group', { name: 'Week of 31 Aug' })
  await group.getByRole('button', { name: 'Copy as text' }).click()
  await expect(group.getByRole('button', { name: 'Copied' })).toBeVisible()

  const text = await page.evaluate(() => navigator.clipboard.readText())
  expect(text).toMatch(/^5 km under 25:00, week of 31 Aug to 6 Sep\nBuild\. Test where the athlete stands/)
  expect(text).toContain('\n\nThursday 3 September · Time trial · Five kilometre time trial\n')
  expect(text).toContain('\nSteps:\n- Warm-up ')
})

test('a session opens from the calendar, gives its instructions and closes with Escape', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-29T12:00:00'))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/plan')

  // Opened from the keyboard: the session is a native button.
  const session = page.getByRole('button', { name: /^Tuesday 25 August, Intervals: Intervals/ })
  await session.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Intervals' })
  await expect(dialog).toBeVisible()
  await expect(page).toHaveURL(/[?&]session=2026-08-25-intervals/)
  // The description as its blocks: a label over its list.
  await expect(dialog.getByRole('list', { name: 'Main set' })).toContainText('Six repeats of one kilometre')
  // The work step's 3.6 to 3.8 m/s, as paces and as treadmill km/h.
  const steps = dialog.getByRole('list', { name: 'Steps' }).getByRole('listitem')
  await expect(steps).toHaveCount(4)
  await expect(steps.nth(1)).toContainText('4:23-4:38/km')
  await expect(steps.nth(1)).toContainText('13.0-13.7 km/h')
  // Focus is trapped in the open dialog, starting on Close.
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused()
  // The workout profile: the session in words, six reps among its segments.
  await expect(dialog.getByRole('img', { name: /^Workout profile: warm-up .*6 × 1 km at 4:23-4:38\/km/ })).toBeVisible()
  await expect(dialog.locator('[data-mark="segment"][data-role="work"]')).toHaveCount(6)

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page).not.toHaveURL(/session=/)
  await expect(session).toBeFocused()
})

test("the browser's back button closes a session, and its link opens it", async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-29T12:00:00'))
  await page.goto('/plan')
  await page.getByRole('button', { name: /^Thursday 3 September, Time trial/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Five kilometre time trial' })
  await expect(dialog).toBeVisible()

  await page.goBack()
  await expect(dialog).toBeHidden()
  await expect(page).not.toHaveURL(/session=/)

  await page.goto('/plan?session=2026-09-03-time-trial')
  await expect(dialog).toBeVisible()
  await page.goto('/plan?session=no-such-session')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('every session has a profile: a sparkline in the calendar, strides as spikes in the detail', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-29T12:00:00'))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/plan')
  const sessions = page.locator('button[data-session-id]')
  await expect(sessions).toHaveCount(11)
  await expect(page.locator('button[data-session-id] svg[aria-hidden="true"]')).toHaveCount(11)

  await page.getByRole('button', { name: /^Friday 18 September, Strides/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Easy run with strides' })
  await expect(dialog.getByRole('img', { name: /^Workout profile: 4 km at .*, 4 × 20 s strides\.$/ })).toBeVisible()
  await expect(dialog.locator('[data-mark="segment"][data-role="strides"]')).toHaveCount(4)
  // Keyed by effort, the hard running first: the strides, then the 4 km at easy pace as easy running.
  await expect(dialog.getByRole('list', { name: 'Key' }).getByRole('listitem')).toHaveText(['Strides', 'Easy running'])
  // A pointer over the profile reads the step out.
  const plot = dialog.getByRole('group', { name: 'Workout steps' })
  const box = await plot.boundingBox()
  if (box === null) throw new Error('the profile has no box')
  await page.mouse.move(box.x + 20, box.y + box.height / 2)
  await expect(dialog.getByTestId('profile-readout')).toContainText('Work')
})

test('on a phone the detail fills the screen', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-29T12:00:00'))
  // Short enough that the intervals' detail scrolls.
  await page.setViewportSize({ width: 390, height: 600 })
  await page.goto('/plan?session=2026-08-25-intervals')
  const dialog = page.getByRole('dialog', { name: 'Intervals' })
  await expect(dialog).toBeVisible()
  const box = await dialog.boundingBox()
  expect(box).toMatchObject({ x: 0, y: 0, width: 390, height: 600 })
  // The sheet scrolls here, and a scroller is focusable in Chromium, so
  // without a hand it takes the dialog's first focus and draws a ring.
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused()
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
  await expect(page).not.toHaveURL(/session=/)
})

test('the session details print after the calendar in the long PDF and are hidden on screen', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-29T12:00:00'))
  await page.goto('/plan')
  const appendix = page.getByRole('heading', { level: 2, name: 'Session details' })
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(appendix).toBeHidden()
  // Its profiles are not rendered on screen, so they add no tab stops.
  const printed = page
    .locator('section', { has: page.getByRole('heading', { level: 2, name: 'Session details', includeHidden: true }) })
    .getByRole('group', { name: 'Workout steps', includeHidden: true })
  await expect(printed).toHaveCount(11)
  const reachable = await printed.evaluateAll((els) =>
    els.filter((el) => {
      ;(el as HTMLElement).focus()
      return el.checkVisibility() || document.activeElement === el
    }).length,
  )
  expect(reachable).toBe(0)

  await printFromButton(page, 'With every session')
  expect(await page.title()).toMatch(/^Plan, .+, every session$/)
  await expect(appendix).toBeVisible()
  const section = page.locator('section', { has: appendix })
  // Every session of the four written-out weeks, in date order.
  await expect(section.getByRole('heading', { level: 3 })).toHaveText([
    'Easy run',
    'Long run',
    'Intervals',
    'Tempo run',
    'Long run',
    'Easy run',
    'Five kilometre time trial',
    'Long run',
    'Easy run',
    'Easy run with strides',
    'Race day',
  ])
  await expect(section.getByRole('list', { name: 'Main set' }).first()).toContainText('Six repeats of one kilometre')
  // Each prints its workout profile.
  await expect(section.getByRole('img', { name: /^Workout profile: / })).toHaveCount(11)
})

test('the assessment shows its verdict, keeps it closed on screen, and the long PDF prints it', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-29T12:00:00'))
  await page.goto('/plan')
  const assessment = page.locator('section', { has: page.getByRole('heading', { level: 2, name: 'Assessment' }) })
  await expect(assessment.getByRole('list', { name: 'Verdict' })).toBeVisible()
  const why = assessment.locator('details')
  await expect(why.locator('summary')).toHaveText('Why this verdict')
  await expect(why).not.toHaveAttribute('open')
  const reasoning = assessment.getByText('A synthetic estimate for the end-to-end store.')
  const stand = assessment.getByRole('list', { name: 'Where you stand' })
  await expect(reasoning).toBeHidden()
  await expect(stand).toBeHidden()

  // Closed still, but the long PDF carries the reasoning.
  await printFromButton(page, 'With every session')
  await expect(why).not.toHaveAttribute('open')
  await expect(reasoning).toBeVisible()
  await expect(stand).toBeVisible()
})

test('the phase strip, the intensity mix and the target paces draw the plan', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-29T12:00:00'))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/plan')

  // Base, build and taper, adjacent weeks of one phase merged.
  const phases = page.getByRole('img', { name: /^Plan phases/ })
  await expect(phases).toBeVisible()
  await expect(phases.locator('[data-mark="phase"]')).toHaveCount(3)
  await expect(phases.locator('[data-mark="checkpoint"]')).toHaveCount(1)
  await expect(phases.locator('[data-mark="race"]')).toHaveCount(1)
  await expect(phases.locator('[data-mark="today"]')).toHaveCount(1)

  // Five weeks, the outline week one hatched bar.
  const mix = page.getByRole('img', { name: /^Weekly intensity mix/ })
  await expect(mix).toBeVisible()
  await expect(mix.locator('[data-segment="outline"]')).toHaveCount(1)
  await expect(mix.locator('[data-week="2"][data-segment="quality"]')).toHaveCount(1)
  await expect(mix.locator('[data-week="3"][data-segment="race"]')).toHaveCount(1)

  // The intervals' one work step with a speed, against the goal's 5:00/km.
  const paces = page.getByRole('img', { name: /^Target paces/ })
  await expect(paces).toBeVisible()
  await expect(paces.locator('[data-mark="pace"]')).toHaveCount(1)
  await expect(paces.getByText('Goal 5:00/km')).toBeVisible()
})

test('the weeks before the plan stack the runs by the tags the app gave them', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-29T12:00:00'))
  await page.setViewportSize({ width: 1280, height: 900 })
  // The fixture runs all fall inside the plan, so the lead-in's request is
  // answered with them moved eight weeks back, each with the tags the
  // store's own list served it.
  await page.route(/\/api\/activities\?.*from=2026-06-22/, async (route) => {
    const url = new URL(route.request().url())
    url.searchParams.set('from', '2026-08-17')
    url.searchParams.set('to', '2026-08-31')
    const response = await route.fetch({ url: url.toString() })
    const page_ = (await response.json()) as { items: { start_time_utc: string }[] }
    const weeksBack = 8 * 7 * 24 * 3600 * 1000
    for (const item of page_.items) {
      item.start_time_utc = new Date(Date.parse(item.start_time_utc) - weeksBack).toISOString()
    }
    await route.fulfill({ response, json: page_ })
  })
  const details: string[] = []
  page.on('request', (request) => {
    if (/\/api\/activities\/[^/?]+$/.test(new URL(request.url()).pathname)) details.push(request.url())
  })
  await page.goto('/plan')

  const leadIn = page.locator('section', { has: page.getByRole('heading', { level: 2, name: 'The 8 weeks before the plan' }) })
  const chart = leadIn.getByRole('img', { name: /^Run distance per week/ })
  await expect(chart).toBeVisible()
  // The stat row over the chart: the weeks summed up, each figure under its label.
  await expect(leadIn.getByText('Runs a week')).toBeVisible()
  await expect(leadIn.getByText('Longest run')).toBeVisible()
  await expect(chart.locator('[data-slot]')).toHaveCount(8)
  // Every fixture run carries an effort tag on the list, so none is
  // drawn unclassified, and no run's detail is asked for.
  await expect(chart.locator('[data-segment]').first()).toBeVisible()
  await expect(chart.locator('[data-segment="unclassified"]')).toHaveCount(0)
  expect(details).toEqual([])
})

test('the weekly load, the heart-rate mix and the VO2max outlook draw the plan, and a session states its ceiling', async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date('2026-08-29T12:00:00'))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/plan')

  // The fixture runs carry a TRIMP but give no threshold estimate, so the
  // version has no TRIMP per minute stamp: the two weeks begun by the fixed
  // day draw run bars and none draws a planned bar, which the chart says.
  const load = page.getByRole('img', { name: /^Weekly load/ })
  await expect(load).toBeVisible()
  await expect(load.locator('[data-bar="run"]')).toHaveCount(2)
  await expect(load.locator('[data-bar="planned"]')).toHaveCount(0)
  const loadSection = page.locator('section', { has: page.getByRole('heading', { level: 2, name: 'Weekly load' }) })
  await expect(loadSection.getByRole('status').filter({ hasText: 'This version predates planned TRIMP' })).toBeVisible()

  // The four weeks that had not ended when the plan was written carry zone
  // minutes; the first had, and is frozen without them. Week 2 plans 130,
  // 20 and 30 minutes: three bands.
  const mix = page.getByRole('img', { name: /^Heart-rate mix/ })
  await expect(mix.locator('[data-bar="planned"][data-week="1"]')).toHaveCount(0)
  await expect(mix.locator('[data-bar="planned"][data-week="2"]')).toHaveCount(3)

  // VDOT and Garmin's own, the target, the estimate and the four expected weeks.
  const outlook = page.getByRole('img', { name: /^VO2max outlook/ })
  await expect(outlook.locator('[data-panel]')).toHaveCount(2)
  await expect(outlook.locator('[data-panel="vdot"] [data-mark="target"]')).toHaveCount(1)
  await expect(outlook.locator('[data-panel="vdot"] [data-mark="measured"]')).toHaveCount(1)
  await expect(outlook.locator('[data-panel="vdot"] [data-mark="expected"] circle')).toHaveCount(4)

  await page.goto('/plan?session=2026-09-01-easy')
  const dialog = page.getByRole('dialog', { name: 'Easy run' })
  await expect(dialog.getByRole('list', { name: 'Steps' })).toContainText('up to 150 bpm')
})

test('a version stamped with a TRIMP per minute draws its planned load', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-29T12:00:00'))
  await page.setViewportSize({ width: 1280, height: 900 })
  // The fixture store gives no threshold estimate, so its version has no
  // stamp; the plan's detail is answered with one on every version.
  await page.route(/\/api\/plans\/[^/?]+$/, async (route) => {
    const response = await route.fetch()
    const detail = (await response.json()) as { versions: { plan: { provenance: Record<string, unknown> } }[] }
    for (const version of detail.versions) version.plan.provenance.trimp_per_minute = [1, 1.5, 2, 2.5, 3]
    await route.fulfill({ response, json: detail })
  })
  await page.goto('/plan')

  // The four weeks with zone minutes each draw a planned bar, and the
  // section has nothing to explain.
  const loadSection = page.locator('section', { has: page.getByRole('heading', { level: 2, name: 'Weekly load' }) })
  const load = loadSection.getByRole('img', { name: /^Weekly load/ })
  await expect(load).toBeVisible()
  await expect(load.locator('[data-bar="planned"]')).toHaveCount(4)
  await expect(loadSection.getByRole('status')).toHaveCount(0)
})

test('fitness and fatigue draw the measured weeks, and say why nothing is expected', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-29T12:00:00'))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/plan')

  // The fixture store gives no threshold estimate, so `propose` priced no
  // week and stamped no expected load; the fixture runs' weeks are measured.
  const section = page.locator('section', {
    has: page.getByRole('heading', { level: 2, name: 'Fitness and fatigue', exact: true }),
  })
  const chart = section.getByRole('img', { name: /^Fitness and fatigue/ })
  await expect(chart).toBeVisible()
  await expect(chart.locator('[data-panel="load"] [data-mark="measured"]')).toHaveCount(1)
  await expect(chart.locator('[data-mark="expected"]')).toHaveCount(0)
  await expect(section.getByRole('status')).toContainText('This version carries no expected fitness and fatigue')
})

test("the week PDF opens with the week's load note", async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-29T12:00:00'))
  await page.goto('/plan')
  await printFromButton(page, 'PDF', 'Week of 31 Aug')

  // The fixture store gives no threshold estimate, so the version carries no
  // expected load: the note stands alone, with no table or chart, above the
  // first session.
  const section = page.locator('section', {
    has: page.getByRole('heading', { level: 2, name: 'Week of 31 Aug to 6 Sep' }),
  })
  const note = section.getByText('The time trial is the week')
  await expect(note).toBeVisible()
  await expect(section.getByRole('table', { name: 'Fitness and fatigue over the week' })).toHaveCount(0)
  const noteBox = await note.boundingBox()
  const firstSession = await section.getByRole('heading', { level: 3 }).first().boundingBox()
  expect(noteBox?.y ?? Infinity).toBeLessThan(firstSession?.y ?? 0)
})
