import { Absent } from '../components/Absent'
import { paceRange } from '../components/plan/planMath'
import { kindSlotClass } from '../components/plan/sessionMarks'
import { calendarDayOfDate, dayMonthLabel, paceOfSeconds, sessionKindLabel, speedRangeAsPace } from '../format'
import {
  LABEL_CHAR_PX,
  PLAN_CHART_FALLBACK_WIDTH_PX,
  besideLabels,
  labelBox,
  linearScale,
  plotBox,
  timeLadder,
  weekStride,
} from './planChartMath'
import type { BesideItem, LabelBox } from './planChartMath'
import { sideBySide } from './planShapeMath'
import type { PaceMark } from './planShapeMath'
import { PlanChartStats } from './PlanChartStats'
import { usePanelWidth } from './usePanelWidth'
import styles from './PlanPaces.module.css'

export interface PlanPacesProps {
  /** From `planShapeMath.paceMarks`, in date order. */
  marks: PaceMark[]
  /** From `planShapeMath.planDays`: the axis's `[start, end)` in day numbers. */
  span: [number, number]
  /** The goal's pace, `planShapeMath.goalPaceS`, in seconds per kilometre. */
  goalPaceS: number
  /** From `planShapeMath.easyBand`, or null when no easy session gives a pace. */
  easy: { fastS: number; slowS: number } | null
  raceDate: string
}

/** The key's entries, the calendar's own words for its slots; only those the chart draws are shown. */
const PACE_KEY: readonly { label: string; kinds: readonly PaceMark['kind'][] }[] = [
  { label: 'Intervals', kinds: ['intervals'] },
  { label: 'Tempo or threshold', kinds: ['tempo', 'threshold'] },
  { label: 'Time trial or race', kinds: ['time_trial', 'race'] },
]

/**
 * Taller than the weekly charts' `PLAN_CHART_HEIGHT_PX`, as Runna's pace
 * chart is near square: the ranges are seconds apart and need the room.
 */
const PACES_HEIGHT_PX = 248
const DAYS_PER_WEEK = 7
/** A range's capsule, and its two ends, Runna's fastest and slowest rep dots. */
const END_RADIUS_PX = 5
const BAR_WIDTH_PX = 2 * END_RADIUS_PX
const BAR_GAP_PX = 4
/** A range narrower than this still draws as a visible mark: most are a few seconds wide. */
const MIN_BAR_PX = 2 * END_RADIUS_PX
/**
 * The ladder's rules stand this far inside the plot's top and bottom, which
 * carry Runna's direction words, "Faster" and "Slower", alone on the axis.
 */
const LADDER_INSET_PX = 22
/** A mark's box keeps this much air around it against a label. */
const MARK_PAD_PX = 2
/** The goal line's reach against a label: its stroke and a pixel of air. */
const LINE_PAD_PX = 2
/** The easy label's baseline below the band's middle, so the label sits centred in it. */
const EASY_LABEL_DY = 4
const BAND_LABEL_DX = 4
const WEEK_LABEL_DY = 19
const RACE_TICK_PX = 5
const LADDER_LABEL_DX = 6
/** The goal's label sits this far in from the plot's edge, and above or below its line by these. */
const LINE_LABEL_INSET_PX = 4
const LINE_LABEL_ABOVE_DY = -6
const LINE_LABEL_BELOW_DY = 15

/**
 * Where the goal line's label goes, `width` wide: above the line at the
 * left, else below it, else the same at the right, the first that covers
 * no mark; with every place taken, above at the left, where its halo keeps
 * it legible.
 */
function goalLabelPlace(
  lineY: number,
  width: number,
  plot: LabelBox,
  obstacles: LabelBox[],
): { x: number; anchor: 'start' | 'end'; box: LabelBox } {
  const candidates = (['start', 'end'] as const).flatMap((anchor) =>
    [LINE_LABEL_ABOVE_DY, LINE_LABEL_BELOW_DY].map((dy) => {
      const x = anchor === 'start' ? plot.left + LINE_LABEL_INSET_PX : plot.right - LINE_LABEL_INSET_PX
      const box = labelBox(anchor === 'start' ? x : x - width, width, lineY + dy)
      return { x, anchor, box }
    }),
  )
  const clear = (b: LabelBox) => obstacles.every((o) => b.right <= o.left || o.right <= b.left || b.bottom <= o.top || o.bottom <= b.top)
  return candidates.find((c) => clear(c.box)) ?? (candidates[0] as (typeof candidates)[number])
}

/**
 * Where the plan's target paces go: for every work step with a speed in a
 * quality, trial or race session, a range from its slower to its faster
 * pace at the session's date, in the session's calendar colour, a week's
 * ranges side by side in its column, drawn as Runna draws a rep's range: a pale capsule
 * between a solid dot at the faster end and a light one at the slower.
 *
 * The y axis is pace, faster up. As on Runna's chart the plot's top and
 * bottom carry the direction words alone, "Faster" and "Slower", and the
 * ladder of whole half minutes (`planChartMath.timeLadder`) stands inside
 * them, so no word sits on a number. The x axis is one airy column per
 * plan week, dashed at its left edge as Runna's are; a long plan keeps
 * only the columns its `W` labels keep (`weekStride`), so 35 weeks on a
 * phone are not a barcode. The race is a tick under the baseline, keyed.
 *
 * Each range's paces are written beside it, level with its middle
 * (`planChartMath.besideLabels`), never above or below, so a label covers
 * no dot and no line; a range repeated week after week is written once.
 * The goal pace is an ink line, never a kind's colour, and the easy range
 * from the easy sessions a faint band in the easy slot's colour. The
 * span's dates are the card's aside (`views/Plan.tsx`), and a stat row
 * over the chart gives the goal pace, the fastest target and how many
 * sessions set one.
 *
 * Plain SVG, its viewBox the panel's measured width, as `PlanVolume`.
 */
export function PlanPaces({ marks, span, goalPaceS, easy, raceDate }: PlanPacesProps) {
  const [panelRef, measured] = usePanelWidth<HTMLDivElement>()
  if (marks.length === 0) {
    return <Absent reason="The plan sets no target pace for a quality session yet." />
  }

  const width = measured > 0 ? measured : PLAN_CHART_FALLBACK_WIDTH_PX
  const height = PACES_HEIGHT_PX
  const plot = plotBox(width, height)
  const x = linearScale(span[0], span[1], plot.left, plot.right)
  const values = [goalPaceS, ...marks.flatMap((m) => [m.fastS, m.slowS]), ...(easy === null ? [] : [easy.fastS, easy.slowS])]
  const ladder = timeLadder(values)
  const y = linearScale(ladder.min, ladder.max, plot.top + LADDER_INSET_PX, plot.bottom - LADDER_INSET_PX)
  const raceDay = calendarDayOfDate(raceDate)

  // One column per plan week, Runna's dashed column per date: the plan's
  // weeks start on `span[0]` and run seven days each. A long plan draws
  // the columns of the weeks it labels, every `k`th, and no others.
  const weekCount = Math.max(1, Math.ceil((span[1] - span[0]) / DAYS_PER_WEEK))
  const weekEdges = Array.from({ length: weekCount + 1 }, (_, i) =>
    Math.min(x(span[0] + i * DAYS_PER_WEEK), plot.right),
  )
  const weekCentres = weekEdges.slice(0, -1).map((left, i) => (left + (weekEdges[i + 1] ?? plot.right)) / 2)
  const weekShown = weekStride(weekCentres)
  const columns = [...weekEdges.slice(0, -1).filter((_, i) => weekShown[i] === true), plot.right]

  // Each range stands in its week's column, the week's ranges side by
  // side about its middle in date order, as Runna stands a session's reps
  // in its date's column; a cluster is kept wholly inside the plot.
  const weekOf = (day: number) => Math.min(weekCount - 1, Math.max(0, Math.floor((day - span[0]) / DAYS_PER_WEEK)))
  const perWeek = new Map<number, number>()
  const slotInWeek = marks.map((m) => {
    const week = weekOf(m.day)
    const index = perWeek.get(week) ?? 0
    perWeek.set(week, index + 1)
    return { week, index }
  })
  const bars = marks.map((m, i) => {
    const { week, index } = slotInWeek[i] as { week: number; index: number }
    const count = perWeek.get(week) ?? 1
    const reach = ((count - 1) / 2) * (BAR_WIDTH_PX + BAR_GAP_PX) + END_RADIUS_PX + 1
    const middle = weekCentres[week] ?? plot.left
    const centre = Math.min(Math.max(middle, plot.left + reach), plot.right - reach)
    const cx = centre + sideBySide(count, index, BAR_WIDTH_PX, BAR_GAP_PX)
    const fast = y(m.fastS)
    const slow = y(m.slowS)
    const h = Math.max(MIN_BAR_PX, slow - fast)
    const top = (fast + slow) / 2 - h / 2
    return { mark: m, cx, top, bottom: top + h, text: paceRange(m.speed), index, count }
  })
  const markBoxes: LabelBox[] = bars.map((b) => ({
    left: b.cx - END_RADIUS_PX - MARK_PAD_PX,
    right: b.cx + END_RADIUS_PX + MARK_PAD_PX,
    top: b.top - MARK_PAD_PX,
    bottom: b.bottom + MARK_PAD_PX,
  }))
  const goalY = y(goalPaceS)
  const goalLine: LabelBox = { left: plot.left, right: plot.right, top: goalY - LINE_PAD_PX, bottom: goalY + LINE_PAD_PX }
  const easyText = easy === null ? null : `Easy ${paceOfSeconds(easy.fastS)}-${paceOfSeconds(easy.slowS, true)}`
  const easyBaseline = easy === null ? 0 : (y(easy.fastS) + y(easy.slowS)) / 2 + EASY_LABEL_DY
  const easyBox = easyText === null ? [] : [labelBox(plot.left + BAND_LABEL_DX, easyText.length * LABEL_CHAR_PX, easyBaseline)]
  const goalText = `Goal ${paceOfSeconds(goalPaceS, true)}`
  const goalLabel = goalLabelPlace(goalY, goalText.length * LABEL_CHAR_PX, plot, [...markBoxes, ...easyBox])

  // A step on the left of its day's cluster reads leftward, one on the
  // right rightward, so neither label crosses its neighbour.
  const items: BesideItem[] = bars.map((b) => ({
    cx: b.cx,
    half: END_RADIUS_PX,
    top: b.top,
    bottom: b.bottom,
    text: b.text,
    width: b.text.length * LABEL_CHAR_PX,
    prefer: b.count > 1 && b.index < (b.count - 1) / 2 ? 'end' : 'start',
  }))
  const labels = besideLabels(items, [...markBoxes, goalLine, goalLabel.box, ...easyBox], {
    left: plot.left + 2,
    right: plot.right - 2,
    top: plot.top + 2,
    bottom: plot.bottom - 2,
  })

  const described = [
    ...marks.map(
      (m) =>
        `${dayMonthLabel(m.day)}, ${sessionKindLabel(m.kind).toLowerCase()} ${speedRangeAsPace(m.speed.low_mps, m.speed.high_mps)}`,
    ),
    `goal ${paceOfSeconds(goalPaceS, true)}`,
    ...(easy === null ? [] : [`easy ${paceOfSeconds(easy.fastS)}-${paceOfSeconds(easy.slowS, true)}`]),
  ]
  const label = `Target paces of the quality, trial and race sessions, faster up: ${described.join('; ')}.`

  const fastest = Math.min(...marks.map((m) => m.fastS))
  const sessions = new Set(marks.map((m) => m.sessionId)).size
  const stats = [
    { label: 'Goal pace', value: paceOfSeconds(goalPaceS), unit: '/km' },
    { label: 'Fastest target', value: paceOfSeconds(fastest), unit: '/km' },
    { label: sessions === 1 ? 'Session' : 'Sessions', value: String(sessions) },
  ]
  // The key's end dots in the first drawn kind's colour, as the marks are.
  const keyKinds = PACE_KEY.filter((k) => marks.some((m) => k.kinds.includes(m.kind)))
  const endSlot = kindSlotClass(keyKinds[0]?.kinds[0] ?? 'intervals')
  // The race's tick stands under the race's own range, or under its week when the plan sets it no pace.
  const raceBar = bars.find((b) => b.mark.kind === 'race' && b.mark.day === raceDay)
  const raceX = raceBar?.cx ?? weekCentres[weekOf(raceDay)] ?? plot.right

  return (
    <div className={styles.chart} data-chart="">
      <PlanChartStats stats={stats} />
      <div className={styles.panel} ref={panelRef} data-part="panel">
        <svg className={styles.svg} viewBox={`0 0 ${String(width)} ${String(height)}`} role="img" aria-label={label}>
          {ladder.ticks.map((t) => (
            <g key={t}>
              <line className={styles.rule} x1={plot.left} x2={plot.right} y1={y(t)} y2={y(t)} />
              <text className={styles.axisLabel} x={plot.right + LADDER_LABEL_DX} y={y(t)} dominantBaseline="middle">
                {paceOfSeconds(t)}
              </text>
            </g>
          ))}

          {/* The frame: a dashed top, Runna's, and a solid baseline, each carrying its direction word. */}
          <line className={styles.frameTop} x1={plot.left} x2={plot.right} y1={plot.top} y2={plot.top} />
          <line className={styles.baseline} x1={plot.left} x2={plot.right} y1={plot.bottom} y2={plot.bottom} />
          {columns.map((edge) => (
            <line
              key={`edge-${String(edge)}`}
              className={styles.column}
              x1={edge}
              x2={edge}
              y1={plot.top}
              y2={plot.bottom}
            />
          ))}
          <text className={styles.direction} x={plot.right + LADDER_LABEL_DX} y={plot.top} dominantBaseline="middle">
            Faster
          </text>
          <text className={styles.direction} x={plot.right + LADDER_LABEL_DX} y={plot.bottom} dominantBaseline="middle">
            Slower
          </text>

          {easy !== null && (
            <g>
              <rect
                className={`${styles.easy} ${kindSlotClass('easy')}`}
                data-mark="easy"
                x={plot.left}
                y={y(easy.fastS)}
                width={plot.right - plot.left}
                height={Math.max(MIN_BAR_PX, y(easy.slowS) - y(easy.fastS))}
              />
              <text className={styles.easyLabel} x={plot.left + BAND_LABEL_DX} y={easyBaseline}>
                {easyText}
              </text>
            </g>
          )}

          <line className={styles.goal} data-mark="goal" x1={plot.left} x2={plot.right} y1={goalY} y2={goalY} />

          {bars.map((b, i) => {
            const place = labels[i] ?? null
            return (
              <g key={`${b.mark.sessionId}-${String(b.mark.index)}`}>
                <g className={kindSlotClass(b.mark.kind)}>
                  <rect
                    className={styles.pace}
                    data-mark="pace"
                    data-kind={b.mark.kind}
                    x={b.cx - BAR_WIDTH_PX / 2}
                    y={b.top}
                    width={BAR_WIDTH_PX}
                    height={b.bottom - b.top}
                    rx={BAR_WIDTH_PX / 2}
                  />
                  <circle className={styles.slowEnd} cx={b.cx} cy={y(b.mark.slowS)} r={END_RADIUS_PX} />
                  <circle className={styles.fastEnd} cx={b.cx} cy={y(b.mark.fastS)} r={END_RADIUS_PX} />
                </g>
                {place !== null && (
                  <text
                    className={styles.paceLabel}
                    data-label="pace"
                    x={place.x}
                    y={place.baseline}
                    textAnchor={place.anchor}
                  >
                    {b.text}
                  </text>
                )}
              </g>
            )
          })}

          {/* Over the marks, with a halo, so it reads where the line meets a column. */}
          <text
            className={styles.goalLabel}
            x={goalLabel.x}
            y={goalLabel.box.bottom - 3}
            textAnchor={goalLabel.anchor}
          >
            {goalText}
          </text>

          {weekCentres.map((centre, i) =>
            weekShown[i] === true ? (
              <text
                key={`week-${String(i)}`}
                className={styles.axisLabel}
                x={Math.min(centre, plot.right - LABEL_CHAR_PX * 1.5)}
                y={plot.bottom + WEEK_LABEL_DY}
                textAnchor="middle"
              >
                W{i + 1}
              </text>
            ) : null,
          )}
          {/* The race day, a tick under the baseline, keyed. */}
          <line
            className={styles.race}
            data-mark="race"
            x1={raceX}
            x2={raceX}
            y1={plot.bottom}
            y2={plot.bottom + RACE_TICK_PX}
          />
        </svg>
      </div>
      {/* Two lines, as Runna's key: what each colour is, then what each mark is. */}
      <div className={styles.key} aria-hidden="true" data-part="key">
        <ul className={styles.keyRow}>
          {keyKinds.map((k) => (
            <li key={k.label}>
              <span className={`${styles.capsule} ${kindSlotClass(k.kinds[0] ?? 'intervals')}`} />
              {k.label}
            </li>
          ))}
        </ul>
        <ul className={styles.keyRow}>
          <li>
            <span className={`${styles.dot} ${endSlot}`} />
            Faster end
          </li>
          <li>
            <span className={`${styles.dot} ${styles.dotSlow} ${endSlot}`} />
            Slower end
          </li>
          <li>
            <svg className={styles.lineSwatch} viewBox="0 0 16 12" width="16" height="12">
              <line className={styles.goal} x1="0" x2="16" y1="6" y2="6" />
            </svg>
            Goal pace
          </li>
          <li>
            <svg className={styles.lineSwatch} viewBox="0 0 16 12" width="16" height="12">
              <line className={styles.baseline} x1="0" x2="16" y1="3" y2="3" />
              <line className={styles.race} x1="8" x2="8" y1="3" y2="9" />
            </svg>
            Race day
          </li>
        </ul>
      </div>
    </div>
  )
}
