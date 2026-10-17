/**
 * Every conversion from the API's SI values into something a person reads.
 *
 * The API is SI by design and carries no formatted strings, so this module is
 * the single implementation of pace, duration, distance and local time. It is
 * pure: no DOM, no fetch, no Date.now, so it is fully unit-testable and gives
 * the same answer on any machine in any timezone.
 */

/** Shown wherever a channel has no value. A missing number is not a zero. */
export const NO_VALUE = '–'

/**
 * A formatted quantity with its unit kept apart from its number.
 *
 * Every `*Measure` function below returns one of these and the matching
 * string formatter is `measureText` over it, so there is still exactly one
 * implementation of each conversion - this is a second *view* of the same
 * answer, not a second answer.
 *
 * It exists because a stat display has to set the two parts as two
 * elements. The reference sets a unit at the value's own size and weight
 * (measured on three screenshots across two phones: the x-height to cap
 * ratio of "km"/"mi" against the digits beside them is 0.725 every time,
 * which is this face's own ratio, so same size), but it still has to be
 * its own box: the number carries `font-variant-numeric` and the unit must
 * not, and a single string cannot be split in a component - `src/format`
 * is the only place a displayed value may be composed or decomposed.
 *
 * `unit` is null whenever there is nothing to qualify, which includes
 * every no-value case. That is the same rule the string formatters follow
 * and for the same reason: `– km` is a malformed reading, not a missing
 * one.
 */
export interface Measure {
  /** The number, already rounded for display, or `NO_VALUE`. */
  value: string
  /** The unit that follows it, or null when the value carries none. */
  unit: string | null
}

/** A `Measure` as the one string it reads as: `9.23 km`, or a bare `–`. */
export function measureText(measure: Measure): string {
  return measure.unit === null ? measure.value : `${measure.value} ${measure.unit}`
}

const SECONDS_PER_KM_AT_1_MPS = 1000

/** Pace in seconds per kilometre from speed in metres per second. */
export function paceSecondsPerKm(speedMps: number): number {
  return SECONDS_PER_KM_AT_1_MPS / speedMps
}

/** Speed in metres per second from pace in seconds per kilometre. */
export function speedFromPaceSeconds(paceSecondsPerKm: number): number {
  return SECONDS_PER_KM_AT_1_MPS / paceSecondsPerKm
}

function mmss(totalSeconds: number): string {
  const rounded = Math.round(totalSeconds)
  const minutes = Math.floor(rounded / 60)
  const seconds = rounded % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * Pace as `m:ss` per kilometre.
 *
 * Null and zero speed both render as the no-value glyph. Pace is a reciprocal
 * and diverges at a standstill, and the 1 Hz grid genuinely contains zero-speed
 * seconds, so returning Infinity here would put `Infinity/km` in a table cell.
 */
export function paceFromSpeed(speedMps: number | null): string {
  if (speedMps === null || !Number.isFinite(speedMps) || speedMps <= 0) return NO_VALUE
  return mmss(paceSecondsPerKm(speedMps))
}

/**
 * Pace as `m:ss/km`, unit included, or the bare no-value glyph - never the
 * glyph with a unit stapled onto it.
 *
 * `paceFromSpeed` returns the bare `m:ss` so a caller (`streamPanelMath`'s
 * axis ticks) can compose it further; every caller that instead wants "the
 * pace, as text" belongs here. Three byte-identical `paceCell` functions
 * across `views/` and `components/`, each with a comment saying it matched
 * the others, used to do this composition themselves.
 */
export function pace(speedMps: number | null): string {
  const value = paceFromSpeed(speedMps)
  return value === NO_VALUE ? NO_VALUE : `${value}/km`
}

/** `h:mm:ss` above an hour, `m:ss` below it. Zero is a time, not an absence. */
export function duration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return NO_VALUE
  const rounded = Math.round(seconds)
  if (rounded < 3600) return mmss(rounded)
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  const secs = rounded % 60
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

/**
 * `h:mm`, with no seconds at all: `0:10`, `1:00`, `2:20`.
 *
 * For a value that is always a whole number of minutes, such as a
 * Distributions bucket edge on `moving_time`/`elapsed_time` (600 s wide).
 * `duration` carries seconds unconditionally, `:00` below an hour and
 * `:00` again above it, so a run-time axis mixing edges under and over an
 * hour rendered `10:00` beside `2:20:00` - `m:ss` and `h:mm:ss` on the same
 * axis, one of them with a redundant trailing `:00`. This formatter is the
 * one place that inconsistency does not arise, because it never carries
 * seconds to begin with.
 */
export function hoursMinutes(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return NO_VALUE
  const rounded = Math.round(seconds)
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  return `${hours}:${String(minutes).padStart(2, '0')}`
}

export function distanceKm(metres: number | null, digits = 2): string {
  if (metres === null || !Number.isFinite(metres)) return NO_VALUE
  return (metres / 1000).toFixed(digits)
}

/**
 * Distance in kilometres, unit included: `9.23 km`, or the bare no-value
 * glyph - never the glyph with a unit stapled onto it.
 *
 * `distanceKm` returns a bare number so a caller can compose it into a
 * bigger string; every caller that instead wants "the distance, as text"
 * belongs here so the unit-or-glyph decision is made once. Six call sites
 * across `views/` and `components/` used to staple ` km` onto `distanceKm`
 * themselves, two of them with no guard at all, which rendered the exact
 * `– km` malformed string this function exists to prevent.
 */
export function distance(metres: number | null, digits = 2): string {
  return measureText(distanceMeasure(metres, digits))
}

/**
 * The same distance as `distance`, with `km` kept apart from the number so
 * a stat display can set the two as two elements. See `Measure`.
 */
export function distanceMeasure(metres: number | null, digits = 2): Measure {
  const km = distanceKm(metres, digits)
  return km === NO_VALUE ? { value: NO_VALUE, unit: null } : { value: km, unit: 'km' }
}

const SQUARE_METRES_PER_KM2 = 1_000_000

/**
 * An area in square kilometres, the unit kept apart: `{ value: '12.35',
 * unit: 'km²' }`, or the bare no-value glyph.
 *
 * The API serves square metres (`docs/reference/api.md`, "Units"); km² is
 * the presentation, at two decimals by default because that is how
 * `docs/reference/math/territory.md` quotes every figure. Two decimals are 10,000 m², a square
 * 100 m on a side, which is finer than any claim a run makes on its own.
 */
export function areaMeasure(squareMetres: number | null, digits = 2): Measure {
  if (squareMetres === null || !Number.isFinite(squareMetres)) return { value: NO_VALUE, unit: null }
  return { value: (squareMetres / SQUARE_METRES_PER_KM2).toFixed(digits), unit: 'km²' }
}

/** An area as text: `12.35 km²`, or the bare no-value glyph. See `areaMeasure`. */
export function area(squareMetres: number | null, digits = 2): string {
  return measureText(areaMeasure(squareMetres, digits))
}

/** Square kilometres from square metres, for a chart axis that plots the number itself. */
export function squareKilometres(squareMetres: number): number {
  return squareMetres / SQUARE_METRES_PER_KM2
}

/**
 * A count of weeks, pluralised: `1 week`, `30 weeks`, `0 weeks`.
 *
 * Zero is a count and not an absence - a current streak of zero weeks is a
 * measured fact about a training history, which is why this takes a plain
 * `number` rather than a nullable one and never emits `NO_VALUE`.
 *
 * Here rather than in the component that shows it for the reason every
 * other formatter in this file is here: `components/StatRail.tsx` carried
 * its own `weeksLabel`, and a second screen wanting the same words is how
 * two spellings of one unit get into a product.
 */
export function weeksMeasure(count: number): Measure {
  return { value: String(count), unit: count === 1 ? 'week' : 'weeks' }
}

/** A count of weeks as one string: `30 weeks`. */
export function weeks(count: number): string {
  return measureText(weeksMeasure(count))
}

/**
 * A count of runs: `27 runs`, and `1 run`. Shared by the Records view's
 * route rows, the route view and the activity view's route line, so the
 * three say the count the same way.
 */
export function runCount(count: number): string {
  return `${String(count)} ${count === 1 ? 'run' : 'runs'}`
}

/**
 * A run's place among the eligible runs of its route, fastest first:
 * `fastest` for rank 1, then `2nd fastest`, `3rd fastest`, `4th fastest`.
 *
 * Rank 1 reads as the bare word because "1st fastest" says the same thing
 * in more syllables. The suffix follows the last digit except across the
 * teens, where 11, 12 and 13 take `th`. The rank itself is the analysis
 * layer's `route_runs.rank`; this only spells it.
 */
export function fastestRankLabel(rank: number): string {
  if (rank === 1) return 'fastest'
  return `${ordinal(rank)} fastest`
}

function ordinal(n: number): string {
  const lastTwo = n % 100
  if (lastTwo >= 11 && lastTwo <= 13) return `${String(n)}th`
  switch (n % 10) {
    case 1:
      return `${String(n)}st`
    case 2:
      return `${String(n)}nd`
    case 3:
      return `${String(n)}rd`
    default:
      return `${String(n)}th`
  }
}

/**
 * A whole number of metres, unit included: `340 m`. Generic - unlike
 * `ascent`, this carries no claim that the metres are climbed, so it is
 * the right formatter for a map scale bar or any other plain distance
 * label, never for a summed ascent figure.
 */
export function metresLabel(metres: number): string {
  return `${Math.round(metres)} m`
}

/**
 * Heart rate as whole beats per minute, or the no-value glyph.
 *
 * A run recorded without heart rate has none at all - 84 of the 307 real
 * runs on the store of 2026-09-12, the oldest year of the history, and none
 * of the 335 on 2026-10-16 - so the null branch here is a real case, not an
 * edge case to special-case away in whatever renders it.
 */
export function heartRate(bpm: number | null): string {
  return measureText(heartRateMeasure(bpm))
}

/**
 * The same heart rate as `heartRate`, with `bpm` kept apart from the
 * number so a stat display can set the two as two elements. See `Measure`,
 * and `distanceMeasure` for the pattern: one implementation per
 * conversion, with the string form as `measureText` over the parts.
 */
export function heartRateMeasure(bpm: number | null): Measure {
  if (bpm === null || !Number.isFinite(bpm)) return { value: NO_VALUE, unit: null }
  return { value: String(Math.round(bpm)), unit: 'bpm' }
}

/** Cadence as whole steps per minute (one foot's rpm doubled at ingestion; see CLAUDE.md), or the no-value glyph. */
export function cadence(spm: number | null): string {
  return measureText(cadenceMeasure(spm))
}

/** The same cadence as `cadence`, with `spm` kept apart from the number. See `Measure`. */
export function cadenceMeasure(spm: number | null): Measure {
  if (spm === null || !Number.isFinite(spm)) return { value: NO_VALUE, unit: null }
  return { value: String(Math.round(spm)), unit: 'spm' }
}

/** Ascent in whole metres, or the no-value glyph. Null on a treadmill run: no GPS, so no ascent. */
export function ascent(metres: number | null): string {
  if (metres === null || !Number.isFinite(metres)) return NO_VALUE
  return `${Math.round(metres)} m`
}

/**
 * Climb per kilometre to one decimal, `5.3 m/km`, or the no-value glyph.
 *
 * One decimal rather than `ascent`'s whole metres because the quantity is
 * small: the Distributions view buckets it 2 m/km wide, and the real
 * store's runs span twelve of those buckets, so a whole number would put
 * two runs a bucket apart under the same figure.
 */
export function ascentPerKm(metresPerKm: number | null): string {
  if (metresPerKm === null || !Number.isFinite(metresPerKm)) return NO_VALUE
  return `${metresPerKm.toFixed(1)} m/km`
}

/**
 * A plain number to at most one decimal, with no trailing `.0`: `3`,
 * `2.5`. For a bar total or an axis rung whose unit is said elsewhere or
 * appended by the caller, such as the Distributions view's run counts.
 */
export function trimmedNumber(value: number): string {
  return String(Math.round(value * 10) / 10)
}

/**
 * A correlation coefficient to two decimals: `0.70`, `-0.35`, `1.00`, or
 * the no-value glyph.
 *
 * Two decimals always, trailing zeros kept, because a coefficient lives in
 * -1 to 1 and `trimmedNumber`'s one decimal would print 0.70 and 0.74 alike
 * as `0.7`. A value that rounds to zero prints `0.00` rather than `-0.00`.
 */
export function correlationLabel(r: number | null | undefined): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return NO_VALUE
  const rounded = Math.round(r * 100) / 100
  return (rounded === 0 ? 0 : rounded).toFixed(2)
}

/**
 * Seconds as a number of hours, for a chart whose bars are in hours: its
 * scale then picks round hours. Handed seconds, `volumeScale` picks round
 * seconds instead, and a rung at 5000 s reads as 1.4 h.
 */
export function hoursFromSeconds(seconds: number): number {
  return seconds / 3600
}

/** A number of hours with its unit: `2 h`, `2.5 h`. */
export function hoursLabel(hours: number): string {
  return `${trimmedNumber(hours)} h`
}

/** A percentage with its unit: `25%`, `12.5%`. */
export function percentLabel(percent: number): string {
  return `${trimmedNumber(percent)}%`
}

/**
 * An altitude in whole metres, or the no-value glyph.
 *
 * Separate from `ascent` even though the rendering is identical, because
 * the two are different quantities: `ascent` is climbed metres summed over
 * an activity and cannot be negative, while this is a position on a scale
 * with an arbitrary origin and genuinely can be - the Dead Sea and
 * Schiphol are both below zero, and a barometric altimeter drifts below it
 * anywhere. Sharing `ascent` would attach its "always non-negative"
 * contract to a value that does not honour it.
 */
export function altitude(metres: number | null): string {
  if (metres === null || !Number.isFinite(metres)) return NO_VALUE
  return `${Math.round(metres)} m`
}

/**
 * A signed elevation change in whole metres, or the no-value glyph.
 *
 * Unlike `ascent`, which is always non-negative (climbed metres summed over
 * a whole activity), this is one split's net altitude change and can be
 * negative - a split run downhill loses elevation, and hiding the sign
 * would show a descent as a climb. Zero renders as `+0 m`, a real, measured
 * flat split, not the no-value glyph.
 */
export function elevationChange(metres: number | null): string {
  if (metres === null || !Number.isFinite(metres)) return NO_VALUE
  const rounded = Math.round(metres)
  const sign = rounded > 0 ? '+' : rounded < 0 ? '-' : '+'
  return `${sign}${Math.abs(rounded)} m`
}

/**
 * A lap's net elevation change in metres, from the device's own recorded
 * ascent and descent totals - `ascent_m - descent_m`, which is the same
 * "net change over the span" quantity `elevationChange` formats, computed
 * here from the two totals a `Lap` actually carries rather than from raw
 * altitude samples, which laps do not have.
 *
 * Null the moment either input is null, never a silent zero: a lap missing
 * one of the two (a treadmill lap carries neither) has no elevation change
 * to report, and `0 - descentM` or `ascentM - 0` would report one anyway.
 */
export function netElevationChange(ascentM: number | null, descentM: number | null): number | null {
  if (ascentM === null || descentM === null || !Number.isFinite(ascentM) || !Number.isFinite(descentM)) {
    return null
  }
  return ascentM - descentM
}

/**
 * The wall clock the athlete saw, as arithmetic on the instant.
 *
 * The returned Date's UTC fields carry the local wall clock, so read it with
 * `getUTC*` and never with `getHours`. That is deliberate: constructing a
 * local Date would make the answer depend on the machine's timezone, and this
 * has to be right on a CI box in another zone.
 *
 * `utcOffsetS` is null for a GPX-sourced activity, which records no offset. We
 * render UTC and flag it rather than assuming home: 15 of the 335 real runs
 * were recorded outside the athlete's usual offsets, and assuming home puts
 * all 15 at the wrong hour.
 */
export function localWallClock(
  startTimeUtc: string,
  utcOffsetS: number | null,
): { date: Date; isUtcFallback: boolean } {
  const instant = new Date(startTimeUtc)
  if (utcOffsetS === null) return { date: instant, isUtcFallback: true }
  return { date: new Date(instant.getTime() + utcOffsetS * 1000), isUtcFallback: false }
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December']

/**
 * Helper to safely index into arrays with strict noUncheckedIndexedAccess.
 * Narrows the type from T | undefined to T.
 */
function getArrayElement<T>(arr: readonly T[], index: number): T {
  const element = arr[index]
  if (element === undefined) {
    throw new Error(`Index ${index} out of bounds`)
  }
  return element
}

/**
 * `Tuesday 25 August 2026` - the local calendar day, written out, with no
 * time on it.
 *
 * Split out of `formatLocal` so a screen can set the day and the time as
 * two different things: `views/ActivityDetail.tsx` gives the day to its
 * `<h1>` and puts the time in the quiet metadata line beneath, which is
 * the shape the reference screens use for a title over its own byline.
 *
 * No UTC marker here, deliberately - the marker belongs to the *time*,
 * which is the half an unknown offset makes uncertain, and `localTimeLabel`
 * carries it. Nothing should render this without that time beside it.
 */
export function localDateLabel(startTimeUtc: string, utcOffsetS: number | null): string {
  const { date } = localWallClock(startTimeUtc, utcOffsetS)
  return (
    `${getArrayElement(WEEKDAYS, date.getUTCDay())} ${date.getUTCDate()} ` +
    `${getArrayElement(MONTHS, date.getUTCMonth())} ${date.getUTCFullYear()}`
  )
}

/**
 * `17:41`, or `17:41 UTC` when the activity recorded no offset.
 *
 * The marker has to survive being split off the date: a GPX-sourced
 * activity records no offset at all and 15 of the 335 real runs were
 * recorded outside the home band, so a stamp with no offset behind it must
 * keep saying so - see `localWallClock`.
 */
export function localTimeLabel(startTimeUtc: string, utcOffsetS: number | null): string {
  const { date, isUtcFallback } = localWallClock(startTimeUtc, utcOffsetS)
  const clock = `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
  return isUtcFallback ? `${clock} UTC` : clock
}

/**
 * `Tuesday 25 August 2026 17:41`, or the same in UTC with a marker.
 *
 * The two halves above composed, rather than a third spelling of the same
 * stamp: one implementation per conversion is this module's whole contract.
 */
export function formatLocal(startTimeUtc: string, utcOffsetS: number | null): string {
  return `${localDateLabel(startTimeUtc, utcOffsetS)} ${localTimeLabel(startTimeUtc, utcOffsetS)}`
}

/**
 * `Wed 26 Aug 2026 20:21`, or the same in UTC with a marker.
 *
 * The list's date column, short. `formatLocal`'s full names make that
 * column's width swing between "Sunday 3 May" and "Wednesday 26 August",
 * so nothing lines up down the page however tabular the figures are; three
 * letters each and a zero-padded day make every stamp the same number of
 * characters, which is what makes a column of them scannable.
 *
 * Slices this module's own `WEEKDAYS`/`MONTHS` rather than reaching for
 * `Intl`, for the reason `shortCalendarDate` already records: `Intl`
 * output is not pinned across ICU versions, and a table gives the same
 * three letters on every machine this runs on.
 *
 * The UTC marker survives the shortening. It has to: a GPX-sourced
 * activity records no offset at all, and 15 of the 335 real runs were
 * recorded outside the home band, so a stamp with no offset behind it must
 * keep saying so.
 */
export function formatLocalShort(startTimeUtc: string, utcOffsetS: number | null): string {
  const { date, isUtcFallback } = localWallClock(startTimeUtc, utcOffsetS)
  const weekday = getArrayElement(WEEKDAYS, date.getUTCDay()).slice(0, 3)
  const month = getArrayElement(MONTHS, date.getUTCMonth()).slice(0, 3)
  const day = String(date.getUTCDate()).padStart(2, '0')
  const stamp =
    `${weekday} ${day} ${month} ${String(date.getUTCFullYear())} ` +
    `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
  return isUtcFallback ? `${stamp} UTC` : stamp
}

/**
 * `1 Oct 2025`: the calendar day an instant fell on in the athlete's own
 * wall clock, with no weekday and no time of day.
 *
 * For a date that qualifies a number rather than identifying a run - the
 * day a personal best was set, under the best itself. `formatLocalShort`
 * is the identifying form and carries the weekday, the zero-padded day and
 * the clock time so a column of them lines up; all three are noise in a
 * stat's caption line, and at a third of a phone's width the longer string
 * wraps mid-date. On the record ladder it is 21 characters in a line that
 * also has to carry the distance, the heart rate and the effort count:
 * measured, the chain with it in runs 286 px against a 256 px budget.
 *
 * The day is not zero-padded here for the same reason: nothing is being
 * aligned, and `01 Oct 2025` reads as a code rather than as a date.
 *
 * The UTC marker survives, as it does in every other stamp in this file: a
 * GPX-sourced activity records no offset, and a run near midnight is on a
 * different calendar day in UTC than the one the athlete saw.
 *
 * That is also where this differs from `localDateLabel`, which drops the
 * marker: `localDateLabel` is always rendered beside `localTimeLabel`,
 * which carries it there, while this stands alone - and an unknown offset
 * makes the calendar day itself uncertain, not merely the hour.
 */
export function shortLocalDate(startTimeUtc: string, utcOffsetS: number | null): string {
  const { date, isUtcFallback } = localWallClock(startTimeUtc, utcOffsetS)
  const month = getArrayElement(MONTHS, date.getUTCMonth()).slice(0, 3)
  const stamp = `${date.getUTCDate()} ${month} ${String(date.getUTCFullYear())}`
  return isUtcFallback ? `${stamp} UTC` : stamp
}

/**
 * `25 Aug`, from a bare calendar date (`"YYYY-MM-DD"`) rather than an
 * instant - the shape `PeriodBucket.period_start` arrives in, already the
 * local date the API bucketed by. There is no offset to apply the way
 * `localWallClock` applies one to a `start_time_utc`; this only reads the
 * date apart. Parsed at UTC midnight purely so the calendar day read back
 * is not shifted by whatever timezone the browser happens to be in.
 *
 * Uses this module's own fixed `MONTHS` table rather than `Intl`/
 * `toLocaleString`, for the same reason every other name in this file does:
 * `Intl`'s output is not pinned across ICU versions, so a table gives the
 * same three letters on every machine this ever runs on.
 */
export function shortCalendarDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  const day = parsed.getUTCDate()
  const month = getArrayElement(MONTHS, parsed.getUTCMonth()).slice(0, 3)
  return `${day} ${month}`
}

/**
 * `17 November 2025`, from a bare calendar date (`"YYYY-MM-DD"`) - the full
 * month name and the year, unlike `shortCalendarDate`. For a date that can
 * be well over a year old, such as the week a streak ended: for a
 * `Streak.longest_ended_week` of 2025-11-17 the day-and-month-only form
 * leaves a reader unable to tell it from 2026-11-17.
 * Same UTC-midnight parsing as `shortCalendarDate`, for the same reason -
 * this only reads the date apart, with no offset to apply.
 */
export function calendarDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  const day = parsed.getUTCDate()
  const month = getArrayElement(MONTHS, parsed.getUTCMonth())
  return `${day} ${month} ${parsed.getUTCFullYear()}`
}

/**
 * `August 2026`, from a bare calendar date (`"YYYY-MM-DD"`) - the month a
 * date falls in, with the day dropped.
 *
 * For naming a whole month rather than a day inside it: a monthly
 * `PeriodBucket` carries the first of the month as its `period_start`, and
 * a reader shown "1 August 2026" over a bar covering all of August reads
 * it as that one day. Unlike a week, a month has a name, so there is
 * something better to say than "the month starting on".
 * Same UTC-midnight parsing as `calendarDate`, for the same reason.
 */
export function calendarMonth(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  return `${getArrayElement(MONTHS, parsed.getUTCMonth())} ${parsed.getUTCFullYear()}`
}

/**
 * `Aug 2026`, from a bare calendar date (`"YYYY-MM-DD"`) - `calendarMonth`
 * abbreviated, for a place with no room for the full month name.
 *
 * That place is the full-history volume chart's x axis. Its 148 weekly bars
 * were labelled `shortCalendarDate`, which repeats the same twelve
 * three-letter names across three years and never says which year a tick
 * belongs to; the twelve-week chart beside it, where every tick is inside
 * one or two months, keeps the day-and-month form.
 *
 * `monthYearLabel` says the same words but takes a *day number*, the
 * fractional-calendar-day coordinate the trend charts plot on.
 * `PeriodBucket.period_start` is a bare date, so this is the form for it.
 * Same UTC-midnight parsing as `calendarMonth`, for the same reason.
 */
export function shortCalendarMonth(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  const month = getArrayElement(MONTHS, parsed.getUTCMonth()).slice(0, 3)
  return `${month} ${parsed.getUTCFullYear()}`
}

/**
 * A signed number to one decimal: `+3.5`, `-1.2`, `+0.0`.
 *
 * The sign is written on zero too, because every caller here is formatting
 * a quantity whose *direction* is the meaning - a decoupling, a slope - and
 * a bare `0.0` in a column of signed values reads as a different kind of
 * number rather than as the middle of the same scale.
 */
function signedOneDecimal(value: number): string {
  const fixed = Math.abs(value).toFixed(1)
  // Signed from the *rounded* magnitude, not the raw value: -0.04 rounds to
  // 0.0 and must not render as `-0.0`.
  const isNegative = value < 0 && fixed !== '0.0'
  return `${isNegative ? '-' : '+'}${fixed}`
}

/**
 * A VO2max estimate to one decimal, or the no-value glyph.
 *
 * One decimal is deliberate. The heart rate estimate's residual against the
 * athlete's own performances is 2.37 VDOT units (see
 * `docs/reference/math/predictions.md`, "The calibration", which owns that
 * figure), so a second decimal would assert
 * precision the model does not have. No unit: VO2max is conventionally
 * quoted as a bare number, and `ml/kg/min` on every tick is noise.
 */
export function formatVo2max(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE
  return value.toFixed(1)
}

/**
 * A VO2max as the watch shows it, a whole number: `50`. For Garmin's own
 * reported value, which is stored whole; this project's estimates keep one
 * decimal through `formatVo2max`.
 */
export function formatWholeVo2max(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE
  return value.toFixed(0)
}

/**
 * A fitted slope, signed, to one decimal, with its unit: `+12.5 spm per
 * m/s`. Or the bare no-value glyph - never the glyph with a unit stapled
 * onto it, for the reason `pace` and `distance` record.
 *
 * Signed because the direction is the finding: nearly every cadence slope
 * the fit covers is positive (`docs/reference/math/efficiency.md` has the
 * count), which is the expected sign, and the few that are not deserve to
 * look different.
 */
export function formatSlope(value: number | null | undefined, unit: string): string {
  return measureText(slopeMeasure(value, unit))
}

/**
 * The same fitted slope as `formatSlope`, with its unit kept apart from the
 * number. See `Measure`.
 *
 * A slope's unit is long - `spm per m/s` - so a stat that sets it as its
 * own element is the difference between one line and two at phone width.
 */
export function slopeMeasure(value: number | null | undefined, unit: string): Measure {
  if (value === null || value === undefined || !Number.isFinite(value)) return { value: NO_VALUE, unit: null }
  return { value: signedOneDecimal(value), unit }
}

/**
 * Aerobic decoupling as a signed percentage: `+3.5%`, `-1.2%`, `+0.0%`.
 *
 * Signed always, because the direction is the meaning: a positive value is
 * heart rate drifting up relative to pace over the run, a negative one is
 * the athlete speeding up relative to their heart rate. The magnitude alone
 * says neither. See `docs/reference/math/efficiency.md`.
 */
export function formatDecoupling(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE
  return `${signedOneDecimal(value)}%`
}

/**
 * The distance keys `analysis/best_efforts.py` extracts, as the words a
 * reader would use for them.
 *
 * Deliberately not a closed mapping: an unknown key passes through as
 * itself rather than throwing, because the key set belongs to the analysis
 * layer, and a distance added there must degrade to a slightly terse label
 * here rather than break the whole view. That is the same reason
 * `Record.distance_key` is a string in the schema and not an enum.
 */
const DISTANCE_KEY_LABEL: Readonly<Record<string, string>> = {
  '400m': '400 m',
  '1k': '1 km',
  '1mi': '1 mile',
  '2k': '2 km',
  '3k': '3 km',
  '4k': '4 km',
  '3mi': '3 miles',
  '5k': '5 km',
  '6k': '6 km',
  '8k': '8 km',
  '5mi': '5 miles',
  '10k': '10 km',
  '8mi': '8 miles',
  '15k': '15 km',
  '10mi': '10 miles',
  '20k': '20 km',
  half: 'Half marathon',
  '15mi': '15 miles',
  '25k': '25 km',
  '30k': '30 km',
  '35k': '35 km',
  marathon: 'Marathon',
}

/**
 * The shapes the analysis layer's own keys take: a whole or decimal number
 * of kilometres, of miles, or of metres. A key it has not been told about
 * still degrades, but to the words the table would have given it rather
 * than to the key itself.
 *
 * This is what a picker of every distance in the store needs. The nine keys
 * in the table above are the nine `STANDARD_DISTANCES_M` names, and the
 * real derived store carries nineteen - `2k`, `3mi`, `8k`, `20k`, `25k` and
 * the rest - so a picker built from `/api/records` showed ten raw keys
 * beside nine English labels. Parsing is the honest fix: it stays open in
 * exactly the way the table is meant to be, instead of pinning a second,
 * longer list of distances in the frontend that the analysis layer would
 * have to be kept in step with.
 */
const DISTANCE_KEY_PATTERN = /^(\d+(?:\.\d+)?)(km|k|mi|m)$/

export function distanceKeyLabel(key: string): string {
  const known = DISTANCE_KEY_LABEL[key]
  if (known !== undefined) return known
  const parsed = DISTANCE_KEY_PATTERN.exec(key)
  if (parsed === null) return key
  const [, amount, unit] = parsed
  if (amount === undefined || unit === undefined) return key
  if (unit === 'mi') return amount === '1' ? '1 mile' : `${amount} miles`
  return unit === 'm' ? `${amount} m` : `${amount} km`
}

/** A key spelled as a plain number of metres or kilometres: `5k`, `400m`, `1.5km`. */
const METRIC_DISTANCE_KEY = /^\d+(?:\.\d+)?(?:m|k|km)$/

/**
 * Whether a distance key's own label already says how far it is, in which
 * case printing the metres beside it is the label a second time.
 *
 * On the real store twelve of the nineteen keys are metric - `5k` labelled
 * "5 km" beside "5.00 km", `400m` beside "0.40 km" - and seven are not:
 * `1mi` is "1 mile" beside "1.61 km" and `half` is "Half marathon" beside
 * "21.10 km", where the metres are a fact the label does not carry and the
 * whole reason to print them.
 *
 * The test is the *shape of the key*, not a list of keys, for the reason
 * `distanceKeyLabel` parses rather than enumerates: the key set belongs to
 * `analysis/best_efforts.py` and the frontend must not hold a second copy
 * of it. A key spelled as a number of metres or kilometres gets a label
 * that is that number with its unit after it, so the label states the
 * distance; a key spelled in miles, or named in words, does not. A key in a
 * shape neither this nor `distanceKeyLabel` recognises falls through to
 * *showing* the metres, which is the safe way round - a row labelled with a
 * raw key needs them most.
 *
 * Nothing is recomputed and no fact leaves the page: the row that drops the
 * metres is the row whose label is those metres. Shared by `views/Records`
 * and `views/Trends`, which both list one row per distance key, and by
 * `views/Progression`'s record headline, rather than copied into each - the
 * same rule `distanceKeyLabel` beside it follows.
 */
export function distanceKeyStatesTheDistance(key: string): boolean {
  return METRIC_DISTANCE_KEY.test(key)
}

/**
 * The two words of a range are `A to B`, and the space that may break is the
 * one *before* the `to`, never the one after it.
 *
 * `RANGE_JOIN` is therefore a normal space, the word, and a **non-breaking**
 * space. A range is one value with two ends, so if it has to take two lines
 * the connector belongs with the end it introduces: measured at 412px, three
 * of the nine prediction rows cannot hold `1:50:00 to 2:05:00` on one line -
 * the three columns need 384 px of an available 364, and no readable type
 * size closes that - so the break is not avoidable and the only question is
 * where it falls. Left to itself the browser broke after the `to` and left
 * the conjunction dangling at the end of a line.
 *
 * It is a rendering hint and not a value: `\u00a0` is whitespace, so every
 * caller that compares or asserts on this string through a whitespace-
 * normalising matcher - which is Testing Library's default, and jest-dom's -
 * sees the ordinary `A to B` it always did.
 */
const RANGE_JOIN = ' to\u00a0'

/**
 * A race prediction's band as `low to high`, both as durations, or the
 * no-value glyph when either bound is missing.
 *
 * `RaceModel.low_s` and `high_s` are each nullable and in practice null
 * together, but a band with one end is not a band, and rendering `– to
 * 25:30` would be the composed-glyph malformation every other helper in
 * this file refuses.
 */
export function formatPredictionBand(low: number | null, high: number | null): string {
  if (low === null || high === null || !Number.isFinite(low) || !Number.isFinite(high)) return NO_VALUE
  return `${duration(low)}${RANGE_JOIN}${duration(high)}`
}

const MS_PER_DAY = 86_400_000

/**
 * The athlete's local calendar day as a day number: whole days since
 * 1970-01-01 in the wall clock the athlete saw, from the instant plus its
 * offset. A run at 23:30 local on 2025-03-01 is day 20148 whatever its UTC
 * instant says, and a run at 00:30 the next morning is 20149.
 *
 * This is the unit of the x axis of every over-time chart in the
 * application, and it is a plain number rather than a `Date` or an epoch
 * second for two reasons. uPlot's own time scale places its ticks at
 * *machine-local* midnights and formats them with machine-local getters, so
 * a chart of the same store would tick differently on a laptop in another
 * timezone; and the quantity a trend chart is really plotting is "which
 * day", not "which instant". A day number carries exactly that and nothing
 * else. The labels read a whole day number back; a point's own x
 * coordinate is `localCalendarTime`, which keeps the time of day so two
 * runs on one day stay two points.
 *
 * A null offset - a GPX-sourced activity, which records none - falls back to
 * the UTC calendar day, the same fallback `localWallClock` makes and for the
 * same reason: the home zone is not assumed. It is not marked here because a
 * tick on a multi-year axis has no room for a marker and an hour's shift
 * cannot move a point by more than one day; `formatLocalShort` still marks
 * it wherever the wall clock itself is shown.
 */
export function localCalendarDay(startTimeUtc: string, utcOffsetS: number | null): number {
  return Math.floor(localCalendarTime(startTimeUtc, utcOffsetS))
}

/**
 * The athlete's local wall clock as a fractional day number: the
 * `localCalendarDay` plus the local time of day as a fraction of 86 400 s.
 * A run at 08:00 local is day plus a third, and one at 18:00 the same day
 * is day plus three quarters.
 *
 * This is the x coordinate of every point on every over-time chart. It is
 * fractional rather than the whole day so that two runs on one day - a
 * morning easy run and an evening session, a real pattern in a 307-run
 * history - stay two points at two x positions, rather than one silently
 * overwriting the other. `Math.floor` of it is the whole day the labels
 * use, and the month-start ticks `trendChartMath.dateAxisSplits` places
 * are whole days, so nothing about the axis changes.
 *
 * Same null-offset fallback as `localCalendarDay`, for the same reason.
 */
export function localCalendarTime(startTimeUtc: string, utcOffsetS: number | null): number {
  const { date } = localWallClock(startTimeUtc, utcOffsetS)
  return date.getTime() / MS_PER_DAY
}

/**
 * The `Date` at UTC midnight of a day number, so `getUTC*` on it reads the
 * calendar day apart - the same contract `localWallClock` has, for the same
 * reason: never `getDate`, which would shift by the machine's zone.
 */
export function dateOfCalendarDay(day: number): Date {
  return new Date(day * MS_PER_DAY)
}

/** `1 October 2025`, from a day number - the calendar day, written out. */
export function calendarDayLabel(day: number): string {
  const date = dateOfCalendarDay(day)
  return `${date.getUTCDate()} ${getArrayElement(MONTHS, date.getUTCMonth())} ${date.getUTCFullYear()}`
}

/**
 * The day number of a bare calendar date (`"YYYY-MM-DD"`), on the same axis
 * `localCalendarTime` puts an activity on: its UTC midnight over a day. For a
 * value that belongs to a day rather than to an instant, such as Garmin's
 * VO2max, which carries no time and no offset to apply.
 */
export function calendarDayOfDate(date: string): number {
  return new Date(`${date}T00:00:00Z`).getTime() / MS_PER_DAY
}

/** `Oct 2025`, from a day number - for an axis tick at a month boundary. */
export function monthYearLabel(day: number): string {
  const date = dateOfCalendarDay(day)
  return `${getArrayElement(MONTHS, date.getUTCMonth()).slice(0, 3)} ${date.getUTCFullYear()}`
}

/** `2025`, from a day number - for an axis tick at a year boundary. */
export function yearLabel(day: number): string {
  return String(dateOfCalendarDay(day).getUTCFullYear())
}

/**
 * `16 Mar`, from a day number - for an axis tick that is an ordinary day
 * rather than a month or year boundary.
 *
 * The year is dropped where `monthYearLabel` keeps it, and that is not an
 * inconsistency: a ladder of bare days only ever appears on an axis whose
 * whole range sits inside one month (a distance with a single effort, say),
 * where every tick would repeat the same year.
 */
export function dayMonthLabel(day: number): string {
  const date = dateOfCalendarDay(day)
  return `${date.getUTCDate()} ${getArrayElement(MONTHS, date.getUTCMonth()).slice(0, 3)}`
}

/**
 * The classifier's effort tag as a word: `all_out` becomes `All out`.
 *
 * Lives here rather than in `components/Tag.tsx`, which held the only copy
 * until the trends view needed the same map: two copies drift the first
 * time a label is reworded. It cannot be exported from `Tag.tsx` itself
 * without costing that file its Fast Refresh, which is the same constraint
 * behind every `*Math.ts` module.
 *
 * An unknown tag passes through as itself rather than throwing. The tag set
 * belongs to `analysis/tags.py`, so a tag added there must degrade to a
 * terse label here rather than break a view.
 */
const EFFORT_TAG_LABEL: Readonly<Record<string, string>> = {
  easy: 'Easy',
  steady: 'Steady',
  intervals: 'Intervals',
  all_out: 'All out',
}

export function effortTagLabel(tag: string): string {
  return EFFORT_TAG_LABEL[tag] ?? tag
}

/**
 * A sport as a reader would say it: `running` becomes `Running` and
 * `alpine_skiing` becomes `Alpine skiing`.
 *
 * Open by construction rather than a lookup table, because `sport` is a
 * plain string on both sides of the API - it is not a closed enum on the
 * backend either (see `api/activitySearch.ts`) - and the real store holds
 * twelve of them, `fitness_equipment` and `hiit` included. A table would
 * have to be edited every time the athlete tries a new one.
 *
 * `null` is the sport GPX ingestion records, which `/api/sports` reports as
 * its own bucket and `UNKNOWN_SPORT` selects: it is stated as `Unknown`
 * rather than left blank, for the reason every absence in this application
 * is stated.
 */
export function sportLabel(sport: string | null): string {
  if (sport === null || sport === '') return 'Unknown'
  const words = sport.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * A race model's name as a reader would say it: `ordinary_runs` becomes
 * `Ordinary runs`.
 *
 * Open like `distanceKeyLabel` and `effortTagLabel`, and for the same
 * reason: the set of models belongs to `analysis/fitness.py` and is
 * documented in `docs/reference/math/predictions.md`, so a model added
 * there must degrade to its own key rather than break the table.
 */
const RACE_MODEL_LABEL: Readonly<Record<string, string>> = {
  riegel: 'Riegel',
  cameron: 'Cameron',
  ordinary_runs: 'Ordinary runs',
}

export function raceModelLabel(model: string): string {
  return RACE_MODEL_LABEL[model] ?? model
}

/**
 * The span of several predicted times as `fastest to slowest`, or the one
 * time when they all agree. Empty when there is nothing to span.
 *
 * This is how the best-effort models are reported. They carry no band of
 * their own by design - `RaceModel`'s own validator says their spread *is*
 * the range across the two, and leaves showing it to the caller. It is how
 * far the two extrapolations disagree, not the uncertainty of the effort
 * they start from; `docs/reference/math/predictions.md` has the figures.
 */
export function formatPredictionSpan(seconds: number[]): string {
  const finite = seconds.filter((value) => Number.isFinite(value))
  if (finite.length === 0) return NO_VALUE
  // Compared as displayed, not as seconds: two models a fraction of a
  // second apart would otherwise read "50:00 to 50:00".
  const low = duration(Math.min(...finite))
  const high = duration(Math.max(...finite))
  return low === high ? low : `${low}${RANGE_JOIN}${high}`
}
