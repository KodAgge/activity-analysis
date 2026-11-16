/**
 * A bar as the charts draw it: a rectangle with its two top corners
 * rounded, drawn by hand rather than with `ctx.roundRect`, whose per-corner
 * radius argument is newer than the browsers this has to run in. The bottom
 * sits flat on the baseline: a bar rests on an axis, and rounding the foot
 * lifts it off one.
 *
 * Shared by `VolumeBars` and `TrainingLoadChart`, so the Overview's weekly
 * bars and the Trends view's weekly TRIMP are one mark. The geometry is
 * `volumeBarsMath.barGeometry`'s.
 */
export function fillBarPath(
  ctx: CanvasRenderingContext2D,
  bar: { x: number; y: number; width: number; height: number; radius: number },
): void {
  const { x, y, width, height, radius } = bar
  ctx.beginPath()
  ctx.moveTo(x, y + height)
  ctx.lineTo(x, y + radius)
  ctx.arcTo(x, y, x + radius, y, radius)
  ctx.lineTo(x + width - radius, y)
  ctx.arcTo(x + width, y, x + width, y + radius, radius)
  ctx.lineTo(x + width, y + height)
  ctx.closePath()
  ctx.fill()
}
