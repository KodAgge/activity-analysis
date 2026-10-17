import { useQuery } from '@tanstack/react-query'
import { describeApiError } from '../api/errors'
import { queries } from '../api/queries'
import type { components } from '../api/schema'
import { Absent } from '../components/Absent'
import { Row, RowList } from '../components/RowList'
import {
  distance,
  distanceKeyLabel,
  distanceKeyStatesTheDistance,
  duration,
  heartRate,
  pace,
  runCount,
  shortLocalDate,
} from '../format'
import styles from './Records.module.css'

type RouteSummary = components['schemas']['RouteSummary']

/**
 * The athlete's best time at each extracted distance, shortest first.
 *
 * **Why this is a view and not a filter on the browser.** Both exist, and
 * they answer different questions. `/activities?has_pr=true` answers "which
 * runs set records", which is a fact about runs. This answers "what am I
 * capable of at 5 k, and when did that happen", which is a fact about the
 * athlete - and it is the question the incumbents answer worst, which is why
 * the maintainer asked for it as its own page rather than only as a badge.
 *
 * Nothing here decides what a record is. The endpoint returns the fastest
 * eligible effort at each distance, and the eligibility rule belongs to the
 * analysis layer and is documented in docs/reference/derived-layer.md: a
 * treadmill effort cannot be a record, and an effort whose
 * `distance_trusted` is not true cannot be one either: it holds a jump in
 * the recorded distance that the measured speed does not confirm. That last
 * is not a formality - measured on the real store, the five fastest 400 m
 * efforts are all flagged `contains_jump`, the quickest implying a speed
 * above the 100 m world record's average, and none is confirmed, so a page that computed its own records would lead
 * with a number no human has run.
 *
 * `contains_jump` is defined on the recorded distance alone: an advance
 * whose implied speed exceeds the analysis layer's threshold. It names no
 * cause and neither does this comment. What causes them is genuinely open -
 * on the one effort anyone has examined the position and speed channels
 * were clean while the odometer alone blipped, while the fact that they
 * appear on outdoor runs and never on treadmill ones is evidence the other
 * way. This wording used to call them GPS reacquisition jumps, which
 * asserted the answer; asserting the opposite would be the same mistake.
 *
 * A distance with a single eligible effort is a record here, with "best of 1"
 * beside it, and the `pr` tag behind the list's badge agrees: the first
 * eligible effort at a distance is a record on both sides, the rule
 * `analysis.tags` adopted on 2026-09-05. See docs/reference/math/tags.md.
 *
 * **What a row is.** The reference screen this was rebuilt against
 * (`.claude/design-bar/strava/stats-totals-and-best-efforts.jpg`, which is
 * this very ladder) gives a row one label and one bold value hard right,
 * with a chevron where it leads somewhere. Ours has five things to say per
 * distance rather than one, so the row keeps that silhouette and hangs the
 * rest off it:
 *
 * - the **distance** is the label, in words;
 * - the **time** is the value - it is what the reader came for;
 * - the **pace** sits directly under the time, because it is that time
 *   interpreted rather than a separate quantity. A column of durations
 *   rising from 1:31 at 400 m to over two hours at the longest rung the
 *   store holds says nothing about how the efforts compare, and a column of
 *   paces beside it, starting at 3:48 per kilometre, says everything, which
 *   is why it is on the page at all. The far end moves as the athlete runs
 *   further, which is why it is not pinned here;
 * - the **exact metres**, the **day**, the **heart rate** and **how many
 *   efforts this one is the best of** are the quiet line under the label,
 *   in that order: what the distance actually is, then which run it was,
 *   then how hard, then how well attested - and the metres appear only on
 *   the rows where they are not the label again, see
 *   `labelAlreadyStatesTheDistance`;
 * - the whole row **links** to the run that set it, which is what the
 *   chevron means.
 *
 * Five equal columns is what this screen used to be, and at 412 px the
 * heart rate ran off the right edge of the phone.
 *
 * **Routes** follow the distance records as a second group of the same
 * rows - see `RoutesSection` - rather than as a view of their own, because
 * a route record answers the same "what is my best"
 * question over a loop instead of a distance.
 */
export function Records() {
  const { data, isPending, isError, error } = useQuery(queries.records())
  const routesQuery = useQuery(queries.routes())

  if (isPending) {
    return <p>Loading the records…</p>
  }

  if (isError) {
    return <p role="alert">Could not load the records: {describeApiError(error)}</p>
  }

  return (
    <div className={styles.records}>
      <h1>Records</h1>

      {data.items.length === 0 ? (
        <Absent
          label="No records yet"
          reason={
            'No eligible best effort has been extracted. A distance appears here once an ' +
            'outdoor run has an effort at it whose recorded distance can be trusted: no jump in it, ' +
            'or one the measured speed confirms.'
          }
        />
      ) : (
        <>
          <RowList title="Best efforts">
            {data.items.map((record) => (
              <Row
                key={record.distance_key}
                label={distanceKeyLabel(record.distance_key)}
                value={duration(record.elapsed_time_s)}
                /*
                 * Pace from the effort's own distance and time, which is
                 * presentation arithmetic rather than a metric: the
                 * analysis layer stores speed and never pace (CLAUDE.md),
                 * and `format.pace` is the one place that reciprocal is
                 * taken.
                 */
                detail={pace(record.distance_m / record.elapsed_time_s)}
                meta={[
                  // The metres behind the key, so `1 mile` and `Half
                  // marathon` are not names the reader has to already know
                  // the length of - and so a key the analysis layer added
                  // after this build, which `distanceKeyLabel` passes
                  // through as itself, still says how far it is.
                  //
                  // `null` rather than a dropped entry on the rows whose
                  // label is already the distance: `Row`'s `meta` is
                  // positional, and an empty slot keeps the date under the
                  // dates and the count under the counts when the desktop
                  // layout turns the run into columns.
                  distanceKeyStatesTheDistance(record.distance_key)
                    ? null
                    : distance(record.distance_m),
                  shortLocalDate(record.start_time_utc, record.utc_offset_s),
                  heartRate(record.avg_hr_bpm),
                  `best of ${String(record.effort_count)}`,
                ]}
                link={{
                  to: '/activities/$activityId',
                  params: { activityId: record.activity_id },
                }}
              />
            ))}
          </RowList>

          <p className={styles.note}>
            Best efforts are elapsed time and span their pauses, so a five-minute stop inside a
            10 km window counts. Treadmill runs are excluded, and so is any effort crossing a jump
            in the recorded distance, unless the watch's measured speed confirms that distance to
            within 1%. Both are excluded on both sides: an ineligible effort neither sets a record
            nor becomes the time a later one has to beat. <strong>Best of</strong> counts the eligible
            efforts at that distance - the number this one is the best of.
          </p>
        </>
      )}

      {routesQuery.isError ? (
        <p role="alert">Could not load the routes: {describeApiError(routesQuery.error)}</p>
      ) : (
        routesQuery.isSuccess && routesQuery.data.length > 0 && <RoutesSection routes={routesQuery.data} />
      )}
    </div>
  )
}

/**
 * Every route the store holds, in the endpoint's order - most runs first,
 * then by name - each row linking to its route view.
 *
 * The value is the record pace, the one number the route view leads with,
 * and it is `format.pace` over the stored `record_speed_mps`: no pace is
 * stored anywhere. A route whose every run is ineligible has no record, so
 * its value is the no-value glyph and its date slot is empty.
 *
 * The date is the record's, in the record run's own wall clock from
 * `record_utc_offset_s`.
 *
 * `meta` is date then run count on every row, with `null` in the date slot
 * rather than a dropped entry, so the desktop columns stay aligned.
 *
 * Nothing is drawn while the list is loading or when it is empty: the
 * group is a second list under the ladder, and the ladder already speaks
 * for the page.
 */
function RoutesSection({ routes }: { routes: RouteSummary[] }) {
  return (
    <RowList title="Routes">
      {routes.map((route) => (
        <Row
          key={route.route_id}
          label={route.name}
          value={pace(route.record_speed_mps)}
          meta={[
            route.record_start_time_utc === null
              ? null
              : shortLocalDate(route.record_start_time_utc, route.record_utc_offset_s),
            runCount(route.run_count),
          ]}
          link={{ to: '/routes/$routeId', params: { routeId: route.route_id } }}
        />
      ))}
    </RowList>
  )
}
