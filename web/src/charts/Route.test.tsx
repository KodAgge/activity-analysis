import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PacePiece, RoutePace } from './paceColour'
import { recordCanvases, type Recorded } from './recordingCanvas.testUtil'
import { Route } from './Route'
import { projectedBox, routePanelRatio } from './routeMath'

const METRES_PER_DEGREE = 111_320

/**
 * The scale bar's drawn width as a fraction of the panel, read back off the
 * inline style `Route` sets.
 *
 * It is a percentage of the *panel*, not of the trace's user units, since
 * the bar moved out of the SVG - see `scaleBarWidthFraction` in
 * `routeMath.ts` for why it had to.
 */
function scaleBarFraction(container: HTMLElement): number {
  const rule = container.querySelector('[data-testid="scale-bar-rule"]')
  if (rule === null) throw new Error('no scale bar rule rendered')
  const width = (rule as HTMLElement).style.width
  const match = /^([\d.eE+-]+)%$/.exec(width)
  if (match?.[1] === undefined) throw new Error(`scale bar width did not parse: "${width}"`)
  return Number(match[1]) / 100
}

/**
 * The panel's rendered aspect ratio, read back off the inline style.
 *
 * `Route` sets it as a bare number, but CSSOM normalises `aspect-ratio` to
 * the two-value `<width> / <height>` form, so `1` comes back as `"1 / 1"`
 * and `Number()` on it is NaN. Both forms are accepted here rather than
 * pinning the serialisation, which is the browser's to choose.
 */
function parseAspectRatio(svg: SVGSVGElement): number {
  const raw = svg.style.aspectRatio.trim()
  if (raw === '') throw new Error('svg has no inline aspect-ratio')
  const [width, height = '1'] = raw.split('/').map((part) => part.trim())
  const ratio = Number(width) / Number(height)
  if (!Number.isFinite(ratio)) throw new Error(`aspect-ratio did not parse: "${raw}"`)
  return ratio
}

function parseViewBox(svg: SVGSVGElement): { minX: number; minY: number; width: number; height: number } {
  const viewBox = svg.getAttribute('viewBox')
  if (viewBox === null) throw new Error('svg has no viewBox')
  const parts = viewBox.split(' ').map(Number)
  const [minX, minY, width, height] = parts
  if (minX === undefined || minY === undefined || width === undefined || height === undefined) {
    throw new Error(`unparseable viewBox: "${viewBox}"`)
  }
  return { minX, minY, width, height }
}

function renderRoute(
  lat: (number | null)[],
  lon: (number | null)[],
): { svg: SVGSVGElement; container: HTMLElement } {
  const { container } = render(<Route lat={lat} lon={lon} />)
  const svg = container.querySelector('svg')
  if (svg === null) throw new Error('Route did not render an <svg>')
  return { svg, container }
}

function renderSvg(lat: (number | null)[], lon: (number | null)[]): SVGSVGElement {
  return renderRoute(lat, lon).svg
}

describe('Route', () => {
  it('scales longitude by cos(mean latitude), compressing a square degree box to about 0.53 wide', () => {
    // A one-degree-by-one-degree box straddling 57.75 degrees north
    // symmetrically, so the mean latitude of the sample points is exactly
    // 57.75 rather than an edge of the box.
    const centerLat = 57.75
    const lat: number[] = []
    const lon: number[] = []
    for (let i = -10; i <= 10; i++) {
      lat.push(centerLat + i / 20)
      lon.push(14 + i / 20)
    }

    const svg = renderSvg(lat, lon)
    const { width, height } = parseViewBox(svg)

    const expectedRatio = Math.cos((centerLat * Math.PI) / 180)
    expect(width / height).toBeCloseTo(expectedRatio, 1)
    // And it is a real correction, not an accidental no-op: an unscaled
    // trace of a square degree box would be square, ratio 1, not ~0.53.
    expect(width / height).not.toBeCloseTo(1, 1)
  })

  it('skips null coordinates rather than plotting them as (0, 0)', () => {
    // These samples sit around 57.7 N, 14.1 E. (0, 0) is off the Gulf of
    // Guinea - if a null were plotted there, the bounding box would have
    // to stretch to cover it, ballooning from a ~0.02 degree box to one
    // spanning the equator and the prime meridian.
    const lat = [57.70, null, 57.71, 57.72]
    const lon = [14.10, null, 14.11, 14.12]

    const svg = renderSvg(lat, lon)
    const { width, height } = parseViewBox(svg)

    expect(width).toBeLessThan(1)
    expect(height).toBeLessThan(1)

    // The gap also must not be silently bridged into one continuous line:
    // it renders as two separate polylines, one per side of the null.
    const polylines = svg.querySelectorAll('polyline')
    expect(polylines).toHaveLength(2)
  })

  it('renders nothing to plot when every coordinate is null, rather than drawing a point at the origin', () => {
    // The shape of a treadmill activity: lat_deg and lon_deg null for every
    // one of its samples.
    const lat = Array.from({ length: 2400 }, () => null)
    const lon = Array.from({ length: 2400 }, () => null)

    const { container } = render(<Route lat={lat} lon={lon} />)

    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('polyline')).toBeNull()

    // I6: the absence is stated through the shared `Absent` component, the
    // same idiom `ActivityDetail`'s other panels use, not a bespoke
    // borderless paragraph of this component's own - `role="note"` is
    // `Absent`'s own contract, which a component-local empty state would
    // not carry.
    expect(screen.getByRole('note')).toHaveTextContent('No GPS route recorded for this activity.')
  })

  it('sizes the strokes and the scale bar from the larger extent, so a one-sided route keeps them visible', () => {
    // An out-and-back along a straight north-south path: 5 km out and back
    // gives ~0.045 degrees of latitude, with only ~20 m of lateral GPS
    // spread. The bounding box is ~250 times taller than it is wide, and
    // `preserveAspectRatio="meet"` inside the panel's fixed box (see
    // Route.module.css) scales both axes by the factor the *taller* one
    // sets. Sizes derived from the negligible axis - the polyline's stroke
    // was `rangeX * 0.01`, the scale bar targeted a fraction of `rangeX` -
    // render sub-pixel here.
    const lat = [57.7, 57.745, 57.7]
    const lon = [14.1, 14.10035, 14.1]

    const { svg, container } = renderRoute(lat, lon)
    const { height } = parseViewBox(svg)

    const polyline = svg.querySelector('polyline')
    if (polyline === null) throw new Error('expected a polyline')

    const traceStroke = Number(polyline.getAttribute('stroke-width'))

    // The one size still expressed in user units is a real fraction of the
    // rendered box, which this route's *height* sets. Taken off `rangeX`
    // instead it would render sub-pixel here.
    expect(traceStroke).toBeGreaterThan(height * 0.005)

    // The scale bar is no longer in user units at all, which is what makes
    // this route safe by construction rather than by a chosen constant: its
    // width is a fraction of the panel, and the panel is bounded by the
    // aspect clamp. A visible ruler, never a sliver and never the whole
    // panel.
    const fraction = scaleBarFraction(container)
    expect(fraction).toBeGreaterThan(0.05)
    expect(fraction).toBeLessThan(1)
  })

  it("draws a scale bar that is a round number of metres, matching the trace's own scale", () => {
    const baseLat = 10
    const lat = [baseLat, baseLat + 0.01, baseLat, baseLat + 0.01]
    const lon = [20, 20, 20.01, 20.01]

    const { svg, container } = renderRoute(lat, lon)
    const { width: paddedWidth, height: paddedHeight } = parseViewBox(svg)
    const panelRatio = parseAspectRatio(svg)

    const scaleBar = container.querySelector('[data-testid="scale-bar"]')
    if (scaleBar === null) throw new Error('no scale bar rendered')

    const label = (scaleBar.textContent ?? '').trim()
    const match = /^([\d.]+) (m|km)$/.exec(label)
    if (match === null) throw new Error(`scale bar label did not parse as a distance: "${label}"`)
    const numberPart = match[1]
    const unit = match[2]
    if (numberPart === undefined || unit === undefined) throw new Error('unreachable: match already checked')
    const statedMetres = Number(numberPart) * (unit === 'km' ? 1000 : 1)

    // A round number: exactly 1, 2 or 5 times a power of ten.
    const normalised = statedMetres / 10 ** Math.floor(Math.log10(statedMetres))
    expect([1, 2, 5]).toContain(Math.round(normalised * 100) / 100)

    // And it is drawn at the trace's own scale, which is the whole point of
    // a scale bar and the thing moving it out of the SVG could have broken.
    //
    // The rendered panel is `panelW` wide and `panelW / panelRatio` tall, and
    // `meet` scales the viewBox by `min` of the two fits, so one panel width
    // spans `max(paddedWidth, panelRatio * paddedHeight)` user units - and a
    // user unit is a degree of latitude, `METRES_PER_DEGREE` on the ground.
    const unitsPerPanelWidth = Math.max(paddedWidth, panelRatio * paddedHeight)
    const metresPerPanelWidth = unitsPerPanelWidth * METRES_PER_DEGREE
    expect(scaleBarFraction(container) * metresPerPanelWidth).toBeCloseTo(statedMetres, 6)

    // Sane on the panel: a real fraction of it, not a sliver and not the
    // whole width.
    expect(scaleBarFraction(container)).toBeGreaterThan(0.05)
    expect(scaleBarFraction(container)).toBeLessThan(1)
  })

  it('renders the panel at exactly the ratio routePanelRatio computes, even on an asymmetrically sampled trace', () => {
    // 19 samples bunched at the southern edge and 1 at the northern edge:
    // the mean latitude of the samples (what Route itself projects
    // longitude by) sits close to the southern edge, well off the bounding
    // box's midpoint. The lon spread is chosen so the padded box's ratio
    // lands inside the unclamped band (1, 1.8), not at either clamp - a
    // clamped ratio would hide a cosine mismatch behind the clamp.
    const lat: number[] = []
    const lon: number[] = []
    for (let i = 0; i < 19; i++) {
      lat.push(57.4)
      lon.push(14.1 + i * (1.262 / 18))
    }
    lat.push(57.9)
    lon.push(14.7)

    const svg = renderSvg(lat, lon)
    // `parseAspectRatio` reads the inline `aspect-ratio` back exactly - see
    // its own comment on why a bare `Number()` on the raw style cannot,
    // since JSDOM's CSSOM normalises it to the two-value form first.
    const rendered = parseAspectRatio(svg)
    const expected = routePanelRatio(lat, lon)

    // Sanity: this trace must actually exercise the unclamped band, or a
    // bug that only shows up off the clamp would pass here by accident.
    expect(expected).toBeGreaterThan(1)
    expect(expected).toBeLessThan(1.8)

    expect(rendered).toBe(expected)
  })

  describe('coloured by pace', () => {
    const lat = [57.70, 57.71, 57.72]
    const lon = [14.10, 14.11, 14.12]

    function piece(step: number | null, coords: PacePiece['coords']): PacePiece {
      return { step, start: 0, end: coords.length - 1, coords }
    }

    it('draws one polyline per piece in its step colour', () => {
      const pace: RoutePace = {
        pieces: [
          piece(0, [[14.1, 57.7], [14.11, 57.71]]),
          piece(1, [[14.11, 57.71], [14.12, 57.72]]),
        ],
        palette: ['#111111', '#222222'],
        stoppedColour: '#999999',
      }

      const { container } = render(<Route lat={lat} lon={lon} pace={pace} />)

      const polylines = container.querySelectorAll('polyline')
      expect(polylines).toHaveLength(2)
      expect((polylines[0] as SVGPolylineElement).style.stroke).toBe('rgb(17, 17, 17)')
      expect((polylines[1] as SVGPolylineElement).style.stroke).toBe('rgb(34, 34, 34)')
    })

    it('draws a stopped piece in the stopped colour', () => {
      const pace: RoutePace = {
        pieces: [piece(null, [[14.1, 57.7], [14.11, 57.71]])],
        palette: ['#111111', '#222222'],
        stoppedColour: '#999999',
      }

      const { container } = render(<Route lat={lat} lon={lon} pace={pace} />)

      const polyline = container.querySelector('polyline')
      if (polyline === null) throw new Error('expected a polyline')
      expect((polyline as SVGPolylineElement).style.stroke).toBe('rgb(153, 153, 153)')
    })

    it('draws the single accent trace when given no pace', () => {
      const { container } = render(<Route lat={lat} lon={lon} />)

      const polylines = container.querySelectorAll('polyline')
      expect(polylines).toHaveLength(1)
      expect((polylines[0] as SVGPolylineElement).style.stroke).toBe('var(--accent)')
    })
  })

  describe('the replay head', () => {
    const lat = [57.7, 57.71, 57.72, 57.73, 57.74, 57.75, 57.76]
    const lon = [14.1, 14.11, 14.12, 14.13, 14.14, 14.15, 14.16]
    const coords = (from: number, to: number): PacePiece['coords'] =>
      lat.slice(from, to + 1).map((la, i) => [lon[from + i] ?? 0, la])
    const pace: RoutePace = {
      pieces: [
        { step: 0, start: 0, end: 2, coords: coords(0, 2) },
        { step: 1, start: 2, end: 4, coords: coords(2, 4) },
        { step: 2, start: 4, end: 6, coords: coords(4, 6) },
      ],
      palette: ['#111111', '#222222', '#333333'],
      stoppedColour: '#999999',
    }
    let canvases: Map<HTMLCanvasElement, Recorded>
    beforeEach(() => {
      canvases = recordCanvases()
      // jsdom lays nothing out; the panel is given a size, as a browser
      // would. Its bounding box is smaller, as a collapsed phone hero's
      // scaled picture reports: the canvas is laid out at the layout size,
      // which the transform leaves alone.
      vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(300)
      vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(300)
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 216, 216))
    })
    afterEach(() => {
      vi.restoreAllMocks()
    })

    const traceStrokes = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('svg[role="img"] polyline')).map((p) => (p as SVGPolylineElement).style.stroke)
    const canvasColours = (container: HTMLElement) => {
      const canvas = container.querySelector('canvas')
      if (canvas === null) throw new Error('no replay canvas')
      return (canvases.get(canvas)?.strokes ?? []).map((s) => s.colour)
    }

    it('shows the outline on the trace and draws the pieces the head has passed on the canvas', () => {
      const { container } = render(<Route lat={lat} lon={lon} pace={pace} replayHead={4} />)
      expect(traceStrokes(container)).toEqual(['var(--pace-map-outline)'])
      expect(canvasColours(container)).toEqual(['#111111', '#222222'])
    })

    it('strokes only the new pieces as the head moves', () => {
      const { container, rerender } = render(<Route lat={lat} lon={lon} pace={pace} replayHead={2} />)
      expect(canvasColours(container)).toEqual(['#111111'])
      rerender(<Route lat={lat} lon={lon} pace={pace} replayHead={6} />)
      expect(canvasColours(container)).toEqual(['#111111', '#222222', '#333333'])
    })

    it("maps the trace's user units onto the canvas with the SVG's own meet fit", () => {
      const { container } = render(<Route lat={lat} lon={lon} pace={pace} replayHead={2} />)
      const canvas = container.querySelector('canvas')
      const svg = container.querySelector('svg')
      if (canvas === null || svg === null) throw new Error('missing layers')
      const { minX, minY, width, height } = parseViewBox(svg)
      const scale = Math.min(300 / width, 300 / height)
      const [a, , , d, e, f] = canvases.get(canvas)?.transform ?? []
      const dpr = window.devicePixelRatio || 1
      expect(a).toBeCloseTo(dpr * scale, 6)
      expect(d).toBeCloseTo(dpr * scale, 6)
      expect(e).toBeCloseTo(dpr * ((300 - width * scale) / 2 - minX * scale), 6)
      expect(f).toBeCloseTo(dpr * ((300 - height * scale) / 2 - minY * scale), 6)
    })

    it('draws the full line and no outline, and nothing on the canvas, without a head', () => {
      const { container } = render(<Route lat={lat} lon={lon} pace={pace} replayHead={null} />)
      expect(traceStrokes(container)).toEqual(['rgb(17, 17, 17)', 'rgb(34, 34, 34)', 'rgb(51, 51, 51)'])
      expect(canvases.size).toBe(0)
    })

    it('restores the full line and clears the canvas when the replay ends', () => {
      const { container, rerender } = render(<Route lat={lat} lon={lon} pace={pace} replayHead={4} />)
      rerender(<Route lat={lat} lon={lon} pace={pace} replayHead={null} />)
      expect(traceStrokes(container)).toHaveLength(3)
      const canvas = container.querySelector('canvas')
      if (canvas === null) throw new Error('no replay canvas')
      expect(canvases.get(canvas)?.clears).toBe(1)
    })

    it('keeps the dot off the trace, on a layer of its own', () => {
      const { container } = render(<Route lat={lat} lon={lon} pace={pace} moment={3} />)
      expect(container.querySelector('svg[role="img"] circle')).toBeNull()
      expect(container.querySelector('svg[aria-hidden="true"] circle')).not.toBeNull()
    })

    it('has no canvas for a route drawn without pace', () => {
      const { container } = render(<Route lat={lat} lon={lon} replayHead={4} />)
      expect(container.querySelector('canvas')).toBeNull()
    })
  })

  describe('the moment', () => {
    const lat = [57.7, 57.71, 57.72]
    const lon = [14.1, 14.11, 14.12]

    it("draws one circle at the moment's projected position", () => {
      const { container } = render(<Route lat={lat} lon={lon} moment={2} />)

      const box = projectedBox(lat, lon)
      if (box === null) throw new Error('expected a box')
      const latAt2 = lat[2]
      const lonAt2 = lon[2]
      if (latAt2 === undefined || lonAt2 === undefined) throw new Error('expected sample 2')
      const expectedX = lonAt2 * box.cosLat - box.minX
      const expectedY = box.maxY - latAt2

      const circles = container.querySelectorAll('circle')
      expect(circles).toHaveLength(1)
      const circle = circles[0]
      if (circle === undefined) throw new Error('expected a circle')
      expect(Number(circle.getAttribute('cx'))).toBeCloseTo(expectedX, 9)
      expect(Number(circle.getAttribute('cy'))).toBeCloseTo(expectedY, 9)
    })

    it('draws no dot when there is no moment', () => {
      const { container } = render(<Route lat={lat} lon={lon} moment={null} />)
      expect(container.querySelectorAll('circle')).toHaveLength(0)
    })

    it("draws no dot when the moment's own position is null", () => {
      const gappyLat = [57.7, null, 57.72]
      const gappyLon = [14.1, 14.11, 14.12]
      const { container } = render(<Route lat={gappyLat} lon={gappyLon} moment={1} />)
      expect(container.querySelectorAll('circle')).toHaveLength(0)
    })
  })
})
