/**
 * The conventional durability line for aerobic decoupling: under it, a long
 * aerobic run held its efficiency. Shared by the Trends chart's dashed rule
 * and the activity page's reading, so the two pages cannot disagree about
 * where the line is. See docs/reference/math/efficiency.md.
 */
export const DURABILITY_REFERENCE_PCT = 5

/**
 * Where a population run's decoupling sits against the line, as the
 * sentence the activity page shows beside it. Named the way the Trends
 * chart's key names the same line, `5% durability`. An earlier wording,
 * "Over the 5% line read as aerobically durable", could be read as its own
 * opposite, the final review of 2026-10-03 found.
 *
 * Compared at the one decimal `format.formatDecoupling` displays, so a
 * value shown as `+5.0%` reads as on the line rather than under or over a
 * line the reader can see it equals. Rounded with the formatter's own
 * `toFixed(1)`, not `Math.round(pct * 10) / 10`: the two disagree on a
 * float such as 5.05, which displays as `+5.0%` but would round up to 5.1.
 */
export function durabilityReading(pct: number): string {
  const shown = Number(pct.toFixed(1))
  const side = shown < DURABILITY_REFERENCE_PCT ? 'Below' : shown > DURABILITY_REFERENCE_PCT ? 'Above' : 'On'
  return `${side} the ${String(DURABILITY_REFERENCE_PCT)}% durability line`
}
