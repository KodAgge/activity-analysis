/**
 * The plan's three PDFs, all saved through the browser's print dialog.
 *
 * - `shown`: the page as it is on screen, without the session appendix,
 *   and with the assessment's reasoning only if it is open.
 * - `full`: the same page with every written-out session's detail after the
 *   calendar and the reasoning printed although it is closed.
 * - `week`: the header and the next week's sessions in full, and nothing
 *   else, for the week ahead (`planMath.nextWeek`).
 *
 * The mode is an attribute on `<html>` that the print stylesheets read, set
 * for the one print and removed on `afterprint`. A print without it, from
 * the browser's own menu, is the `shown` one: a page printed from the menu
 * is expected to print as it looks.
 *
 * The document's title is the PDF's default file name in Chromium and
 * Firefox, so it names the goal and the mode for the one print, and the three
 * files saved from one plan do not overwrite each other.
 */
export type PlanPrintMode = 'shown' | 'full' | 'week'

/** `data-plan-print` on `<html>`; the print stylesheets match `[data-plan-print='full']` and `'week'`. */
export const PLAN_PRINT_ATTRIBUTE = 'planPrint'

/**
 * The PDF's default file name. `week` is the week's Monday as `31 Aug`,
 * which the `week` mode needs and the others ignore.
 */
export function planPdfTitle(goal: string, mode: PlanPrintMode, week = ''): string {
  if (mode === 'full') return `Plan, ${goal}, every session`
  if (mode === 'week') return `Plan, ${goal}, week of ${week}`
  return `Plan, ${goal}`
}

export function printPlan(mode: PlanPrintMode, goal: string, week = ''): void {
  const root = document.documentElement
  const title = document.title
  if (mode === 'shown') delete root.dataset[PLAN_PRINT_ATTRIBUTE]
  else root.dataset[PLAN_PRINT_ATTRIBUTE] = mode
  document.title = planPdfTitle(goal, mode, week)
  // `print()` returns before the dialog closes on some mobile browsers, so
  // the page is put back on `afterprint` rather than after the call.
  window.addEventListener(
    'afterprint',
    () => {
      delete root.dataset[PLAN_PRINT_ATTRIBUTE]
      document.title = title
    },
    { once: true },
  )
  window.print()
}
