import type { components } from '../api/schema'
import type { ReactNode } from 'react'
import { type GrowthSummary, SPARK_HEIGHT, SPARK_WIDTH, growthSummary, sparkPath } from '../charts/territoryGrowthMath'
import { area, areaMeasure, metresLabel, shortLocalDate } from '../format'
import { DESKTOP_LAYOUT_QUERY, useMediaQuery } from '../views/useMediaQuery'
import { Stat, StatGroup } from './Stat'
import styles from './TerritoryReadout.module.css'

type TerritoryCounts = components['schemas']['TerritoryCounts']
type TerritoryGrowthPoint = components['schemas']['TerritoryGrowthPoint']

export interface TerritoryReadoutProps {
  /** The area of the union, `total_area_m2`, in m². */
  totalM2: number
  counts: TerritoryCounts
  /** The closure rule the store was built with, `closure_max_m`. */
  closureMaxM: number
  /** The sliver rule the store was built with, `sliver_radius_m`. */
  sliverRadiusM: number
  /** `growth`: one point per claiming run, oldest first. */
  growth: readonly TerritoryGrowthPoint[]
}

/**
 * The territory's headline: the total claimed ground, how it has grown,
 * and what it rests on.
 *
 * The total is the subject of the screen in the way intvl's planner header
 * makes its `CAPTURE` figure the subject, so it is set at `--text-display`,
 * the rung `tokens.css` reserves for a value that is the whole point of a
 * screen, under an eyebrow naming it - the shape of the Progression view's
 * personal best.
 *
 * Directly under it, one sentence on how it grew, in the place the
 * Progression best puts its pace and heart rate: what this year added and
 * what the latest gain was. A total alone says how much and not whether it
 * is still moving; on the real store close to two thirds of the ground
 * came in the latest year, which nothing else above the map would say.
 *
 * Then the three counts it is built from, as a `StatGroup` in thirds: the
 * runs that claimed ground, the loops out of every outdoor run, and the
 * places. Each caption is one short line, since a caption that wraps at a
 * third of a 360px phone hangs below its row.
 *
 * On a phone the total carries a spark of the growth, in the room the
 * number leaves on its own line, since the full chart is a scroll below
 * the map there. On a desktop the full chart is in sight under the map
 * (`views/Territory.tsx`), so the total stands alone and the rules behind
 * it, `TerritoryRules`, follow the counts; on a phone they follow the
 * chart instead. Both from the same `DESKTOP_LAYOUT_QUERY` the view reads,
 * so the two cannot disagree.
 */
export function TerritoryReadout({ totalM2, counts, closureMaxM, sliverRadiusM, growth }: TerritoryReadoutProps) {
  const wide = useMediaQuery(DESKTOP_LAYOUT_QUERY)
  const total = areaMeasure(totalM2)
  const summary = growthSummary(growth)
  return (
    <div className={styles.readout}>
      <dl className={styles.total}>
        <dt className={styles.totalLabel}>Claimed ground</dt>
        <dd className={styles.totalValue}>
          <span className={styles.figureLine}>
            <span className={styles.number}>{total.value}</span>
            {total.unit !== null && <span className={styles.unit}> {total.unit}</span>}
          </span>
          {!wide && growth.length > 1 && <GrowthSpark growth={growth} />}
        </dd>
        {summary !== null && <dd className={styles.gain}>{gainLine(summary)}</dd>}
      </dl>
      <StatGroup>
        <Stat label="Runs" value={String(counts.claiming_runs)} detail="claimed ground" />
        <Stat
          label="Loops"
          value={`${String(counts.loop_runs)} of ${String(counts.outdoor_runs)}`}
          detail={`within ${metresLabel(closureMaxM)}`}
        />
        <Stat
          label="Places"
          value={String(counts.regions)}
          detail={`${String(counts.parts)} ${counts.parts === 1 ? 'part' : 'parts'}`}
        />
      </StatGroup>
      {wide && <TerritoryRules closureMaxM={closureMaxM} sliverRadiusM={sliverRadiusM} />}
    </div>
  )
}

/**
 * How the total grew, as one sentence rather than parts with separators
 * between them: a separator is left at the start of the next line when a
 * phone wraps the parts, and a sentence wraps anywhere. Each figure and
 * each date holds together.
 */
function gainLine(summary: GrowthSummary): ReactNode {
  const day = (point: GrowthSummary['first']) => (
    <span className={styles.nowrap}>{shortLocalDate(point.start_time_utc, point.utc_offset_s)}</span>
  )
  const latest = (
    <>
      most recently <span className={styles.gainFigure}>{area(summary.latest.new_m2)}</span> on {day(summary.latest)}
    </>
  )
  if (summary.yearGainM2 !== null) {
    return (
      <>
        <span className={styles.gainFigure}>+{area(summary.yearGainM2)}</span> in {String(summary.year)}, {latest}
      </>
    )
  }
  if (summary.latest === summary.first) return <>Claimed on {day(summary.first)}</>
  return (
    <>
      Claimed since {day(summary.first)}, {latest}
    </>
  )
}

export interface TerritoryRulesProps {
  closureMaxM: number
  sliverRadiusM: number
}

/**
 * What counts towards the total, and why it is less than the runs' own
 * areas added up: the three facts a reader cannot get from the number,
 * folded away as the Progression view folds its own.
 *
 * Both rules come from the payload, `closure_max_m` and `sliver_radius_m`,
 * so a store rebuilt with other rules says so without an edit here.
 */
export function TerritoryRules({ closureMaxM, sliverRadiusM }: TerritoryRulesProps) {
  return (
    <details className={styles.footnote}>
      <summary className={styles.footnoteSummary}>What counts, and why</summary>
      <p className={styles.footnoteBody}>
        An outdoor run claims ground when its last position is within {metresLabel(closureMaxM)} of its first: the
        loop is closed with a straight line, and the ground it encloses is every area its track surrounds, however
        often it crosses itself. Strips narrower than {metresLabel(2 * sliverRadiusM)} are left out, so an
        out-and-back along one road claims nothing. Ground claimed twice counts once, which is why the total is less
        than the runs&apos; own areas added up. Treadmill runs have no positions and claim nothing.
      </p>
    </details>
  )
}

/**
 * The growth series' shape beside the total on a phone: the same step,
 * zero-anchored fill and colour as `TerritoryGrowth`, with no axes and no
 * readout, ending on the dot the full chart ends on.
 *
 * Plain SVG rather than uPlot, as the project does for a chart with no
 * hover: a second canvas and its observer for forty pixels of line would
 * be machinery for nothing. The x is the run's local day, the y its total,
 * scaled to a box the SVG stretches without keeping its aspect, which is
 * why the stroke is `non-scaling-stroke` and the end dot is not part of
 * the drawing: the series only rises, so its end is always the box's top
 * right corner, where the stylesheet puts the dot.
 *
 * Decorative to assistive technology: the line under the total and the
 * full chart under the map say in words and numbers what it shows.
 */
function GrowthSpark({ growth }: { growth: readonly TerritoryGrowthPoint[] }) {
  const path = sparkPath(growth)
  return (
    <span className={styles.spark} aria-hidden="true" data-testid="territory-growth-spark">
      <svg
        className={styles.sparkSvg}
        viewBox={`0 0 ${String(SPARK_WIDTH)} ${String(SPARK_HEIGHT)}`}
        preserveAspectRatio="none"
        focusable="false"
      >
        <path className={styles.sparkFill} d={`${path} V ${String(SPARK_HEIGHT)} H 0 Z`} />
        <path className={styles.sparkLine} d={path} vectorEffect="non-scaling-stroke" />
      </svg>
      <span className={styles.sparkEnd} />
    </span>
  )
}
