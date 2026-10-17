/**
 * Resolves a design token to the colour value the browser actually computed
 * for it, for anywhere that needs a real CSS colour rather than a
 * `var(...)` reference.
 *
 * A canvas `fillStyle`/`strokeStyle` does not run the CSS cascade: handing
 * it the literal string `"var(--ink-dim)"` paints nothing, silently. So a
 * token has to be resolved through `getComputedStyle` once, here, rather
 * than every chart file keeping its own hex-code copy of the palette that
 * `theme/tokens.css` would then no longer be the single source of.
 *
 * Kept out of `UPlot.tsx` itself so that file exports only the `UPlot`
 * component - a file mixing a component export with a plain function export
 * cannot be Fast-Refreshed.
 */
export function cssVar(name: string, element: Element = document.documentElement): string {
  return getComputedStyle(element).getPropertyValue(name).trim()
}
