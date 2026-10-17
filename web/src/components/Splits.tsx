import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import type { components } from '../api/schema'
import { cadence, distance, duration, elevationChange, heartRate, netElevationChange, pace } from '../format'
import { Absent } from './Absent'
import styles from './Splits.module.css'
import type { ClassifiedLap, KmSplit, LapRole, PaceScale } from './splitsMath'
import { paceBarScale, paceBarWidthPercent, perKilometreSplits, rolesFromPattern } from './splitsMath'

type Lap = components['schemas']['Lap']

function lapsTabLabel(laps: Lap[], repCount: number | null): string {
  if (repCount !== null) return `Laps · ${repCount} rep${repCount === 1 ? '' : 's'}`
  return `Laps · ${laps.length} lap${laps.length === 1 ? '' : 's'}`
}

function kmTabLabel(splitCount: number | null): string {
  return splitCount === null ? 'Per km' : `Per km · ${splitCount}`
}

function lapRoleLabel(classified: ClassifiedLap): string {
  if (classified.role === 'rep') return `Rep ${String(classified.repNumber ?? '')}`
  if (classified.role === 'recovery') return 'Recovery'
  return `Lap ${String(classified.lap.lap_index + 1)}`
}

function splitAvgSpeed(split: KmSplit): number | null {
  if (split.elapsedS <= 0) return null
  return split.distanceM / split.elapsedS
}

interface RowData {
  key: string
  label: string
  distanceM: number | null
  elapsedS: number | null
  avgSpeedMps: number | null
  avgHrBpm: number | null
  avgCadenceSpm: number | null
  elevationChangeM: number | null
  role: LapRole
  partial: boolean
}

const ROLE_CLASS: Record<LapRole, string> = {
  rep: styles.rep ?? '',
  recovery: styles.recovery ?? '',
  plain: styles.plain ?? '',
}

/**
 * Both tabs' "Elevation" column mean the same thing - the net altitude
 * change over the row's span, positive for a net climb - but they reach it
 * from different data because a `Lap` and a grid window carry different
 * things: a lap's own `ascent_m - descent_m` (the device's recorded
 * totals) here, the grid's own start/end altitude difference on the
 * per-kilometre tab. The heading stays one word in both; the `title`
 * spells out which computation backs it, so the two tabs never look like
 * they silently redefined the same column.
 */
const ELEVATION_HEADER_TITLE: Record<'laps' | 'km', string> = {
  laps: "Net change from the device's own recorded ascent and descent for this lap.",
  km: 'Net change in recorded altitude across this split.',
}

/**
 * One column of the splits table, header and cell together - the same
 * shape `views/Activities.tsx`'s `COLUMNS` uses, and for the same reason:
 * `SplitTable` used to build a seven-`<th>` `<thead>` and a seven-`<td>`
 * body as two independent lists, so swapping two `<td>`s left every test
 * green (I5 in the branch's final review). A column's header and the field
 * its cell renders can no longer silently point at two different lists,
 * because there is only one list.
 */
interface SplitColumn {
  key: string
  header: string
  numeric?: boolean
  /** A column whose header names something the cell shows visually. */
  headerHidden?: boolean
  render: (row: RowData, scale: PaceScale) => ReactNode
}

const SPLIT_COLUMNS: SplitColumn[] = [
  {
    key: 'split',
    header: 'Split',
    render: (row) => (
      <>
        {row.label}
        {row.partial && <span className={styles.partialTag}>partial</span>}
      </>
    ),
  },
  {
    key: 'distance',
    header: 'Distance',
    numeric: true,
    render: (row) => distance(row.distanceM),
  },
  {
    key: 'time',
    header: 'Time',
    numeric: true,
    render: (row) => duration(row.elapsedS),
  },
  {
    key: 'pace',
    header: 'Pace',
    numeric: true,
    render: (row) => pace(row.avgSpeedMps),
  },
  {
    // Its own cell, not an inline sibling of the pace text. The bar's width
    // is a percentage of its container, so the fastest split's bar is by
    // construction the full width of it; sharing a cell with the number
    // meant that number was pushed out under `white-space: nowrap` and
    // landed on top of the heart-rate column. Measured before the fix, on
    // every activity tried and at every viewport: 204px of content in a
    // 151px cell at 1440 wide, 166 in 102 at 420.
    key: 'pace-bar',
    header: 'Pace, relative',
    headerHidden: true,
    render: (row, scale) => (
      <span className={styles.track}>
        <span
          data-testid="pace-bar"
          className={styles.bullet}
          style={{
            width: `${String(paceBarWidthPercent(row.avgSpeedMps, scale.slowestSpeedMps, scale.fastestSpeedMps))}%`,
          }}
        />
      </span>
    ),
  },
  {
    key: 'heart-rate',
    header: 'Heart rate',
    numeric: true,
    render: (row) => heartRate(row.avgHrBpm),
  },
  {
    key: 'cadence',
    header: 'Cadence',
    numeric: true,
    render: (row) => cadence(row.avgCadenceSpm),
  },
  {
    key: 'elevation',
    header: 'Elevation',
    numeric: true,
    render: (row) => elevationChange(row.elevationChangeM),
  },
]

function SplitTable({ rows, elevationHeaderTitle }: { rows: RowData[]; elevationHeaderTitle: string }) {
  // Every row takes part on equal terms, roles included. Why the lap roles
  // are deliberately not consulted here, and what each alternative
  // measured on the real interval fixture, is `paceBarScale`'s own doc.
  const scale = paceBarScale(rows)

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {SPLIT_COLUMNS.map((column) => (
              <th
                key={column.key}
                title={column.key === 'elevation' ? elevationHeaderTitle : undefined}
                className={column.numeric ? styles.numericHeader : undefined}
              >
                {column.headerHidden === true ? (
                  <span className={styles.srOnly}>{column.header}</span>
                ) : (
                  column.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} data-role={row.role} data-partial={row.partial} className={ROLE_CLASS[row.role]}>
              {SPLIT_COLUMNS.map((column) => (
                <td key={column.key} className={column.numeric ? `mono ${styles.numeric}` : undefined}>
                  {column.render(row, scale)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export interface SplitsStreams {
  t: number[]
  distanceM: (number | null)[]
  hrBpm: (number | null)[]
  cadenceSpm: (number | null)[]
  altitudeM: (number | null)[]
}

export interface SplitsProps {
  /**
   * The activity this splits section belongs to. Used only to reset the
   * leading tab when it changes - see the component doc below - never to
   * fetch or compute anything itself.
   */
  activityId: string
  /** `ActivityDetail.laps`, present for any activity. */
  laps: Lap[]
  /**
   * Whether `derived.tags` carries a `kind: "effort", tag: "intervals"`
   * row - the intervals-tag rule, and the *only* input that
   * decides which tab leads. Not derived from `repCount` being non-null:
   * that is true only of an `intervals` row today, but a predicate that
   * actually reads `tag === 'intervals'` stays correct even if some other
   * effort tag ever grows a rep count of its own, where one keyed on
   * "non-null `repCount`" would not.
   */
  isIntervalsSession: boolean
  /** `rep_count` off the `intervals` tag, for the tab's label - null when there is none. */
  repCount: number | null
  /**
   * `rep_pattern` off the `intervals` tag: the analysis layer's own
   * per-lap "R"/"W"/"-" string, one character per recorded lap. Null when
   * there is no `intervals` tag, or on a store not yet recomputed past
   * ANALYSIS_VERSION 4.
   */
  repPattern: string | null
  /** The 1 Hz grid, or `null` when the streams endpoint has nothing to serve. */
  streams: SplitsStreams | null
  /**
   * Shown in place of the per-kilometre tab's content when `streams` is
   * null because the streams endpoint gave an authoritative 404 - a stated
   * absence, framed through `Absent`. `null` when there is no such reason
   * (a genuine success, or the failure case below instead).
   */
  streamsAbsentReason: string | null
  /**
   * Shown in place of the per-kilometre tab's content, as an alert rather
   * than a stated absence, when `streams` is null because the request
   * itself failed - a 503, or a network error (M9): a real problem, not a
   * fact about this activity, and framed differently for exactly that
   * reason. `null` when there is no such reason.
   */
  streamsFailureReason: string | null
}

/** The leading tab for a freshly-seen activity, per the intervals-tag rule. */
function leadingTab(isIntervalsSession: boolean): 'laps' | 'km' {
  return isIntervalsSession ? 'laps' : 'km'
}

/**
 * The splits section: recorded laps and per-kilometre splits as two tabs
 * over the same run.
 *
 * Which tab **leads** is decided once per activity, from `isIntervalsSession`
 * alone - never from how many laps are manual, a rule tried first and
 * rejected (recovery presses on an interval session are manual; the reps themselves are usually
 * distance-triggered auto-laps). The other tab stays one click away either
 * way. The per-kilometre math and the lap rep/recovery lookup both live in
 * `splitsMath.ts`, kept pure and independently testable, the same split
 * `charts/streamPanelMath.ts` draws for `StreamPanel`.
 *
 * **The leading tab is reset whenever `activityId` changes, and only then.**
 * An earlier version picked it once, in `useState`'s initialiser, which
 * only ever runs on a component's first mount. `ActivityDetail` renders
 * `Splits` at a fixed position with no `key`, and the query client holds
 * `staleTime: Infinity`, so revisiting an already-cached activity reused the
 * same mounted instance and carried over whatever tab a *previous* activity
 * had been left on - reversing the intervals-tag rule on the second visit rather than the
 * first. This compares `activityId` against the id the current tab
 * selection was made for on every render (the standard React pattern for
 * "adjust state when a prop changes", called during render rather than in
 * an effect so the stale tab is never actually painted) and resets to
 * `leadingTab(isIntervalsSession)` the moment they disagree - which also
 * means a reader who switches tabs and then triggers some unrelated
 * re-render (new data for the *same* activity, say) keeps whatever tab they
 * chose, because `activityId` has not moved.
 */
export function Splits({
  activityId,
  laps,
  isIntervalsSession,
  repCount,
  repPattern,
  streams,
  streamsAbsentReason,
  streamsFailureReason,
}: SplitsProps) {
  const splits = useMemo(
    () =>
      streams === null
        ? null
        : perKilometreSplits(streams.t, streams.distanceM, streams.hrBpm, streams.cadenceSpm, streams.altitudeM),
    [streams],
  )

  const classifiedLaps = useMemo(() => rolesFromPattern(laps, repPattern), [laps, repPattern])

  const [tabState, setTabState] = useState<{ activityId: string; tab: 'laps' | 'km' }>(() => ({
    activityId,
    tab: leadingTab(isIntervalsSession),
  }))
  if (tabState.activityId !== activityId) {
    setTabState({ activityId, tab: leadingTab(isIntervalsSession) })
  }
  const activeTab = tabState.activityId === activityId ? tabState.tab : leadingTab(isIntervalsSession)

  function selectTab(tab: 'laps' | 'km') {
    setTabState({ activityId, tab })
  }

  const lapRows: RowData[] = classifiedLaps.map((classified) => ({
    key: `lap-${String(classified.lap.lap_index)}`,
    label: lapRoleLabel(classified),
    distanceM: classified.lap.distance_m,
    elapsedS: classified.lap.elapsed_time_s,
    avgSpeedMps: classified.lap.avg_speed_mps,
    avgHrBpm: classified.lap.avg_hr_bpm,
    avgCadenceSpm: classified.lap.avg_cadence_spm,
    elevationChangeM: netElevationChange(classified.lap.ascent_m, classified.lap.descent_m),
    role: classified.role,
    partial: false,
  }))

  const kmRows: RowData[] | null =
    splits?.map((split) => ({
      key: `km-${String(split.index)}`,
      label: split.partial ? 'Partial' : `Km ${String(split.index)}`,
      distanceM: split.distanceM,
      elapsedS: split.elapsedS,
      avgSpeedMps: splitAvgSpeed(split),
      avgHrBpm: split.avgHrBpm,
      avgCadenceSpm: split.avgCadenceSpm,
      elevationChangeM: split.elevationChangeM,
      role: 'plain',
      partial: split.partial,
    })) ?? null

  return (
    <div className={styles.splits}>
      <div className={styles.tabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'laps'}
          className={activeTab === 'laps' ? styles.tabActive : styles.tab}
          onClick={() => selectTab('laps')}
        >
          {lapsTabLabel(laps, repCount)}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'km'}
          className={activeTab === 'km' ? styles.tabActive : styles.tab}
          onClick={() => selectTab('km')}
        >
          {kmTabLabel(kmRows?.length ?? null)}
        </button>
      </div>

      {activeTab === 'laps' &&
        (lapRows.length === 0 ? (
          <Absent reason="No laps were recorded for this activity." />
        ) : (
          <SplitTable rows={lapRows} elevationHeaderTitle={ELEVATION_HEADER_TITLE.laps} />
        ))}

      {activeTab === 'km' &&
        (kmRows === null ? (
          streamsFailureReason !== null ? (
            <p role="alert">Could not load the 1 Hz grid: {streamsFailureReason}</p>
          ) : (
            <Absent reason={streamsAbsentReason ?? 'No 1 Hz grid is available for this activity.'} />
          )
        ) : kmRows.length === 0 ? (
          <Absent reason="This run never covered a full kilometre." />
        ) : (
          <SplitTable rows={kmRows} elevationHeaderTitle={ELEVATION_HEADER_TITLE.km} />
        ))}
    </div>
  )
}
