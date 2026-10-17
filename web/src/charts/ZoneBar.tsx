import { Absent } from '../components/Absent'
import { NO_VALUE, duration } from '../format'
import styles from './ZoneBar.module.css'

export interface ZoneBucket {
  zone_index: number
  seconds_s: number
  low_bpm?: number | null
  high_bpm?: number | null
}

export interface ZoneBarProps {
  buckets: ZoneBucket[]
  /**
   * True for `Overview.zones` (`ZoneTotal`), which carries no boundaries of
   * its own because it is summed across a period during which the
   * athlete's maximum heart rate can have changed - see
   * docs/reference/api.md, "GET /api/overview". False for a single
   * activity's own `derived.zones` (`ZoneBucket`), where one profile was in
   * force and its boundaries are the ones these seconds were actually
   * measured against.
   */
  boundariesAreCurrentSettings: boolean
}

const ZONE_FILL_TOKENS = [
  'var(--zone-below)',
  'var(--zone-1)',
  'var(--zone-2)',
  'var(--zone-3)',
  'var(--zone-4)',
  'var(--zone-5)',
]

/**
 * True for the open-ended band above the last configured boundary: it has a
 * floor and no ceiling, which is what "everything at or above the last
 * boundary" looks like in a bucket (see `zoneBoundaries.ts`). Zone 0 is
 * open-ended at the *other* end - a ceiling and no floor - and is an
 * ordinary reachable zone that real runs do spend time in, so the two
 * are told apart by which edge is missing rather than by index.
 *
 * **This is not "hide an empty zone".** An empty zone 5 on an easy run is a
 * real measurement and must still render as `0:00`, and the real store has
 * one: activity `854fd775d479ca9f` records 0 s in zone 5 and 0 s in zone 6.
 * The rule here is structural - a band above the top of the configured
 * range is not a zone the athlete can be in - and only the second of those
 * two rows disappears.
 */
function isAboveConfiguredRange(bucket: ZoneBucket): boolean {
  const low = bucket.low_bpm ?? null
  const high = bucket.high_bpm ?? null
  // Zero seconds is a safety catch rather than part of the rule. The band is
  // unreachable because the last boundary is the athlete's configured
  // maximum - 207 in every one of the five stored profile intervals, against
  // a maximum of 207 - and on that configuration it holds 0 s across all 223
  // activities with zone data. If a profile ever set its top boundary below
  // the maximum, the band would be genuinely reachable, and time measured in
  // it is a fact about the athlete that must not be hidden by a rule about
  // the configuration. So it is dropped only when there is nothing in it,
  // which also keeps the shares below it summing to the total.
  return low !== null && high === null && bucket.seconds_s === 0
}

/** The fill for a zone beyond the six the token set names. Only reachable
 * on a profile with more boundaries than this device configures; reusing
 * the most intense token is a deliberate saturation rather than an
 * invented colour outside the palette. */
function zoneFill(zoneIndex: number): string {
  return ZONE_FILL_TOKENS[Math.min(zoneIndex, ZONE_FILL_TOKENS.length - 1)] ?? 'var(--zone-below)'
}

interface ZoneRow {
  zoneIndex: number
  bucket: ZoneBucket
  /** Percentage of the *largest* zone, which is what the bar is scaled to. */
  barWidthPercent: number
  /** Percentage of the total, which is what the number says. */
  sharePercent: number
}

/**
 * The bpm column's text for one zone: a range, an open-ended end, or the
 * project's `NO_VALUE` glyph when the bucket carries no boundary at all.
 *
 * That last case is reachable by construction rather than by accident -
 * `DEFAULT_ABOVE_MAX_INDEX` synthesises a bucket with no edges for any
 * index the served buckets stop short of - and it has to **fit
 * `.colEdges`**, which `table-layout: fixed` holds at 4.4rem. With the
 * self-hosted IBM Plex Mono at `.edges`' `--text-caption` (11px) and its
 * 0.6em advance, a glyph is 6.6px and the content box is 70.4 - 8 = 62.4px,
 * so nine glyphs fit: the common `145-166` is 46.2px and `below 104` is
 * 59.4px, while the wording this used to carry, "no recorded boundary", is
 * twenty glyphs and 132px - spilling across the bar, Time and Share cells
 * under `white-space: nowrap`, which is the overlapping-numbers fault this
 * file was rewritten to remove. The column is not widened for it: sizing the
 * common case for the exception would spend the width the bar needs, and
 * the row's own `Z{n}` header already says which zone is unknown, so the
 * cell only has to say that no boundary was recorded - which is exactly
 * what `NO_VALUE` means everywhere else in this application.
 */
function edgesLabel(bucket: ZoneBucket): string {
  const low = bucket.low_bpm ?? null
  const high = bucket.high_bpm ?? null
  if (low === null && high === null) return NO_VALUE
  if (low === null) return `below ${String(high)}`
  if (high === null) return `${String(low)}+`
  return `${low}-${high}`
}

/**
 * Time in each heart rate zone, one row per zone: index, boundary range,
 * bar, duration, share of the total.
 *
 * **Why rows rather than one stacked bar.** The stacked bar this replaced
 * set `preserveAspectRatio="none"` on a `101.5 x 10` viewBox and let CSS
 * render it at `1024 x 32`, which stretched its own text 3.15x more
 * horizontally than vertically - the reason it looked wrong. It also spent
 * the page's full width carrying five numbers and showed no durations,
 * boundaries or shares at all. Rows are plain HTML and CSS with no
 * viewBox to distort, they carry every number at once, and they come out
 * narrow enough to sit beside the route rather than under it. Chosen by
 * the maintainer on 2026-09-02 from three rendered options.
 *
 * Bars are scaled to the largest zone, not to the total. A run that spends
 * 70% of its time in one zone would otherwise render every other zone as a
 * sliver against a mostly-empty track, which is the same
 * everything-looks-the-same failure the splits bars had.
 *
 * Every index from 0 to the highest is rendered with one exception, the
 * empty band above the last configured boundary - `isAboveConfiguredRange`
 * owns that rule and why it is not "hide an empty zone". Everything else
 * that is present and empty reads `0:00`, not "none": the maintainer's
 * explicit instruction, and the honest rendering, since zero seconds is a
 * measurement rather than an absence. See docs/reference/frontend.md, "An
 * empty measurement is a zero; an unmeasured activity is an absence".
 *
 * The index range is read from the buckets rather than fixed at the seven
 * this device happens to emit. `docs/reference/derived-layer.md` is
 * explicit that the six boundaries are a default rather than the law, and
 * `zoneEdgesFromBoundaries` already emits `n + 1` zones for `n`
 * boundaries; a hardcoded 0..6 would silently drop a further bucket from
 * the list while still counting its seconds in the denominator, so every
 * row below it would read short with nothing to say so.
 */
export function ZoneBar({ buckets, boundariesAreCurrentSettings }: ZoneBarProps) {
  const totalSeconds = buckets.reduce((sum, bucket) => sum + bucket.seconds_s, 0)

  // 84 of 307 real runs have no `zone_time` rows at all - no heart rate, so
  // no zone distribution - and arrive here as an empty `buckets` array. A
  // bucket list that sums to zero for a different reason (every second
  // landed nowhere, which the schema does not rule out) is the same fact
  // to a reader: there is nothing to show a distribution of. Either way
  // this is an absence, not a list of zeroes - rendering seven `0:00` rows
  // from a zero total would claim a measured distribution where there is
  // none.
  if (totalSeconds === 0) {
    return <Absent reason="No heart rate zone data recorded." />
  }

  const byIndex = new Map(buckets.map((bucket) => [bucket.zone_index, bucket] as const))
  // The index range is the buckets' own, with no floor under it. It used to
  // be padded up to the device's seven so the above-maximum band was drawn
  // even when the payload stopped short, and that padding's whole stated
  // reason was that the empty top band is still information. It is not: see
  // `isAboveConfiguredRange`. Padding now would invent edgeless rows above a
  // real band this then drops, which is the opposite of what either rule
  // wants. Both real payloads carry every index anyway - `/api/overview` and
  // an activity's own `derived.zones` each send all seven, checked live on
  // 2026-09-12 - so nothing changes on this store.
  const zoneIndices = Array.from(
    { length: Math.max(...buckets.map((bucket) => bucket.zone_index)) + 1 },
    (_, index) => index,
  ).filter((index) => {
    const bucket = byIndex.get(index)
    return bucket === undefined || !isAboveConfiguredRange(bucket)
  })
  const largestSeconds = Math.max(
    ...zoneIndices.map((index) => byIndex.get(index)?.seconds_s ?? 0),
  )

  const rows: ZoneRow[] = zoneIndices
    .map((zoneIndex) => {
      const bucket = byIndex.get(zoneIndex) ?? { zone_index: zoneIndex, seconds_s: 0 }
      return {
        zoneIndex,
        bucket,
        barWidthPercent: largestSeconds > 0 ? (bucket.seconds_s / largestSeconds) * 100 : 0,
        sharePercent: (bucket.seconds_s / totalSeconds) * 100,
      }
    })
    // Hardest zone at the top, so the list reads down the way effort reads
    // down and the eye lands on the intense end first.
    .reverse()

  const caption = boundariesAreCurrentSettings
    ? 'Boundaries as configured today, not necessarily what was in force when these seconds were recorded.'
    : 'Boundaries as recorded for this activity.'

  return (
    <figure className={styles.figure}>
      <table className={styles.table}>
        <caption className={styles.srOnly}>Time in each heart rate zone</caption>
        {/*
         * `table-layout: fixed` takes its column widths from the first row,
         * and the header row carries no width classes - so without this the
         * five columns each took an equal fifth and the bar, the one column
         * that needs whatever is left over, was squeezed to about 80px.
         * A `colgroup` states the widths for the column rather than for a
         * cell that happens to be in it.
         */}
        <colgroup>
          <col className={styles.colZone} />
          <col className={styles.colEdges} />
          <col />
          <col className={styles.colTime} />
          <col className={styles.colShare} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Zone</th>
            <th scope="col">bpm</th>
            <th scope="col">
              <span className={styles.srOnly}>Relative time</span>
            </th>
            <th scope="col" className={styles.numericHeader}>
              Time
            </th>
            <th scope="col" className={`${styles.numericHeader} ${styles.shareHeader}`}>
              Share
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ zoneIndex, bucket, barWidthPercent, sharePercent }) => (
            <tr key={zoneIndex} data-zone={zoneIndex}>
              <th scope="row" className={styles.zone}>
                Z{zoneIndex}
              </th>
              <td className={`${styles.edges} mono`}>{edgesLabel(bucket)}</td>
              <td className={styles.trackCell}>
                <span className={styles.track}>
                  <span
                    className={styles.fill}
                    style={{ width: `${String(barWidthPercent)}%`, background: zoneFill(zoneIndex) }}
                  />
                </span>
              </td>
              <td className={`${styles.time} mono`}>{duration(bucket.seconds_s)}</td>
              <td className={`${styles.share} mono`}>{Math.round(sharePercent)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <figcaption className={styles.caption}>{caption}</figcaption>
    </figure>
  )
}
