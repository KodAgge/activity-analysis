import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { describeApiError } from '../api/errors'
import { queries } from '../api/queries'
import type { components } from '../api/schema'
import { TrendChart, type TrendPointDatum, type TrendSeries } from '../charts/TrendChart'
import {
  MIN_TREND_RUNS,
  cadenceLevelTrend,
  cadenceSlopeTrend,
  runsWithCadenceSlope,
  decouplingAcrossSessions,
  decouplingLevels,
  estimatesAgainstDevice,
  heartRateEstimateAgainstVdot,
  heartRateRecordStart,
  heartRateStepAgainstGap,
  type AgainstDevice,
  type HeartRateRecordStart,
  type Side,
  type TrendFinding,
} from '../charts/trendsFindings'
import { Absent } from '../components/Absent'
import { Section } from '../components/Section'
import { Stat, StatGroup } from '../components/Stat'
import { DURABILITY_REFERENCE_PCT } from '../components/decouplingMath'
import {
  NO_VALUE,
  cadence,
  cadenceMeasure,
  calendarDayLabel,
  calendarDayOfDate,
  correlationLabel,
  distance,
  distanceKeyLabel,
  distanceKeyStatesTheDistance,
  duration,
  effortTagLabel,
  formatDecoupling,
  formatPredictionBand,
  formatPredictionSpan,
  formatVo2max,
  formatWholeVo2max,
  heartRate,
  heartRateMeasure,
  localCalendarDay,
  localCalendarTime,
  pace,
  percentLabel,
  raceModelLabel,
  runCount,
  slopeMeasure,
  trimmedNumber,
} from '../format'
import styles from './Trends.module.css'

type TrendPoint = components['schemas']['TrendPoint']
type FitnessPoint = components['schemas']['FitnessPoint']
type DeviceVo2maxPoint = components['schemas']['DeviceVo2maxPoint']
type Prediction = components['schemas']['Prediction']

/**
 * The classifier's effort tags in the order it ranks them, for the filter's
 * own ordering. The tag-to-word map is `format.effortTagLabel`, shared with
 * `components/Tag.tsx`; the tag set itself belongs to `analysis/tags.py`,
 * so an unknown tag passes through as itself rather than breaking the
 * filter.
 */
const EFFORT_ORDER = ['easy', 'steady', 'intervals', 'all_out'] as const

/**
 * `RaceModel.source` for the calibrated prediction from ordinary running,
 * which is the one model that carries its own band. Mirrors the literal
 * `api/models.py`'s own validator keys off; the field is a plain string on
 * both sides, so like `ALL_SPORTS` in `api/activitySearch.ts` it can only
 * be read from the Python source rather than pinned by a generated type.
 */
const ORDINARY_RUNS_SOURCE = 'ordinary_runs'

/** The filter's key for a run the classifier could not tag, most often one with no heart rate. */
const UNTAGGED = 'untagged'
const UNTAGGED_LABEL = 'Untagged'

function effortKey(point: TrendPoint): string {
  return point.effort_tag ?? UNTAGGED
}

function effortLabel(key: string): string {
  if (key === UNTAGGED) return UNTAGGED_LABEL
  return effortTagLabel(key)
}

/** The effort keys present in the payload, classifier order first, unknown tags after, untagged last. */
function effortKeysPresent(items: TrendPoint[]): string[] {
  const present = new Set(items.map(effortKey))
  const known = EFFORT_ORDER.filter((tag) => present.has(tag))
  const unknown = [...present].filter((key) => key !== UNTAGGED && !(EFFORT_ORDER as readonly string[]).includes(key)).sort()
  return [...known, ...unknown, ...(present.has(UNTAGGED) ? [UNTAGGED] : [])]
}

/**
 * The sequential ramp the three reference paces are drawn in, slow to fast.
 * They are ordinal, so they take a ramp rather than the categorical palette
 * - the same decision `theme/tokens.css` records for the heart rate zones,
 * and using the categorical set for an ordered trio was the mistake this
 * replaces.
 */
const PACE_RAMP: [string, string, string] = ['--pace-1', '--pace-2', '--pace-3']

/** One point per activity from one field, dated on the athlete's own calendar. */
function pointsFrom(items: TrendPoint[], field: keyof TrendPoint, withNote: boolean): TrendPointDatum[] {
  return items.map((point) => {
    const value = point[field]
    return {
      t: localCalendarTime(point.start_time_utc, point.utc_offset_s),
      v: typeof value === 'number' ? value : null,
      ...(withNote ? { note: effortLabel(effortKey(point)) } : {}),
    }
  })
}

/**
 * The three reference-pace series, drawn from the analysis layer's
 * *smoothed* columns, with the raw per-run values for the median reference
 * faintly behind them.
 *
 * **The raw series are not plottable as three lines and no presentation
 * change makes them so.** On the history this was developed against, the
 * median difference between one run and the next at the median reference
 * is several times the median difference between the fast and slow series
 * on the same run, which is why the three lines read as one band. On the
 * stored trailing 42-day window the gap holds while the run-to-run step
 * shrinks, so the gap ends up larger than the noise rather than a fraction
 * of it. `docs/reference/math/efficiency.md` owns the figures behind these
 * ratios, read from its smoothed-series table, and the page's own copy
 * states the viewer's step against the gap through
 * `charts/trendsFindings.ts`.
 *
 * The smoothing is a stored column and never computed here: this view may
 * not recompute a metric the analysis layer owns, and a smoothed series is
 * named as exactly such a metric.
 *
 * One raw scatter, for the median reference only. Smoothing must not hide
 * its own inputs - the rule the VO2max chart already follows - but three
 * scatters behind three lines rebuilds the band this exists to remove.
 *
 * **Two populations, and the split is the whole point of the effort
 * filter.** The lines are drawn over `all`, the scatter over `filtered`.
 * Each smoothed value is a trailing 42-day mean ending at its own run, so
 * dropping a run does not filter the mean series, it deletes a sample of
 * it: `alignSeries` takes x from the union of the series it is given, the
 * dropped dates leave the axis, and uPlot draws a straight chord across a
 * stretch of consecutive runs the reader unticked. The line at those dates
 * would then no longer be the value the analysis layer computed. That is
 * the same argument that put decoupling and VO2max outside the filter, and
 * it holds here for the same reason.
 *
 * What the filter is *for* survives the split intact. It exists because the
 * fit includes `all_out` sessions sitting several bpm higher at the same
 * speed and a reader must be able to see which points are which and take
 * them out - and those are per-run points, which is exactly the scatter.
 *
 * The two lists give the two kinds of series different x positions, which
 * `alignSeries` supports: at an instant the scatter no longer carries, its
 * y is undefined, `TrendChart` pins its cursor dot to that instant, and the
 * hover readout shows the no-value glyph there rather than a neighbour's
 * value. The effort tag in the readout comes from the
 * lines, so it still names the run at that date whether or not its point
 * is currently shown.
 */
function paceSeries(
  all: TrendPoint[],
  filtered: TrendPoint[],
  labels: [string, string, string],
  smoothed: [keyof TrendPoint, keyof TrendPoint, keyof TrendPoint],
  raw: keyof TrendPoint,
): TrendSeries[] {
  const lines = labels.map((label, i) => {
    const field = smoothed[i]
    if (field === undefined) throw new Error('unreachable: three labels, three fields')
    // The median line carries the latest-observation marker, because the
    // stat above the chart names that exact value. The other two have no
    // stat of their own, and three haloed dots would compete with each
    // other rather than tie one number to one point.
    return {
      label,
      colorVar: PACE_RAMP[i],
      // The outer two bound an envelope around the middle one rather than
      // being three curves to read apart. They are ordered at essentially
      // every instant, which `docs/reference/frontend.md` measures, so the
      // band contains the median by construction, and the fill is
      // between two stored columns rather than anything computed here. See
      // `TrendSeries.edge`.
      edge: i !== 1,
      markLatest: i === 1,
      points: pointsFrom(all, field, true),
    }
  })
  return [
    ...lines,
    {
      label: `${labels[1]}, per run`,
      scatter: true,
      // The quieter of the two scatter tones: these points sit *beneath*
      // the line they feed rather than being the chart's own subject.
      faint: true,
      colorVar: PACE_RAMP[1],
      points: pointsFrom(filtered, raw, false),
    },
  ]
}

// Hoisted rather than written inline at the chart, because `TrendChart`
// carries `referenceLine` in its `options` memo and `options` identity is
// the chart's recreation key (see UPlot.tsx). A fresh literal per render
// would destroy and rebuild the chart on any re-render - a focus refetch is
// enough - and take the reader's zoom with it.
const DURABILITY_REFERENCE_LINE = { value: DURABILITY_REFERENCE_PCT, label: '5% durability' }

/**
 * Aerobic decoupling over the runs it means something on, smoothed.
 *
 * **The population is the point.** Read across every session with a value,
 * decoupling does not separate by session type - `efficiency.md`'s
 * decoupling table has the all-out and easy medians about a point apart -
 * so it measures the shape of the session rather than the athlete,
 * which is what made the old chart say nothing. Restricted to easy or
 * steady runs of 40 fitted minutes or more it is the conventional measure
 * of durability. The page's own copy states the viewer's medians through
 * `charts/trendsFindings.ts`.
 * `analysis/efficiency.py` owns the rule and `is_aerobic_long_run` carries
 * it; this view never re-decides it.
 *
 * **Only the population is plotted, and that is not gap-filling.**
 * `decoupling_smoothed_pct` is a trailing 90-day mean over that population,
 * so it is a property of the window ending at each qualifying run rather
 * than of every fitted activity: at a non-qualifying run the quantity is
 * undefined, not missing, which is why the analysis layer masks the output
 * as well as the input. Passing every fitted run through, with a null at
 * each one outside the population, would draw isolated dots and no line at
 * all, since `TrendChart` breaks at every null and never spans a gap - and
 * it would
 * make this the one place in the application where a null meaning "not
 * applicable" renders exactly like one meaning "not recorded".
 */
function decouplingSeriesFrom(items: TrendPoint[]): TrendSeries[] {
  const population = items.filter((point) => typeof point.decoupling_smoothed_pct === 'number')
  return [
    {
      label: 'Decoupling, 90-day mean',
      markLatest: true,
      points: pointsFrom(population, 'decoupling_smoothed_pct', true),
    },
  ]
}

/**
 * The two smoothed VO2max series and the raw heart-rate points beneath the
 * first.
 *
 * `FitnessPoint` carries no `utc_offset_s` of its own, unlike `TrendPoint`
 * and `ProgressionPoint`, so the offset is joined in by activity id from
 * the `/api/trends` payload. Without that join the same run is dated by its
 * UTC instant here and by its local wall clock on every other chart on the
 * page: a run at 00:30 local on 2 October is 22:30Z on the 1st, so the two
 * readouts named different days and the two points sat a day apart on a
 * shared axis. An activity the trends payload does not carry keeps the UTC
 * fallback, the same one `localWallClock` makes, rather than assuming home.
 *
 * `device` is Garmin's own VO2max by calendar day, drawn as a fourth series
 * when a Garmin export has been ingested. It is a reference beside the two
 * estimates rather than a third one, and a day carries no instant, so each
 * point sits at the start of its day on the same day-number axis.
 *
 * Every line here holds its last value for the readout, so hovering one of
 * Garmin's days reads both 42-day means as of that instant rather than as
 * missing; only the raw per-run points read at their own runs alone.
 */
function fitnessSeries(
  items: FitnessPoint[],
  offsets: ReadonlyMap<string, number | null>,
  device: readonly DeviceVo2maxPoint[],
): TrendSeries[] {
  const t = (point: FitnessPoint) =>
    localCalendarTime(point.start_time_utc, offsets.get(point.activity_id) ?? null)
  return [
    {
      label: 'Heart rate based, 42-day mean',
      markLatest: true,
      holdsLastForReadout: true,
      points: items.map((p) => ({ t: t(p), v: p.hr_vo2max_smoothed })),
    },
    {
      label: 'Performance based (VDOT), 42-day mean',
      markLatest: true,
      holdsLastForReadout: true,
      points: items.map((p) => ({ t: t(p), v: p.vdot_smoothed })),
    },
    {
      label: 'Heart rate based, per run',
      scatter: true,
      faint: true,
      paletteSlot: 1,
      points: items.map((p) => ({ t: t(p), v: p.hr_vo2max })),
    },
    // Garmin's own number, a reference beside the two estimates rather than
    // a third one; `docs/reference/math/vo2max.md`, "Against Garmin's own".
    // Slot 3 explicitly: by position it would default to slot 4.
    ...(device.length > 0
      ? [
          {
            label: 'Garmin (watch)',
            markLatest: true,
            // The watch's VO2max on any day is its last update, so hovering a
            // run reads Garmin's value as of that day beside the estimates.
            holdsLastForReadout: true,
            paletteSlot: 3 as const,
            points: device.map((d) => ({ t: calendarDayOfDate(d.calendar_date), v: d.vo2max })),
          },
        ]
      : []),
  ]
}

/** The units the two shared slopes are stated in. */
const SLOPE_UNIT = 'spm per m/s'
const HR_SLOPE_UNIT = 'bpm per m/s'

/**
 * The decoupling ladder. The default rung would set `20 %` from the axis
 * unit, where `format.formatDecoupling` - the same page's own reading of
 * the same quantity - sets `+13.1%` closed up. One quantity, one typography.
 * Unsigned and whole, because a tick is a level on a scale rather than a
 * reading, and `+0.0%` on the zero rung reads as a measurement that is not
 * there.
 *
 * Hoisted, like every other formatter handed to a chart: `formatTick` is an
 * input to `TrendChart`'s options memo and that memo's identity is the
 * chart's recreation key (see `UPlot.tsx`).
 */
const formatDecouplingTick = (value: number): string => `${String(Math.round(value))}%`

/**
 * The most recent item that carries a value in `field`, or undefined.
 *
 * **Selection, not computation.** Every headline number on this screen is
 * one stored column of one stored row, chosen by date; nothing here
 * averages, differences or extrapolates anything, which is the rule
 * `docs/reference/frontend.md` states as "the view converts units, dates
 * each point and filters, and computes nothing". A "change since last year"
 * would be arithmetic over two stored values and is exactly what this must
 * not become.
 *
 * Ordered by the UTC instant rather than by position in the array, because
 * nothing in the payload's contract promises an order, and by the instant
 * rather than by the local calendar day because "most recent" is a fact
 * about when the run happened, not about whose midnight it fell before.
 */
function latestWith<T extends { start_time_utc: string }>(
  items: readonly T[],
  field: (item: T) => number | null | undefined,
): T | undefined {
  let best: T | undefined
  for (const item of items) {
    const value = field(item)
    if (value === null || value === undefined || !Number.isFinite(value)) continue
    if (best === undefined || item.start_time_utc > best.start_time_utc) best = item
  }
  return best
}

/** The day a point sits on, written out, for the caption that dates a headline number. */
function dayOf(point: { start_time_utc: string; utc_offset_s?: number | null }): string {
  return calendarDayLabel(localCalendarDay(point.start_time_utc, point.utc_offset_s ?? null))
}

/** One stored column of one stored row, as a number or null. Never a zero for an absence. */
function valueAt(point: TrendPoint | undefined, field: keyof TrendPoint): number | null {
  if (point === undefined) return null
  const raw = point[field]
  return typeof raw === 'number' ? raw : null
}

/**
 * The disclosure that holds a section's full explanation.
 *
 * The screen keeps one visible caption per section, the way the reference
 * runs a single `Past 12 weeks` over its chart, and folds the rest behind
 * this. It is the same affordance `components/AppShell.tsx` uses for the
 * staleness strip - marker off, summary at caption size in dim ink, with an
 * underline carrying the affordance rather than a colour - so a reader who
 * has met one has met both.
 *
 * **What may not go in here.** The VO2max caveat, the prediction range's
 * caveat, the decoupling population, the cadence slope's finding and the
 * effort filter's stated scope are required
 * rather than decorative: each is what makes the number beside it honest,
 * and a reader who never opens a disclosure must still meet all of them.
 * They stay in the open. What folds is the teaching - what the quantity is,
 * how it is fitted, what a reader should take from it.
 */
function About({ children }: { children: ReactNode }) {
  return (
    <details className={styles.about}>
      <summary className={styles.aboutSummary}>What this measures</summary>
      <div className={styles.aboutBody}>{children}</div>
    </details>
  )
}

/*
 * The copy below states figures about the viewer's own history, computed by
 * `charts/trendsFindings.ts` from the payloads this page already holds. Each
 * sentence carrying one is rendered only when that module says the data
 * supports it, and is dropped, or falls back to a sentence with no figure,
 * when it does not. No figure measured on any one store belongs in this
 * file: the copy is read by every runner whose history this page draws.
 */

/** `61.6% above VDOT`, `level with VDOT`: an offset from a reference, unsigned, with its side in words. */
function offsetFrom(offsetPct: number, side: Side, reference: string): string {
  if (side === 'at') return `level with ${reference}`
  return `${percentLabel(Math.abs(offsetPct))} ${side} ${reference}`
}

/** Where a value sits against a line, as the preposition the decoupling copy uses. */
const ON_THE_LINE: Record<Side, string> = { above: 'above', below: 'below', at: 'on' }

/** What a trend over the history does, in words that never call either direction an improvement. */
const TREND_WORDS: Record<Exclude<TrendFinding['direction'], 'constant'>, string> = {
  rises: 'rises over this history',
  falls: 'falls over this history',
  flat: 'does not trend',
}

/**
 * Why the heart rate chart begins after the history does, with the viewer's
 * own counts. Rendered only when some runs before the first with heart rate
 * have none, which is when the chart's first ink falls after the cadence
 * chart's.
 */
function HeartRateStartNote({ start }: { start: HeartRateRecordStart }) {
  const { fitted, withoutHeartRate, beforeFirst, withCadence } = start
  const counted =
    withoutHeartRate === 1
      ? `1 of the ${trimmedNumber(fitted)} runs the fit covers carries no heart rate at all`
      : `${trimmedNumber(withoutHeartRate)} of the ${trimmedNumber(fitted)} runs the fit covers carry no heart rate at all`
  const placed =
    beforeFirst === withoutHeartRate
      ? withoutHeartRate === 1
        ? 'it is the oldest'
        : `they are the oldest ${trimmedNumber(beforeFirst)}`
      : beforeFirst === 1
        ? 'the oldest of them comes before the first that does'
        : `the oldest ${trimmedNumber(beforeFirst)} of them come before the first that does`
  return (
    <p>
      The heart rate record starts later than the history does: {counted}, and {placed}, so this chart
      begins where the recording does rather than where the training does.
      {withCadence === fitted &&
        ` The cadence chart below it covers all ${trimmedNumber(fitted)} and so runs the full span.`}
    </p>
  )
}

/**
 * The two estimates against Garmin's own over the runs that pair with one of
 * its days, as a sentence that follows the paragraph's opening; nothing when
 * neither estimate has enough pairs.
 */
function GarminComparison({ against }: { against: AgainstDevice }) {
  const { heartRate, vdot } = against
  const clauses = [
    ...(heartRate === null
      ? []
      : [
          `the smoothed heart rate estimate sits ${offsetFrom(heartRate.meanOffsetPct, heartRate.side, 'it')} on average over ${runCount(heartRate.pairs)}` +
            (heartRate.correlation === null ? '' : ` and the two correlate at ${correlationLabel(heartRate.correlation)}`),
        ]),
    ...(vdot === null ? [] : [`VDOT sits ${offsetFrom(vdot.meanOffsetPct, vdot.side, 'it')} over ${runCount(vdot.pairs)}`]),
  ]
  if (clauses.length === 0) return null
  return <> Paired with Garmin&apos;s value for each run&apos;s day, or the latest day before it, {clauses.join('; ')}.</>
}

/** The cadence slope section's finding: its trend against its own standard error, or why there is none yet. */
function slopeFinding(trend: TrendFinding | null, withSlope: number): ReactNode {
  if (trend === null) {
    return (
      <>
        Whether this slope trends needs at least {trimmedNumber(MIN_TREND_RUNS)} runs with a fitted slope, and{' '}
        {runCount(withSlope)} {withSlope === 1 ? 'carries' : 'carry'} one so far.
      </>
    )
  }
  if (trend.direction === 'constant') {
    return (
      <>
        Every one of the {runCount(trend.runs)} that carry it takes the shared slope exactly, because their own slopes
        spread no further than their errors explain: it does not trend on this history.
      </>
    )
  }
  const measured = (
    <>
      Measured over the {runCount(trend.runs)} that carry it, the trend in this shrunk slope is{' '}
      <strong>{trimmedNumber(trend.standardErrors)} times its own standard error</strong>
    </>
  )
  if (trend.direction === 'flat') {
    return <>{measured}, which is not distinguishable from zero: it does not trend on this history.</>
  }
  return (
    <>
      {measured}: it {TREND_WORDS[trend.direction]}.
    </>
  )
}

const TRENDS_ABSENT_REASON =
  'No efficiency fit has been computed yet. A run appears here once it has heart rate, a ' +
  'known maximum heart rate for its date and enough steady running to fit a slope; run ' +
  'recompute after ingesting.'
const FITNESS_ABSENT_REASON =
  'No VO2max estimate has been computed yet. The heart rate estimate needs at least ten ' +
  'minutes at 70% of maximum heart rate or above, and VDOT needs an eligible best effort.'

/**
 * The trend analysis: what heart rate and cadence would have been at three
 * fixed reference paces, per run over the whole history, so that a change in
 * fitness is separable from how fast the athlete happened to run that day.
 * Plotting raw average heart rate over time is what the incumbents already
 * do, and it mostly measures pace.
 *
 * Nothing here decides a value. Every number plotted or headlined on this
 * page is a stored column from `activity_efficiency` or `fitness_series`,
 * fitted and smoothed by the analysis layer (see
 * `docs/reference/math/efficiency.md` and `vo2max.md`); the view converts
 * SI to display units, dates each point on the athlete's own calendar day,
 * and filters by the effort tag the classifier gave the run. The figures
 * the explanatory prose states are summaries of those same columns for one
 * sentence each, computed by `charts/trendsFindings.ts` over the viewer's
 * own history, and none of them is plotted. The reference paces themselves are read
 * from the payload, because they are whole-history quantities that drift
 * slightly as history grows, and a label pinned here would go stale.
 *
 * The effort filter exists because the heart rate fit includes `all_out`
 * sessions, which sit several bpm higher at the same speed than an easy
 * run does; a reader must be able to see which points are which, and to
 * take them out, before reading a trend off the chart.
 */
export function Trends() {
  const trendsQuery = useQuery(queries.trends())
  const fitnessQuery = useQuery(queries.fitness())
  const predictionsQuery = useQuery(queries.predictions())
  // Every tag present is shown until the reader unticks it. The set is
  // kept as the *hidden* keys so a tag that appears later is shown by
  // default rather than needing to be known here in advance.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())

  // A link into one section, `/trends#decoupling` from the activity page,
  // lands on it only once every chart above it has data. The router tries
  // the hash on navigation, while the three queries are still pending, and
  // the charts that load afterwards push the section out of view. So the
  // view scrolls once, after all three settle, and never again: a later
  // refetch must not yank the reader back.
  const scrolledToHash = useRef(false)
  const settled = !trendsQuery.isPending && !fitnessQuery.isPending && !predictionsQuery.isPending
  useEffect(() => {
    if (!settled || scrolledToHash.current) return
    scrolledToHash.current = true
    const id = window.location.hash.slice(1)
    if (id === '') return
    document.getElementById(id)?.scrollIntoView()
  }, [settled])

  // Memoised on the response, not read with a `?? []` fallback inline: a fresh
  // empty array every render would rebuild every chart's options below.
  const allItems = useMemo(() => trendsQuery.data?.items ?? [], [trendsQuery.data])
  const effortKeys = useMemo(() => effortKeysPresent(allItems), [allItems])
  const items = useMemo(() => allItems.filter((point) => !hidden.has(effortKey(point))), [allItems, hidden])

  const references = trendsQuery.data?.references
  const paceLabels = useMemo<[string, string, string]>(
    () => [pace(references?.slow_mps ?? null), pace(references?.median_mps ?? null), pace(references?.fast_mps ?? null)],
    [references],
  )

  const hrSeries = useMemo(
    () =>
      paceSeries(
        allItems,
        items,
        paceLabels,
        ['hr_at_slow_smoothed_bpm', 'hr_at_median_smoothed_bpm', 'hr_at_fast_smoothed_bpm'],
        'hr_at_median_bpm',
      ),
    [allItems, items, paceLabels],
  )
  const cadenceSeries = useMemo(
    () =>
      paceSeries(
        allItems,
        items,
        paceLabels,
        [
          'cadence_at_slow_smoothed_spm',
          'cadence_at_median_smoothed_spm',
          'cadence_at_fast_smoothed_spm',
        ],
        'cadence_at_median_spm',
      ),
    [allItems, items, paceLabels],
  )
  // Built from the population alone rather than from every run with a null
  // between - see `decouplingSeriesFrom` for why that is not gap-filling -
  // and from the *unfiltered* items, for the same reason the VO2max chart
  // is outside the effort filter. Every point on this chart is a 90-day
  // mean over a population, and dropping members of that population does
  // not filter the mean, it recomputes it through fewer runs and redraws a
  // different line. Unticking a tag would silently change what the line
  // says rather than change which runs it shows.
  const decouplingSeries = useMemo(() => decouplingSeriesFrom(allItems), [allItems])
  // Keyed on the *unfiltered* items: the VO2max chart is not effort-filtered
  // (its own series are already smoothed over a calendar window), so the
  // join must not lose an offset because its run is hidden from the trends.
  const offsets = useMemo(
    () => new Map(allItems.map((point) => [point.activity_id, point.utc_offset_s])),
    [allItems],
  )
  const vo2maxSeries = useMemo(
    () => fitnessSeries(fitnessQuery.data?.items ?? [], offsets, fitnessQuery.data?.device ?? []),
    [fitnessQuery.data, offsets],
  )

  // The figures the explanatory copy states, over the viewer's own history:
  // see `charts/trendsFindings.ts`. All of them read the unfiltered items,
  // because the copy describes the history rather than the reader's
  // current selection of points.
  const findings = useMemo(() => {
    const fitness = fitnessQuery.data?.items ?? []
    const device = fitnessQuery.data?.device ?? []
    return {
      heartRateStart: heartRateRecordStart(allItems),
      stepAgainstGap: heartRateStepAgainstGap(allItems),
      againstVdot: heartRateEstimateAgainstVdot(fitness),
      againstDevice: estimatesAgainstDevice(fitness, offsets, device),
      decoupling: decouplingLevels(allItems, DURABILITY_REFERENCE_PCT),
      sessions: decouplingAcrossSessions(allItems),
      slopeTrend: cadenceSlopeTrend(allItems),
      levelTrend: cadenceLevelTrend(allItems),
    }
  }, [allItems, fitnessQuery.data, offsets])

  function toggle(key: string) {
    setHidden((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // The trends payload's own state, resolved once. Every per-run chart and
  // the effort filter share it, so resolving it here is what lets the
  // render below be an ordered list of sections rather than an artefact of
  // where each guard happened to sit.
  const trendsNotice = (() => {
    if (trendsQuery.isPending) return <p className={styles.status}>Loading the trends…</p>
    if (trendsQuery.isError) {
      return (
        <p className={styles.status} role="alert">
          Could not load the trends: {describeApiError(trendsQuery.error)}
        </p>
      )
    }
    if (allItems.length === 0) return <Absent label="No trends yet" reason={TRENDS_ABSENT_REASON} />
    return null
  })()

  /*
   * The effort filter, as the reference draws a filter: a row of pill chips
   * on the page gutter with no container of its own, an uppercase band
   * naming the group above them, and a marked chip carrying the accent in
   * its border and its text rather than a solid fill.
   *
   * **It stays a fieldset of real checkboxes.** The chip is the `<label>`
   * and the input is clipped rather than removed, so the group keeps its
   * accessible name from the `<legend>`, every option keeps its own, and
   * the whole thing is still operable from the keyboard - which a row of
   * `<button>`s pretending to be checkboxes would not be.
   *
   * **Every included chip is marked, in every state, and that is a reversal
   * measured against three rounds of the opposite.** The reference's chip
   * row is one-of-N, so its selected chip is read against unselected
   * neighbours and it can afford to mark nothing else; an exclusion filter
   * starts with everything in, so in its resting state there is no
   * neighbour to read against. The answer tried twice was to mark the chips
   * harder, and once to mark nothing and state the group's condition in
   * words. All three were read the same way by a blind critic: "four
   * identical outline pills with no selected/unselected marking anywhere on
   * the control", three rounds running.
   *
   * So an included chip is filled and an excluded one is an outline, and
   * the words went with the marks that replaced them.
   *
   * **The marking is neutral, and that is the correction after it.** Round 2
   * marked the included chips in the accent over an 8% accent tint, which
   * is `views/Progression.tsx`'s chosen-pill treatment and this
   * application's marked-chip language. Measured as mean CIELAB chroma over
   * each block's own box, that made the chip row **9.54 against 3.67 for
   * the plot it filters** - the control 2.6 times more saturated than the
   * data it is furniture for, and the loudest thing in a section named
   * after that data. The state is carried on the border instead, a
   * neutral outline on an excluded chip over a fill both states share. See
   * `.chipFace` in
   * `Trends.module.css` for why the fill is lighter than the page rather
   * than darker, which is what keeps this from undoing round 2's own ink
   * measurement.
   */
  const effortFilter = (
    <fieldset className={styles.filter}>
      <legend className={styles.filterLegend}>Effort</legend>
      <div className={styles.chips}>
        {effortKeys.map((key) => (
          <label key={key} className={styles.chip}>
            <input
              className={styles.chipInput}
              type="checkbox"
              name={key}
              checked={!hidden.has(key)}
              onChange={() => toggle(key)}
            />
            <span className={styles.chipFace}>
              {effortLabel(key)}
            </span>
          </label>
        ))}
      </div>
      {/*
       * The scope, one click away.
       *
       * It used to be five full-measure lines of body copy standing above
       * the section title. Measured on the round-1 capture, the filter
       * block carried 5867k of ink against the chart's 5313k and the
       * paragraph alone 4220k - 79% of the whole chart and 2.8 times the
       * stat block it pushed down the page - so the apparatus outweighed
       * the content it introduced. Every word of it survives; it is one
       * click away instead of ahead of the heading.
       *
       * The summary used to carry the group's state in words as well -
       * `All 4 efforts shown`. That was the right answer while the chips
       * said nothing, and it is redundant now that a filled chip says
       * "included" on its own, so it is gone: a control that states in a
       * sentence what its own marks already say asks to be read twice.
       */}
      <details className={styles.filterAbout}>
        <summary className={styles.filterSummary}>What this changes</summary>
        <p className={styles.filterNote}>
          Filters the per-run points on the heart rate and cadence charts. The lines through them are
          trailing means over the whole history, so their values do not change, and the aerobic decoupling
          and VO2max charts are outside the filter entirely. The axis rescales as points come and go, which
          spreads the lines further apart once the fastest sessions are out.
        </p>
      </details>
    </fieldset>
  )

  /*
   * The headline for a reference-pace chart: the latest stored value of the
   * *median* line, which is the one the marker on the chart picks out.
   *
   * One number rather than three. The gap between the fast and slow
   * smoothed series on one run is a small fraction of the heart rate itself -
   * `docs/reference/math/efficiency.md` owns its measured size - so the three
   * whole-bpm readings sit close together and can coincide, and a row
   * reading `150 bpm  150 bpm  151 bpm` under three different labels reads
   * as broken software whatever the truth behind it. The other two paces
   * are named in the chart's own key, where they label lines rather than
   * claim to be different readings.
   *
   * It is selection, not computation: `latestWith` picks the most recent
   * row carrying that stored column and nothing here averages or
   * differences anything.
   */
  const latestHr = latestWith(allItems, (point) => point.hr_at_median_smoothed_bpm)
  const latestCadence = latestWith(allItems, (point) => point.cadence_at_median_smoothed_spm)
  const latestDecoupling = latestWith(allItems, (point) => point.decoupling_smoothed_pct)

  const perRunChartsTop = (
      <>
        <Section
          title="Heart rate at the reference paces"
          note="Trailing 42-day means, at three paces the athlete actually runs"
          divided
        >
          <StatGroup>
            <Stat
              label={`42-day mean at ${paceLabels[1]}`}
              share="full"
              value={heartRateMeasure(valueAt(latestHr, 'hr_at_median_smoothed_bpm'))}
              detail={latestHr === undefined ? 'no run has a heart rate fit yet' : `through ${dayOf(latestHr)}`}
            />
          </StatGroup>
          {/* The control sits under the title and the number it refines
              rather than above the heading, and between the two charts
              whose per-run points it scopes and the reading it changes.
              Its own note names both charts, which is what keeps "it is in
              the heart rate section" from being read as "it only drives
              this one". */}
          {effortFilter}
          <TrendChart
            series={hrSeries}
            yLabel="bpm"
            formatValue={heartRate}
            emptyReason="No run has a heart rate fit yet."
            ariaLabel="Heart rate at the reference paces"
          />
          <About>
            {/* The step against the gap is the viewer's own, measured the
                way `docs/reference/math/efficiency.md`'s smoothed-series
                table measures it; the clause is dropped when the raw step is
                not larger than the gap, where the raw lines would not cross. */}
            <p>
              What each run&apos;s heart rate would have been at three paces the athlete actually runs,
              from the run&apos;s own fitted heart rate against speed. The three lines are trailing 42-day
              means of that, with the median reference&apos;s own per-run values faintly beneath them
              {findings.stepAgainstGap === null
                ? '.'
                : `: run to run the quantity moves about ${trimmedNumber(findings.stepAgainstGap.ratio)} times further than the three paces are apart, so the raw lines would cross each other and say nothing.`}{' '}
              Lower over time at the same pace is the aerobic fitness signal this page exists for; the three
              paces are the 25th, 50th and 75th percentile of the history&apos;s per-run median speed.
            </p>
            {/* When the heart rate record starts after the history does, the
                chart starts later than the cadence chart below it, and a
                reader is owed the reason rather than left to read the gap as
                a fault. The axis is trimmed to the first instant any series
                has a value at (`alignSeries`), which removes no drawn value
                by construction, so the plot itself does not open on blank
                ground; this note says why it opens where it does. */}
            {findings.heartRateStart !== null && <HeartRateStartNote start={findings.heartRateStart} />}
          </About>
        </Section>

        <Section title="Cadence at the reference paces" note="The same fit, read on its other channel" divided>
          <StatGroup>
            <Stat
              label={`42-day mean at ${paceLabels[1]}`}
              share="full"
              value={cadenceMeasure(valueAt(latestCadence, 'cadence_at_median_smoothed_spm'))}
              detail={
                latestCadence === undefined ? 'no run has a cadence fit yet' : `through ${dayOf(latestCadence)}`
              }
            />
          </StatGroup>
          <TrendChart
            series={cadenceSeries}
            yLabel="spm"
            formatValue={cadence}
            emptyReason="No run has a cadence fit yet."
            ariaLabel="Cadence at the reference paces"
          />
          <About>
            <p>
              Steps per minute at each of the three reference paces, from the same fit the heart rate
              chart above reads on its other channel, and smoothed the same way. Cadence moves with
              fatigue, with terrain and with shoes as well as with fitness, so it is read here as a
              description of how the athlete runs rather than of how fit they are.
            </p>
          </About>
        </Section>
      </>
  )

  const fitnessItems = fitnessQuery.data?.items ?? []
  const latestVo2max = latestWith(fitnessItems, (point) => point.hr_vo2max_smoothed)
  const latestVdot = latestWith(fitnessItems, (point) => point.vdot_smoothed)
  // Oldest first, so the last day is Garmin's latest.
  const latestDevice = fitnessQuery.data?.device.at(-1)
  // Garmin's note and comparison only beside a drawn chart: with no estimate
  // the section shows its absent state, whatever `device` holds.
  const showsDevice = latestDevice !== undefined && fitnessItems.length > 0

  const fitnessBody = (() => {
    if (fitnessQuery.isPending) return <p className={styles.status}>Loading the VO2max series…</p>
    if (fitnessQuery.isError) {
      return (
        <p className={styles.status} role="alert">
          Could not load the VO2max series: {describeApiError(fitnessQuery.error)}
        </p>
      )
    }
    if ((fitnessQuery.data.items.length ?? 0) === 0) {
      return <Absent label="No VO2max yet" reason={FITNESS_ABSENT_REASON} />
    }
    return (
      <>
        <StatGroup>
          {/* A half each, or a third each once Garmin's own number joins them. */}
          <Stat
            label="Heart rate based"
            share={latestDevice === undefined ? 'half' : undefined}
            value={formatVo2max(latestVo2max?.hr_vo2max_smoothed)}
            detail="42-day mean"
          />
          <Stat
            label="Performance based (VDOT)"
            share={latestDevice === undefined ? 'half' : undefined}
            value={formatVo2max(latestVdot?.vdot_smoothed)}
            detail="42-day mean"
          />
          {latestDevice !== undefined && (
            <Stat
              label="Garmin"
              value={formatWholeVo2max(latestDevice.vo2max_reported)}
              detail="as the watch shows it"
            />
          )}
        </StatGroup>
        <TrendChart
          series={vo2maxSeries}
          yLabel="VO2max"
          formatValue={formatVo2max}
          formatTick={formatVo2max}
          emptyReason={FITNESS_ABSENT_REASON}
          ariaLabel="VO2max"
          // Two smoothed series that can sit far apart, with the raw points
          // beneath them, need the vertical room, or the three read as one
          // band rather than as a trend.
          height="tall"
        />
      </>
    )
  })()

  const predictionsBody = (() => {
    if (predictionsQuery.isPending) return <p className={styles.status}>Loading the predictions…</p>
    if (predictionsQuery.isError) {
      return (
        <p className={styles.status} role="alert">
          Could not load the predictions: {describeApiError(predictionsQuery.error)}
        </p>
      )
    }
    const data = predictionsQuery.data
    // Only an empty `items` is an absence. `insufficient_data` is set
    // whenever either source could not produce a model
    // (`docs/reference/api.md`), so a window with best efforts but no
    // heart-rate estimate still has every best-effort prediction. Rendering
    // `Absent` on it would throw away predictions that were computed fine,
    // so a partial insufficiency shows `reason` as a note beside the table
    // rather than in place of it.
    if (data.items.length === 0) {
      return <Absent label="No predictions yet" reason={data.reason ?? 'Not enough eligible efforts to predict from.'} />
    }
    // The best-effort models are reported as one range, not as separate
    // point estimates. That is the contract on both sides: `RaceModel`'s own
    // validator lets them omit a band because "their spread is the range
    // across the two models, shown by the caller".
    const bestEffortModels = (prediction: Prediction) =>
      prediction.models.filter((model) => model.source !== ORDINARY_RUNS_SOURCE)
    const ordinaryRunsModel = (prediction: Prediction) =>
      prediction.models.find((model) => model.source === ORDINARY_RUNS_SOURCE)

    const partialReason =
      data.insufficient_data && data.reason !== null && data.reason !== undefined ? data.reason : null

    return (
      <>
        {partialReason !== null && (
          // The API's own prose, displayed verbatim and never parsed.
          <p className={styles.partialNote} role="note">
            {partialReason}
          </p>
        )}
        {/*
         * The reference's own statistics list, which is what this is: a name
         * on the left, a value in the sans face at 700 on the right, rows
         * separated by whitespace rather than by rules, and no box around
         * any of it. A luminance scan across 120 rows of
         * `stats-totals-and-best-efforts.jpg` finds no divider at all.
         *
         * It stays a `<table>` because it is one - three quantities per
         * distance, read down as much as across - and because the row is
         * the unit both this view's tests and a screen reader address it
         * by. What went is the chrome: the border, the radius, the fill,
         * the per-cell rules and the 38rem minimum that made a two-finger
         * horizontal scroll the only way to read a prediction on a phone.
         */}
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Distance</th>
              <th scope="col" className={styles.numericHeader}>
                Best efforts
              </th>
              <th scope="col" className={styles.numericHeader}>
                Ordinary runs
              </th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((prediction) => {
              const fromEfforts = bestEffortModels(prediction)
              const fromOrdinary = ordinaryRunsModel(prediction)
              return (
                <tr key={prediction.distance_key} data-distance-key={prediction.distance_key}>
                  {/* The metres only where they say something the label
                      does not. Five of the nine rows printed the distance
                      twice - "1 km" over "1.00 km", "5 km" over "5.00 km" -
                      which is the fault the records ladder found and fixed
                      first; `format.distanceKeyStatesTheDistance` is that
                      same test, shared rather than copied. `1 mile` over
                      "1.61 km" and `Half marathon` over "21.10 km" keep
                      theirs, because there the metres are the fact the
                      label does not carry. */}
                  <th scope="row" className={styles.distanceCell}>
                    {distanceKeyLabel(prediction.distance_key)}
                    {!distanceKeyStatesTheDistance(prediction.distance_key) && (
                      <span className={styles.metres}>{distance(prediction.distance_m)}</span>
                    )}
                  </th>
                  <td className={styles.numeric}>
                    {fromEfforts.length === 0 ? (
                      <span className={styles.value}>{NO_VALUE}</span>
                    ) : (
                      <>
                        <span className={styles.value}>
                          {formatPredictionSpan(fromEfforts.map((model) => model.predicted_time_s))}
                        </span>
                        {/* The models behind the range, so a reader can see
                            which one sets each end rather than having to
                            trust the span. Their paces are not repeated
                            here: three times and three paces in a column 83
                            px wide is the dense-table fault this screen was
                            rebuilt to remove, and the range is the reading.
                            The ordinary-runs prediction keeps its own pace,
                            because it is a single estimate rather than a
                            spread. */}
                        <span className={styles.modelDetail}>
                          {fromEfforts.map((model) => (
                            <span key={model.model} className={`${styles.modelRow} ${styles.modelPair}`}>
                              {raceModelLabel(model.model)}{' '}
                              <span className={styles.modelTime}>{duration(model.predicted_time_s)}</span>
                            </span>
                          ))}
                        </span>
                      </>
                    )}
                  </td>
                  <td className={styles.numeric}>
                    {/* Secondary to the range beside it, in the detail
                        ink rather than the headline's: it reads what
                        typical training supports, so after a breakthrough
                        effort it sits slower than the best efforts by
                        design, and set at the same weight it read as a
                        second race prediction that disagreed with the
                        first. `docs/reference/math/predictions.md`, "Why it
                        runs slow after a breakthrough effort". */}
                    {fromOrdinary === undefined ? (
                      <span className={styles.secondaryValue}>{NO_VALUE}</span>
                    ) : (
                      <>
                        <span className={styles.secondaryValue}>{duration(fromOrdinary.predicted_time_s)}</span>
                        <span className={styles.modelDetail}>
                          <span className={styles.modelRow}>
                            {pace(prediction.distance_m / fromOrdinary.predicted_time_s)}
                          </span>
                          <span className={styles.modelRow}>
                            {formatPredictionBand(fromOrdinary.low_s, fromOrdinary.high_s)}
                          </span>
                        </span>
                      </>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </>
    )
  })()

  const trendsReady = trendsQuery.isSuccess && allItems.length > 0

  const vo2maxSection = (
      <Section
        title="VO2max"
        note={showsDevice ? "Two estimates, and the watch's own" : 'Two estimates, from different evidence'}
        divided
      >
        {/*
         * The claim stays in the open and the evidence for it folds, which
         * is the treatment the decoupling section already takes.
         *
         * It used to be a `--panel` card with a bold lead-in, and measured
         * on the predictions section's twin of it a blind critic found the
         * lead-in was the darkest text on the panel - darker than the
         * section title and darker than the headline numbers - so the eye
         * landed on a caveat rather than on the section's name or on a
         * value, while the body sat at the same grey as the table's own row
         * labels and so was not subordinate at all. It is now one line at
         * the subtitle's size and grey, on the page gutter, directly under
         * the subtitle it qualifies.
         *
         * `tests/phase4.spec.ts` asserts this sentence is *visible*, not
         * merely present, which is the right constraint: a reader who never
         * opens a disclosure must still meet it.
         */}
        <p className={styles.caveat}>
          The level is a model output; only the trend is defensible. Read the slope, not the number.
        </p>
        {fitnessBody}
        <About>
          <p>
            Two estimates from different evidence: the heart rate method reads sustained intensity from
            ordinary running, VDOT reads it from the best efforts the extractor found. Each is a trailing
            42-day mean, with the raw per-run heart rate estimates drawn faintly beneath so the smoothing
            never hides its inputs. This is one of the two charts the effort filter does not drive - the
            plotted series are already smoothed over a calendar window, so filtering their inputs would
            not be reflected in a smoothed value.
          </p>
          {/* The offset is the viewer's own, the comparison
              `docs/reference/math/vo2max.md`'s "Why the level is a model
              output" makes: the median ratio of the two smoothed estimates
              over the runs carrying both, and that ratio's standard
              deviation. That document also measures how the level compares
              with the athlete's best 5 km, which needs the VDOT tables the
              backend owns, so the page does not state it. The document is
              named here rather than on the page - a repository path is a
              developer artefact, and a code comment is where a pointer to
              the owning document belongs. */}
          <p>
            {findings.againstVdot !== null &&
              `Over the ${runCount(findings.againstVdot.pairs)} that carry both, the heart rate based estimate sits ${offsetFrom(findings.againstVdot.medianOffsetPct, findings.againstVdot.side, 'VDOT')} at the median, with a standard deviation of ${trimmedNumber(findings.againstVdot.spreadPoints)} percentage points in that offset. `}
            The level also scales directly with the configured maximum heart rate, a device setting rather
            than a measurement.
          </p>
          {showsDevice && (
            <>
              {/* The comparison is the viewer's own, paired the way
                  `docs/reference/math/vo2max.md`, "Against Garmin's own",
                  pairs them. The seasonal swing that document describes is
                  not stated: it rests on one winter of one history, and the
                  document leaves its cause open. */}
              <p>
                Garmin&apos;s own VO2max, the third line, is a model too: it reads heart rate against running
                speed, the family the heart rate estimate belongs to, so it is a reference rather than a
                measurement.
                <GarminComparison against={findings.againstDevice} />
              </p>
            </>
          )}
        </About>
      </Section>
  )

  const predictionsSection = (
      <Section title="Race predictions" note="What today's training says a race would take" divided>
        {/* One line in the open, at the subtitle's size and grey, and the
            reasoning behind it folded - the same split the VO2max section
            and the decoupling section take. Measured on the round-2
            capture, this paragraph as a `--panel` card carried 2.161M of
            ink against 3.102M for the whole nine-row table beneath it, 70%
            of the content's ink, and at a higher density per pixel than the
            table itself. Its bold lead-in was the darkest text on the
            panel, darker than the section title and darker than any
            predicted time, and the card's own 16px padding was what put the
            one block of prose on the page 17px inside the gutter every
            other line starts at. */}
        <p className={styles.caveat}>
          The best efforts are the prediction. Ordinary runs read typical training, so they sit slower after a
          breakthrough run.
        </p>
        {predictionsBody}
        <About>
          <p>
            What the best efforts and the ordinary runs say the athlete could race today. Two models
            extrapolate from the best recent effort, the one with the highest VDOT, and are shown as a
            range: narrow near that effort&apos;s distance and wider far from it, where they diverge. The
            calibrated prediction from ordinary runs carries the residual band of its own fit. None is a
            promise.
          </p>
          <p>
            The prediction from ordinary runs is a second reading rather than a third model. It is
            calibrated against the best 5 km inside six weeks of training, which is rarely a race, so it
            says what typical training supports and sits slower than the best efforts after a breakthrough
            run. A critical speed model fitted across every distance&apos;s best was removed: on the history
            this page was developed against, easy long runs among those bests made it predict a 10 km
            slower than one the window already held.
            See <span className="mono">docs/reference/math/predictions.md</span>.
          </p>
          {/* Every claim below is `docs/reference/math/predictions.md`'s, which
              owns them: the exponent above 1 because pace decays with
              distance and the marathon optimism that follows from it, the
              fatigue factors fitted in miles from 400 m upwards, the removed
              critical speed fit, and the calibration against the VDOT of the
              nearby best 5 km and why it runs slow after a breakthrough. A figure or a claim here that the document does not carry
              is a defect, not a simplification. */}
        <dl className={styles.models}>
          <div>
            <dt>Riegel</dt>
            <dd>
              One exponent applied to the ratio between the two distances, fitted to record performances.
              It is above 1 because pace decays with distance, so doubling a distance costs more than
              doubling the time. Known to be optimistic at the marathon end, where a single exponent cannot
              capture the extra fatigue past two hours, which is why it is never shown alone.
            </dd>
          </div>
          <div>
            <dt>Cameron</dt>
            <dd>
              A fatigue factor per distance, fitted to observed times from 400 m to the marathon, scaling
              pace by the ratio between the two distances&apos; factors. It agrees closely with Riegel over
              a doubling and diverges from it at the long end, which is what makes showing both
              informative.
            </dd>
          </div>
          <div>
            <dt>Ordinary runs</dt>
            <dd>
              The smoothed heart rate VO2max, calibrated against the VDOT of the nearby best 5 km and then
              inverted to a time, so it needs no maximal effort. It reads typical training rather than the
              best recent effort, and carries its own band, from one residual standard deviation of that
              calibration either side.
            </dd>
          </div>
        </dl>
        </About>
      </Section>
  )

  const perRunChartsBottom = trendsReady && (
        <>
          <Section id="decoupling" title="Aerobic decoupling" note="Heart rate drift against pace, within a run" divided>
            <StatGroup>
              <Stat
                label="90-day mean"
                share="full"
                value={formatDecoupling(valueAt(latestDecoupling, 'decoupling_smoothed_pct'))}
                detail={
                  latestDecoupling === undefined
                    ? 'no run in the population yet'
                    : `through ${dayOf(latestDecoupling)}`
                }
              />
            </StatGroup>
            {/* **The population stays in the open and only the population.**
                This is the one series on the page sampled on a population
                of its own: a null here means the quantity is not defined at
                that run, and without words that renders exactly like a null
                meaning it was not recorded, so a reader who never opens a
                disclosure still has to meet it.

                What folds is the reading of the level, the medians over the
                population and over its runs of an hour or more. Measured
                on the round-1 capture, this paragraph carried 5536k of ink
                against its own chart's 2737k, which is the same fault a
                blind critic named on the effort filter one section above:
                the words outweighing the drawing they introduce. The
                headline stat above already gives the current value and the
                chart's own key already names the 5% rule. */}
            <p className={styles.finding}>
              Averaged across the 90 days ending at each of them, over easy or steady runs of 40 minutes or
              more - the only runs it is defined on.
            </p>
            <TrendChart
              series={decouplingSeries}
              yLabel="%"
              formatValue={formatDecoupling}
              formatTick={formatDecouplingTick}
              referenceLine={DURABILITY_REFERENCE_LINE}
              emptyReason="No easy or steady run of 40 minutes or more has a decoupling average yet."
              ariaLabel="Aerobic decoupling"
            />
            <About>
              {/* Every figure in these two paragraphs is the viewer's own,
                  measured the way `docs/reference/math/efficiency.md`'s
                  decoupling table measures it, and each is dropped when its
                  runs are too few to carry it. */}
              <p>
                How much heart rate drifted relative to pace between the first and second half of a run.
                That population is the point: read across every session it measures the session rather
                than the athlete
                {findings.sessions === null
                  ? '.'
                  : `, and on this history the median all-out session and the median easy one are ${trimmedNumber(findings.sessions.apartPoints)} percentage points apart.`}{' '}
                Runs outside the population are not plotted, because the average is not defined at them -
                and this chart is the other one the effort filter does not drive, for the same reason.
              </p>
              {findings.decoupling !== null && (
                <p>
                  Over the {runCount(findings.decoupling.population.runs)} in the population the median reads{' '}
                  <strong>{formatDecoupling(findings.decoupling.population.medianPct)}</strong>,{' '}
                  {ON_THE_LINE[findings.decoupling.population.side]} the 5% line conventionally taken as good
                  aerobic durability
                  {findings.decoupling.hourOrMore === null ? (
                    '.'
                  ) : (
                    <>
                      ; on the {trimmedNumber(findings.decoupling.hourOrMore.runs)} of them of an hour or more
                      it reads <strong>{formatDecoupling(findings.decoupling.hourOrMore.medianPct)}</strong>,{' '}
                      {findings.decoupling.hourOrMore.side === findings.decoupling.population.side ? 'also ' : ''}
                      {ON_THE_LINE[findings.decoupling.hourOrMore.side]} it.
                    </>
                  )}
                </p>
              )}
            </About>
          </Section>

          <Section
            title="Cadence slope"
            note="Steps per minute added per metre per second of speed"
            divided
          >
            <StatGroup>
              <Stat
                label="Shared cadence slope"
                share="half"
                value={slopeMeasure(trendsQuery.data.cadence_slope_shared_spm_per_mps, SLOPE_UNIT)}
                detail="across the whole history"
              />
              <Stat
                label="Shared heart rate slope"
                share="half"
                value={slopeMeasure(trendsQuery.data.hr_slope_shared_bpm_per_mps, HR_SLOPE_UNIT)}
                detail="across the whole history"
              />
            </StatGroup>
            {/* The finding is the viewer's own: an ordinary least squares
                trend over time in each run's shrunk slope, read against that
                trend's own standard error, the test
                `docs/reference/math/efficiency.md`'s "The cadence slope as
                its own metric" makes. It states the ratio and no other test.

                It stays in the open rather than folding into the disclosure,
                because it is the section's finding: a reader who never opens
                a disclosure must still meet it. It is never called an
                improvement in either direction - a lower slope describes
                running style rather than fitness. */}
            <p className={styles.finding}>{slopeFinding(findings.slopeTrend, runsWithCadenceSlope(allItems))}</p>
            {/* There is deliberately no chart here. A chart of a quantity
                that does not trend, in a unit as abstract as steps per
                minute per metre per second, is what the maintainer read as
                not making sense on 2026-09-12. The readable form is the
                cadence-at-reference-paces chart above, whose level the
                disclosure reads against its own standard error the same
                way. */}
            <About>
              <p>
                How many steps per minute each run added per metre per second of speed, shrunk towards the
                shared slope. A lower slope means gaining speed more by lengthening stride than by raising
                turnover, which describes running style and is not obviously better or worse.
                {findings.levelTrend !== null &&
                  findings.levelTrend.direction !== 'constant' &&
                  ` The readable form is the cadence chart above: at the median reference pace its level ${TREND_WORDS[findings.levelTrend.direction]}, with a trend ${trimmedNumber(findings.levelTrend.standardErrors)} times its own standard error over the ${runCount(findings.levelTrend.runs)} that carry it.`}
              </p>
            </About>
          </Section>
        </>
  )

  // The order is a decision, written out once as a list. The
  // effort-filtered charts all hang off `trendsReady`, and the VO2max and
  // predictions sections carry their own state, so no section's position
  // is decided by which guard it happens to sit inside.
  //
  // VO2max, race predictions and heart rate are the maintainer's stated order.
  // Cadence follows heart rate because they are the same chart of the same
  // fit and read as a pair; decoupling follows as the other aerobic signal;
  // the slope closes as a stated non-finding rather than opening with one.
  // This supersedes an earlier order, which put VO2max between the two
  // reference-pace charts.
  //
  // The effort filter sits with the charts it drives rather than at the top
  // of the page: it removes per-run points from the heart rate and cadence
  // charts directly below it, and nothing anywhere else. It changes no
  // plotted value on any chart. On those two that is because every line on
  // them is a trailing mean the analysis layer computes over the unfiltered
  // history; on decoupling and VO2max it is because those charts are
  // outside the filter's scope altogether, which is the reason that has to
  // be given for the VO2max chart, since it carries a raw per-run scatter
  // of its own that is no kind of mean.
  //
  // What the filter can still change is where a line is *drawn*, since the
  // y scale is fitted across every series including the scatter it thins.
  // The filter's own note keeps those apart, because a filter that visibly
  // removes points while every level holds is otherwise read as broken, and
  // one that claims the lines never move is caught out by the first tick.
  return (
    <div className={styles.trends}>
      <header className={styles.head}>
        <h1>Trends</h1>
        {trendsNotice}
      </header>
      {vo2maxSection}
      {predictionsSection}
      {trendsReady && perRunChartsTop}
      {perRunChartsBottom}
    </div>
  )
}
