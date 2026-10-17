/**
 * The conversion between the canvas pixels a chart's own drawing code
 * works in and the CSS pixels its constants are expressed in.
 *
 * Kept here rather than in any one chart's math module because nothing
 * about it is chart-specific: `StreamPanel` scales two dash patterns
 * through it and `VolumeBars` its empty-period marker, and the next chart
 * that draws by hand needs the same thing. It sits beside `cssVar.ts` for
 * the same underlying reason that file exists - a canvas does not run the
 * CSS cascade, so anything expressed in CSS terms has to be resolved for
 * it explicitly.
 */

/**
 * The ratio uPlot scaled its canvas by.
 *
 * Read live rather than captured: a window moved between displays of
 * different densities fires uPlot's own `dppxchange` listener, which
 * recomputes `bbox` against the new ratio and redraws, so a stale value
 * would mis-scale until the next rebuild. Guarded because a headless
 * environment can leave it undefined or zero, and dividing by either turns
 * a finite measurement into a meaningless one.
 *
 * `uPlot.pxRatio` is the same number and would be a better source, but it
 * is a static on the uPlot class and reading it needs a *runtime* import of
 * the package. `UPlot.tsx` is deliberately the only file that imports
 * `uplot` for real - that is what lets a test mock the specifier and
 * intercept every chart - so this module reads the ratio from the platform
 * instead.
 */
export function cssPixelRatio(): number {
  const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio
  return typeof ratio === 'number' && ratio > 0 ? ratio : 1
}

/** Scales a CSS-pixel dash pattern into the canvas pixels a context draws in. */
export function scaleDash(dash: readonly number[]): number[] {
  const ratio = cssPixelRatio()
  return dash.map((segment) => segment * ratio)
}
