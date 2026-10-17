import { useQuery } from '@tanstack/react-query'
import { VolumeBars } from '../charts/VolumeBars'
import { ZoneBar } from '../charts/ZoneBar'
import { localIsoDate, TREND_WINDOW_WEEKS, trendLastIndex } from '../charts/volumeBarsMath'
import { zoneEdgesFromBoundaries } from '../charts/zoneBoundaries'
import { describeApiError } from '../api/errors'
import { queries } from '../api/queries'
import { Section } from '../components/Section'
import { StatRail } from '../components/StatRail'
import styles from './Overview.module.css'

const TWELVE_WEEKS = 12

/**
 * The first screen the athlete sees: what training has looked like lately.
 *
 * Composition approved 2026-08-30, and not this component's to reorder: it
 * leads with recent form, the stat rail first, then twelve weekly bars large
 * enough to read individual numbers, then the zone distribution, then the
 * whole history as a context strip. The rejected alternative led with the
 * full history, where at 148 weeks each bar is about four pixels wide and
 * cannot answer the question the application is opened with.
 *
 * **The screen has no containers.** Title, stats, section headings and
 * charts all start at the page gutter and end at it, and the only chrome
 * on the whole scroll is one full-bleed rule per section boundary - which
 * is what `components/Section` draws. The version this replaced put every
 * stat in a `--panel` card nine levels of separation from the page and
 * gave the chart four different left edges (page gutter 48, gridlines 50,
 * zero axis 54, card text 67). Both are gone; do not reintroduce either.
 */
export function Overview() {
  const { data, isPending, isError, error } = useQuery(queries.overview())

  if (isPending) {
    return <p>Loading the overview…</p>
  }

  if (isError) {
    return (
      <p role="alert">Could not load the overview: {describeApiError(error)}</p>
    )
  }

  const overview = data

  // The dense weekly series is empty exactly when the store has never held
  // a run at all (see `queries.volume_by_period`'s own docstring: an empty
  // store's `min(period_start)` is NULL, so `generate_series` over it
  // produces nothing). That is a different situation from a store with
  // data, and rendering the charts below on it would draw an empty bar
  // chart rather than say why there is nothing to draw.
  if (overview.weeks.length === 0) {
    return (
      <div className={styles.empty}>
        <h1>No training data yet</h1>
        <p>
          This store has no activities in it. Ingest a Strava or Garmin Connect export to get
          started:
        </p>
        <pre className="mono">activity-analysis ingest &lt;export.zip&gt;</pre>
        <p>
          Then restart <code className="mono">activity-analysis serve</code>, which reads the store
          once, at startup.
        </p>
      </div>
    )
  }

  const lastTwelveWeeks = overview.weeks.slice(-TWELVE_WEEKS)

  // The full history's trend line stops at the last week the store knows
  // about, finished and not after the latest activity of any sport. See
  // `trendLastIndex` for why both bounds exist.
  const trend = {
    window: TREND_WINDOW_WEEKS,
    lastIndex: trendLastIndex(
      overview.weeks.map((w) => w.period_start),
      overview.last_activity_local_date,
      localIsoDate(new Date()),
    ),
  }

  // `zone_boundaries_bpm` says, by construction, exactly how many zones
  // there are - n boundaries define n + 1 zones, see
  // `zoneEdgesFromBoundaries` - so driving the join from its output rather
  // than from `overview.zones` means this code does not have to assume
  // `zones` is complete or in zone-index order to render every band. In
  // the real store the two sides are in fact equivalent: every activity's
  // own `zone_time` writes a row for every zone, the always-zero "above
  // maximum" one included, so a summed `zones` already carries one row per
  // index too. The join is written this way anyway, because the boundary
  // count is the one guarantee that does not depend on that being true.
  const secondsByZoneIndex = new Map(overview.zones.map((zone) => [zone.zone_index, zone.seconds_s]))
  const zoneBuckets = zoneEdgesFromBoundaries(overview.zone_boundaries_bpm).map((edge) => ({
    zone_index: edge.zone_index,
    seconds_s: secondsByZoneIndex.get(edge.zone_index) ?? 0,
    low_bpm: edge.low_bpm,
    high_bpm: edge.high_bpm,
  }))

  return (
    <div className={styles.overview}>
      {/*
       * Title and stats are one block with a gap of their own, rather than
       * two children of the screen's own rhythm.
       *
       * The reference runs 29 pt from its screen title's baseline to the
       * first stat label's - about 30 px at our width - where the screen's
       * block gap is 32 px *of box*, which measured 50 px baseline to
       * baseline. A tighter gap here cannot be written as a margin on the
       * `<h1>`: `AppShell.module.css` restates `main.main h1 { margin: 0 }`
       * at a specificity a view module cannot beat, on purpose, and this
       * is not the piece to unpick that.
       */}
      <header className={styles.head}>
        {/*
         * The one view that had no `<h1>` at all - every other one does,
         * and this is the landing page, so a screen reader arriving here
         * found a document whose outline started at `<h2>` with nothing
         * naming the page. Found in a browser sweep on 2026-09-02.
         */}
        <h1>Overview</h1>
        {/*
         * Directly under the title with no section heading of its own, the
         * way the reference puts its three stats directly under "This
         * week". A heading here would name the stats twice: the title
         * already says what screen this is, and each stat says what it is.
         */}
        <StatRail
          weeks={overview.weeks}
          streak={overview.streak}
          consistency={overview.consistency}
        />
      </header>

      <Section title="Last 12 weeks" note="Distance run each week" divided>
        <VolumeBars periods={lastTwelveWeeks} metric="distance" bucket="week" markEmpty />
      </Section>

      <Section title="Time in zone" divided>
        <ZoneBar buckets={zoneBuckets} boundariesAreCurrentSettings />
      </Section>

      <Section
        title="Full history"
        note={`Every week on record, and the ${String(TREND_WINDOW_WEEKS)}-week average as a line`}
        divided
      >
        {/* Month and year on the ticks here, day and month above: at 148
            weeks the bare day-and-month form repeats the same twelve month
            names over three years without ever saying which year one of
            them is. Both series are weekly, so the form follows the span
            rather than the bucket. */}
        <VolumeBars
          periods={overview.weeks}
          metric="distance"
          bucket="week"
          markEmpty
          compact
          axisLabel="monthYear"
          trend={trend}
        />
      </Section>
    </div>
  )
}
