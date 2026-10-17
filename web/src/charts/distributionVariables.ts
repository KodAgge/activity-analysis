import type { components } from '../api/schema'
import {
  ascentPerKm,
  cadence,
  distance,
  distanceKm,
  duration,
  formatDecoupling,
  heartRate,
  hoursMinutes,
  localWallClock,
  pace,
  paceFromSpeed,
  paceSecondsPerKm,
  speedFromPaceSeconds,
} from '../format'

/**
 * The fifteen variables the Distributions view can bucket a run on.
 *
 * Each entry is the whole contract for one variable: how to read its value
 * out of a served run, in bucket space (SI throughout, except pace, which
 * is seconds per kilometre because a speed axis is not what anyone reads),
 * its drop-down and caption text, and how `histogramMath.ts` should widen
 * and label its buckets. Kept out of the chart and the view for the same
 * reason `charts/trendChartMath.ts` is: pure data, testable against a
 * known answer with no component in the way.
 */

export type DistributionRun = components['schemas']['DistributionRun']

export type VariableId =
  | 'distance'
  | 'avg_hr'
  | 'avg_cadence'
  | 'moving_time'
  | 'start_hour'
  | 'weekday'
  | 'pace'
  | 'days_since_previous_run'
  | 'hr_at_reference'
  | 'cadence_at_reference'
  | 'climb_per_km'
  | 'month'
  | 'max_hr'
  | 'elapsed_time'
  | 'decoupling'

interface VariableBase {
  id: VariableId
  /** Drop-down and caption text. The two reference-pace labels take the pace from the payload. */
  label: (referenceMps: number | null) => string
  /**
   * Unit for the caption, which is where the axis's unit is said: the
   * bucket labels are bare numbers. '' for categories and for durations,
   * whose `h:mm` edges carry their own shape. Pace is `min/km` because its
   * edges are bare `m:ss`.
   */
  unit: string
  /** The value in bucket space, or null when the run has none. */
  value: (run: DistributionRun) => number | null
  /**
   * A value in bucket space as a reader reads it, unit included: a median
   * in the caption, a run's value in the bucket list. A category's median
   * can fall halfway between two categories on an even count, and is then
   * named by both rather than rounded into one.
   */
  formatValue: (value: number) => string
  /** A sentence the caption adds, for a variable defined on only some runs. */
  note?: string
  /** Channel whose reference-pace variable the pace caveat points to; only on avg_hr, max_hr, avg_cadence. */
  caveatTarget?: 'hr_at_reference' | 'cadence_at_reference'
}

export interface NumericVariable extends VariableBase {
  kind: 'numeric'
  /** Bucket width, in bucket space (SI, except pace in s/km). */
  width: number
  /** Values below this go to one open bucket, labelled `< …`. */
  openBelow?: number
  /** Values at or above this go to one open bucket, labelled `≥ …`. */
  openAtOrAbove?: number
  /** A bucket edge, in bucket space, formatted for a label. */
  edgeLabel: (edge: number) => string
}

export interface CategoryVariable extends VariableBase {
  kind: 'category'
  categories: readonly { key: number; label: string }[]
}

export type DistributionVariable = NumericVariable | CategoryVariable

/**
 * A run's local wall-clock parts, read the house way: shift the UTC instant
 * by the stored offset (zero for a null offset, same as `format.localWallClock`)
 * and then read every field with `getUTC*`, never `getHours`/`getDay`, which
 * would instead read the machine's own timezone. See `docs/reference/frontend.md`'s
 * "local time" trap.
 *
 * `isoWeekday` is 1 (Monday) to 7 (Sunday), because the weekday variable's
 * categories run Monday to Sunday, not JavaScript's own Sunday-first
 * `getUTCDay`.
 */
export function localParts(
  run: Pick<DistributionRun, 'start_time_utc' | 'utc_offset_s'>,
): { date: string; hour: number; isoWeekday: number; month: number } {
  const { date } = localWallClock(run.start_time_utc, run.utc_offset_s)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + 1
  const day = date.getUTCDate()
  const jsWeekday = date.getUTCDay()
  return {
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    hour: date.getUTCHours(),
    isoWeekday: jsWeekday === 0 ? 7 : jsWeekday,
    month,
  }
}

/**
 * A bare `m:ss` for a pace already in seconds per kilometre, reusing
 * `format`'s own speed-based pace formatter rather than duplicating its
 * rounding.
 *
 * `format` has no seconds-per-kilometre formatter directly - every caller
 * up to now has had a speed - so this round-trips through
 * `speedFromPaceSeconds`, which is exactly the inverse of
 * `paceSecondsPerKm` and therefore loses nothing.
 */
function paceEdgeLabel(paceSecondsPerKmValue: number): string {
  return paceFromSpeed(speedFromPaceSeconds(paceSecondsPerKmValue))
}

/**
 * A plain number label with no unit, for bucket edges whose unit lives on
 * the axis instead. Rounded to three decimal places, not to an integer,
 * because decoupling's 2.5-wide buckets have edges like `7.5`; the
 * rounding only clears the float noise a bucket boundary built from
 * repeated addition can carry, such as `7.5000000000000009`.
 */
function plainEdgeLabel(edge: number): string {
  return String(Math.round(edge * 1000) / 1000)
}

/** `label(referenceMps)` for average heart rate, maximum heart rate and average cadence: no reference pace involved. */
function fixedLabel(text: string): (referenceMps: number | null) => string {
  return () => text
}

/** `label(referenceMps)` for the two reference-pace channels: names the pace when the payload has one. */
function referencePaceLabel(channel: string): (referenceMps: number | null) => string {
  return (referenceMps) => {
    if (referenceMps === null) return `${channel} at reference pace`
    return `${channel} at ${pace(referenceMps)}`
  }
}

/**
 * A category value by its label, or, for a median halfway between two
 * categories, by both: `Wed to Thu`. `labelOf` names one category key.
 */
function categoryText(labelOf: (key: number) => string, value: number): string {
  if (Number.isInteger(value)) return labelOf(value)
  return `${labelOf(Math.floor(value))} to ${labelOf(Math.ceil(value))}`
}

/** `labelOf` over a fixed category list, falling back to the key itself for one outside it. */
function labelIn(categories: readonly { key: number; label: string }[]): (key: number) => string {
  return (key) => categories.find((category) => category.key === key)?.label ?? String(key)
}

const HOURS = Array.from({ length: 24 }, (_, hour) => ({ key: hour, label: String(hour).padStart(2, '0') }))
const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const WEEKDAYS = WEEKDAY_LABELS.map((label, index) => ({ key: index + 1, label }))
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS = MONTH_LABELS.map((label, index) => ({ key: index + 1, label }))
const REST_DAYS = [0, 1, 2, 3, 4, 5, 6, 7].map((day) => ({ key: day, label: day === 7 ? '7+' : String(day) }))

/** A clock hour as a time of day, `07:00`, which a bare `07` on its own is not. */
function hourText(value: number): string {
  return categoryText((hour) => `${labelIn(HOURS)(hour)}:00`, value)
}

/** Days since the previous run: `0 days`, `1 day`, `7+ days`, `2 to 3 days`. */
function restDaysText(value: number): string {
  const text = categoryText(labelIn(REST_DAYS), value)
  return `${text} ${text === '1' ? 'day' : 'days'}`
}

/** Pace held in seconds per kilometre, as `m:ss/km`. */
function paceText(paceSecondsPerKmValue: number): string {
  return pace(speedFromPaceSeconds(paceSecondsPerKmValue))
}

/** The fifteen variables, in the drop-down's order. */
export const VARIABLES: readonly DistributionVariable[] = [
  {
    id: 'distance',
    kind: 'numeric',
    label: fixedLabel('Distance'),
    unit: 'km',
    value: (run) => run.distance_m,
    formatValue: (value) => distance(value),
    width: 1000,
    openAtOrAbove: 22000,
    edgeLabel: (edge) => distanceKm(edge, 0),
  },
  {
    id: 'avg_hr',
    kind: 'numeric',
    label: fixedLabel('Average heart rate'),
    unit: 'bpm',
    value: (run) => run.avg_hr_bpm,
    formatValue: heartRate,
    width: 5,
    openBelow: 120,
    edgeLabel: plainEdgeLabel,
    caveatTarget: 'hr_at_reference',
  },
  {
    id: 'avg_cadence',
    kind: 'numeric',
    label: fixedLabel('Average cadence'),
    unit: 'spm',
    value: (run) => run.avg_cadence_spm,
    formatValue: cadence,
    width: 2,
    openBelow: 140,
    edgeLabel: plainEdgeLabel,
    caveatTarget: 'cadence_at_reference',
  },
  {
    id: 'moving_time',
    kind: 'numeric',
    label: fixedLabel('Run time'),
    unit: '',
    value: (run) => run.moving_time_s,
    formatValue: duration,
    width: 600,
    openAtOrAbove: 8400,
    edgeLabel: (edge) => hoursMinutes(edge),
  },
  {
    id: 'start_hour',
    kind: 'category',
    label: fixedLabel('Start time of day'),
    unit: '',
    value: (run) => localParts(run).hour,
    formatValue: hourText,
    categories: HOURS,
  },
  {
    id: 'weekday',
    kind: 'category',
    label: fixedLabel('Weekday'),
    unit: '',
    value: (run) => localParts(run).isoWeekday,
    formatValue: (value) => categoryText(labelIn(WEEKDAYS), value),
    categories: WEEKDAYS,
  },
  {
    id: 'pace',
    kind: 'numeric',
    label: fixedLabel('Average pace'),
    unit: 'min/km',
    formatValue: paceText,
    value: (run) => {
      const speed = run.avg_speed_mps
      if (speed === null || !Number.isFinite(speed) || speed <= 0) return null
      return paceSecondsPerKm(speed)
    },
    width: 15,
    openAtOrAbove: 540,
    edgeLabel: paceEdgeLabel,
  },
  {
    id: 'days_since_previous_run',
    kind: 'category',
    label: fixedLabel('Days since previous run'),
    unit: '',
    formatValue: restDaysText,
    value: (run) => {
      const days = run.days_since_previous_run
      if (days === null) return null
      return Math.min(days, 7)
    },
    categories: REST_DAYS,
  },
  {
    id: 'hr_at_reference',
    kind: 'numeric',
    label: referencePaceLabel('Heart rate'),
    unit: 'bpm',
    value: (run) => run.hr_at_median_bpm,
    formatValue: heartRate,
    width: 5,
    openBelow: 130,
    openAtOrAbove: 185,
    edgeLabel: plainEdgeLabel,
  },
  {
    id: 'cadence_at_reference',
    kind: 'numeric',
    label: referencePaceLabel('Cadence'),
    unit: 'spm',
    value: (run) => run.cadence_at_median_spm,
    formatValue: cadence,
    width: 2,
    edgeLabel: plainEdgeLabel,
  },
  {
    id: 'climb_per_km',
    kind: 'numeric',
    label: fixedLabel('Climb per km'),
    unit: 'm/km',
    value: (run) => run.ascent_per_km_m,
    formatValue: ascentPerKm,
    width: 2,
    edgeLabel: plainEdgeLabel,
  },
  {
    id: 'month',
    kind: 'category',
    label: fixedLabel('Month of year'),
    unit: '',
    value: (run) => localParts(run).month,
    formatValue: (value) => categoryText(labelIn(MONTHS), value),
    categories: MONTHS,
  },
  {
    id: 'max_hr',
    kind: 'numeric',
    label: fixedLabel('Maximum heart rate'),
    unit: 'bpm',
    value: (run) => run.max_hr_bpm,
    formatValue: heartRate,
    width: 5,
    openBelow: 145,
    edgeLabel: plainEdgeLabel,
    caveatTarget: 'hr_at_reference',
  },
  {
    id: 'elapsed_time',
    kind: 'numeric',
    label: fixedLabel('Elapsed time'),
    unit: '',
    value: (run) => run.elapsed_time_s,
    formatValue: duration,
    width: 600,
    openAtOrAbove: 8400,
    edgeLabel: (edge) => hoursMinutes(edge),
  },
  {
    id: 'decoupling',
    kind: 'numeric',
    label: fixedLabel('Aerobic decoupling'),
    unit: '%',
    // Shown only over the population the metric is defined on - see
    // docs/reference/math/efficiency.md - so a run outside it contributes
    // no value here rather than a misleading one.
    value: (run) => (run.is_aerobic_long_run === true ? run.decoupling_pct : null),
    formatValue: formatDecoupling,
    note: 'Only aerobic long runs carry it, so every other run is left out.',
    width: 2.5,
    edgeLabel: plainEdgeLabel,
  },
]

export const DEFAULT_VARIABLE: VariableId = 'distance'

const BY_ID = new Map<VariableId, DistributionVariable>(VARIABLES.map((variable) => [variable.id, variable]))

/** The variable named by `id`. Throws for anything not in `VARIABLES`, so a caller should check `isVariableId` first for untrusted input such as a URL. */
export function variableById(id: VariableId): DistributionVariable {
  const variable = BY_ID.get(id)
  if (variable === undefined) throw new Error(`Unknown distribution variable: ${id}`)
  return variable
}

/** Narrows an arbitrary value (a URL search param, typically) to a known `VariableId`. */
export function isVariableId(value: unknown): value is VariableId {
  return typeof value === 'string' && BY_ID.has(value as VariableId)
}
