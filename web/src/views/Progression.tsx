import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { describeApiError, isNotFoundError } from '../api/errors'
import { validateProgressionSearch } from '../api/progressionSearch'
import { queries } from '../api/queries'
import { ProgressionMark, ProgressionScatter } from '../charts/ProgressionScatter'
import { Absent } from '../components/Absent'
import { Section } from '../components/Section'
import {
  distance,
  distanceKeyLabel,
  distanceKeyStatesTheDistance,
  duration,
  heartRate,
  pace,
  shortLocalDate,
} from '../format'
import styles from './Progression.module.css'

/**
 * Every effort at one distance over time, records marked: how the athlete
 * got to each entry in the records ladder, and why a faster effort did not
 * count.
 *
 * **This is the one screen with no counterpart in the reference.** Strava
 * has a best-efforts *list* - one row per distance, the time on the right,
 * a chevron - and nothing that plots every attempt at one of them over
 * three years. So the shape of the screen is taken from the reference
 * rather than the screen itself: the sport-filter chips at the top of
 * `you-tab-weekly-stats-and-12-week-chart.jpg` become the distance picker,
 * the "Den här veckan / Distans / Tid / Höjdökning" block under them
 * becomes the three stats describing the personal best, and the twelve-week
 * chart's registration - plot on the page gutter, ladder outside it on the
 * right, horizontal rules and no verticals - is the chart's.
 *
 * The chosen distance lives in the URL as a validated search param, so a
 * view of the 10 km progression is a shareable link. The search is read
 * loosely and re-validated here rather than typed from the route, for the
 * reason `queries.activities` re-validates its own input: TanStack Router
 * overlays a route's validated search onto the raw parent search, so a key
 * the validator dropped can still be on the object `useSearch()` returns.
 * `router.tsx`'s `beforeLoad` redirect is what keeps the address bar clean;
 * this is the boundary that decides what is requested regardless.
 *
 * The picker is driven by `/api/records`, which lists every distance the
 * store holds an eligible effort at, shortest first. The three the athlete
 * has never covered, 30 km, 35 km and the marathon, are not there, because
 * no run reaches them, and `/api/progression/marathon` is a 404 - so
 * the picker cannot offer them, and a URL that names one renders the 404 as
 * a stated absence rather than an empty chart.
 *
 * Eligibility and records are the analysis layer's decisions, carried on
 * each point. Ineligible efforts are drawn by default in a distinct muted
 * style: for 5 km they are 70 of 225 efforts, and hiding them would
 * misrepresent training volume, while drawing them like the others would
 * let an effort across a distance jump look like a record.
 *
 * The flag itself is the analysis layer's and is correct under its own
 * rule, which tests the odometer's implied speed against 12.5 m/s. The
 * words for it are this application's and were wrong: examined on a real
 * half marathon, the position advanced steadily through the flagged moment
 * and the speed channel never moved, while the distance channel alone
 * gained nearly five times the speed channel's reading in one second.
 * So the copy says what the flag is defined on, the recorded distance, and
 * names no cause. What causes these is open: the clean channels above point
 * one way, and the fact that they appear on outdoor runs and never on
 * treadmill ones, which use no GPS at all, points the other. Asserting
 * either is the mistake the old wording made.
 * The API's own `ineligible_reason` is its prose and is shown verbatim.
 */
export function Progression() {
  const rawSearch = useSearch({ strict: false })
  const navigate = useNavigate()
  const { distance: distanceKey } = validateProgressionSearch(rawSearch as Record<string, unknown>)
  const [showIneligible, setShowIneligible] = useState(true)
  const chosenPillRef = useRef<HTMLLabelElement | null>(null)

  const recordsQuery = useQuery(queries.records())
  const progressionQuery = useQuery(queries.progression(distanceKey))

  function onDistanceChange(event: ChangeEvent<HTMLInputElement>) {
    // `to: '.'` is this route, whatever it is mounted at; naming
    // `/progression` here would couple the view to the route tree the way
    // `getRouteApi` does, and the test harness mounts it elsewhere.
    void navigate({ to: '.', search: { distance: event.target.value } })
  }

  const distanceKeys = recordsQuery.data?.items.map((record) => record.distance_key) ?? []
  // The URL may name a distance the picker does not list - an unknown key,
  // or one with efforts but no eligible one. The row still has to show what
  // the URL says, or the control and the address bar disagree.
  const options = distanceKeys.includes(distanceKey) ? distanceKeys : [...distanceKeys, distanceKey]

  /*
   * The chosen pill, brought into view.
   *
   * The real store holds nineteen distances, so the row is several screens
   * wide at phone width and `5k` - the default - starts well off the right
   * edge of it. The reference's own chip row scrolls the same way (its
   * third chip is clipped by the screen edge, which is what says it
   * scrolls), and a selected chip a reader cannot see is a control that
   * looks empty.
   *
   * `block: 'nearest'` so bringing a pill into view horizontally cannot
   * also scroll the page vertically, and a guard because jsdom implements
   * no scrolling at all.
   */
  useEffect(() => {
    const pill = chosenPillRef.current
    if (pill === null || typeof pill.scrollIntoView !== 'function') return
    pill.scrollIntoView({ block: 'nearest', inline: 'center' })
    // The option count as well as the chosen key: on the first paint the row
    // holds one pill, because `/api/records` has not landed and the only
    // distance known is the URL's own. Scrolling then and never again left
    // the row parked on `400 m` with `5 km` several screens to the right.
  }, [distanceKey, options.length])

  const record = recordsQuery.data?.items.find((item) => item.distance_key === distanceKey)

  const body = (() => {
    if (progressionQuery.isPending) return <p className={styles.status}>Loading the progression…</p>
    if (progressionQuery.isError) {
      if (isNotFoundError(progressionQuery.error)) {
        return (
          <Absent
            label={`No efforts at ${distanceKeyLabel(distanceKey)}`}
            reason={describeApiError(progressionQuery.error)}
          />
        )
      }
      return (
        <p role="alert" className={styles.status}>
          Could not load the progression: {describeApiError(progressionQuery.error)}
        </p>
      )
    }
    const data = progressionQuery.data
    return (
      <>
        {/*
         * The personal best, as the one number this screen exists to show.
         *
         * **It is the screen's headline, not a stat in a row.** The first
         * version set it at `--text-stat` under a `5 km` heading, and a
         * blind critic put it plainly: the largest thing on the page was
         * the word "Progression", the record sat one pixel above a heading
         * that only repeated the selected chip, and four of the six type
         * sizes in play were within two pixels of each other. So the
         * heading is gone - the chosen pill 39 px above it already says
         * `5 km`, and a heading set smaller than its own content is not a
         * heading - and the value is at `--text-title`, which is the top of
         * the scale.
         *
         * There is no `<h2>` in its place, for the reason
         * `views/Overview.tsx` gives for putting its stat rail directly
         * under the title: the screen's own name plus the label on the
         * value already say what this is, and a heading would name it a
         * third time. The label is the reference's uppercase band - every
         * group on `stats-totals-and-best-efforts.jpg` is introduced by
         * one - which is also what the picker above it uses, so the two
         * blocks are introduced the same way.
         *
         * Pace, heart rate and the date drop to one dim line under the
         * value, led by the exact distance in kilometres for a key whose
         * label does not state it - `Best 1 mile`, `Best Half marathon` -
         * by the same test the records ladder uses. They qualify the record
         * rather than standing beside it, and at `--text-stat` they
         * collided with the `<h2>` below: 18 px
         * against 17 is the same one-pixel tier the critic named.
         *
         * Every number here comes from `/api/records`, which the picker
         * already needs, rather than from the points below: the frontend
         * does not get to decide which effort is the best, and picking the
         * last `is_record` out of the items would be exactly that decision.
         * The pace is the one piece of arithmetic, and it is presentation
         * rather than a metric - no pace is stored anywhere, and
         * `format.pace` is where the reciprocal is taken, the same line
         * `views/Records.tsx` and the chart's readout both have.
         *
         * The block is skipped rather than filled with no-value glyphs when
         * `/api/records` has not landed or has failed, because its absence
         * is a fact about that request and not about this distance - the
         * failure already speaks for itself in the alert above.
         */}
        {record !== undefined && (
          <dl className={styles.best}>
            <dt className={styles.bestLabel}>Best {distanceKeyLabel(data.distance_key)}</dt>
            <dd className={styles.bestValue}>{duration(record.elapsed_time_s)}</dd>
            <dd className={styles.bestDetail}>
              {!distanceKeyStatesTheDistance(data.distance_key) && (
                <span className={styles.bestFigure}>{distance(data.distance_m)}</span>
              )}
              <span>
                Pace <span className={styles.bestFigure}>{pace(record.distance_m / record.elapsed_time_s)}</span>
              </span>
              <span>
                Heart rate <span className={styles.bestFigure}>{heartRate(record.avg_hr_bpm)}</span>
              </span>
              <span className={styles.bestFigure}>
                {shortLocalDate(record.start_time_utc, record.utc_offset_s)}
              </span>
            </dd>
          </dl>
        )}

        <Section
          title="Every effort"
          /*
           * The reference's own caption slot - "De senaste 12 veckorna"
           * over its chart - carrying the two things a reader needs before
           * reading this one: which way is an improvement, and how much
           * data is on the panel. The direction comes first because it is
           * what makes the rest legible, and it is said again on the axis
           * itself, where a reader who skips captions will meet it.
           */
          note={`Faster is lower, so improvement descends. ${String(data.effort_count)} efforts, ${String(
            data.eligible_count,
          )} eligible, ${String(data.record_count)} ${data.record_count === 1 ? 'record' : 'records'}.`}
          divided
        >
          <ProgressionScatter
            points={data.items}
            distanceM={data.distance_m}
            showIneligible={showIneligible}
            ariaLabel={`${distanceKeyLabel(data.distance_key)} progression`}
          />
          <div className={styles.key}>
            {/* The swatches are the chart's own marks, drawn by the chart's
                own module, so the key cannot drift from the panel - which a
                CSS `border: 1px dashed` on a 10px circle already had, since
                no two engines break that into the same number of dashes. */}
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
            {/*
             * A plain checkbox rather than another pill. The pills above
             * mean "which distance", and a second row of them here would
             * have to be told apart from the first by its words alone; a
             * checkbox says what it is at a glance and needs no explaining.
             */}
            <label className={styles.toggle}>
              <input
                className={styles.toggleInput}
                type="checkbox"
                checked={showIneligible}
                onChange={(event) => setShowIneligible(event.target.checked)}
              />
              Show ineligible efforts
            </label>
          </div>
          {/*
           * The three facts a reader cannot get from looking at the chart,
           * behind a disclosure.
           *
           * **Nothing is deleted.** The eligibility explanation is
           * load-bearing - it is the only place the screen says why a
           * faster dot did not become a record - so it is folded, not cut,
           * the same way `components/AppShell.tsx` folds the staleness
           * message rather than shortening it.
           *
           * What forced the fold was weight, not length. Measured per
           * element as ink against the page's own ground, this paragraph
           * was the heaviest object on the screen at 1469k, ahead of the
           * word "Progression" at 771k and far ahead of the record at 226k;
           * caption plus paragraph came to more ink than all 225 data marks
           * in the chart. A footnote outweighing the data is the fault, and
           * a five-line block of dim prose is a footnote however carefully
           * it is written.
           *
           * The one sentence that has to be read *before* the chart -
           * which way is an improvement - is not in here. It is the
           * section's own note, above the panel, and on the axis itself.
           */}
          <details className={styles.footnote}>
            <summary className={styles.footnoteSummary}>What counts, and why</summary>
            <p className={styles.footnoteBody}>
              A record dot is an effort that was the best at the time it was run. An ineligible one - a
              treadmill run, or one across a jump in the recorded distance that the watch&apos;s measured
              speed does not confirm to within 1% - can never set a record, and never becomes the time a
              later effort has to beat. Best efforts are elapsed time and span their pauses.
              Hover a point for the run behind it.
            </p>
          </details>
        </Section>
      </>
    )
  })()

  return (
    <div className={styles.progression}>
      {/*
       * Title and picker are one block with a gap of their own, tighter
       * than the screen's block rhythm, the way `views/Overview.tsx` binds
       * its title to the stats it introduces.
       */}
      <header className={styles.head}>
        <h1>Progression</h1>
        {/*
         * A radio group drawn as the reference's filter chips: one of a set
         * is exactly what a distance is, and native radios give arrow-key
         * navigation, a group name and a checked state for free. A `select`
         * would too, but it is a control whose options a reader cannot see,
         * and the choice between eight distances is the first thing this
         * screen asks.
         */}
        <fieldset className={styles.picker}>
          <legend className={styles.pickerLabel}>Distance</legend>
          <div className={styles.pills}>
            {options.map((key) => (
              <label
                key={key}
                className={styles.pill}
                ref={key === distanceKey ? chosenPillRef : null}
              >
                <input
                  className={styles.pillInput}
                  type="radio"
                  name="progression-distance"
                  value={key}
                  checked={key === distanceKey}
                  onChange={onDistanceChange}
                />
                <span className={styles.pillBody}>{distanceKeyLabel(key)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {recordsQuery.isError && (
          <p role="alert" className={styles.status}>
            Could not list the distances: {describeApiError(recordsQuery.error)}
          </p>
        )}
      </header>

      {body}
    </div>
  )
}
