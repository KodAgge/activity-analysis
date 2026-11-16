import { kindSlotClass } from '../components/plan/sessionMarks'
import { dayMonthLabel, distance, distanceKeyLabel, runCount, trimmedNumber } from '../format'
import {
  LABEL_CHAR_PX,
  LEAD_IN_TOP_PX,
  PLAN_CHART_FALLBACK_WIDTH_PX,
  PLAN_CHART_HEIGHT_PX,
  distanceLadder,
  linearScale,
  plotBox,
  roundedTopBar,
  thinLabels,
} from './planChartMath'
import { PlanChartStats } from './PlanChartStats'
import type { PlanChartStat } from './PlanChartStats'
import { LEAD_IN_WEEKS, barSlots, leadInSummary } from './planShapeMath'
import type { LeadInWeek, RunCategory } from './planShapeMath'
import { usePanelWidth } from './usePanelWidth'
import styles from './PlanLeadIn.module.css'

export interface PlanLeadInProps {
  /** From `planShapeMath.leadInWeeks`, in date order. */
  weeks: LeadInWeek[]
  /**
   * Why the runs are not known yet, or null once they are. While it is
   * set no bar and no summary is drawn: a week whose runs have not
   * arrived would otherwise read as a week off.
   */
  note: string | null
}

/**
 * Each category in stacking order, bottom up, in the calendar's palette
 * slot of the session kind it is closest to (`sessionMarks.kindSlotClass`):
 * easy or steady as easy, a long run as long, intervals as intervals, and
 * all-out as a race. A run the app could not classify takes the neutral
 * tone rest days take.
 */
const CATEGORIES: readonly { category: RunCategory; label: string; short: string; slot: string }[] = [
  { category: 'easy', label: 'Easy or steady', short: 'easy', slot: kindSlotClass('easy') },
  { category: 'long', label: 'Long run', short: 'long', slot: kindSlotClass('long') },
  { category: 'intervals', label: 'Intervals', short: 'intervals', slot: kindSlotClass('intervals') },
  { category: 'all_out', label: 'All-out', short: 'all-out', slot: kindSlotClass('race') },
  { category: 'unclassified', label: 'Unclassified', short: 'unclassified', slot: kindSlotClass('rest') },
]

const WEEK_LABEL_DY = 16
const LADDER_LABEL_DX = 6
/** A record's marker sits this far above its week's bar, its label this far above that. */
const RECORD_MARKER_DY = 7
const RECORD_LABEL_DY = 9
const RECORD_MARKER_PX = 4
const LABEL_PAD_PX = 8

/** Kilometres to one decimal without the unit, which the stat row sets apart. */
function km(metres: number): string {
  return (metres / 1000).toFixed(1)
}

/** A record run's label, `PR 5.0 km`: the run's own distance. */
function recordLabel(week: LeadInWeek): string | null {
  const longest = week.records.reduce<number | null>(
    (best, r) => (r.distanceM !== null && (best === null || r.distanceM > best) ? r.distanceM : best),
    null,
  )
  return longest === null ? null : `PR ${distance(longest, 1)}`
}

/**
 * The athlete's running in the eight weeks before the plan, for the
 * context the plan starts from: one stacked bar per week of run distance
 * by the app's effort tags (`planShapeMath.runCategory`), a marker over
 * each week holding a record with the run's distance, and a stat row above
 * summing the weeks up. A week with no run keeps its slot, empty.
 *
 * Plain SVG, its viewBox the panel's measured width, as `PlanVolume`, on
 * the same whole-kilometre ladder.
 */
export function PlanLeadIn({ weeks, note }: PlanLeadInProps) {
  const [panelRef, measured] = usePanelWidth<HTMLDivElement>()
  const width = measured > 0 ? measured : PLAN_CHART_FALLBACK_WIDTH_PX
  const height = PLAN_CHART_HEIGHT_PX
  const plot = { ...plotBox(width, height), top: LEAD_IN_TOP_PX }
  const known = note === null
  const ladder = distanceLadder(known ? Math.max(0, ...weeks.map((w) => w.totalM)) : 0)
  const y = linearScale(ladder.min, ladder.max, plot.bottom, plot.top)
  const slots = barSlots(weeks.length, plot.left, plot.right)
  const weekLabels = thinLabels(
    slots.map((s) => s.centre),
    'MM MMM'.length * LABEL_CHAR_PX + LABEL_PAD_PX,
  )
  const records = weeks.map((w) => (known ? recordLabel(w) : null))
  // Thinned among the records alone, then put back on their weeks.
  const recorded = slots.flatMap((s, i) => (records[i] === null ? [] : [{ i, x: s.centre }]))
  const kept = thinLabels(
    recorded.map((r) => r.x),
    'PR 10.0 km'.length * LABEL_CHAR_PX + LABEL_PAD_PX,
  )
  const recordShown = new Set(recorded.filter((_, k) => kept[k] === true).map((r) => r.i))
  const used = new Set(weeks.flatMap((w) => CATEGORIES.filter((c) => w.byCategory[c.category] > 0).map((c) => c.category)))

  const summary = leadInSummary(weeks)
  // The four figures a coach asks first, as Runna's stat row over its bars.
  const stats: PlanChartStat[] | null =
    summary.runsPerWeek === 0
      ? null
      : [
          { label: 'A week', value: km(summary.avgWeeklyM), unit: 'km' },
          { label: 'Runs a week', value: trimmedNumber(summary.runsPerWeek) },
          ...(summary.longestM === null ? [] : [{ label: 'Longest run', value: km(summary.longestM), unit: 'km' }]),
          {
            label: summary.qualityCount === 1 ? 'Quality session' : 'Quality sessions',
            value: String(summary.qualityCount),
          },
        ]

  const described = weeks.map((w) => {
    const head = `week of ${dayMonthLabel(w.startDay)}`
    if (w.runCount === 0) return `${head}: no runs`
    const parts = CATEGORIES.filter((c) => w.byCategory[c.category] > 0).map(
      (c) => `${distance(w.byCategory[c.category], 1)} ${c.short}`,
    )
    const recordParts = w.records.map(
      (r) => `a record over ${r.distanceKeys.map(distanceKeyLabel).join(' and ')} on a ${distance(r.distanceM, 1)} run`,
    )
    return `${head}: ${distance(w.totalM, 1)} in ${runCount(w.runCount)}, ${[...parts, ...recordParts].join(', ')}`
  })
  const label = known
    ? `Run distance per week in the ${String(LEAD_IN_WEEKS)} weeks before the plan, by effort: ${described.join('; ')}.`
    : `Run distance per week in the ${String(LEAD_IN_WEEKS)} weeks before the plan. ${note}`

  return (
    <div className={styles.chart} data-chart="">
      {known ? (
        stats === null ? (
          <p className={styles.summary} data-part="stats">No runs in these weeks.</p>
        ) : (
          <PlanChartStats stats={stats} />
        )
      ) : (
        <p className={styles.note} role="status" data-part="stats">
          {note}
        </p>
      )}
      <div className={styles.panel} ref={panelRef} data-part="panel">
        <svg className={styles.svg} viewBox={`0 0 ${String(width)} ${String(height)}`} role="img" aria-label={label}>
          {ladder.ticks.map((t) => (
            <g key={t}>
              <line className={styles.rule} x1={plot.left} x2={plot.right} y1={y(t)} y2={y(t)} />
              <text className={styles.axisLabel} x={plot.right + LADDER_LABEL_DX} y={y(t)} dominantBaseline="middle">
                {distance(t, 0)}
              </text>
            </g>
          ))}
          {weeks.map((w, i) => {
            const slot = slots[i]
            if (slot === undefined) return null
            const week = String(i + 1)
            let base = 0
            const record = records[i] ?? null
            const top = y(w.totalM)
            return (
              <g key={w.startDay} data-slot={week}>
                {known &&
                  CATEGORIES.map((c) => {
                    const metres = w.byCategory[c.category]
                    if (metres <= 0) return null
                    const segTop = y(base + metres)
                    const segBottom = y(base)
                    base += metres
                    // Only the week's top segment takes the bar's rounded cap.
                    const isTop = Math.abs(base - w.totalM) < 1
                    return isTop ? (
                      <path
                        key={c.category}
                        className={`${styles.segment} ${c.slot}`}
                        data-week={week}
                        data-segment={c.category}
                        d={roundedTopBar(slot.x, segTop, slot.width, segBottom)}
                      />
                    ) : (
                      <rect
                        key={c.category}
                        className={`${styles.segment} ${c.slot}`}
                        data-week={week}
                        data-segment={c.category}
                        x={slot.x}
                        y={segTop}
                        width={slot.width}
                        height={segBottom - segTop}
                      />
                    )
                  })}
                {record !== null && (
                  <g>
                    <path
                      className={styles.record}
                      data-mark="record"
                      data-week={week}
                      d={`M ${String(slot.centre - RECORD_MARKER_PX)} ${String(top - RECORD_MARKER_DY - RECORD_MARKER_PX)} h ${String(2 * RECORD_MARKER_PX)} l ${String(-RECORD_MARKER_PX)} ${String(RECORD_MARKER_PX + 2)} z`}
                    />
                    {recordShown.has(i) && (
                      <text
                        className={styles.recordLabel}
                        x={slot.centre}
                        y={top - RECORD_MARKER_DY - RECORD_LABEL_DY}
                        textAnchor="middle"
                      >
                        {record}
                      </text>
                    )}
                  </g>
                )}
                {weekLabels[i] === true && (
                  <text className={styles.axisLabel} x={slot.centre} y={plot.bottom + WEEK_LABEL_DY} textAnchor="middle">
                    {dayMonthLabel(w.startDay)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
      {known && (
        <ul className={styles.key} aria-hidden="true" data-part="key">
          {CATEGORIES.filter((c) => c.category !== 'unclassified' || used.has('unclassified')).map((c) => (
            <li key={c.category}>
              <span className={`${styles.swatch} ${c.slot}`} />
              {c.label}
            </li>
          ))}
          {weeks.some((w) => w.records.length > 0) && (
            <li>
              <span className={styles.recordSwatch} />
              Personal record
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
