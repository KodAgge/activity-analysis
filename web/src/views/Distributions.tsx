import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useId, useMemo, useState } from 'react'
import {
  applySearchChange,
  customBoundChange,
  groupsFor,
  inclusiveLastDay,
  periodLabel,
  todayLocalDate,
  validateDistributionSearch,
  yearsIn,
  type Compare,
  type CustomBounds,
  type Days,
  type DistributionSearch,
  type Period,
} from '../api/distributionSearch'
import { describeApiError } from '../api/errors'
import { queries } from '../api/queries'
import { VARIABLES, variableById, type DistributionRun, type VariableId } from '../charts/distributionVariables'
import { Histogram, type HistogramSeries } from '../charts/Histogram'
import {
  barFormatter,
  bucketListTitle,
  bucketRowParts,
  bucketRuns,
  bucketsFor,
  groupCaption,
  groupSeries,
  measureNoun,
  variableCaption,
  type BarMeasure,
} from '../charts/histogramMath'
import { Absent } from '../components/Absent'
import { Row, RowList } from '../components/RowList'
import { formatLocalShort } from '../format'
import styles from './Distributions.module.css'

/** One identity for "no runs yet", so the memos below do not rerun while the query is pending. */
const NO_RUNS: DistributionRun[] = []

const COMPARE_OPTIONS: readonly { value: Compare; label: string }[] = [
  { value: 'none', label: 'Nothing' },
  { value: 'periods', label: 'Two periods' },
  { value: 'days', label: 'Weekdays and weekends' },
  { value: 'surface', label: 'Outdoor and treadmill' },
  { value: 'years', label: 'Each year' },
]

const MEASURE_OPTIONS: readonly { value: BarMeasure; label: string }[] = [
  { value: 'runs', label: 'Runs' },
  { value: 'distance', label: 'Kilometres' },
  { value: 'time', label: 'Hours' },
]

const DAYS_OPTIONS: readonly { value: Days; label: string }[] = [
  { value: 'all', label: 'All days' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekends', label: 'Weekends' },
]

/**
 * One variable at a time, bucketed into a histogram over every run: how
 * far, how fast, when, and how that compares across two periods, weekdays
 * and weekends, outdoor and treadmill, or calendar years.
 * `docs/reference/frontend.md`, "Distributions", describes the view.
 *
 * The whole state is the URL's, read loosely and re-validated here for the
 * reason `views/Progression.tsx` gives. Every control navigates with
 * `replace` through `applySearchChange`, which holds the two rules the
 * validator cannot apply because they depend on the previous search:
 * changing the variable clears the bucket, and comparing two periods from
 * all time starts from the last 12 months.
 *
 * The component is a composition. Groups come from `groupsFor`, buckets
 * from `bucketsFor` over every served run so that no filter moves the
 * axis, and each group's bars, median and caption from `histogramMath`.
 * The buckets, the series and the bar formatter are memoised, because
 * `Histogram` rebuilds its uPlot instance whenever one of them changes
 * identity. Selecting a bucket changes none of them: `Histogram` repaints
 * the same instance for a new `selectedKey`.
 */
export function Distributions() {
  const rawSearch = useSearch({ strict: false })
  const navigate = useNavigate()
  const search = validateDistributionSearch(rawSearch as Record<string, unknown>)
  const [today] = useState(todayLocalDate)
  const query = useQuery(queries.distributions())

  const runs = query.data?.runs ?? NO_RUNS
  const referenceMps = query.data?.references.median_mps ?? null
  const variable = variableById(search.variable)
  const measure = search.measure ?? 'runs'
  const compare = search.compare ?? 'none'
  const comparing = compare !== 'none'
  const variableLabel = variable.label(referenceMps)

  const buckets = useMemo(() => bucketsFor(variable, runs), [variable, runs])

  const { period, from, to, days, treadmill, vs, vs_from: vsFrom, vs_to: vsTo } = search
  const groups = useMemo(
    () =>
      groupsFor(
        { variable: variable.id, period, from, to, days, treadmill, compare, vs, vs_from: vsFrom, vs_to: vsTo },
        runs,
        today,
      ),
    [variable.id, period, from, to, days, treadmill, compare, vs, vsFrom, vsTo, runs, today],
  )

  const drawn = useMemo(
    () => groups.map((group) => ({ group, ...groupSeries(variable, buckets, group.runs, measure, comparing) })),
    [groups, variable, buckets, measure, comparing],
  )
  const chartSeries = useMemo<HistogramSeries[]>(
    () =>
      drawn.map((d) => ({ label: d.group.label, values: d.values, medianAt: d.medianAt, n: d.tally.counted })),
    [drawn],
  )
  const overlay = useMemo(() => asOverlay(chartSeries), [chartSeries])
  const perGroup = useMemo(() => chartSeries.map((s): [HistogramSeries] => [s]), [chartSeries])
  const yMax = useMemo(() => Math.max(0, ...chartSeries.flatMap((s) => s.values)), [chartSeries])
  const formatValue = barFormatter(measure, comparing)

  const selectedBucket = buckets.find((bucket) => bucket.key === search.bucket)
  const selectedKey = selectedBucket?.key ?? null

  function update(change: Partial<DistributionSearch>): void {
    // `to: '.'` is this route wherever it is mounted, for the reason
    // `views/Progression.tsx` gives.
    void navigate({ to: '.', search: applySearchChange(search, change, today), replace: true })
  }

  function onSelect(key: string): void {
    // Choosing the selected bucket again clears it, which is the one way
    // back to no selection from the chart itself.
    update({ bucket: key === selectedKey ? undefined : key })
  }

  const header = (
    <header className={styles.head}>
      <h1>Distributions</h1>
      {query.isSuccess && runs.length > 0 && (
        <div className={styles.controls}>
          <label className={styles.field}>
            Variable
            <select
              value={variable.id}
              onChange={(event) => update({ variable: event.target.value as VariableId })}
            >
              {VARIABLES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label(referenceMps)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            Compare
            <select value={compare} onChange={(event) => update({ compare: event.target.value as Compare })}>
              {COMPARE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <PeriodPicker
            label="Period"
            period={period ?? 'all'}
            bounds={{ from, to }}
            years={yearsIn(runs)}
            onPeriod={(next) => update({ period: next })}
            onBounds={(next) => update({ from: next.from, to: next.to })}
          />
          {compare === 'periods' && (
            <PeriodPicker
              label="Against"
              period={vs ?? 'previous_12_months'}
              bounds={{ from: vsFrom, to: vsTo }}
              years={yearsIn(runs)}
              onPeriod={(next) => update({ vs: next })}
              onBounds={(next) => update({ vs_from: next.from, vs_to: next.to })}
            />
          )}
          <Segmented
            legend="Bars"
            options={MEASURE_OPTIONS}
            value={measure}
            onChange={(next) => update({ measure: next })}
          />
          {/* Disabled while it is what the comparison splits on, with its
              URL value kept, so ending the comparison restores it. */}
          <Segmented
            legend="Days"
            options={DAYS_OPTIONS}
            value={days ?? 'all'}
            onChange={(next) => update({ days: next })}
            disabled={compare === 'days'}
          />
          <label className={styles.toggle}>
            <input
              className={styles.toggleInput}
              type="checkbox"
              checked={treadmill !== 'exclude'}
              disabled={compare === 'surface'}
              onChange={(event) => update({ treadmill: event.target.checked ? 'include' : 'exclude' })}
            />
            Include treadmill runs
          </label>
        </div>
      )}
    </header>
  )

  if (query.isPending) {
    return (
      <div className={styles.distributions}>
        {header}
        <p className={styles.status}>Loading the runs…</p>
      </div>
    )
  }

  if (query.isError) {
    return (
      <div className={styles.distributions}>
        {header}
        <p role="alert" className={styles.status}>
          Could not load the runs: {describeApiError(query.error)}
        </p>
      </div>
    )
  }

  if (runs.length === 0) {
    return (
      <div className={styles.distributions}>
        {header}
        <Absent reason="No runs are stored yet, so there is nothing to bucket." />
      </div>
    )
  }

  const noValues = drawn.every((d) => d.tally.counted === 0)
  const medianText = (median: number | null) => (median === null ? null : variable.formatValue(median))
  // Small multiples carry each year's count on their own head; the caption
  // carries them only when there are no charts to head.
  const groupParts =
    compare === 'years' && !noValues
      ? []
      : drawn.map((d) => `${groupCaption(compare === 'none' ? null : d.group.label, d.tally, medianText(d.median))}.`)
  const caption = [variableCaption(variable, referenceMps, measure, comparing), ...groupParts].join(' ')
  const barNoun = comparing ? `share of ${measureNoun(measure)}` : measureNoun(measure)

  const chart = (() => {
    if (noValues) {
      const anyRuns = drawn.some((d) => d.group.runs.length > 0)
      return (
        <Absent
          label={variableLabel}
          reason={anyRuns ? 'None of these runs has a value for this variable.' : 'No runs fall in this selection.'}
        />
      )
    }
    if (compare === 'years') {
      return (
        <div className={styles.multiples}>
          {drawn.map((d, i) => (
            <div key={d.group.key} className={styles.multiple}>
              <p className={styles.multipleHead}>{groupCaption(d.group.label, d.tally, medianText(d.median))}</p>
              <Histogram
                buckets={buckets}
                series={perGroup[i] ?? [{ label: d.group.label, values: [], medianAt: null, n: 0 }]}
                formatValue={formatValue}
                selectedKey={selectedKey}
                onSelect={onSelect}
                label={`${variableLabel}, ${d.group.label}`}
                compact
                yMax={yMax}
              />
            </div>
          ))}
        </div>
      )
    }
    if (overlay === null) return null
    return (
      <Histogram
        buckets={buckets}
        series={overlay}
        formatValue={formatValue}
        selectedKey={selectedKey}
        onSelect={onSelect}
        label={`${variableLabel}, ${barNoun} per bucket`}
        wholeNumbers={measure === 'runs' && !comparing}
      />
    )
  })()

  const caveatTarget = variable.caveatTarget
  const showCaveat = !noValues && (compare === 'periods' || compare === 'years') && caveatTarget !== undefined

  return (
    <div className={styles.distributions}>
      {header}
      <section className={styles.chartBlock} aria-label={variableLabel}>
        <p className={styles.caption}>{caption}</p>
        {chart}
        {showCaveat && (
          <p className={styles.caveat}>
            Part of a shift in {variableLabel.toLowerCase()} between {compare === 'years' ? 'years' : 'periods'} can
            come from pace.{' '}
            <Link to="." search={applySearchChange(search, { variable: caveatTarget }, today)} replace>
              {variableById(caveatTarget).label(referenceMps)}
            </Link>{' '}
            holds the pace fixed.
          </p>
        )}
      </section>
      {selectedBucket !== undefined && !noValues && (
        <div className={styles.lists}>
          {drawn.map((d) => {
            const inBucket = bucketRuns(variable, buckets, selectedBucket.key, d.group.runs)
            return (
              <RowList key={d.group.key} title={bucketListTitle(variable, selectedBucket, d.group.label)}>
                {inBucket.length === 0 ? (
                  <Row label="No runs in this bucket" value="" />
                ) : (
                  inBucket.map((run) => {
                    const { value, meta } = bucketRowParts(variable, run)
                    return (
                      <Row
                        key={run.activity_id}
                        label={formatLocalShort(run.start_time_utc, run.utc_offset_s)}
                        value={value}
                        meta={meta}
                        link={{ to: '/activities/$activityId', params: { activityId: run.activity_id } }}
                      />
                    )
                  })
                )}
              </RowList>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** The one or two series `Histogram` draws as bars and an outline, or null for none. */
function asOverlay(series: readonly HistogramSeries[]): [HistogramSeries] | [HistogramSeries, HistogramSeries] | null {
  const [first, second] = series
  if (first === undefined) return null
  return second === undefined ? [first] : [first, second]
}

interface PeriodPickerProps {
  label: string
  period: Period
  bounds: CustomBounds
  /** Every year holding a run, ascending, as `yearsIn` returns them. */
  years: readonly number[]
  onPeriod: (period: Period) => void
  onBounds: (bounds: CustomBounds) => void
}

/**
 * One picker for both `period` and `vs`: the presets,
 * one option per year holding a run, newest first, and a custom range.
 *
 * The URL's `to` is exclusive and the "To" input is not: it shows and
 * takes the last day the range includes, and `customBoundChange` stores the
 * day after it.
 */
function PeriodPicker({ label, period, bounds, years, onPeriod, onBounds }: PeriodPickerProps) {
  const presets: Period[] = ['all', 'last_12_months', 'previous_12_months']
  const yearPeriods = [...years].reverse().map((year): Period => `year_${year}`)
  // A URL naming a year no run is in still gets its option, or the select
  // and the address bar would disagree about what is shown.
  const options = [...presets, ...yearPeriods]
  if (period !== 'custom' && !options.includes(period)) options.push(period)
  options.push('custom')

  return (
    <div className={styles.picker} role="group" aria-label={label}>
      <label className={styles.field}>
        {label}
        <select value={period} onChange={(event) => onPeriod(event.target.value as Period)}>
          {options.map((option) => (
            <option key={option} value={option}>
              {option === 'custom' ? 'Custom range' : periodLabel(option, undefined, undefined)}
            </option>
          ))}
        </select>
      </label>
      {period === 'custom' && (
        <>
          <label className={styles.field}>
            From
            <input
              type="date"
              value={bounds.from ?? ''}
              onChange={(event) => onBounds(customBoundChange(bounds, 'from', event.target.value))}
            />
          </label>
          <label className={styles.field}>
            To
            <input
              type="date"
              value={bounds.to === undefined ? '' : inclusiveLastDay(bounds.to)}
              onChange={(event) => onBounds(customBoundChange(bounds, 'lastDay', event.target.value))}
            />
          </label>
        </>
      )}
    </div>
  )
}

interface SegmentedProps<T extends string> {
  legend: string
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
}

/**
 * One of a few, as joined radio segments. Native radios in a `fieldset`,
 * so the group has a name, the arrow keys move within it, and `disabled`
 * on the fieldset disables every segment at once while keeping the checked
 * one visible.
 */
function Segmented<T extends string>({ legend, options, value, onChange, disabled = false }: SegmentedProps<T>) {
  const name = useId()
  return (
    <fieldset className={styles.segmented} disabled={disabled}>
      <legend className={styles.legend}>{legend}</legend>
      <div className={styles.segments}>
        {options.map((option) => (
          <label key={option.value} className={styles.segment}>
            <input
              className={styles.segmentInput}
              type="radio"
              name={name}
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
            />
            <span className={styles.segmentBody}>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
