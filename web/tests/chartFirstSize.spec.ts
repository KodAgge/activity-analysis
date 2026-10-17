import { expect, test } from '@playwright/test'

/**
 * A chart is drawn at its container's size from its first frame, not at the
 * 600px placeholder its options carry until the first `ResizeObserver`
 * callback. Under the full suite's load that callback came late enough for
 * `distributions.spec.ts` to measure a 624px document at 360px wide.
 *
 * Holding every observation back makes the first frame stay on screen, so
 * this measures it deterministically.
 */
test('a chart never widens a phone-width page before its first resize observation', async ({ page }) => {
  await page.addInitScript(() => {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  })
  await page.setViewportSize({ width: 360, height: 800 })
  await page.goto('/distributions?variable=distance')
  await page.locator('canvas').first().waitFor()
  const overflow = await page.evaluate(() => ({
    scrollWidth: Math.round(document.documentElement.scrollWidth),
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)
})
