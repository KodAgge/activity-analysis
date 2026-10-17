import { expect, test, type Page } from '@playwright/test'

/**
 * Each stream panel's line is the mean of its own trace, and the pace panel
 * says why that differs from the header's Pace; see
 * docs/reference/frontend.md. The reference run is
 * the 2026-08-28 fixture: its header reads
 * 6:33/km over 7.46 km and its speed trace averages 6:40/km, 7.33 km over
 * the same moving time.
 */
const REFERENCE_RUN = '854fd775d479ca9f'

/** The run `activityMoment.spec.ts` checks the desktop stack on. */
const STACK_RUN = '174c6a0e5af5c4b4'

const paceSection = (page: Page) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: 'Pace', exact: true }) })

test("the pace legend reads the trace's mean and the note names both distances", async ({ page }) => {
  await page.goto(`/activities/${REFERENCE_RUN}`)
  const section = paceSection(page)
  await section.locator('canvas').waitFor()
  await expect(section.getByText(/^average/)).toContainText('6:40/km')
  await expect(
    section.getByText(
      "The line averages the watch's speed reading, which covers 7.33 km in the moving time; the 6:33/km pace above uses the run's 7.46 km.",
    ),
  ).toBeVisible()
})

test('the desktop stack still fits one screen with the note shown', async ({ page }) => {
  // activityMoment.spec.ts's fit test runs on this run; this pins that the
  // run shows a note, so that test exercises the note's height.
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/activities/${STACK_RUN}`)
  await page.getByRole('region', { name: 'Route', exact: true }).waitFor()
  const section = paceSection(page)
  await expect(section.getByText(/^The line averages/)).toBeVisible()
  await section.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  const top = (await section.boundingBox())!.y
  const elevation = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Elevation', exact: true }) })
  const bottom = (await elevation.boundingBox())!
  expect(top).toBeGreaterThanOrEqual(-1)
  expect(bottom.y + bottom.height).toBeLessThanOrEqual(800)
})
