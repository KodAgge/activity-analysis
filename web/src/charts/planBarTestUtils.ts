/**
 * A bar's drawn height, read back from its `planChartMath.roundedTopBar`
 * path in a test: the `M` names its foot and the first `Q`'s control
 * point its top. jsdom lays out nothing, so the path is all there is.
 */
export function barHeight(bar: Element | undefined): number {
  const n = (bar?.getAttribute('d') ?? '').match(/-?\d+(\.\d+)?(e-?\d+)?/g)?.map(Number) ?? []
  const [, bottom, , , top] = n
  if (bottom === undefined || top === undefined) throw new Error('not a bar path')
  return bottom - top
}
