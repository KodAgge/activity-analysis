import { useEffect, useMemo, useRef } from 'react'
import type { CSSProperties } from 'react'
import { Absent } from '../components/Absent'
import { pieceColour, type RoutePace } from './paceColour'
import { ReplayCanvas, type ReplayPath } from './replayCanvas'
import { PAD_FRACTION, SCALE_BAR_TARGET_FRACTION, niceRoundNumber, panelAspectRatio, projectedBox, scaleBarWidthFraction, toRuns } from './routeMath'
import { ScaleBar } from './ScaleBar'
import styles from './Route.module.css'

export interface RouteProps {
  lat: (number | null)[]
  lon: (number | null)[]
  /** The route coloured by pace, in place of the single accent trace - see paceColour.ts. */
  pace?: RoutePace
  /**
   * The moment to mark with a dot - a grid index into `lat`/`lon`, or
   * `null`/`undefined` for none. See `moment/momentStore.ts`'s
   * `currentMoment` and docs/reference/frontend.md's "The moment".
   */
  moment?: number | null
  /**
   * How far a replay has drawn the line - a grid index, see
   * `moment/useReplay.ts`. `null` or absent draws the full line; a number
   * draws the pieces with `end <= replayHead` over a faint outline of the
   * whole route, the pieces on a canvas of their own. Only a coloured route
   * replays: without `pace` it is ignored.
   */
  replayHead?: number | null
}

// A commonly used flat approximation (WGS84 mean, ~111.32 km per degree of
// latitude). This is a sketch with no basemap and no claim to survey
// precision - the same constant doubles as "distance per degree" for the
// longitude axis too, because the cosine correction `Route` applies (see
// its own doc block below) is exactly what makes one unit of corrected
// longitude worth the same ground distance as one unit of latitude.
const METRES_PER_DEGREE = 111_320

/*
 * The trace's own stroke width, as a fraction of the larger extent - see
 * the note on `span` below for why it has to be a fraction of one extent
 * rather than one of each axis.
 *
 * 1.4% of the span, up from 1%. At hero scale a 1% stroke is about 3.5 CSS
 * px across a 412 px panel, which reads as a hairline plot of a path; the
 * reference draws its route as a bold ribbon, and that weight is what makes
 * it read as a route rather than as a chart line.
 *
 * It is the only size left in user units. The scale bar's were too, and
 * that is what put the bar in the wrong place and sized its label at 21 CSS
 * px - see `scaleBarWidthFraction` in `routeMath.ts`.
 */
const TRACE_STROKE_FRACTION = 0.014

/**
 * Everything about the trace that depends only on `lat`, `lon` and `pace` -
 * never on `moment` - computed once and reused across a pointer move.
 *
 * `Route` re-renders on every moment change (the hero re-renders on every
 * pointer move over a stream panel, and passes the new index straight
 * through), and this is the expensive part: projecting every sample,
 * building each polyline's point string, and - the dominant cost on a long
 * run - building one drawn `<polyline>` per pace piece, up to 1,466 of them
 * on one long run in the real store. Measured in a production
 * build, from a synthetic pointer move to the next painted frame after the
 * moment label changed: a median 7.8-11.2 ms before this memo existed
 * (two independent runs) and 2.8-4.25 ms after it, against a 0.5 ms
 * floor with the moment removed entirely.
 *
 * Memoising the *data* alone would not have been enough: the `<polyline>`
 * elements themselves have to be the same object across renders, not just
 * built from the same strings, for React to skip re-diffing that subtree
 * (its bailout on an unchanged fiber checks the element's own `props`
 * reference, not a deep comparison) - so the rendered elements are built
 * here too, not just the numbers behind them.
 */
function useTrace(lat: (number | null)[], lon: (number | null)[], pace: RoutePace | undefined) {
  return useMemo(() => {
    const runs = toRuns(lat, lon)
    const box = projectedBox(lat, lon)
    if (box === null) return null

    // Same box `routePanelRatio` derives its ratio from - see `routeMath.ts`'s
    // `projectedBox` for why the two must share this rather than each
    // computing their own cosine correction.
    const { cosLat, minX, maxY, rangeX, rangeY } = box

    const projected = runs.map((run) => run.map((p) => ({ x: p.lon * cosLat, y: p.lat })))

    const toSvg = (p: { x: number; y: number }) => ({
      svgX: p.x - minX,
      // North is up: the largest latitude gets the smallest (topmost) SVG y.
      svgY: maxY - p.y,
    })

    const polylines = projected.map((run) =>
      run.map((p) => {
        const { svgX, svgY } = toSvg(p)
        return `${svgX},${svgY}`
      }),
    )

    const paddedMinX = -rangeX * PAD_FRACTION
    const paddedMinY = -rangeY * PAD_FRACTION
    const paddedWidth = rangeX * (1 + 2 * PAD_FRACTION)
    const paddedHeight = rangeY * (1 + 2 * PAD_FRACTION)

    // `preserveAspectRatio="meet"` inside the panel box (whose ratio
    // `panelAspectRatio` clamps, so it can differ from the route's own) scales
    // both axes by one factor, and that factor is set by whichever extent is
    // larger. Every size expressed in user units - stroke widths, the label,
    // the scale bar itself - therefore has to be a fraction of that same
    // larger extent, or a strongly one-sided route renders them sub-pixel on
    // one axis and enormous on the other.
    const span = Math.max(rangeX, rangeY)

    // A pace piece's own coords are `[lon, lat]` pairs from the same source
    // stream `lat`/`lon` above, so they take the same cosine correction and
    // the same box - a piece drawn off a different box would drift from the
    // route it is meant to colour.
    // The same numbers are kept flat for the replay's canvas, which
    // strokes them in these user units through its own transform.
    const replayPaths: ReplayPath[] | undefined = pace?.pieces.map((piece) => {
      const points: number[] = []
      for (const [lonV, latV] of piece.coords) {
        const { svgX, svgY } = toSvg({ x: lonV * cosLat, y: latV })
        points.push(svgX, svgY)
      }
      return { end: piece.end, colour: pieceColour(pace, piece), points }
    })
    const paceStrokes = replayPaths?.map((path) => {
      const pairs: string[] = []
      for (let i = 0; i + 1 < path.points.length; i += 2) pairs.push(`${path.points[i]},${path.points[i + 1]}`)
      return { points: pairs.join(' '), stroke: path.colour }
    })

    // The rendered trace elements themselves, not only the data behind
    // them - see this function's own doc comment for why.
    const pieceElements = paceStrokes?.map((piece, i) => (
      <polyline
        key={i}
        points={piece.points}
        style={{ fill: 'none', stroke: piece.stroke }}
        strokeWidth={span * TRACE_STROKE_FRACTION}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ))
    const runElements = (stroke: string, round: boolean) =>
      polylines.map((points, i) => (
        <polyline
          key={i}
          points={points.join(' ')}
          style={{ fill: 'none', stroke }}
          strokeWidth={span * TRACE_STROKE_FRACTION}
          strokeLinecap={round ? 'round' : undefined}
          strokeLinejoin={round ? 'round' : undefined}
        />
      ))
    // The full line, one element, so a moment change skips it whole.
    const fullTrace = <g>{pieceElements ?? runElements('var(--accent)', false)}</g>
    // What the static trace shows during a replay: the faint outline, round
    // like the pieces the canvas draws over it and the map's own outline.
    const outline = pieceElements === undefined ? null : <g>{runElements('var(--pace-map-outline)', true)}</g>

    // Both axes are in the same "degrees of latitude" unit once longitude
    // has been cosine-corrected, so one constant converts either dimension.
    const unitsPerMetre = 1 / METRES_PER_DEGREE
    const visibleSpanMetres = span / unitsPerMetre
    const niceMetres = niceRoundNumber(visibleSpanMetres * SCALE_BAR_TARGET_FRACTION)
    const barLengthUnits = niceMetres * unitsPerMetre

    const panelRatio = panelAspectRatio(paddedWidth, paddedHeight)

    return {
      cosLat,
      toSvg,
      span,
      fullTrace,
      outline,
      replayPaths,
      paddedMinX,
      paddedMinY,
      paddedWidth,
      paddedHeight,
      panelRatio,
      niceMetres,
      barLengthUnits,
    }
  }, [lat, lon, pace])
}

/**
 * The run's GPS trace as a plain, single-colour polyline. `Route` draws no
 * basemap itself: it is the whole picture where no fetched area covers the
 * run, and the loading state and fallback under `RouteMap` where one does.
 * Plain SVG, like `ZoneBar` - a route is not a Cartesian chart uPlot has an
 * opinion about.
 *
 * Longitude is scaled by `cos(mean latitude)` before plotting. A degree of
 * longitude is only as wide as a degree of latitude at the equator; at the
 * fixtures' latitude, 57.77 degrees north, one degree of longitude spans
 * about 0.53 degrees of latitude's worth of ground distance, and an
 * unscaled trace would render about twice as wide as it is tall.
 *
 * A null sample is dropped rather than plotted, and each contiguous run of
 * valid samples becomes its own `<polyline>`, so a real gap breaks the
 * trace instead of drawing a straight chord across whatever the athlete did
 * while unrecorded. `routeMath.ts`'s `toRuns` is where that happens and why.
 *
 * The panel follows the route's own aspect ratio, clamped by
 * `panelAspectRatio` below - `Route.module.css`'s 3:2 is only the fallback
 * for a route with no ratio to state yet. `preserveAspectRatio="xMidYMid
 * meet"` still letterboxes the trace inside whatever box that produces,
 * but on a route the clamp does not bind there is nothing left to
 * letterbox; the visible letterbox is now the clamp's degenerate case
 * rather than the normal path. It is what bounds a route the clamp *does*
 * bind - an out-and-back along a straight path - without stretching the
 * trace, which the cosine correction above exists to keep true.
 */
export function Route({ lat, lon, pace, moment, replayHead }: RouteProps) {
  const trace = useTrace(lat, lon, pace)
  const head = replayHead ?? null
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const replayCanvasRef = useRef<ReplayCanvas | null>(null)
  const headRef = useRef(head)

  // The replay's canvas, laid out over the trace's own box: the same
  // `meet` fit the SVG's viewBox gets, as a transform from user units to
  // CSS pixels, redone whenever the panel resizes.
  useEffect(() => {
    const canvas = canvasRef.current
    const paths = trace?.replayPaths
    if (canvas === null || trace === null || paths === undefined) return undefined
    const replayCanvas = new ReplayCanvas(canvas)
    replayCanvas.setHead(headRef.current)
    replayCanvasRef.current = replayCanvas
    const { paddedMinX, paddedMinY, paddedWidth, paddedHeight, span } = trace
    const layout = () => {
      // The layout size, not the bounding box, which a collapsing phone
      // hero's scale transform shrinks - see `RouteMap`'s `fit`.
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (!(width > 0) || !(height > 0)) return
      const scale = Math.min(width / paddedWidth, height / paddedHeight)
      const dx = (width - paddedWidth * scale) / 2 - paddedMinX * scale
      const dy = (height - paddedHeight * scale) / 2 - paddedMinY * scale
      replayCanvas.layout(paths, width, height, window.devicePixelRatio || 1, { scale, dx, dy }, span * TRACE_STROKE_FRACTION)
    }
    layout()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(layout)
    observer?.observe(canvas)
    return () => {
      observer?.disconnect()
      if (replayCanvasRef.current === replayCanvas) replayCanvasRef.current = null
    }
  }, [trace])

  // A frame's head: the canvas strokes only the pieces newly passed.
  useEffect(() => {
    headRef.current = head
    replayCanvasRef.current?.setHead(head)
  }, [head])

  if (trace === null) {
    return <Absent reason="No GPS route recorded for this activity." />
  }

  const { cosLat, toSvg, span, fullTrace, outline, replayPaths, paddedMinX, paddedMinY, paddedWidth, paddedHeight, panelRatio, niceMetres, barLengthUnits } =
    trace
  const viewBox = `${paddedMinX} ${paddedMinY} ${paddedWidth} ${paddedHeight}`

  // The moment's own dot, drawn over whichever trace above. `moment` is a
  // grid index into the same `lat`/`lon` the memo above already projected,
  // so a null position - the derived layer nulls it across a gap the same
  // way it nulls a sensor channel - draws no dot, exactly as `RouteMap`'s
  // marker does for the same case. Cheap - `toSvg` is one multiply and two
  // subtractions - so it costs nothing to redo on every moment change
  // rather than caching it alongside the trace above.
  const momentLat = moment === undefined || moment === null ? undefined : lat[moment]
  const momentLon = moment === undefined || moment === null ? undefined : lon[moment]
  const momentPoint =
    momentLat === undefined || momentLat === null || momentLon === undefined || momentLon === null
      ? null
      : toSvg({ x: momentLon * cosLat, y: momentLat })

  /*
   * Three layers. The static trace is the memoised SVG, which changes only
   * when a replay starts or ends, between the full line and the outline.
   * Over it, the replay's canvas and a second SVG holding only the dot,
   * each on a compositing layer of its own (`Route.module.css`'s `.layer`),
   * so a pointer move or a replay frame repaints neither the trace nor the
   * other: measured under SwiftShader, a dot in the trace's own SVG made a
   * pointer move repaint all 1,466 pieces, for frames of several seconds.
   */
  return (
    <div className={styles.wrap} style={{ '--route-ratio': String(panelRatio) } as CSSProperties}>
      <svg
        className={styles.route}
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        style={{ aspectRatio: String(panelRatio) }}
        role="img"
        aria-label="Route map"
      >
        {head !== null && outline !== null ? outline : fullTrace}
      </svg>
      {replayPaths !== undefined && <canvas ref={canvasRef} className={styles.layer} aria-hidden="true" />}
      <svg className={styles.layer} viewBox={viewBox} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        {momentPoint !== null && (
          <circle
            cx={momentPoint.svgX}
            cy={momentPoint.svgY}
            r={span * TRACE_STROKE_FRACTION * 1.6}
            fill="var(--raised)"
            stroke="var(--ink)"
            strokeWidth={(span * TRACE_STROKE_FRACTION) / 2}
          />
        )}
      </svg>
      {niceMetres > 0 && (
        /*
         * The scale bar is an overlay in the *panel's* coordinates, not a
         * `<g>` in the trace's. Inside the SVG it was correct and misplaced:
         * `meet` centres the viewBox, so on any route the aspect clamp binds
         * on it started a letterbox-width in from the edge, and that offset
         * moves with every route's shape. Out here it sits on
         * `--route-inset`, the one inset the hero layer has - the same one
         * `ActivityDetail` puts its back control on.
         *
         * Its length is still the trace's own scale: `scaleBarWidthFraction`
         * converts the round number of metres into a fraction of the panel's
         * width, from the geometry this component already fixes.
         */
        <ScaleBar
          metres={niceMetres}
          fraction={scaleBarWidthFraction(barLengthUnits, paddedWidth, paddedHeight, panelRatio)}
        />
      )}
    </div>
  )
}
