/**
 * The pure logic behind colouring the route by pace. Kept out of the chart
 * components for the reason `streamPanelMath.ts` is: pure maths is directly
 * testable, and a module mixing a component with plain exports cannot be
 * Fast-Refreshed.
 *
 * See docs/reference/frontend.md, "The route is coloured by pace".
 */

/** How many colours the route is drawn in. Fine enough that no step edge is visible on the line. */
export const PACE_STEP_COUNT = 24

/**
 * The longest piece, in grid seconds. A replay reveals the line a whole
 * piece at a time, so this bounds how far the drawn line trails the dot:
 * 10 s is about 30 m at running pace.
 */
export const MAX_PIECE_SAMPLES = 10

export interface PaceEnds {
  /** The 5th percentile of the run's moving speed, m/s. */
  slow: number
  /** The 95th percentile, m/s. */
  fast: number
}

export interface PaceInput {
  lat: (number | null)[]
  lon: (number | null)[]
  speed: (number | null)[]
  paused: (boolean | null)[]
  outage: (boolean | null)[]
}

export interface PacePiece {
  /** Index into the ramp's steps, slow 0; null for a stopped stretch. */
  step: number | null
  /** First and last grid sample the piece's points come from. */
  start: number
  end: number
  /** `[lon, lat]`, GeoJSON order. */
  coords: [number, number][]
}

/**
 * A run's route, ready to draw: the pieces to colour, the ramp itself and
 * the neutral colour for a stopped piece. `RouteMap` and the bare `Route`
 * both take one of these, built once by `RouteHero` from the run's own
 * grid, so the map and the trace always agree on which piece is which
 * colour.
 */
export interface RoutePace {
  pieces: PacePiece[]
  palette: string[]
  stoppedColour: string
}

function stopped(input: Pick<PaceInput, 'paused' | 'outage'>, i: number): boolean {
  return input.paused[i] === true || input.outage[i] === true
}

function quantile(sorted: number[], q: number): number {
  const p = (sorted.length - 1) * q
  const i = Math.floor(p)
  const lo = sorted[i] ?? 0
  const hi = sorted[Math.min(sorted.length - 1, i + 1)] ?? lo
  return lo + (hi - lo) * (p - i)
}

/**
 * The run's own colour scale: the 5th and 95th percentile of its moving
 * speeds. Moving means neither paused nor outage, with a speed recorded.
 * Null when there is no such second, and the route is then drawn stopped.
 */
export function paceScaleEnds(
  speed: (number | null)[],
  paused: (boolean | null)[],
  outage: (boolean | null)[],
): PaceEnds | null {
  const moving: number[] = []
  speed.forEach((v, i) => {
    if (v !== null && paused[i] !== true && outage[i] !== true) moving.push(v)
  })
  if (moving.length === 0) return null
  moving.sort((a, b) => a - b)
  return { slow: quantile(moving, 0.05), fast: quantile(moving, 0.95) }
}

export function rampPosition(speedMps: number, ends: PaceEnds): number {
  if (!(ends.fast > ends.slow)) return 0.5
  return Math.min(1, Math.max(0, (speedMps - ends.slow) / (ends.fast - ends.slow)))
}

// sRGB <-> OKLab, after Björn Ottosson's reference implementation.
function toLinear(c: number): number {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
function fromLinear(c: number): number {
  const s = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(s * 255)))
}
function hexToOklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16))) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}
function oklabToHex([L, a, b]: [number, number, number]): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  return `#${rgb.map((c) => fromLinear(c).toString(16).padStart(2, '0')).join('')}`
}

/**
 * `count` colours spread evenly along the anchors, each at its step's
 * centre, interpolated in OKLab so equal steps look equally far apart.
 */
export function rampSteps(anchors: readonly string[], count: number): string[] {
  const labs = anchors.map(hexToOklab)
  return Array.from({ length: count }, (_, k) => {
    if (labs.length === 1) {
      const anchor0 = anchors[0]
      return anchor0 ?? '#000000'
    }
    const t = ((k + 0.5) / count) * (labs.length - 1)
    const i = Math.min(labs.length - 2, Math.floor(t))
    const f = t - i
    const a = labs[i]
    const b = labs[i + 1]
    if (a === undefined || b === undefined) return '#000000'
    return oklabToHex([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f])
  })
}

/**
 * The route as pieces to draw, each one colour.
 *
 * Segment i runs from sample i to sample i + 1 and takes sample i's colour.
 * A segment exists only where both ends have a position, so a GPS gap
 * breaks the route rather than drawing a chord across it. Consecutive
 * segments of one step merge into one piece, up to `maxSamples` segments,
 * and a piece's last point is the next piece's first, so the line has no
 * seam.
 */
export function pacePieces(
  input: PaceInput,
  ends: PaceEnds | null,
  steps: number = PACE_STEP_COUNT,
  maxSamples: number = MAX_PIECE_SAMPLES,
): PacePiece[] {
  const pieces: PacePiece[] = []
  const n = Math.min(input.lat.length, input.lon.length)
  let current: PacePiece | null = null
  for (let i = 0; i < n - 1; i++) {
    const lat0 = input.lat[i]
    const lon0 = input.lon[i]
    const lat1 = input.lat[i + 1]
    const lon1 = input.lon[i + 1]
    if (lat0 == null || lon0 == null || lat1 == null || lon1 == null) {
      current = null
      continue
    }
    const v = input.speed[i]
    const step =
      ends === null || v == null || stopped(input, i)
        ? null
        : Math.min(steps - 1, Math.floor(rampPosition(v, ends) * steps))
    if (current !== null && current.step === step && current.end === i && current.end - current.start < maxSamples) {
      current.end = i + 1
      current.coords.push([lon1, lat1])
    } else {
      current = { step, start: i, end: i + 1, coords: [[lon0, lat0], [lon1, lat1]] }
      pieces.push(current)
    }
  }
  return pieces
}

/**
 * How many pieces a replay head has passed: the count with `end <= head`,
 * which is a prefix, since pieces come in grid order with increasing
 * `end`. A binary search, as the replay asks on every frame.
 */
export function piecesPassed(pieces: readonly { end: number }[], head: number): number {
  let lo = 0
  let hi = pieces.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((pieces[mid]?.end ?? Infinity) <= head) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** A piece's drawn colour: its ramp step, or the stopped colour for a stopped piece. */
export function pieceColour(pace: RoutePace, piece: PacePiece): string {
  return piece.step === null ? pace.stoppedColour : (pace.palette[piece.step] ?? pace.stoppedColour)
}
