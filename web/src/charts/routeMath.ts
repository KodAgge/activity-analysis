/**
 * The route trace's pure geometry: splitting a pair of position streams
 * into the contiguous runs a `<polyline>` can be drawn from, and the
 * question "is there a trace here at all".
 *
 * Here rather than in `Route.tsx` for the reason every other chart in this
 * directory keeps its arithmetic in a `*Math.ts` module - it is testable
 * without a DOM - and for one specific to this pair: `ActivityDetail` has
 * to answer `hasRoute` *before* it renders, because the route is that
 * screen's hero and a run with no trace gets no hero at all. Exporting a
 * plain function beside a component is also what React Fast Refresh
 * refuses to hot-reload, so the two belong in different files.
 */

export interface Point {
  lat: number
  lon: number
}

/**
 * One array per contiguous run of non-null samples.
 *
 * A null sample - 23.43% of real position samples, measured - is dropped
 * rather than plotted at (0, 0), which is open ocean off the Gulf of Guinea
 * for this athlete and nowhere close to a real GPS dropout. Breaking the
 * runs here is what makes a real gap break the drawn trace instead of
 * drawing a straight chord across whatever the athlete did while
 * unrecorded.
 */
export function toRuns(lat: (number | null)[], lon: (number | null)[]): Point[][] {
  const runs: Point[][] = []
  let current: Point[] = []
  for (let i = 0; i < lat.length; i++) {
    const la = lat[i]
    const lo = lon[i]
    if (la !== null && la !== undefined && lo !== null && lo !== undefined) {
      current.push({ lat: la, lon: lo })
    } else if (current.length > 0) {
      runs.push(current)
      current = []
    }
  }
  if (current.length > 0) runs.push(current)
  return runs
}

/**
 * Whether these position streams contain a trace at all.
 *
 * `Route` renders its own `Absent` from exactly this predicate and
 * `ActivityDetail` decides whether to open on a hero from it, so the two
 * can never disagree about which state the activity is in.
 */
export function hasRoute(lat: (number | null)[], lon: (number | null)[]): boolean {
  return toRuns(lat, lon).length > 0
}

const NICE_MULTIPLIERS = [1, 2, 5]
/**
 * The margin the padded box adds around the trace, as a fraction of the
 * trace's own extent on each axis.
 *
 * 5%, down from 8%, since the route became `ActivityDetail`'s full-bleed
 * hero. The padding and the clamp's letterbox compound: on the reference
 * activity, whose trace is 0.85 as wide as it is tall and so lands on the
 * square floor, 8% left the trace filling 73% of the panel's width against
 * a reference hero whose own trace runs to the edges. At 5% the same trace
 * measures 79% of the panel's width and 93% of its height at 412 px, and the
 * stroke's own width still clears the edge, which is all the pad is for.
 */
export const PAD_FRACTION = 0.05
/** The fraction of the trace's larger extent the scale bar targets. */
export const SCALE_BAR_TARGET_FRACTION = 0.25

export function niceRoundNumber(target: number): number {
  if (!(target > 0)) return 0
  const exponent = Math.floor(Math.log10(target))
  const base = 10 ** exponent
  let best = base
  for (const multiplier of NICE_MULTIPLIERS) {
    const candidate = multiplier * base
    if (candidate <= target) best = candidate
  }
  return best
}

/**
 * Taller than this and the trace is letterboxed rather than the panel grown.
 *
 * Square, deliberately. Following a tall route's own ratio all the way
 * removes the letterbox entirely but buys it with height: the reference
 * activity's trace is 0.85 wide-to-tall, which in the detail view's
 * 620px-wide column would render a 729px-tall panel - taller than the
 * full-width panel this change set out to shrink. At a square floor the
 * same run renders 620x620 with the trace at 527x620, which takes the
 * horizontal waste from the 584px originally measured down to about 93px
 * without the panel dominating the page.
 */
const TALLEST_PANEL_RATIO = 1
/** Wider than this and the trace is letterboxed rather than the panel stretched. */
const WIDEST_PANEL_RATIO = 1.8

/**
 * The panel's own aspect ratio, following the route's shape but clamped.
 *
 * A fixed 3:2 box letterboxes the trace inside it, which is correct but
 * wasteful: measured on the reference activity at full width, the panel
 * rendered 1024x600 while the trace occupied 440x517, leaving 584px of
 * horizontal emptiness - the thing the maintainer asked to stop wasting. Following
 * the route's own ratio removes almost all of that, because the letterbox
 * is what the emptiness *is*.
 *
 * It has to stay clamped, for the reason `Route.module.css` records: an
 * out-and-back along a straight path has a bounding box tens or hundreds
 * of times taller than it is wide, and an unclamped ratio would render the
 * panel thousands of pixels tall and push the rest of the page off the
 * document. The bounds below let a tall route be noticeably taller than
 * wide and a wide one noticeably wider, and refuse anything past that;
 * a route beyond them is letterboxed exactly as before, which is the
 * degenerate case the clamp exists for.
 */
export function panelAspectRatio(paddedWidth: number, paddedHeight: number): number {
  if (!(paddedWidth > 0) || !(paddedHeight > 0)) return WIDEST_PANEL_RATIO
  const routeRatio = paddedWidth / paddedHeight
  return Math.min(Math.max(routeRatio, TALLEST_PANEL_RATIO), WIDEST_PANEL_RATIO)
}

export interface Bounds {
  west: number
  south: number
  east: number
  north: number
}

/** The bounding box of the non-null samples, or null without a fix. */
export function routeBounds(lat: (number | null)[], lon: (number | null)[]): Bounds | null {
  const points = toRuns(lat, lon).flat()
  if (points.length === 0) return null
  return {
    west: Math.min(...points.map((p) => p.lon)),
    south: Math.min(...points.map((p) => p.lat)),
    east: Math.max(...points.map((p) => p.lon)),
    north: Math.max(...points.map((p) => p.lat)),
  }
}

// A degenerate box (one point, or every point identical) would divide by
// zero below. A few metres' worth of degrees keeps the trace visible as a
// point rather than crashing the layout.
export const EPSILON_DEGREES = 1e-5

export interface ProjectedBox {
  /** `cos(mean latitude)` of the non-null samples - `Route`'s own longitude scale. */
  cosLat: number
  minX: number
  maxX: number
  minY: number
  maxY: number
  /** `max(maxX - minX, EPSILON_DEGREES)` */
  rangeX: number
  /** `max(maxY - minY, EPSILON_DEGREES)` */
  rangeY: number
}

/**
 * The route's own projected box: longitude scaled by `cos(mean latitude of
 * the samples)`, latitude plain, extents floored at `EPSILON_DEGREES`. Not
 * the same box as `routeBounds`: that one is the plain lat/lon bounding box
 * `coveringArea` tests an area against, and its cosine, if taken from the
 * box's midpoint rather than the samples' own mean, disagrees with `Route`
 * on an asymmetrically sampled trace - measured 1.30725 against 1.31244 on
 * a synthetic trace bunched near one edge. `Route` draws its SVG viewBox
 * from exactly this box, and `routePanelRatio` derives the panel ratio from
 * exactly this box, so the two can never disagree about what box the bare
 * trace occupies.
 */
export function projectedBox(lat: (number | null)[], lon: (number | null)[]): ProjectedBox | null {
  const points = toRuns(lat, lon).flat()
  if (points.length === 0) return null
  const meanLat = points.reduce((sum, p) => sum + p.lat, 0) / points.length
  const cosLat = Math.cos((meanLat * Math.PI) / 180)
  const xs = points.map((p) => p.lon * cosLat)
  const ys = points.map((p) => p.lat)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return {
    cosLat,
    minX,
    maxX,
    minY,
    maxY,
    rangeX: Math.max(maxX - minX, EPSILON_DEGREES),
    rangeY: Math.max(maxY - minY, EPSILON_DEGREES),
  }
}

/**
 * The clamped ratio `Route` renders its panel at, from the same
 * cosine-corrected, padded box, so the map panel is the bare trace's box.
 */
export function routePanelRatio(lat: (number | null)[], lon: (number | null)[]): number {
  const box = projectedBox(lat, lon)
  if (box === null) return WIDEST_PANEL_RATIO
  const w = box.rangeX * (1 + 2 * PAD_FRACTION)
  const h = box.rangeY * (1 + 2 * PAD_FRACTION)
  return panelAspectRatio(w, h)
}

/**
 * The area whose box holds every non-null sample, or null.
 *
 * Every sample, not the bounding box's centre: a route that leaves the box
 * would draw over blank tiles past the edge, and the bare trace is the
 * better picture of it.
 */
export function coveringArea<A extends Bounds>(
  lat: (number | null)[],
  lon: (number | null)[],
  areas: readonly A[],
): A | null {
  const b = routeBounds(lat, lon)
  if (b === null) return null
  return (
    areas.find((a) => a.west <= b.west && a.south <= b.south && a.east >= b.east && a.north >= b.north) ??
    null
  )
}

/** Web Mercator's equatorial circumference over MapLibre's 512 px tile. */
const METRES_PER_PIXEL_AT_ZOOM_0 = 40_075_016.686 / 512

/**
 * The map view's scale bar: a round distance near a quarter of the panel's
 * width, and its length as a fraction of that width, from the map's own
 * metres per pixel at the panel's centre latitude.
 */
export function mapScaleBar(
  panelWidthPx: number,
  latDeg: number,
  zoom: number,
): { metres: number; fraction: number } {
  const metresPerPixel = (METRES_PER_PIXEL_AT_ZOOM_0 * Math.cos((latDeg * Math.PI) / 180)) / 2 ** zoom
  if (!(panelWidthPx > 0) || !(metresPerPixel > 0)) return { metres: 0, fraction: 0 }
  const metres = niceRoundNumber(panelWidthPx * metresPerPixel * SCALE_BAR_TARGET_FRACTION)
  return { metres, fraction: metres / metresPerPixel / panelWidthPx }
}

/**
 * The scale bar's drawn length, as a fraction of the rendered panel's width.
 *
 * The bar used to be drawn inside the trace's own `<svg>`, in the same user
 * units as the polyline, which made it correct and put it in the wrong
 * place: `preserveAspectRatio="xMidYMid meet"` centres the viewBox inside
 * the panel, so on any route the aspect clamp binds on, the bar started a
 * letterbox-width in from the panel's edge - 48 CSS px on the reference
 * activity, against the back control's 8 - and that offset moves with every
 * route's shape. The hero layer had two gutters and neither was a gutter.
 *
 * So the bar is an overlay in the panel's own coordinates now, and this is
 * what keeps it honest. `meet` scales both axes by one factor,
 * `s = min(panelW / paddedWidth, panelH / paddedHeight)`, and the panel's
 * own `aspect-ratio` fixes `panelH = panelW / panelRatio`, so
 *
 *     s = panelW / max(paddedWidth, panelRatio * paddedHeight)
 *
 * and the bar's length in panel widths is `barLengthUnits * s / panelW`,
 * which is the expression below with `panelW` cancelled. The result depends
 * only on the geometry this component already fixes, so the bar states the
 * same distance the trace does at every width.
 *
 * `panelRatio` must be the ratio the panel is actually rendered at - the
 * *clamped* one - and the panel's height must genuinely be its width over
 * that ratio. A `max-height` that bound would break both, which is why
 * `Route.module.css` no longer carries one.
 */
export function scaleBarWidthFraction(
  barLengthUnits: number,
  paddedWidth: number,
  paddedHeight: number,
  panelRatio: number,
): number {
  const denominator = Math.max(paddedWidth, panelRatio * paddedHeight)
  if (!(denominator > 0)) return 0
  return barLengthUnits / denominator
}

/**
 * Which bottom corner of the panel is farther from where the route starts:
 * where the replay's controls go, so they do not sit over the first seconds
 * the replay draws. Wherever the start lands in the frame, the other bottom
 * corner is clear of it. `right` when the start
 * is in the left half of the route's box, or there is no position at all.
 */
export function replayControlsSide(lat: (number | null)[], lon: (number | null)[]): 'left' | 'right' {
  const box = projectedBox(lat, lon)
  const start = toRuns(lat, lon)[0]?.[0]
  if (box === null || start === undefined) return 'right'
  const x = (start.lon * box.cosLat - box.minX) / box.rangeX
  return x > 0.5 ? 'left' : 'right'
}
