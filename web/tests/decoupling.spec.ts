import { expect, test } from '@playwright/test'

/**
 * The aerobic decoupling section against the fixture store; see
 * docs/reference/frontend.md. The reference run is
 * the 2026-08-28 fixture.
 */
const REFERENCE_RUN = '854fd775d479ca9f'

test('the reference run shows its decoupling, both halves and the 5% reading', async ({ page }) => {
  await page.goto(`/activities/${REFERENCE_RUN}`)
  const section = page.getByRole('region', { name: 'Aerobic decoupling' })
  await expect(section.getByText('+13.1%')).toBeVisible()
  await expect(section.getByText('Above the 5% durability line')).toBeVisible()
  await expect(section.getByRole('row', { name: /Pace/ })).toContainText('6:31/km')
  await expect(section.getByRole('row', { name: /Pace/ })).toContainText('6:49/km')
  await expect(section.getByRole('row', { name: /Heart rate/ })).toContainText('148 bpm')
  await expect(section.getByRole('row', { name: /Heart rate/ })).toContainText('163 bpm')
})

test('the section does not scroll the page sideways at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/activities/${REFERENCE_RUN}`)
  await expect(page.getByRole('region', { name: 'Aerobic decoupling' })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('the trend link lands on the decoupling chart, not the top of the Trends page', async ({ page }) => {
  await page.goto(`/activities/${REFERENCE_RUN}`)
  await page.getByRole('link', { name: 'Decoupling trend' }).click()
  await expect(page).toHaveURL(/\/trends#decoupling$/)
  await expect(page.locator('#decoupling')).toBeInViewport()
})
