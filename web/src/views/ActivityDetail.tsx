import { useQuery } from '@tanstack/react-query'
import { Link, getRouteApi } from '@tanstack/react-router'
import type { CSSProperties, ReactNode } from 'react'
import { Route as RouteChart } from '../charts/Route'
import { hasRoute } from '../charts/routeMath'
import { StreamPanel, StreamPanelHeading } from '../charts/StreamPanel'
import type { StreamChannel } from '../charts/StreamPanel'
import { chartFurniturePx, hasChartableValue, paceLineNote, traceMean } from '../charts/streamPanelMath'
import { ZoneBar } from '../charts/ZoneBar'
import { describeApiError, isNotFoundError } from '../api/errors'
import { queries } from '../api/queries'
import type { components } from '../api/schema'
import { Absent } from '../components/Absent'
import { BackControl } from '../components/BackControl'
import { Decoupling } from '../components/Decoupling'
import { RouteHero } from '../components/RouteHero'
import { Splits } from '../components/Splits'
import { Stat, StatGroup } from '../components/Stat'
import { ReclassificationNote } from '../components/ReclassificationNote'
import { RecordNote } from '../components/RecordNote'
import { Tag } from '../components/Tag'
import { MomentProvider } from '../moment/MomentProvider'
import {
  ascent,
  cadenceMeasure,
  distanceMeasure,
  duration,
  fastestRankLabel,
  heartRateMeasure,
  localDateLabel,
  localTimeLabel,
  pace,
  runCount,
} from '../format'
import styles from './ActivityDetail.module.css'
import { useElementHeight } from './useElementHeight'
import { useHeroCollapse } from './useHeroCollapse'
import { DESKTOP_LAYOUT_QUERY, useMediaQuery } from './useMediaQuery'

type Streams = components['schemas']['Streams']
type ActivityRoute = components['schemas']['ActivityRoute']

/**
 * `getRouteApi` rather than importing the route object from `router.tsx`,
 * for the same reason `Activities.tsx` does - that file imports this
 * component, so importing the route back would be a cycle.
 */
const routeApi = getRouteApi('/activities/$activityId')

/**
 * A treadmill's distance comes from an uncalibrated footpod rather than
 * GPS - see CLAUDE.md and docs/reference/derived-layer.md - so its route
 * panel is replaced with that fact rather than an empty map. Every other
 * no-GPS case (a lost signal outdoors, say) falls through to `Route`'s own
 * generic "no route recorded" message: `is_indoor` is the one case this
 * view has a more specific reason for.
 */
const TREADMILL_ROUTE_ABSENT_REASON =
  'This is a treadmill run: distance is measured by a footpod rather than GPS, so there is no route to draw.'

/**
 * What to show in place of a stream-dependent panel when the streams
 * request did not succeed, or `null` when it did (or is still pending).
 *
 * A 404 (M9) is this application's one authoritative "there is no grid to
 * serve" answer - `derived_absent_reason`'s own wording, or the running-
 * but-not-yet-recomputed case - and is framed through `Absent` like every
 * other stated absence. Anything else - a 503 from a broken store, or a
 * network error with the server unreachable mid-page - is a real failure,
 * not a fact about the activity, and renders as an alert instead: an
 * earlier version framed both the same way, so a stopped server mid-page
 * read as calmly as a genuine 404, while the page's own detail-query
 * failure one section up already rendered as an alert for the same class
 * of problem.
 */
function streamsProblem(absentReason: string | null, failureReason: string | null): ReactNode {
  if (failureReason !== null) return <p role="alert">Could not load the 1 Hz grid: {failureReason}</p>
  if (absentReason !== null) return <Absent reason={absentReason} />
  return null
}

type ActivitySummary = components['schemas']['ActivitySummary']
type ActivityMetrics = components['schemas']['ActivityMetrics']

/**
 * The stream channels the detail view draws, in order.
 *
 * Elevation joined the list on the maintainer's instruction of 2026-09-02,
 * as its own panel beside the other three rather than only as a per-split
 * column.
 * It needed no API change: `altitude_m` is already served on the streams
 * response and is non-null on all 2932 samples of the reference activity.
 */
const STREAM_CHANNELS: readonly StreamChannel[] = ['pace', 'hr', 'cadence', 'elevation']

/**
 * Where the activity happened, as a line of text, or `null` when the derived
 * layer has no place for it.
 *
 * The distance is what makes this honest. A nearest-place match is usually
 * within a couple of kilometres, and sometimes is not: the worst on the real
 * history is a start abroad nearly three times `NEAR_THRESHOLD_M` from the
 * nearest place in the table. Printing that place's name flat for a run that
 * far outside it claims a precision the lookup does not have, so past
 * `NEAR_THRESHOLD_M` the label says `near` and means it.
 *
 * Null for every treadmill run, which has no position at all, and for any
 * activity recomputed before the place columns existed.
 */
function placeLabel(metrics: ActivityMetrics | undefined): string | null {
  if (metrics === undefined) return null
  const { locality, country, locality_distance_m: away } = metrics
  if (locality === null || locality === undefined) return null
  const named = country === null || country === undefined ? locality : `${locality}, ${country}`
  if (away !== null && away !== undefined && away > NEAR_THRESHOLD_M) return `near ${named}`
  return named
}

/**
 * Past this, the named place is somewhere the run was *near* rather than in.
 *
 * 10 km: on the real history 205 of the 221 placed runs match inside it and
 * 16 do not. The far end of that tail is what the threshold is for - two
 * starts abroad, each well over twice the threshold from the nearest place in
 * the table. Four of the sixteen are runs in one large city, 1.3 to 1.5 times
 * the threshold out, which read as `near` that city because the distance is
 * measured to the city's own point rather than to its boundary. That is a
 * fair description of a run that did not start in the middle of it, so the
 * wording holds either way.
 */
const NEAR_THRESHOLD_M = 10_000

/** The way back's name when it is a link to the list, which is where it goes with no history behind it. */
const BACK_TO_ACTIVITIES = 'Back to activities'

/**
 * The id each stream panel's own heading carries, so its `<section>` can
 * point `aria-labelledby` at it.
 *
 * A `<section>` is only exposed as a landmark when it has an accessible
 * name, and these used to get one from an `aria-label` with no visible
 * heading at all - which named the region for a screen reader and left
 * nothing on screen saying what the chart was. Naming the region *from*
 * the visible heading gives both, from one string.
 */
function streamHeadingId(channel: StreamChannel): string {
  return `section-stream-${channel}`
}

/**
 * The SI series each channel plots. Pace takes `speed_mps`, not a pace:
 * the panel's axis is linear in speed and only its tick labels are pace,
 * for the measured reason in `StreamPanel`'s own module doc.
 */
function streamValues(streams: Streams, channel: StreamChannel): (number | null)[] {
  switch (channel) {
    case 'pace':
      return streams.speed_mps
    case 'hr':
      return streams.hr_bpm
    case 'cadence':
      return streams.cadence_spm
    case 'elevation':
      return streams.altitude_m
  }
}

/**
 * The stream panels' own sizes, from their axis options, for the compact
 * desktop charts' height in `ActivityDetail.module.css` (`.pinned`) - a
 * stylesheet cannot read them from `streamPanelMath.ts` itself.
 */
const COMPACT_CHART_SIZES = {
  '--stream-chart-furniture-axis': `${chartFurniturePx(true)}px`,
  '--stream-chart-furniture-bare': `${chartFurniturePx(false)}px`,
} as CSSProperties

/**
 * The last of the stream panels that draws a chart rather than its "no X
 * recorded" state, or `null` when none does: the panel that carries the
 * time axis for the compact desktop stack. Elevation on almost every run,
 * but a run with no altitude recorded would otherwise leave the stack with
 * no time axis at all.
 */
function bottomChartedChannel(streams: Streams): StreamChannel | null {
  const charted = STREAM_CHANNELS.filter((channel) =>
    hasChartableValue(streamValues(streams, channel), streams.paused, streams.outage),
  )
  return charted.at(-1) ?? null
}

/**
 * The reference line each panel draws: the mean of its own trace, over the
 * seconds the panel draws. docs/reference/frontend.md, "A panel's dashed line
 * is the mean of the trace it is drawn over", has why it is not the summary's average, which the header shows instead.
 *
 * Elevation has none: an average altitude is not a quantity anybody
 * trains against, and a flat line through the middle of a terrain profile
 * would read as a target rather than as arithmetic. Ascent is the number
 * that matters there and it is already in the stat rail above.
 */
function streamAverage(streams: Streams, channel: StreamChannel): number | null {
  if (channel === 'elevation') return null
  return traceMean(streamValues(streams, channel), streams.paused, streams.outage)
}

/**
 * One stream channel's `<section>`: its panel when there is a grid to
 * draw, its heading and the reason otherwise.
 *
 * **The heading renders in every state, and that is the reason this is a
 * component rather than a branch inside the map.** A `<section>` is only
 * exposed as a landmark while its `aria-labelledby` resolves, so a state
 * that skipped the heading pointed the attribute at nothing and the
 * section silently stopped being a named region - which is what happened
 * on a failed streams request. Keeping the rule in one named place, next
 * to the id it depends on, is worth more than the nesting it saves.
 */
function StreamSection({
  channel,
  streams,
  streamsAbsentReason,
  streamsFailureReason,
  summary,
  isIndoor,
  paceNoteRef,
  timeAxis,
}: {
  channel: StreamChannel
  streams: Streams | null
  streamsAbsentReason: string | null
  streamsFailureReason: string | null
  summary: ActivitySummary
  isIndoor: boolean | null
  paceNoteRef: (node: HTMLParagraphElement | null) => void
  timeAxis: boolean
}) {
  const headingId = streamHeadingId(channel)
  const problem = streamsProblem(streamsAbsentReason, streamsFailureReason)
  const average = streams === null ? null : streamAverage(streams, channel)
  const note =
    channel === 'pace'
      ? paceLineNote({
          traceSpeedMps: average,
          summarySpeedMps: summary.avg_speed_mps,
          distanceM: summary.distance_m,
          movingTimeS: summary.moving_time_s,
          isIndoor,
        })
      : null

  return (
    <section className={`${styles.section} ${styles.divided}`} aria-labelledby={headingId}>
      {problem !== null || streams === null ? (
        <>
          <StreamPanelHeading channel={channel} headingLevel={2} headingId={headingId} />
          {problem ?? <p>Loading…</p>}
        </>
      ) : (
        <>
          <StreamPanel
            channel={channel}
            headingLevel={2}
            headingId={headingId}
            t={streams.t_s}
            values={streamValues(streams, channel)}
            paused={streams.paused}
            outage={streams.outage}
            average={average}
            timeAxis={timeAxis}
          />
          {/* Visible text, not a tooltip: the header's Pace and this line
              are two measurements of the run, and the page says which. */}
          {note !== null && (
            <p ref={paceNoteRef} className={styles.paceNote}>
              {note}
            </p>
          )}
        </>
      )}
    </section>
  )
}

/**
 * Everything after the hero, as the right-hand column of the desktop layout
 * when there is a hero to pin beside it - see `ActivityDetail.module.css`'s
 * `.besideHero` for the layout and why this is an element of its own rather
 * than a hero spanning a guessed number of grid rows. Without a hero there
 * is no column, and the children are the page's own.
 */
function BesideHero({ pinned, children }: { pinned: boolean; children: ReactNode }) {
  return pinned ? <div className={styles.besideHero}>{children}</div> : <>{children}</>
}

/**
 * The route line under the title: which route this run belongs to, how many
 * runs that route has, and where this one ranks among its eligible runs,
 * all as one link to the route view.
 *
 * The rank is the analysis layer's `rank`. It is null on an ineligible run,
 * and the line then states no rank at all.
 * The separators are `aria-hidden` with a real space either side, because
 * an accessible name is its parts concatenated with no space inserted.
 */
function RouteLine({ route }: { route: ActivityRoute }) {
  const parts = [route.name, runCount(route.run_count)]
  if (route.rank !== null) parts.push(fastestRankLabel(route.rank))
  return (
    <p className={styles.routeLine}>
      <Link to="/routes/$routeId" params={{ routeId: route.route_id }} className={styles.link}>
        Route:{' '}
        {parts.map((part, index) => (
          <span key={index}>
            {index > 0 && (
              <>
                {' '}
                <span aria-hidden="true">·</span>{' '}
              </>
            )}
            {part}
          </span>
        ))}
      </Link>
    </p>
  )
}

/**
 * The deepest screen in the application: one run's route as the hero, the
 * day it happened and its six headline numbers as one block beneath, then
 * the heart-rate zone distribution, the four stream panels, and the splits -
 * see `components/Splits.tsx` for which of the two splits tabs leads.
 *
 * **The route leads at hero scale, full bleed, and it keeps its own
 * shape.** `Route` sets its `aspect-ratio` from the trace's own bounding
 * box, clamped between square and 1.8:1, so the hero is as tall as the run
 * is - a fixed hero ratio would put back exactly the letterbox that clamp
 * exists to remove (measured at 1024px wide: a 1024x600 panel with the
 * trace occupying 440x517). Before this the route shared a row with the
 * zone table, which was how that letterbox's 584px of horizontal emptiness
 * got filled; a full-bleed hero at the trace's own ratio has no hole to
 * fill, so the zones are their own section again.
 *
 * **A run with no trace gets no hero at all.** The absence is stated where
 * a route section would be, at the page gutter, rather than in a
 * hero-sized box: the most valuable block on the screen is not spent on the
 * absence of its subject. The way back becomes an ordinary control at the
 * top of the page in that case, in the same position it floats in
 * otherwise.
 *
 * `derived` and the 1 Hz grid are fetched and can each be absent
 * independently of the other - a non-running activity has no `derived`
 * block at all, while a running one that has not been recomputed yet can
 * have `derived` but still 404 on `/streams`. Absence is stated wherever it
 * occurs rather than left as a blank panel - see `Absent.tsx`.
 */
export function ActivityDetail() {
  const { activityId } = routeApi.useParams()

  const detailQuery = useQuery(queries.activity(activityId))
  const streamsQuery = useQuery(queries.streams(activityId))
  const basemapQuery = useQuery(queries.basemap())
  // Before the early returns below, as every hook has to be.
  const heroRef = useHeroCollapse()
  const desktop = useMediaQuery(DESKTOP_LAYOUT_QUERY)
  // The pace note's height, for the desktop stack's plot height; see
  // `.pinned` in ActivityDetail.module.css.
  const [paceNoteRef, paceNoteHeight] = useElementHeight<HTMLParagraphElement>()

  if (detailQuery.isPending) {
    return <p>Loading the activity…</p>
  }

  if (detailQuery.isError) {
    return (
      <p role="alert">Could not load this activity: {describeApiError(detailQuery.error)}</p>
    )
  }

  const detail = detailQuery.data
  const { summary, laps, derived, derived_absent_reason: derivedAbsentReason } = detail

  // See `streamsProblem` above: a 404 is a stated absence, anything else
  // (a 503, a network error) is a real failure and framed as an alert
  // instead. Only one of the two is ever non-null.
  const streamsAbsentReason =
    streamsQuery.isError && isNotFoundError(streamsQuery.error) ? describeApiError(streamsQuery.error) : null
  const streamsFailureReason =
    streamsQuery.isError && !isNotFoundError(streamsQuery.error) ? describeApiError(streamsQuery.error) : null
  const streams: Streams | null = streamsQuery.isSuccess ? streamsQuery.data : null

  const splitsStreams =
    streams === null
      ? null
      : {
          t: streams.t_s,
          distanceM: streams.distance_m,
          hrBpm: streams.hr_bpm,
          cadenceSpm: streams.cadence_spm,
          altitudeM: streams.altitude_m,
        }

  const effortTag = (derived?.tags ?? []).find((tag) => tag.kind === 'effort')
  // The intervals-tag rule: the sole criterion for which splits tab leads is the
  // presence of an `intervals` tag, never a count of manual laps and,
  // deliberately, not "does `rep_count` happen to be non-null" either -
  // that is equivalent today only because `rep_count` happens to be
  // populated on no other effort tag, and a predicate that actually names
  // `tag === 'intervals'` stays correct if that ever changes.
  const isIntervalsSession = effortTag?.tag === 'intervals'

  // Whether this run could have a trace at all, from the derived layer's
  // own two facts rather than from anything computed here. `has_gps` is
  // false for a treadmill and for any outdoor recording that never got a
  // fix, and it is what lets the hero hold its space while the grid is
  // still in flight instead of appearing under the reader a second later.
  const metrics = derived?.metrics
  const canHaveRoute = metrics !== undefined && metrics.has_gps === true && metrics.is_indoor !== true
  const heroStreams =
    streams !== null && canHaveRoute && hasRoute(streams.lat_deg, streams.lon_deg) ? streams : null
  const heroPending =
    heroStreams === null &&
    canHaveRoute &&
    streams === null &&
    streamsAbsentReason === null &&
    streamsFailureReason === null
  const hasHero = heroStreams !== null || heroPending

  // The compact desktop charts share one time axis, drawn by the bottom
  // panel that has a chart - see `.pinned` in ActivityDetail.module.css.
  // Everywhere else, and when no panel has a chart, each panel keeps its own.
  const sharedTimeAxisChannel =
    hasHero && desktop && streams !== null ? bottomChartedChannel(streams) : null

  return (
    // Keyed on the activity id, deliberately: this component reads its id
    // from `useParams` and the route carries no key, so it does not remount
    // between two activities (neither `router.tsx`'s route definition nor
    // this component's own hooks force one) - a bare `<MomentProvider>`
    // would carry the previous activity's moment, and a replay's head, into
    // the next one.
    <MomentProvider key={activityId}>
      <div
        className={hasHero ? `${styles.detail} ${styles.pinned}` : styles.detail}
        style={{ ...COMPACT_CHART_SIZES, '--pace-note-height': `${paceNoteHeight}px` } as CSSProperties}
      >
        {hasHero && (
          <RouteHero
            ref={heroRef}
            className={styles.hero}
            trace={heroStreams === null ? null : { lat: heroStreams.lat_deg, lon: heroStreams.lon_deg }}
            activity={
              heroStreams === null
                ? undefined
                : {
                    t: heroStreams.t_s,
                    distance: heroStreams.distance_m,
                    speed: heroStreams.speed_mps,
                    paused: heroStreams.paused,
                    outage: heroStreams.outage,
                  }
            }
            basemap={basemapQuery.data}
          >
            <BackControl floating={true} fallbackTo="/activities" fallbackLabel={BACK_TO_ACTIVITIES} />
          </RouteHero>
        )}

        <BesideHero pinned={hasHero}>
          <header className={styles.header}>
            {!hasHero && <BackControl floating={false} fallbackTo="/activities" fallbackLabel={BACK_TO_ACTIVITIES} />}

            <h1>{localDateLabel(summary.start_time_utc, summary.utc_offset_s)}</h1>

            {/* The reference's byline: one quiet line under the title carrying
                when and where, in that order, separated by a middle dot. The
                time is its own half because an activity with no recorded
                offset renders `18:19 UTC` and the marker has to stay attached
                to the number it qualifies. */}
            <p className={styles.meta}>
              <span>{localTimeLabel(summary.start_time_utc, summary.utc_offset_s)}</span>
              {placeLabel(metrics) !== null && (
                <>
                  <span aria-hidden="true" className={styles.metaDot}>
                    ·
                  </span>
                  <span>{placeLabel(metrics)}</span>
                </>
              )}
            </p>

            {detail.route !== null && <RouteLine route={detail.route} />}

            {(summary.sub_sport === 'treadmill' || summary.pr_distance_keys.length > 0) && (
              <p className={styles.badges}>
                {summary.sub_sport === 'treadmill' && <span className={styles.badge}>Treadmill</span>}
                {summary.pr_distance_keys.length > 0 && (
                  <span
                    className={`${styles.badge} ${styles.badgePr}`}
                    title={`Personal record at ${summary.pr_distance_keys.join(', ')}`}
                  >
                    PR {summary.pr_distance_keys.join(' ')}
                  </span>
                )}
              </p>
            )}

            {/*
              * The automatic tags: the effort badge and every flag, in the
              * slot the reference fills with its achievement card - between
              * the title block and the numbers.
              *
              * **No card.** The reference's block there is a promotion with an
              * icon and a "Se mer" button, and a blind critic reading the two
              * screens side by side named that saturated pill as the loudest
              * object on its page - the thing ours wins by not having. Ours is
              * a row of badges, and whitespace does the separating, as it does
              * everywhere else on these screens.
              *
              * The box also could not be drawn honestly. The reference's card is
              * +27 of 255 off its page on Android and +13 on iOS, which a dark
              * palette can spend upwards; `--page` is 233,238,241 and there are
              * only 22 steps between it and white, so the `--panel` version
              * measured a 3% fill delta - a box that cannot be seen, which is
              * exactly what the Overview's stat cards were deleted for. The
              * alternative, `--raised` plus a hairline, would put the screen's
              * only white box directly under a white hero and compete with it.
              *
              * **The classifier's own reasoning moved off the title block and
              * into a popover, at the maintainer's request on 2026-09-28.** It
              * used to sit as a visible sentence under each badge - "median heart
              * rate 161 bpm, 77.7% of max, no recorded reps" beside `Steady`
              * on the reference fixture, the run's distance against the top
              * decile of the last 90 days under `Long run` - and at up to three
              * badges deep that ran several lines into a right-hand column
              * only about 480px wide (the desktop layout's right-hand column), pushing the
              * stats and the charts beside the map further down than the
              * reasoning earned. The reason is one hover, one keyboard focus
              * or one tap away instead - see `Tag.tsx` - and stays in the DOM
              * the whole time, visually hidden rather than removed, so a
              * screen reader still gets it through `aria-describedby` with
              * nothing to trigger.
              *
              * `Tag` renders nothing at all when there is no effort row and no
              * flag, which is 57 of the 307 real runs.
              */}
            <Tag tags={derived?.tags ?? []} />

            {/* Why this activity is missing from every running analysis, if it is. */}
            <ReclassificationNote reclassification={detail.reclassification} />

            {/* Why a fast effort here is missing from the records ladder, if one is. */}
            <RecordNote efforts={derived?.best_efforts ?? []} />

            {/*
              * Six stats as two rows of three, which is the arrangement the
              * reference's own Android header uses (three left-aligned
              * label-over-value columns, measured at x 75, 376 and 675 of a
              * 1080px shot). `share="third"` fills each row exactly, so both
              * rows start and end on the page gutter - see `Stat.tsx`.
              *
              * Distance, pace, time leads, which is the reference's order and
              * not this view's old one: those are the three a reader opens a
              * run for.
              */}
            <StatGroup>
              <Stat label="Distance" share="third" value={distanceMeasure(summary.distance_m)} />
              <Stat label="Pace" share="third" value={pace(summary.avg_speed_mps)} />
              <Stat label="Moving time" share="third" value={duration(summary.moving_time_s)} />
              <Stat label="Heart rate" share="third" value={heartRateMeasure(summary.avg_hr_bpm)} />
              <Stat label="Cadence" share="third" value={cadenceMeasure(summary.avg_cadence_spm)} />
              <Stat label="Ascent" share="third" value={ascent(summary.ascent_m)} />
            </StatGroup>
          </header>

          {derived === null ? (
            <Absent
              label="No analysis for this activity"
              reason={derivedAbsentReason ?? 'This activity has no derived data.'}
            />
          ) : (
            <>
              {!hasHero && (
                <section className={`${styles.section} ${styles.divided}`} aria-labelledby="section-route">
                  <h2 id="section-route">Route</h2>
                  {streamsProblem(streamsAbsentReason, streamsFailureReason) ??
                    (streams === null ? (
                      <p>Loading the route…</p>
                    ) : derived.metrics.is_indoor === true ? (
                      <Absent reason={TREADMILL_ROUTE_ABSENT_REASON} />
                    ) : (
                      <RouteChart lat={streams.lat_deg} lon={streams.lon_deg} />
                    ))}
                </section>
              )}

              <section className={`${styles.section} ${styles.divided}`} aria-labelledby="section-zones">
                <h2 id="section-zones">Time in zone</h2>
                <ZoneBar buckets={derived.zones} boundariesAreCurrentSettings={false} />
              </section>

              {/*
                * Aerobic decoupling sits between the zone distribution and the
                * stream panels, directly above the heart rate and pace traces it
                * summarises.
                * It is drawn for every run, with the API's reason when the run
                * has no value, the way every other section states an absence.
                */}
              <section className={`${styles.section} ${styles.divided}`} aria-labelledby="section-decoupling">
                <h2 id="section-decoupling">Aerobic decoupling</h2>
                <Decoupling decoupling={derived.decoupling} absentReason={derived.decoupling_absent_reason} />
              </section>

              {STREAM_CHANNELS.map((channel) => (
                <StreamSection
                  key={channel}
                  channel={channel}
                  streams={streams}
                  streamsAbsentReason={streamsAbsentReason}
                  streamsFailureReason={streamsFailureReason}
                  summary={summary}
                  isIndoor={derived.metrics.is_indoor}
                  paceNoteRef={paceNoteRef}
                  timeAxis={sharedTimeAxisChannel === null || channel === sharedTimeAxisChannel}
                />
              ))}

              <section className={`${styles.section} ${styles.divided}`} aria-labelledby="section-splits">
                <h2 id="section-splits">Splits</h2>
                <Splits
                  activityId={activityId}
                  laps={laps}
                  isIntervalsSession={isIntervalsSession}
                  repCount={effortTag?.rep_count ?? null}
                  repPattern={effortTag?.rep_pattern ?? null}
                  streams={splitsStreams}
                  streamsAbsentReason={streamsAbsentReason}
                  streamsFailureReason={streamsFailureReason}
                />
              </section>
            </>
          )}
        </BesideHero>
      </div>
    </MomentProvider>
  )
}
