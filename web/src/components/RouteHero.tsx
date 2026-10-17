import { Component, Suspense, lazy, useMemo } from 'react'
import type { ReactNode, Ref } from 'react'
import type { components } from '../api/schema'
import { cssVar } from '../charts/cssVar'
import { Route as RouteChart } from '../charts/Route'
import { PACE_STEP_COUNT, pacePieces, paceScaleEnds, rampSteps } from '../charts/paceColour'
import type { PaceEnds, RoutePace } from '../charts/paceColour'
import { coveringArea, replayControlsSide } from '../charts/routeMath'
import { isStopped, speedupLabel } from '../charts/replayTimeline'
import { distance, duration } from '../format'
import { currentMoment } from '../moment/momentStore'
import { useMomentState, useMomentStore } from '../moment/useMoment'
import { useReplay } from '../moment/useReplay'
import { PaceLegend } from './PaceLegend'
import { ReplayControls } from './ReplayControls'
import styles from './RouteHero.module.css'

type Basemap = components['schemas']['Basemap']
type BasemapArea = components['schemas']['BasemapArea']

/** The five anchor tokens `rampSteps` interpolates between, slow to fast. */
const PACE_RAMP_TOKENS = [1, 2, 3, 4, 5].map((k) => `--pace-map-${k}`)

/**
 * The id the hero's heading carries. One hero per screen, and a screen
 * that shows the route as an ordinary section instead uses the same id for
 * that section's heading, never both at once.
 */
const HEADING_ID = 'section-route'

/**
 * Catches a failure to load the lazily loaded `RouteMap` chunk.
 *
 * A rejected dynamic import is not something `Suspense` catches on its own -
 * React throws it during render instead, once the lazy component's promise
 * settles rejected, which is what an error boundary is for. The fallback is
 * the identical `Route` that `Suspense` shows while the chunk is still
 * loading, so the hero only ever shows one of two things: the bare trace, or
 * the trace with a map over it. It never shows an error.
 */
class RouteMapErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/**
 * MapLibre is 302 kB gzipped, twice the rest of the app, so it arrives in
 * its own chunk on the first covered route rather than with every view.
 */
const RouteMap = lazy(() => import('../charts/RouteMap'))

/**
 * The hero's own picture: `RouteMap` over the self-hosted basemap when
 * `coveringArea` finds an area holding every sample, the bare `Route`
 * otherwise.
 *
 * The bare trace is also what shows in every state that is not "a covered
 * route, loaded": while `/api/basemap` is still pending, when it fails,
 * while the `RouteMap` chunk itself is still loading (`Suspense`'s
 * fallback), and if that chunk fails to load at all
 * (`RouteMapErrorBoundary`'s). One fallback covers all four, because it is
 * the same picture the reader already has - nothing regresses by the map
 * not being there yet, or not arriving at all.
 */
function HeroPicture({
  lat,
  lon,
  basemap,
  area,
  pace,
  moment,
  replayHead,
}: {
  lat: (number | null)[]
  lon: (number | null)[]
  basemap: Basemap | undefined
  area: BasemapArea | null
  pace?: RoutePace
  moment: number | null
  replayHead: number | null
}) {
  const bare = <RouteChart lat={lat} lon={lon} pace={pace} moment={moment} replayHead={replayHead} />
  if (area === null || basemap === undefined) return bare
  return (
    <RouteMapErrorBoundary fallback={bare}>
      <Suspense fallback={bare}>
        <RouteMap
          lat={lat}
          lon={lon}
          area={area}
          attribution={basemap.attribution}
          pace={pace}
          moment={moment}
          replayHead={replayHead}
        />
      </Suspense>
    </RouteMapErrorBoundary>
  )
}

export interface RouteHeroProps {
  /** The trace to draw, or `null` while the 1 Hz grid is still in flight. */
  trace: { lat: (number | null)[]; lon: (number | null)[] } | null
  /**
   * The run's own grid, for colouring the route by pace - see
   * paceColour.ts and docs/reference/frontend.md. `undefined` for
   * the route view, which draws the route's reference run and keeps its
   * single-colour trace.
   */
  activity?: {
    t: number[]
    distance: (number | null)[]
    speed: (number | null)[]
    paused: (boolean | null)[]
    outage: (boolean | null)[]
  }
  /** `queries.basemap()`'s data, `undefined` while it is pending or when it failed. */
  basemap: Basemap | undefined
  /**
   * The screen's own placement of the band: its bleed, its grid cell on
   * desktop, and whether it reaches the top of the scroll. Those depend on
   * what is around the hero, so they stay with the view.
   */
  className?: string
  /** Controls that float over the picture, such as the activity view's way back. */
  children?: ReactNode
  /**
   * The hero's own `<section>`, for a view that lays it out from script -
   * the activity view's collapsing phone hero, `views/useHeroCollapse.ts`.
   */
  ref?: Ref<HTMLElement>
}

/**
 * A route as a screen's hero: the named region, the picture, and a square
 * placeholder while the trace is still loading.
 *
 * Shared by the activity view, which draws the run's own trace, and the
 * route view, which draws the route's reference run. The region is named
 * from a real heading that is visually hidden: the map is self-evidently
 * the map, and an `aria-labelledby` pointing at a heading cannot come to
 * point at nothing.
 *
 * Whether a screen shows a hero at all is the screen's decision - a run
 * with no trace gets none - so this is only rendered once the screen has
 * decided it has, or is about to have, a trace.
 */
export function RouteHero({ trace, activity, basemap, className, children, ref }: RouteHeroProps) {
  // Read through the wrapper props into the arrays themselves: `trace` and
  // `activity` are object literals a caller like `ActivityDetail` may build
  // fresh on every render even though the arrays inside come from the query
  // cache and are otherwise stable. `pace`'s identity below is a dependency
  // of `RouteMap`'s own build effect, so memoising on the wrappers rather
  // than their contents would tear down and rebuild the whole MapLibre map
  // on a re-render that changed nothing this hero actually draws.
  const traceLat = trace?.lat
  const traceLon = trace?.lon
  const t = activity?.t
  const activityDistance = activity?.distance
  const speed = activity?.speed
  const paused = activity?.paused
  const outage = activity?.outage

  // The moment: an index into the run's own grid, or none. Read straight
  // off the store on every render - see docs/reference/frontend.md's "The moment" -
  // rather than memoised, since it is exactly what makes this hero
  // re-render on a pointer move.
  const moment = currentMoment(useMomentState())

  // The replay, which re-renders this hero on every frame it plays: every
  // memo below is keyed on the grid's arrays, so a frame recomputes none of
  // them, and each picture hands the head to its own `ReplayCanvas`
  // (`charts/replayCanvas.ts`) through `setHead`, which strokes only the
  // pieces newly passed, without re-rendering the trace or repainting the
  // map under it.
  const grid = useMemo(
    () => (t === undefined || paused === undefined || outage === undefined ? null : { t, paused, outage }),
    [t, paused, outage],
  )
  const replay = useReplay(grid, useMomentStore())
  const replayHead = replay.status === 'idle' ? null : replay.head
  const replaySide = useMemo(
    () => (traceLat === undefined || traceLon === undefined ? 'right' : replayControlsSide(traceLat, traceLon)),
    [traceLat, traceLon],
  )
  const momentElapsed = moment === null || t === undefined ? undefined : t[moment]
  const momentDistance = moment === null || activityDistance === undefined ? undefined : activityDistance[moment]
  const momentStopped =
    moment !== null && paused !== undefined && outage !== undefined && isStopped(paused, outage, moment)

  // The one area, if any, the whole picture agrees the route sits inside -
  // computed once here rather than separately by `HeroPicture` and the
  // legend, which both need to know it: the picture, to choose the map,
  // and the legend, to know whether a map style switch sits above it.
  // Memoised: `coveringArea` walks the full trace, and a later task
  // re-renders this hero on every pointer move.
  const area = useMemo(
    () =>
      traceLat === undefined || traceLon === undefined || basemap === undefined
        ? null
        : coveringArea(traceLat, traceLon, basemap.areas),
    [traceLat, traceLon, basemap],
  )

  const ends: PaceEnds | null = useMemo(
    () => (speed === undefined || paused === undefined || outage === undefined ? null : paceScaleEnds(speed, paused, outage)),
    [speed, paused, outage],
  )
  // The ramp is a run's own tokens, not its own trace - it reads the same
  // five colours whichever activity is shown, so it costs nothing to build
  // once rather than only when a run turns out to need it.
  const palette = useMemo(() => rampSteps(PACE_RAMP_TOKENS.map((token) => cssVar(token)), PACE_STEP_COUNT), [])
  const stoppedColour = useMemo(() => cssVar('--pace-map-stopped'), [])
  const pace: RoutePace | undefined = useMemo(() => {
    if (traceLat === undefined || traceLon === undefined || speed === undefined || paused === undefined || outage === undefined) {
      return undefined
    }
    // `ends` is null for a run with no moving speed at all - a treadmill's
    // footpod stream or a run that never left a standstill - and
    // `pacePieces` already takes `PaceEnds | null` for exactly that case:
    // every piece comes back with `step: null`, so the route still draws,
    // in the stopped colour, rather than falling back to the plain accent
    // line. The legend has its own, separate gate on `ends !== null` below.
    const pieces = pacePieces({ lat: traceLat, lon: traceLon, speed, paused, outage }, ends)
    return { pieces, palette, stoppedColour }
  }, [traceLat, traceLon, speed, paused, outage, ends, palette, stoppedColour])

  return (
    <section
      ref={ref}
      className={className === undefined ? styles.hero : `${styles.hero} ${className}`}
      aria-labelledby={HEADING_ID}
    >
      <h2 className={styles.srOnly} id={HEADING_ID}>
        Route
      </h2>
      {/* The picture's own box, whichever picture it is: what a collapsing
          hero scales, and whose layout height is the hero's natural one -
          see `.picture` in RouteHero.module.css. The attribute is how
          `views/useHeroCollapse.ts` finds it to measure. */}
      <div className={styles.picture} data-hero-picture="">
        {trace !== null ? (
          <HeroPicture
            lat={trace.lat}
            lon={trace.lon}
            basemap={basemap}
            area={area}
            pace={pace}
            moment={moment}
            replayHead={replayHead}
          />
        ) : (
          <p className={styles.pending}>Loading the map…</p>
        )}
      </div>
      {ends !== null && (
        <div
          className={area === null ? styles.legendSlot : `${styles.legendSlot} ${styles.legendBelowSwitch}`}
        >
          <PaceLegend ends={ends} palette={palette} />
        </div>
      )}
      {momentElapsed !== undefined && momentDistance !== undefined && (
        // `aria-hidden`, for the reason `VolumeBars`' own readout gives: a
        // value that changes on every pointer move is not something to
        // announce.
        //
        // `area === null` puts the legend, not the switch, in the top-right
        // corner - see `RouteHero.module.css`'s `.momentLabelBelowTop` for
        // why the switch-tuned offset cannot also hold against that.
        <div
          className={area === null ? `${styles.momentLabel} ${styles.momentLabelBelowTop}` : styles.momentLabel}
          aria-hidden="true"
          data-testid="moment-label"
        >
          <span className="mono">
            {duration(momentElapsed)} · {distance(momentDistance)}
          </span>
          {momentStopped && ' · stopped'}
          {replay.status === 'playing' && <span className="mono"> · {speedupLabel(replay.speed)}</span>}
        </div>
      )}
      {activity !== undefined && trace !== null && <ReplayControls replay={replay} side={replaySide} />}
      {children}
    </section>
  )
}
