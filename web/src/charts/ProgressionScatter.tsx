import { Link } from '@tanstack/react-router'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { components } from '../api/schema'
import { Absent } from '../components/Absent'
import { CONFIRMED_JUMP_NOTE } from '../components/recordNotes'
import {
  NO_VALUE,
  distance,
  duration,
  formatLocalShort,
  heartRate,
  localCalendarTime,
  pace,
  paceSecondsPerKm,
} from '../format'
import {
  DATE_LABEL_DY,
  DEFAULT_PLOT_HEIGHT,
  DEFAULT_PLOT_WIDTH,
  FASTER_LABEL_DY,
  LADDER_LABEL_DY,
  SLOWER_LABEL_Y,
  diamondPath,
  inPaintOrder,
  pointStyle,
  readoutFlipsBelow,
  scatterLayout,
  staircase,
  type EffortDatum,
  type PointStyle,
} from './progressionMath'
import { dateAxisSplits, dateTickLabels } from './trendChartMath'
import { clampReadoutLeft } from './volumeBarsMath'
import styles from './ProgressionScatter.module.css'

type ProgressionPoint = components['schemas']['ProgressionPoint']
type RouteRun = components['schemas']['RouteRun']

/** Every effort at one distance, laid out by elapsed time. */
interface DistanceSource {
  /**
   * Optional, and only here: `distance` is what the chart drew before routes
   * existed, so a caller that names neither kind still gets it.
   */
  kind?: 'distance'
  /** `Progression.items`, verbatim: every effort at one distance, with the analysis layer's own eligibility and record flags. */
  points: ProgressionPoint[]
  /** The distance in metres, for the pace in the readout. */
  distanceM: number
}

/** Every run on one route, laid out by pace. */
interface RouteSource {
  kind: 'route'
  /** `RouteDetail.runs`, verbatim: the analysis layer's own direction, eligibility and record flags. */
  runs: RouteRun[]
}

export type ProgressionScatterProps = (DistanceSource | RouteSource) & {
  /** Draw the ineligible efforts too. They are real runs; hiding a third of the points by default would misrepresent training volume. */
  showIneligible: boolean
  ariaLabel: string
}

/**
 * The shape of a mark. A distance chart draws only circles; a route chart
 * draws a run the other way round as a diamond - a shape, not a colour,
 * because colour already says record, ordinary or ineligible, and a second
 * meaning on the same channel would leave a reader unable to tell a reverse
 * record from a forward one. `DIAMOND_HALF_DIAGONAL_PER_RADIUS` records why
 * the diamond is sized to the circle's area.
 */
export type MarkShape = 'circle' | 'diamond'

interface ReadoutRow {
  label: string
  value: string
  /** Set in the mono utility, which a number wants and a place name does not. */
  mono: boolean
}

/**
 * What the drawing code below knows about a point, whichever kind it came
 * from. Both kinds are converted to this at the top of the component, so
 * there is one layout, one paint order, one staircase and one readout, and a
 * fix to any of them reaches both charts.
 *
 * `valueS` is the ladder's own value: an elapsed time for an effort, a pace
 * in seconds per kilometre for a route run. Both are seconds and both are
 * faster-when-smaller, so the one inverted duration axis serves both.
 */
interface ScatterPoint {
  id: string
  /** Fractional local calendar day, the x coordinate. */
  t: number
  /** The readout's heading and the start of the link's accessible name. */
  when: string
  name: string | null
  valueS: number
  eligible: boolean
  record: boolean
  reason: string | null
  /** A qualifier on an eligible point, such as a jump the measured speed confirmed; null on most. */
  note: string | null
  /** A route run's direction, for `data-direction` and the mark's shape; null on a distance chart, which has none. */
  direction: RouteRun['direction'] | null
  rows: ReadoutRow[]
  /** The link's accessible name: what the mark says to someone who cannot see it. */
  label: string
}

/** A reverse run is a diamond and everything else a circle; see `MarkShape`. */
function markShape(direction: ScatterPoint['direction']): MarkShape {
  return direction === 'reverse' ? 'diamond' : 'circle'
}

/**
 * What the readout says under the numbers, for the link's accessible name:
 * the readout itself is `aria-hidden`, so without this a keyboard reader
 * could not tell a record, or an ineligible run and its reason, from any
 * other mark.
 */
function statusLabel(record: boolean, eligible: boolean, reason: string | null, note: string | null = null): string {
  const qualifier = note === null ? '' : `, ${note}`
  if (record) return `, record${qualifier}`
  if (!eligible) return `, not eligible: ${reason ?? 'no reason recorded'}`
  return qualifier
}

function fromEffort(p: ProgressionPoint, distanceM: number): ScatterPoint {
  const when = formatLocalShort(p.start_time_utc, p.utc_offset_s)
  // An eligible effort holding a jump counts only because the measured speed
  // confirmed the distance; saying so keeps it from reading as a clean one.
  const note = p.is_eligible && p.contains_jump === true ? CONFIRMED_JUMP_NOTE : null
  return {
    id: p.activity_id,
    t: localCalendarTime(p.start_time_utc, p.utc_offset_s),
    when,
    name: p.name,
    valueS: p.elapsed_time_s,
    eligible: p.is_eligible,
    record: p.is_record,
    reason: p.ineligible_reason,
    note,
    direction: null,
    rows: [
      { label: 'Time', value: duration(p.elapsed_time_s), mono: true },
      // Presentation arithmetic, not a metric: the API stores speed and
      // never pace, and `format.pace` is where the reciprocal is taken - the
      // same line `views/Records.tsx` has.
      { label: 'Pace', value: pace(distanceM / p.elapsed_time_s), mono: true },
      { label: 'Heart rate', value: heartRate(p.avg_hr_bpm), mono: true },
      { label: 'Where', value: p.locality ?? NO_VALUE, mono: false },
    ],
    label: `${when}, ${duration(p.elapsed_time_s)}${statusLabel(p.is_record, p.is_eligible, p.ineligible_reason, note)}`,
  }
}

const DIRECTION_LABEL: Record<RouteRun['direction'], string> = { forward: 'Forward', reverse: 'Reverse' }

function fromRun(r: RouteRun): ScatterPoint {
  const when = formatLocalShort(r.start_time_utc, r.utc_offset_s)
  return {
    id: r.activity_id,
    t: localCalendarTime(r.start_time_utc, r.utc_offset_s),
    when,
    name: r.name,
    // Pace rather than time because runs of one route differ in recorded
    // length - the longest run of the main loop is 8% longer than the
    // shortest - and a route's total time
    // partly measures where the watch was started and stopped; see "Why
    // pace, not time" in `docs/reference/math/routes.md`. The API serves
    // speed, never pace; the reciprocal is taken here, through `format`, as
    // every other pace in the frontend is.
    valueS: paceSecondsPerKm(r.speed_mps),
    eligible: r.eligible,
    record: r.is_record,
    reason: r.ineligible_reason,
    note: null,
    direction: r.direction,
    rows: [
      { label: 'Pace', value: pace(r.speed_mps), mono: true },
      { label: 'Distance', value: distance(r.distance_m), mono: true },
      { label: 'Direction', value: DIRECTION_LABEL[r.direction], mono: false },
    ],
    label: `${when}, ${pace(r.speed_mps)}, ${DIRECTION_LABEL[r.direction]}${statusLabel(r.is_record, r.eligible, r.ineligible_reason)}`,
  }
}

/** The words the empty state uses, per kind. */
const ABSENCE = {
  distance: {
    none: 'No efforts were returned for this distance.',
    allIneligible: 'Every effort at this distance is ineligible. Show ineligible efforts to see them.',
  },
  route: {
    none: 'No runs were returned for this route.',
    allIneligible: 'Every run on this route is ineligible. Show ineligible runs to see them.',
  },
} as const

/*
 * Plain SVG rather than uPlot, deliberately. Every point here needs a hover
 * readout of its own and is a link to its activity, which means per-point
 * hit testing; uPlot draws to a canvas, where that would need a hit-test
 * layer of our own on top of its cursor index, and its cursor snaps to the
 * nearest x rather than to a point. An SVG `<circle>` is its own hit
 * target, and `<a>` around it is a link the browser already understands -
 * modifier-click opens a new tab without any code here. `charts/Route.tsx`
 * is SVG for a related reason, and this follows its structure.
 */

/**
 * The three marks, in CSS pixels of the rendered panel - which is what a
 * coordinate in this chart now is, see `progressionMath`'s
 * `DEFAULT_PLOT_WIDTH`.
 *
 * **An ordinary effort is small and translucent, and has no ring.** 225 of
 * them sit in a band about 80 px tall, so how many are in one place is a
 * real quantity and the marks have to carry it: at 0.7 opacity one mark
 * reads at 2.4:1 against the page, two overlapping at 2.7 and three at
 * 2.85, which is the opaque colour - so density darkens toward the full
 * hue and the cloud's shape becomes its own histogram. Opaque marks with a
 * page-coloured ring, which is what round 1 gave them, threw all of that
 * away: every overlap read as two separate objects and the densest month
 * looked exactly like the sparsest.
 *
 * That ring was added for a real reason and this is the trade, stated. It
 * was doing two jobs: separating neighbours, and keeping the marks off the
 * staircase. The second is no longer its job - the staircase is drawn last
 * now - and the first is better done by transparency, which separates
 * neighbours *and* counts them. The ring also punched page-coloured holes
 * in the staircase, which is the bug round 3 fixed.
 *
 * **A record keeps its ring**, because it is doing the opposite job: nine
 * marks that must never be read as part of the cloud. It stays opaque, at
 * twice the radius, with a page-coloured gap around it.
 *
 * **An ineligible effort is a plain hollow ring, not a dashed one.** The
 * dashes were solved to close on the circle in round 2, which was the right
 * fix to the arithmetic and the wrong fix to the problem: at 8 px across,
 * six whole dashes are still six specks, and a blind critic read them as
 * "grey noise" at 1x. An unbroken outline is legible at any size and is
 * just as unmistakably not a filled dot. Its fill is `none` rather than the
 * page colour so it cannot erase the cloud behind it, with
 * `pointer-events: all` in the stylesheet keeping the whole disc a hit
 * target for its own readout - a fill that is not painted is not hit.
 *
 * It carries the same radius and the same 0.7 as an eligible effort, and
 * that is deliberate rather than tidy. An outline of radius 3 at a 1 px
 * stroke is about 19 px² of ink against a filled disc's 28, so an
 * ineligible effort is *quieter* than an eligible one at the same size -
 * which is the right way round for a mark that can never set a record.
 * Drawn a step larger, at radius 4 and a 1.25 stroke, the grey rings were
 * the first thing the eye found in the cloud.
 */
const MARK: Record<
  PointStyle,
  { r: number; fill: string; fillOpacity?: number; stroke: string; strokeWidth: number; strokeOpacity?: number }
> = {
  record: { r: 6, fill: 'var(--accent)', stroke: 'var(--page)', strokeWidth: 2 },
  eligible: { r: 3, fill: 'var(--series-4)', fillOpacity: 0.7, stroke: 'none', strokeWidth: 0 },
  ineligible: { r: 3, fill: 'none', stroke: 'var(--ink-dim)', strokeWidth: 1, strokeOpacity: 0.7 },
}

/** The box a legend swatch is drawn in, wide enough for the largest mark plus its ring. */
const SWATCH_PX = 14

/**
 * One of the chart's three marks, in either shape, at the size and in the
 * style the chart draws it, for the key beside the chart.
 *
 * It lives here rather than as CSS shapes in the view because a key that
 * has drifted from its chart is worse than no key. It had: the ineligible
 * mark was a dashed ring when the key was a `border: 1px dashed` on a 10px
 * CSS circle, which no two engines break into the same number of dashes,
 * and a CSS diamond is a rotated square whose area nobody would keep equal
 * to the circle's by hand.
 */
export function ProgressionMark({ style, shape = 'circle' }: { style: PointStyle; shape?: MarkShape }) {
  return (
    <svg
      className={styles.swatch}
      viewBox={`0 0 ${String(SWATCH_PX)} ${String(SWATCH_PX)}`}
      width={SWATCH_PX}
      height={SWATCH_PX}
      aria-hidden="true"
      focusable="false"
    >
      <Mark cx={SWATCH_PX / 2} cy={SWATCH_PX / 2} style={style} shape={shape} />
    </svg>
  )
}

/**
 * One mark, in one of the three styles and either shape - the single place
 * both the panel and its key draw one, so the two cannot disagree.
 *
 * **The paint is presentation attributes, never the `style` attribute, and
 * that is what makes the keyboard focus ring visible at all.** The ring is
 * `.point:focus-visible circle, path` in the stylesheet, setting the
 * stroke. An inline `style` declaration beats every stylesheet rule short
 * of `!important`, so while the paint was inline, as it was from the
 * chart's first commit (`0c0482e`) until 2026-09-25, a focused mark never
 * showed a ring and a keyboard reader could not see where they were.
 * A presentation attribute is the weakest author style there is, so the
 * rule overrides it with no `!important` escalation for the next rule to
 * fight. `ProgressionScatter.test.tsx`'s "focus ring" block pins that no
 * mark carries inline paint.
 */
function Mark({
  cx,
  cy,
  style,
  shape,
  data,
}: {
  cx: number
  cy: number
  style: PointStyle
  shape: MarkShape
  data?: Record<`data-${string}`, string | undefined>
}) {
  const mark = MARK[style]
  const paint = {
    fill: mark.fill,
    fillOpacity: mark.fillOpacity,
    stroke: mark.stroke,
    strokeWidth: mark.strokeWidth,
    strokeOpacity: mark.strokeOpacity,
  }
  return shape === 'diamond' ? (
    <path d={diamondPath(cx, cy, mark.r)} {...paint} {...data} />
  ) : (
    <circle cx={cx} cy={cy} r={mark.r} {...paint} {...data} />
  )
}

/**
 * Half the widest date label this axis emits: `Sep 2026` measures 50 px at
 * `--text-caption`, so 25.
 *
 * A tick within this of either end of the plot gets its label anchored to
 * that end and **pinned to the plot's own edge**, rather than centred on the
 * tick. Two things fall out of that and both are wanted.
 *
 * The label cannot escape into the page gutter or slide under the time
 * ladder, which centring it on a tick near the edge did.
 *
 * And the ladder starts on the page gutter, which is where every other left
 * edge on this screen starts. A blind critic counted five left edges on the
 * screen and named the year labels as the one outlier: the first tick on the
 * real 5 km axis is 1 January 2024, which lands 13 px inside a 305 px plot,
 * so `2024` began 13 px right of everything above it.
 *
 * Pinning moves a label off its own tick by at most half its width. That is
 * affordable *here specifically* because *this chart draws no vertical
 * gridlines and no tick marks* - there is nothing visible for the label to
 * be seen as detached from - and because a year label on a three-year axis
 * says "around here the year turned", not "this pixel is midnight". A chart
 * with visible x ticks must not do this.
 */
const DATE_LABEL_HALF_PX = 25

/**
 * Every effort at one distance over time - or, with `kind: 'route'`, every
 * run on one route, by pace - records marked and joined by the running-best
 * staircase.
 *
 * **One component for both, by construction.** The two kinds are converted
 * to one `ScatterPoint` shape at the top and nothing below that line knows
 * which it is drawing, apart from the direction key a route adds under the
 * panel. A route plots pace, `1000 / speed_mps` seconds per kilometre, on
 * the same inverted duration axis: its ladder reads `5:00` where the
 * distance chart's reads `25:00`, and `FASTER` is still at the bottom.
 *
 * **The time axis is inverted: a faster effort sits lower.** See
 * `progressionMath.scatterLayout`. The chart says so itself, in the ladder
 * column: `SLOWER` above the top tick and `FASTER` below the bottom one, the
 * second in full ink where the first is dim. Those two words are the only
 * thing on the panel that tells a reader which direction is an improvement,
 * so do not remove them to tidy the axis - the descending staircase is only
 * legible as progress once the direction is known.
 *
 * Nothing here decides what a record is or which effort is eligible: both
 * come from the analysis layer as `is_record` and `is_eligible`, because
 * measured on the real store the five fastest 400 m efforts are all flagged
 * `contains_jump` - an advance in the recorded distance whose implied speed
 * exceeds the analysis layer's threshold, which names no cause - and a
 * chart that crowned the fastest time would lead with a number no human has
 * run.
 *
 * **The SVG's viewBox is the panel's own measured size, so one coordinate
 * unit is one CSS pixel.** It was a fixed 800x360 scaled to fit, which made
 * every stated size a lie at both ends - a 4 px point radius drew at 1.8 px
 * on a phone and 5.4 px on a desktop column. See `progressionMath`.
 *
 * The hover readout is HTML, absolutely positioned inside the panel and
 * adding no layout height - the house rule `UPlot.tsx` documents, applied
 * to a chart that is not uPlot.
 */
export function ProgressionScatter(props: ProgressionScatterProps) {
  const { showIneligible, ariaLabel } = props
  const kind = props.kind ?? 'distance'
  // Keyed on the array the caller passed, and the distance, rather than on
  // `props`, which is new on every render. Narrowed on `props.kind` inside,
  // so each kind converts with no fallback for a shape that cannot occur;
  // the kind cannot change without the array changing with it.
  const all = useMemo<ScatterPoint[]>(
    () =>
      props.kind === 'route'
        ? props.runs.map(fromRun)
        : props.points.map((p) => fromEffort(p, props.distanceM)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    [props.kind === 'route' ? props.runs : props.points, props.kind === 'route' ? null : props.distanceM],
  )

  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const readoutRef = useRef<HTMLDivElement | null>(null)
  const [panel, setPanel] = useState({ width: 0, height: 0 })
  const [readoutWidthPx, setReadoutWidthPx] = useState(0)
  const [readoutHeightPx, setReadoutHeightPx] = useState(0)

  const visible = useMemo(() => (showIneligible ? all : all.filter((p) => p.eligible)), [all, showIneligible])
  const efforts = useMemo<EffortDatum[]>(
    () => visible.map((p) => ({ t: p.t, valueS: p.valueS, isRecord: p.record })),
    [visible],
  )

  // The fallback is per dimension rather than for the pair, because jsdom
  // reports zero for both while the chart's own tests stub one of them: a
  // pair-wise fallback would throw away a stubbed panel height and lay the
  // chart out at a size no test asked for.
  const width = panel.width > 0 ? panel.width : DEFAULT_PLOT_WIDTH
  const height = panel.height > 0 ? panel.height : DEFAULT_PLOT_HEIGHT

  const layout = useMemo(() => scatterLayout(efforts, width, height), [efforts, width, height])
  const stair = useMemo(() => staircase(efforts, layout), [efforts, layout])

  /*
   * The panel's own size, measured, because it is what the viewBox is set
   * from: everything this chart draws is in the panel's CSS pixels, so a
   * panel whose size the component has not read would draw at the wrong
   * scale rather than merely in the wrong place. A `ResizeObserver` keeps
   * it right through a window resize and through the desktop breakpoint,
   * which a one-shot measurement on mount would not; it does not exist in
   * jsdom, so the first measurement stands there - `charts/UPlot.tsx`
   * carries the same guard for the same reason.
   *
   * Keyed on whether the panel is drawn at all, because the empty state
   * below renders `<Absent>` in its place: a panel that mounts after an
   * absence is a new element, and an effect that ran only on the first
   * mount would never observe it.
   */
  const isDrawn = visible.length > 0
  useLayoutEffect(() => {
    const wrap = wrapRef.current
    if (wrap === null) return undefined
    const measure = () => {
      const next = { width: wrap.clientWidth, height: wrap.clientHeight }
      setPanel((previous) =>
        previous.width === next.width && previous.height === next.height ? previous : next,
      )
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(wrap)
    return () => {
      observer.disconnect()
    }
  }, [isDrawn])

  // Measured after layout rather than assumed, because what the readout
  // says is what decides how wide and how tall it is. Keyed on the hovered
  // point so a sweep across one point does not re-measure; see
  // `VolumeBars.tsx` for the same pair. Declared above the empty-state
  // return below, because a hook may not be called conditionally - the ref
  // is simply null on the render that states an absence.
  useLayoutEffect(() => {
    const readout = readoutRef.current
    if (readout === null) return
    const nextWidth = readout.offsetWidth
    const nextHeight = readout.offsetHeight
    setReadoutWidthPx((previous) => (previous === nextWidth ? previous : nextWidth))
    setReadoutHeightPx((previous) => (previous === nextHeight ? previous : nextHeight))
  }, [hoveredId])

  if (!isDrawn) {
    return <Absent reason={all.length === 0 ? ABSENCE[kind].none : ABSENCE[kind].allIneligible} />
  }

  const dateTicks = dateAxisSplits(layout.xDomain[0], layout.xDomain[1], layout.plot.width)
  const dateLabels = dateTickLabels(dateTicks)

  const drawn = visible.flatMap((p, i) => {
    const effort = efforts[i]
    if (effort === undefined) return []
    return [
      {
        point: p,
        cx: layout.x(effort.t),
        cy: layout.y(effort.valueS),
        style: pointStyle(p.record, p.eligible),
      },
    ]
  })
  const painted = inPaintOrder(drawn, (d) => d.style)
  const hovered = hoveredId === null ? undefined : drawn.find((d) => d.point.id === hoveredId)

  return (
    <>
      <div className={styles.wrap} ref={wrapRef}>
        <svg
          className={styles.svg}
          viewBox={`0 0 ${String(width)} ${String(height)}`}
          role="img"
          aria-label={ariaLabel}
        >
          {/* Horizontal rules only. The reference draws three of them across
              its plot and nothing vertical at all, and with 225 points a
              vertical for every date tick was the loudest ink on the panel. */}
          {layout.timeTicks.map((s) => (
            <g key={`t${String(s)}`}>
              <line
                className={styles.gridLine}
                x1={layout.plot.left}
                x2={layout.plot.right}
                y1={layout.y(s)}
                y2={layout.y(s)}
              />
              {/* Right-aligned on the panel's own right edge, which is the
                  page's right gutter - so the ladder ends where every other
                  line on the page ends and the times stack on their colons.
                  `VolumeBars` does the same with uPlot's `alignTo: 2`. */}
              <text className={styles.axisLabel} x={width} y={layout.y(s) + LADDER_LABEL_DY} textAnchor="end">
                {duration(s)}
              </text>
            </g>
          ))}
          <text className={styles.directionSlower} x={width} y={SLOWER_LABEL_Y} textAnchor="end">
            SLOWER
          </text>
          <text
            className={styles.directionFaster}
            x={width}
            y={layout.plot.bottom + FASTER_LABEL_DY}
            textAnchor="end"
          >
            FASTER
          </text>
          {dateTicks.map((d, i) => {
            const tickX = layout.x(d)
            const nearLeft = tickX < layout.plot.left + DATE_LABEL_HALF_PX
            const nearRight = tickX > layout.plot.right - DATE_LABEL_HALF_PX
            return (
              <text
                key={`d${String(d)}`}
                className={styles.axisLabel}
                x={nearLeft ? layout.plot.left : nearRight ? layout.plot.right : tickX}
                y={layout.plot.bottom + DATE_LABEL_DY}
                textAnchor={nearLeft ? 'start' : nearRight ? 'end' : 'middle'}
              >
                {dateLabels[i]}
              </text>
            )
          })}
          {painted.map(({ point: p, cx, cy, style }) => (
            <Link
              key={p.id}
              to="/activities/$activityId"
              params={{ activityId: p.id }}
              className={styles.point}
              aria-label={p.label}
              onMouseEnter={() => setHoveredId(p.id)}
              onMouseLeave={() => setHoveredId(null)}
              onFocus={() => setHoveredId(p.id)}
              onBlur={() => setHoveredId(null)}
            >
              <Mark
                cx={cx}
                cy={cy}
                style={style}
                shape={markShape(p.direction)}
                data={{
                  'data-activity-id': p.id,
                  'data-record': p.record ? 'true' : 'false',
                  'data-eligible': p.eligible ? 'true' : 'false',
                  'data-direction': p.direction ?? undefined,
                }}
              />
            </Link>
          ))}
          {/*
           * Last, so it is above every mark on the panel.
           *
           * **This was a real rendering fault, not a z-order preference.**
           * Drawn before the points, the line was erased wherever a mark's
           * ring or fill crossed it - and both are `--page`, the panel's own
           * background, so the breaks looked like gaps in the line rather
           * than like something in front of it. Measured on the round-2
           * capture at 3x: 76 columns of the staircase's 906-column span held
           * no accent pixel at all, in runs of up to 24, and sampling inside
           * one gave exactly rgb(233,238,241) - `--page` - from an ineligible
           * effort's fill. A record's own 2 px ring cut the line twice more
           * at every vertex.
           *
           * On top, none of that can happen: the line covers a few marks
           * instead of being covered by them, which is the right way round
           * for the one mark that carries the screen's story. Over a record
           * dot it is invisible anyway, both being accent.
           *
           * `pointer-events: none` in the stylesheet is part of this fix: an
           * SVG stroke is a hit target by default, so a line painted last
           * would otherwise swallow the hover of every point beneath it -
           * including the record dots, whose centres it passes straight
           * through.
           */}
          {stair.length > 0 && (
            <polyline
              className={styles.staircase}
              data-testid="staircase"
              points={stair.map((p) => `${String(p.x)},${String(p.y)}`).join(' ')}
            />
          )}
        </svg>
        {hovered !== undefined && (
          <div
            ref={readoutRef}
            // Flipped below the point only when the measured readout does not
            // fit in the measured pixels above it; `readoutFlipsBelow` records
            // why the point's y and the readout's height have to be in one
            // unit for that question to have an answer.
            className={`${styles.readout} ${
              readoutFlipsBelow(hovered.cy, panel.height, readoutHeightPx) ? styles.readoutBelow : ''
            }`}
            style={{
              // Both in panel pixels, which is what a coordinate in this
              // chart is now. The horizontal one is clamped: centred with
              // `translateX(-50%)`, half the box hangs either side, and
              // `.wrap` sets no `overflow`, so at the rightmost point that
              // half joined the document's scrollable area - measured in
              // Chromium, a 606px viewport reported a 644px document and a
              // 390px one a 436px document while hovering, with the time,
              // pace and heart rate rows off screen. `clampReadoutLeft` is
              // the same function the uPlot readouts use, so both charts
              // clamp by one rule.
              left: `${String(clampReadoutLeft(hovered.cx, readoutWidthPx, panel.width))}px`,
              top: `${String(hovered.cy)}px`,
            }}
            // Not a live region, for the reason VolumeBars.tsx gives: a
            // pointer-only affordance is left to the pointer, and the link's
            // own aria-label carries the essentials for a keyboard reader.
            aria-hidden="true"
            data-testid="progression-readout"
          >
            <p className={styles.readoutWhen}>{hovered.point.when}</p>
            {hovered.point.name !== null && <p className={styles.readoutName}>{hovered.point.name}</p>}
            {hovered.point.rows.map((row) => (
              <p key={row.label} className={styles.readoutRow}>
                <span>{row.label}</span>
                <span className={row.mono ? 'mono' : undefined}>{row.value}</span>
              </p>
            ))}
            {hovered.point.record && <p className={`${styles.readoutRow} ${styles.readoutRecord}`}>Record</p>}
            {!hovered.point.eligible && (
              <p className={styles.readoutReason}>Not eligible: {hovered.point.reason ?? 'no reason recorded'}</p>
            )}
            {hovered.point.eligible && hovered.point.note !== null && (
              <p className={styles.readoutReason}>Counted: {hovered.point.note}</p>
            )}
          </div>
        )}
      </div>
      {/*
       * The direction key, under the panel rather than inside `.wrap`, whose
       * height is stated and must not be moved by its content. It lives here
       * rather than in the view because the diamond is this chart's encoding:
       * a route chart without its key would draw a shape nothing names.
       */}
      {kind === 'route' && (
        <ul className={styles.directionKey} aria-label="Directions">
          <li className={styles.directionKeyItem}>
            <ProgressionMark style="eligible" shape="circle" />
            {DIRECTION_LABEL.forward}
          </li>
          <li className={styles.directionKeyItem}>
            <ProgressionMark style="eligible" shape="diamond" />
            {DIRECTION_LABEL.reverse}
          </li>
        </ul>
      )}
    </>
  )
}
