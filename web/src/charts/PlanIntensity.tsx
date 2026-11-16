import { useId } from 'react'
import { Absent } from '../components/Absent'
import { kindSlotClass } from '../components/plan/sessionMarks'
import { distance } from '../format'
import {
  PLAN_CHART_FALLBACK_WIDTH_PX,
  distanceLadder,
  linearScale,
  plotBox,
  weekStride,
} from './planChartMath'
import { barSlots } from './planShapeMath'
import type { MixWeek } from './planShapeMath'
import { PlanChartStats } from './PlanChartStats'
import type { PlanChartStat } from './PlanChartStats'
import { usePanelWidth } from './usePanelWidth'
import styles from './PlanIntensity.module.css'

export interface PlanIntensityProps {
  /** From `planShapeMath.weeklyMix`, in date order; the first is `W1`. */
  weeks: MixWeek[]
}

type Segment = 'easy' | 'quality' | 'race'

/**
 * The three intensities, bottom up, each in the calendar's palette slot
 * of the kind it stands for (`sessionMarks.kindSlotClass`): easy in the
 * easy slot, quality in the intervals slot, race or trial in the race slot.
 */
const SEGMENTS: readonly { segment: Segment; label: string; slot: string; of: (w: MixWeek) => number }[] = [
  { segment: 'easy', label: 'Easy', slot: kindSlotClass('easy'), of: (w) => w.easyM },
  { segment: 'quality', label: 'Quality', slot: kindSlotClass('intervals'), of: (w) => w.qualityM },
  { segment: 'race', label: 'Race or trial', slot: kindSlotClass('race'), of: (w) => w.raceM },
]

const WEEK_LABEL_DY = 16
/**
 * Taller than `PLAN_CHART_HEIGHT_PX`: on a desktop the chart stands beside
 * the VO2max outlook's two panels and shares their plot row, so it takes
 * their height rather than leaving a band of white over its key.
 */
const INTENSITY_HEIGHT_PX = 240

/**
 * The stat row over the bars: the detailed weeks' planned kilometres of
 * each intensity, in the key's own words. An outline week has no split,
 * so it counts in none of them.
 */
function mixStats(weeks: MixWeek[]): PlanChartStat[] {
  const detailed = weeks.filter((w) => w.outlineM === null)
  if (detailed.length === 0) return []
  return SEGMENTS.map((seg) => ({
    label: seg.label,
    value: (detailed.reduce((sum, w) => sum + seg.of(w), 0) / 1000).toFixed(1),
    unit: 'km',
  }))
}
const LADDER_LABEL_DX = 6

/**
 * The plan's planned distance per week, split by intensity: one stacked
 * bar per week of easy running, the work of the quality sessions, and the
 * work of the time trials and the race, as `planShapeMath.sessionMix`
 * splits a session. An outline week has no sessions to split, so it is
 * one hatched bar of its planned distance, "not yet detailed". A stat
 * row over the bars gives the detailed weeks' kilometres of each.
 *
 * Plain SVG, its viewBox the panel's measured width, as `PlanVolume`, on
 * the same whole-kilometre ladder.
 */
export function PlanIntensity({ weeks }: PlanIntensityProps) {
  const [panelRef, measured] = usePanelWidth<HTMLDivElement>()
  const hatchId = `plan-intensity-hatch-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`
  if (weeks.length === 0) return <Absent reason="This plan has no weeks to chart." />

  const width = measured > 0 ? measured : PLAN_CHART_FALLBACK_WIDTH_PX
  const height = INTENSITY_HEIGHT_PX
  const plot = plotBox(width, height)
  const totals = weeks.map((w) => w.outlineM ?? w.easyM + w.qualityM + w.raceM)
  const ladder = distanceLadder(Math.max(...totals))
  const y = linearScale(ladder.min, ladder.max, plot.bottom, plot.top)
  const slots = barSlots(weeks.length, plot.left, plot.right)
  const weekLabels = weekStride(slots.map((s) => s.centre))
  const hasOutline = weeks.some((w) => w.outlineM !== null)

  const described = weeks.map((w, i) => {
    const head = `W${String(i + 1)}: ${distance(totals[i] ?? 0, 1)}`
    if (w.outlineM !== null) return `${head}, not yet detailed.`
    const parts = SEGMENTS.filter((s) => s.segment === 'easy' || s.of(w) > 0).map(
      (s) => `${distance(s.of(w), 1)} ${s.label.toLowerCase()}`,
    )
    return `${head}, ${parts.join(', ')}.`
  })
  const label = `Weekly intensity mix, planned distance per week by intensity. ${described.join(' ')}`

  return (
    <div className={styles.chart} data-chart="">
      <PlanChartStats stats={mixStats(weeks)} />
      <div className={styles.panel} ref={panelRef} data-part="panel">
        <svg className={styles.svg} viewBox={`0 0 ${String(width)} ${String(height)}`} role="img" aria-label={label}>
          <defs>
            <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line className={styles.hatch} x1="0" x2="0" y1="0" y2="6" />
            </pattern>
          </defs>
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
            return (
              <g key={w.startDate}>
                {w.outlineM !== null ? (
                  <rect
                    className={styles.outline}
                    data-week={week}
                    data-segment="outline"
                    x={slot.x}
                    y={y(w.outlineM)}
                    width={slot.width}
                    height={plot.bottom - y(w.outlineM)}
                    fill={`url(#${hatchId})`}
                  />
                ) : (
                  SEGMENTS.map((s) => {
                    const metres = s.of(w)
                    if (metres <= 0) return null
                    const top = y(base + metres)
                    const bottom = y(base)
                    base += metres
                    return (
                      <rect
                        key={s.segment}
                        className={`${styles.segment} ${s.slot}`}
                        data-week={week}
                        data-segment={s.segment}
                        x={slot.x}
                        y={top}
                        width={slot.width}
                        height={bottom - top}
                      />
                    )
                  })
                )}
                {weekLabels[i] === true && (
                  <text className={styles.axisLabel} x={slot.centre} y={plot.bottom + WEEK_LABEL_DY} textAnchor="middle">
                    W{week}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
      <ul className={styles.key} aria-hidden="true" data-part="key">
        {SEGMENTS.map((s) => (
          <li key={s.segment}>
            <span className={`${styles.swatch} ${s.slot}`} />
            {s.label}
          </li>
        ))}
        {hasOutline && (
          <li>
            <span className={`${styles.swatch} ${styles.swatchOutline}`} />
            Not yet detailed
          </li>
        )}
      </ul>
    </div>
  )
}
