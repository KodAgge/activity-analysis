import { useQuery } from '@tanstack/react-query'
import { Link, getRouteApi } from '@tanstack/react-router'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { describeApiError, isNotFoundError } from '../api/errors'
import { queries } from '../api/queries'
import type { components } from '../api/schema'
import { ProgressionMark, ProgressionScatter } from '../charts/ProgressionScatter'
import { hasRoute } from '../charts/routeMath'
import { Absent } from '../components/Absent'
import { BackControl } from '../components/BackControl'
import { RouteHero } from '../components/RouteHero'
import { Section } from '../components/Section'
import { Stat, StatGroup } from '../components/Stat'
import { distanceMeasure, pace, runCount, shortLocalDate } from '../format'
import styles from './RouteDetail.module.css'

type RouteDetailResponse = components['schemas']['RouteDetail']
type RouteRun = components['schemas']['RouteRun']

/**
 * `getRouteApi` rather than importing the route object from `router.tsx`,
 * which imports this component - the same reason `ActivityDetail.tsx` gives.
 */
const routeApi = getRouteApi('/routes/$routeId')

/** The way back's name when it is a link, which is where the Routes list lives. */
const BACK_TO_RECORDS = 'Back to Records'

/**
 * One route: every run of it, how fast each was, and which ones set the
 * record - "am I getting faster on my usual loop", which controls for the
 * hills and the surface because the ground is the same.
 *
 * The shape is the activity view's: the trace as a full-bleed hero with
 * the shared way back floating on it, then the title block, then the
 * chart. The hero is `components/RouteHero`, shared with that view,
 * drawing the route's **reference run** - the medoid, the run closest to
 * all the others, whose trace is the route's by construction. The title
 * block links to that run, because the trace is one specific run's and a
 * reader should be able to open it. Direction is not measured against it:
 * the analysis layer measures it against the route's earliest run, whose id
 * is the route's, so a later run moving the medoid cannot flip it.
 *
 * The chart is `ProgressionScatter` in its `route` form: pace per run over
 * time on the progression chart's own axis, faster lower, the records
 * joined by the best-so-far staircase, and a reverse run drawn as a
 * diamond with the chart's own Forward/Reverse key. This view adds the
 * record/eligible/ineligible key and the toggle under it, as
 * `views/Progression.tsx` does, and never a second direction key. The
 * chart's ladder labels are bare `m:ss`, so the section's caption says the
 * axis is pace per km.
 *
 * Every flag - direction, eligibility, rank, record - is the analysis
 * layer's, on each run, handed to the chart verbatim. The counts in the
 * caption are counts of those flags over the runs on the chart, which is
 * what a caption about the chart should count. Pace is formatted here from
 * `speed_mps`; no pace comes from the API.
 */
export function RouteDetail() {
  const { routeId } = routeApi.useParams()
  const routeQuery = useQuery(queries.route(routeId))

  // The page's own wording, apart from the hero's `Loading the map…`, so a
  // reader can tell which of the two is still in flight.
  if (routeQuery.isPending) return <p>Loading the route…</p>

  if (routeQuery.isError) {
    if (isNotFoundError(routeQuery.error)) return <UnknownRoute reason={describeApiError(routeQuery.error)} />
    return <p role="alert">Could not load this route: {describeApiError(routeQuery.error)}</p>
  }

  return <RouteBody detail={routeQuery.data} />
}

/**
 * An id no route has. Not a failure: a route's id is its earliest run's
 * activity id, so a recompute that regroups the runs can retire an id a
 * bookmark or a shared link still holds.
 *
 * A page-level state with a way out rather than `Absent`, for the reason
 * `Absent`'s own doc gives for the other three: it speaks for the whole
 * page, and it carries a link a `reason` string has no place for.
 */
function UnknownRoute({ reason }: { reason: string }) {
  return (
    <div className={styles.route}>
      <header className={styles.header}>
        <h1>No such route</h1>
        <p className={styles.meta}>
          The server answered: {reason}. A route takes the id of its earliest run, so a recompute that
          regroups the runs can retire an id a link still holds.
        </p>
      </header>
      <p className={styles.back}>
        <Link to="/records" className={styles.link}>
          Back to Records
        </Link>
      </p>
    </div>
  )
}

/**
 * A run's day in its own local wall clock, or the fallback instant's UTC
 * day when the run is not in the list - which the API's contract rules
 * out, and which this states as a UTC day rather than guessing an offset.
 */
function runDay(run: RouteRun | undefined, fallbackUtc: string): string {
  if (run === undefined) return shortLocalDate(fallbackUtc, null)
  return shortLocalDate(run.start_time_utc, run.utc_offset_s)
}

function RouteBody({ detail }: { detail: RouteDetailResponse }) {
  const { route, reference_activity_id: referenceId, runs } = detail
  const streamsQuery = useQuery(queries.streams(referenceId))
  const basemapQuery = useQuery(queries.basemap())
  const [showIneligible, setShowIneligible] = useState(true)

  const streams = streamsQuery.isSuccess ? streamsQuery.data : null
  const trace =
    streams !== null && hasRoute(streams.lat_deg, streams.lon_deg)
      ? { lat: streams.lat_deg, lon: streams.lon_deg }
      : null
  const hasHero = streamsQuery.isPending || trace !== null

  // What stands where the hero would, when there is none. The reference run
  // is a GPS run by construction - only runs with `has_gps` and not
  // `is_indoor` are grouped - so the last branch is a guard, not a state
  // the real store reaches.
  let heroAbsence: ReactNode = null
  if (streamsQuery.isError) {
    heroAbsence = isNotFoundError(streamsQuery.error) ? (
      <Absent reason={describeApiError(streamsQuery.error)} />
    ) : (
      <p role="alert">Could not load the reference run&apos;s 1 Hz grid: {describeApiError(streamsQuery.error)}</p>
    )
  } else if (streams !== null && trace === null) {
    heroAbsence = <Absent reason="The reference run recorded no GPS trace to draw." />
  }

  const reference = runs.find((r) => r.activity_id === referenceId)
  const recordDay =
    route.record_start_time_utc === null
      ? undefined
      : shortLocalDate(route.record_start_time_utc, route.record_utc_offset_s)

  const eligibleCount = runs.filter((r) => r.eligible).length
  const recordCount = runs.filter((r) => r.is_record).length

  return (
    <div className={styles.route}>
      {hasHero && (
        <RouteHero className={styles.hero} trace={trace} basemap={basemapQuery.data}>
          <BackControl floating={true} fallbackTo="/records" fallbackLabel={BACK_TO_RECORDS} />
        </RouteHero>
      )}

      <header className={styles.header}>
        {!hasHero && <BackControl floating={false} fallbackTo="/records" fallbackLabel={BACK_TO_RECORDS} />}
        <h1>{route.name}</h1>
        <p className={styles.meta}>
          <span>{runCount(route.run_count)}</span> <span aria-hidden="true">·</span>{' '}
          <span>
            {runDay(runs.at(0), route.first_run_utc)} to {runDay(runs.at(-1), route.last_run_utc)}
          </span>
        </p>
        {reference !== undefined && (
          <p className={styles.metaLink}>
            <Link to="/activities/$activityId" params={{ activityId: referenceId }} className={styles.link}>
              Map from the run on {runDay(reference, reference.start_time_utc)}
            </Link>
          </p>
        )}
        <StatGroup>
          <Stat label="Record pace" share="half" value={pace(route.record_speed_mps)} detail={recordDay} />
          <Stat label="Median distance" share="half" value={distanceMeasure(route.median_distance_m)} />
        </StatGroup>
      </header>

      {heroAbsence !== null && (
        <section className={styles.section} aria-labelledby="section-route">
          <h2 id="section-route">Route</h2>
          {heroAbsence}
        </section>
      )}

      <Section
        title="Every run"
        note={`Pace per km. Faster is lower, so improvement descends. ${runCount(runs.length)}, ${String(
          eligibleCount,
        )} eligible, ${String(recordCount)} ${recordCount === 1 ? 'record' : 'records'}.`}
        divided
      >
        <ProgressionScatter
          kind="route"
          runs={runs}
          showIneligible={showIneligible}
          ariaLabel={`${route.name}, pace per run`}
        />
        <div className={styles.key}>
          {/* Colour only: the chart's own key, directly above, names the
              two shapes, so this one draws every swatch as a circle. */}
          <ul className={styles.legend} aria-label="Point styles">
            <li className={styles.legendItem}>
              <ProgressionMark style="record" />
              Record
            </li>
            <li className={styles.legendItem}>
              <ProgressionMark style="eligible" />
              Eligible
            </li>
            <li className={styles.legendItem}>
              <ProgressionMark style="ineligible" />
              Ineligible
            </li>
          </ul>
          <label className={styles.toggle}>
            <input
              className={styles.toggleInput}
              type="checkbox"
              checked={showIneligible}
              onChange={(event) => setShowIneligible(event.target.checked)}
            />
            Show ineligible runs
          </label>
        </div>
        <details className={styles.footnote}>
          <summary className={styles.footnoteSummary}>What counts, and why</summary>
          <p className={styles.footnoteBody}>
            Pace is the run&apos;s elapsed time over its recorded distance, pauses included. A record is a
            run faster than every eligible run before it on this route, the first eligible run included. An
            ineligible run - one recorded as GPX, one with a jump in the recorded distance that the
            watch&apos;s measured speed does not confirm to within 1% or has no measured speed to check, or
            one not known to be free of jumps - is drawn, but never sets a record and never becomes the pace
            a later run has to beat; its readout gives the reason. Forward and Reverse are relative to the first run on the
            route, and a route that doubles back on itself marks every run Forward.
          </p>
        </details>
      </Section>
    </div>
  )
}
