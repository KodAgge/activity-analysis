/**
 * Where the reason popover's own `left` has to land, in `.item`'s own
 * coordinate space - the containing block `position: absolute` places it
 * against - so it never crosses the page gutter on either side.
 *
 * The popover's default CSS centres it under its badge
 * (`Tag.module.css`'s `.reasonVisible`), which is fine for a badge with
 * room either side but not for one near an edge: measured on the real
 * store at 390px wide, the first badge's popover centred at `left: 24px`
 * put its own left edge at -109.5px, entirely off the left of the
 * viewport. This is `clampReadoutLeft` in `charts/volumeBarsMath.ts`'s same
 * idea, against the reader's own window instead of a chart's panel.
 *
 * `itemLeftPx` and `itemWidthPx` are the trigger's own box in viewport
 * pixels (`getBoundingClientRect`), `popoverWidthPx` is the popover's own
 * measured width once it is showing, and `viewportWidthPx`/`gutterPx` are
 * the reader's own window and the page's horizontal inset
 * (`--gutter`). The result is relative to the item, not the viewport,
 * because the popover's containing block is the item itself.
 */
export function clampPopoverLeft(
  itemLeftPx: number,
  itemWidthPx: number,
  popoverWidthPx: number,
  viewportWidthPx: number,
  gutterPx: number,
): number {
  const naturalLeft = itemLeftPx + itemWidthPx / 2 - popoverWidthPx / 2
  const minLeft = gutterPx
  // A popover wider than the window minus both gutters cannot be clamped
  // inside them at all - `Tag.module.css`'s own `max-width` keeps this
  // from happening, but the floor still has to win over a `maxLeft` below
  // it rather than produce an inverted range.
  const maxLeft = Math.max(viewportWidthPx - gutterPx - popoverWidthPx, minLeft)
  const clampedLeft = Math.min(Math.max(naturalLeft, minLeft), maxLeft)
  return clampedLeft - itemLeftPx
}

/**
 * The page gutter in px, read from the shell's own `<main>` padding
 * (`components/AppShell.module.css`'s `.main` sets its horizontal padding
 * to `--gutter`) rather than from the custom property's own raw value.
 *
 * `--gutter` is declared in rem and changes at the desktop breakpoint
 * (`theme/tokens.css`), so `getComputedStyle(root).getPropertyValue('--gutter')`
 * hands back the literal string `"1.5rem"` - a custom property's computed
 * value is its *declared* value, never resolved, unlike an ordinary
 * property such as `padding-left`. `Number.parseFloat` on that string
 * reads `1.5`, not the `24` (or `32` above the breakpoint) it actually
 * means, and every reader near an edge lands with almost no clamp at all
 * - measured live, the first badge's popover on a 390px phone sat flush
 * against the left edge, `x: 0.5`, once this bug was fixed for the
 * *unit* but before it was fixed for the *element it reads from*.
 * `getComputedStyle` on a real length property, by contrast, always
 * resolves to a used pixel value regardless of the unit it was declared
 * in - confirmed directly against jsdom, which has no layout engine but
 * does resolve this: an inline `padding-left: 1.5rem` against the
 * default 16px root font size reads back as `"24px"`.
 */
export function pageGutterPx(root: ParentNode = document): number {
  const main = root.querySelector('main')
  if (main === null) return 0
  return Number.parseFloat(getComputedStyle(main).paddingLeft) || 0
}
