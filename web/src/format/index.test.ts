import { describe, expect, it } from 'vitest'
import {
  NO_VALUE,
  altitude,
  area,
  areaMeasure,
  ascent,
  ascentPerKm,
  calendarDayOfDate,
  formatWholeVo2max,
  cadence,
  calendarDate,
  calendarDayLabel,
  calendarMonth,
  correlationLabel,
  dateOfCalendarDay,
  dayMonthLabel,
  distance,
  distanceKeyLabel,
  distanceKm,
  distanceMeasure,
  duration,
  effortTagLabel,
  elevationChange,
  formatDecoupling,
  formatPredictionBand,
  formatPredictionSpan,
  formatSlope,
  formatVo2max,
  fastestRankLabel,
  runCount,
  metresLabel,
  netElevationChange,
  formatLocal,
  formatLocalShort,
  heartRate,
  hoursFromSeconds,
  hoursLabel,
  hoursMinutes,
  localCalendarDay,
  localCalendarTime,
  localDateLabel,
  localWallClock,
  measureText,
  monthYearLabel,
  pace,
  paceFromSpeed,
  raceModelLabel,
  paceSecondsPerKm,
  percentLabel,
  shortCalendarDate,
  shortCalendarMonth,
  shortLocalDate,
  speedFromPaceSeconds,
  trimmedNumber,
  weeks,
  weeksMeasure,
  yearLabel,
} from './index'

describe('pace', () => {
  it('converts 5:00/km to and from metres per second', () => {
    // A pace of 5:00/km is 1000/300 m/s exactly.
    expect(paceSecondsPerKm(1000 / 300)).toBeCloseTo(300, 6)
    expect(speedFromPaceSeconds(300)).toBeCloseTo(1000 / 300, 6)
  })

  it('formats a real average speed', () => {
    // 2.783 m/s is the 2026-08-25 fixture activity's average.
    expect(paceFromSpeed(2.783)).toBe('5:59')
  })

  it('pads the seconds', () => {
    expect(paceFromSpeed(1000 / 245)).toBe('4:05')
  })

  it('is the no-value glyph for a null speed', () => {
    // 26.31% of real samples are null. This is not an edge case.
    expect(paceFromSpeed(null)).toBe(NO_VALUE)
  })

  it('is the no-value glyph at a standstill rather than Infinity', () => {
    // Pace is a reciprocal and diverges at zero speed. It must never render
    // as Infinity or NaN in a table cell.
    expect(paceFromSpeed(0)).toBe(NO_VALUE)
  })

  it('round-trips across the range of running paces', () => {
    for (const seconds of [240, 300, 360, 450, 630]) {
      expect(paceSecondsPerKm(speedFromPaceSeconds(seconds))).toBeCloseTo(seconds, 6)
    }
  })
})

describe('pace (with unit)', () => {
  it('appends /km to a real pace', () => {
    expect(pace(2.783)).toBe('5:59/km')
  })

  it('is the bare no-value glyph for a null speed, never "–/km"', () => {
    // The exact malformed composition this function exists to prevent: a
    // caller that reverted to `${paceFromSpeed(speedMps)}/km` without the
    // guard would fail this.
    expect(pace(null)).toBe(NO_VALUE)
  })

  it('is the bare no-value glyph at a standstill', () => {
    expect(pace(0)).toBe(NO_VALUE)
  })
})

describe('duration', () => {
  it('omits the hour below an hour', () => {
    expect(duration(3318)).toBe('55:18')
  })

  it('includes the hour above one', () => {
    expect(duration(3981.654)).toBe('1:06:22')
  })

  it('rounds rather than truncates', () => {
    expect(duration(59.6)).toBe('1:00')
  })

  it('is the no-value glyph for null', () => {
    expect(duration(null)).toBe(NO_VALUE)
  })

  it('renders zero as a time, not as absent', () => {
    // A dense weekly series carries real zeros; they are data.
    expect(duration(0)).toBe('0:00')
  })

  it('rounds up across the hour boundary', () => {
    // A classic carry bug: deciding < 3600 on the unrounded value would give 59:60 or 60:00.
    // 3599.6 rounds to 3600, which branches to h:mm:ss, yielding 1:00:00.
    expect(duration(3599.6)).toBe('1:00:00')
  })

  it('stays below one hour when rounding does not cross', () => {
    // The pair brackets the boundary: this one does not cross.
    // 3599.4 rounds to 3599, which stays in m:ss format.
    expect(duration(3599.4)).toBe('59:59')
  })
})

describe('hoursMinutes', () => {
  it('carries no seconds below an hour, unlike duration', () => {
    expect(hoursMinutes(600)).toBe('0:10')
  })

  it('writes a whole hour as 1:00, not 1:00:00', () => {
    expect(hoursMinutes(3600)).toBe('1:00')
  })

  it('formats the Run time open edge as hours and minutes', () => {
    // The distributions' Run time variable opens at `≥ 2:20`.
    expect(hoursMinutes(8400)).toBe('2:20')
  })

  it('is the no-value glyph for null', () => {
    expect(hoursMinutes(null)).toBe(NO_VALUE)
  })

  it('rounds rather than truncates', () => {
    expect(hoursMinutes(659.6)).toBe('0:11')
  })
})

describe('distance', () => {
  it('formats metres as kilometres to two places', () => {
    expect(distanceKm(9234.22)).toBe('9.23')
  })

  it('takes a digit count', () => {
    expect(distanceKm(9234.22, 1)).toBe('9.2')
  })

  it('renders a real zero', () => {
    expect(distanceKm(0)).toBe('0.00')
  })

  it('is the no-value glyph for null', () => {
    expect(distanceKm(null)).toBe(NO_VALUE)
  })
})

describe('distance (with unit)', () => {
  it('appends km to a real distance', () => {
    expect(distance(9234.22)).toBe('9.23 km')
  })

  it('takes a digit count through to the composed string', () => {
    expect(distance(9234.22, 0)).toBe('9 km')
  })

  it('is the bare no-value glyph for null, never "– km"', () => {
    // The exact malformed composition this function exists to prevent: a
    // caller that reverted to `${distanceKm(metres)} km` without the guard,
    // or that never guarded at all (StatRail's two sites had none), would
    // fail this.
    expect(distance(null)).toBe(NO_VALUE)
  })
})

describe('Measure: a value with its unit kept apart', () => {
  it('reads back as exactly the string the composed formatter returns', () => {
    // The two views must not drift: `distance` *is* `measureText` over
    // `distanceMeasure`, so any disagreement here would mean two
    // implementations of one conversion, which is what this module exists
    // to prevent.
    for (const metres of [0, 1, 9234.22, 42_195]) {
      expect(measureText(distanceMeasure(metres))).toBe(distance(metres))
    }
    expect(measureText(distanceMeasure(null))).toBe(distance(null))
  })

  it('separates the number from its unit', () => {
    expect(distanceMeasure(9234.22)).toEqual({ value: '9.23', unit: 'km' })
  })

  it('takes a digit count the same way the composed formatter does', () => {
    expect(distanceMeasure(9234.22, 0)).toEqual({ value: '9', unit: 'km' })
  })

  it('carries no unit at all when there is no value', () => {
    // A null unit is what stops a display from rendering "– km": there is
    // nothing for the unit to qualify.
    expect(distanceMeasure(null)).toEqual({ value: NO_VALUE, unit: null })
    expect(measureText({ value: NO_VALUE, unit: null })).toBe(NO_VALUE)
  })

  it('pluralises a count of weeks, and treats zero as a count rather than an absence', () => {
    // A current streak of zero weeks is a measured fact about a training
    // history. `NO_VALUE` here would claim the streak is unknown.
    expect(weeksMeasure(1)).toEqual({ value: '1', unit: 'week' })
    expect(weeksMeasure(30)).toEqual({ value: '30', unit: 'weeks' })
    expect(weeksMeasure(0)).toEqual({ value: '0', unit: 'weeks' })
    expect(weeks(0)).toBe('0 weeks')
    expect(weeks(1)).toBe('1 week')
  })
})

describe('metresLabel', () => {
  it('rounds to a whole metre and appends the unit', () => {
    expect(metresLabel(339.6)).toBe('340 m')
  })
})

describe('heart rate', () => {
  it('rounds to a whole beat per minute and appends the unit', () => {
    expect(heartRate(162.75)).toBe('163 bpm')
  })

  it('renders a real zero, not the no-value glyph', () => {
    expect(heartRate(0)).toBe('0 bpm')
  })

  it('is the no-value glyph for null, never a zero', () => {
    // 84 of 307 real runs have no recorded heart rate at all.
    expect(heartRate(null)).toBe(NO_VALUE)
  })
})

describe('cadence', () => {
  it('rounds to a whole step per minute and appends the unit', () => {
    expect(cadence(162.75)).toBe('163 spm')
  })

  it('is the no-value glyph for null', () => {
    expect(cadence(null)).toBe(NO_VALUE)
  })
})

describe('ascent', () => {
  it('rounds to a whole metre and appends the unit', () => {
    expect(ascent(55.6)).toBe('56 m')
  })

  it('renders a real zero, not the no-value glyph', () => {
    expect(ascent(0)).toBe('0 m')
  })

  it('is the no-value glyph for null - a treadmill run has no GPS and so no ascent', () => {
    expect(ascent(null)).toBe(NO_VALUE)
  })
})

describe('elevation change', () => {
  it('signs a climb with a plus', () => {
    expect(elevationChange(12.4)).toBe('+12 m')
  })

  it('signs a descent with a minus, unlike ascent which cannot go negative', () => {
    expect(elevationChange(-8.6)).toBe('-9 m')
  })

  it('renders a real flat split as +0 m, not the no-value glyph', () => {
    expect(elevationChange(0)).toBe('+0 m')
  })

  it('is the no-value glyph for null', () => {
    expect(elevationChange(null)).toBe(NO_VALUE)
  })
})

describe('net elevation change', () => {
  it('subtracts descent from ascent - lap 13 of the 2026-08-25 fixture interval session', () => {
    // A real lap (ascent_m: 4, descent_m: 15) that a `+` mutation
    // (ascent + descent) would misreport as +19 m for an actual 11 m net
    // descent.
    expect(netElevationChange(4, 15)).toBe(-11)
  })

  it('is positive for a net climb', () => {
    expect(netElevationChange(10, 2)).toBe(8)
  })

  it('is the no-value-shaped null, not 0, when ascent is missing', () => {
    // A treadmill lap carries neither ascent nor descent (no GPS, no
    // barometer reading tied to distance) - 0 - 5 would silently claim a
    // 5 m descent that was never measured.
    expect(netElevationChange(null, 5)).toBeNull()
  })

  it('is null when descent is missing', () => {
    expect(netElevationChange(5, null)).toBeNull()
  })

  it('is null when both are missing', () => {
    expect(netElevationChange(null, null)).toBeNull()
  })
})

describe('local wall clock', () => {
  it('applies the recorded offset', () => {
    // The 2026-08-25 activity: 15:41:23Z at +7200 is 17:41 local.
    const { date, isUtcFallback } = localWallClock('2026-08-25T15:41:23Z', 7200)
    expect(isUtcFallback).toBe(false)
    expect(date.getUTCHours()).toBe(17)
    expect(date.getUTCMinutes()).toBe(41)
  })

  it('falls back to UTC and says so when the offset is null', () => {
    // GPX records no offset. Guessing the home offset puts every real run
    // recorded away from the usual offsets at the wrong hour.
    const { date, isUtcFallback } = localWallClock('2026-08-25T15:41:23Z', null)
    expect(isUtcFallback).toBe(true)
    expect(date.getUTCHours()).toBe(15)
  })

  it('handles an offset that is not the home one', () => {
    // 15 of 307 real runs were recorded outside the athlete's usual offsets.
    const { date } = localWallClock('2026-08-25T15:41:23Z', -25200)
    expect(date.getUTCHours()).toBe(8)
  })

  it('does not depend on the machine timezone', () => {
    // The conversion is arithmetic on the instant, never a local Date
    // constructor, so a CI box in another zone gets the same answer.
    const a = formatLocal('2026-08-25T15:41:23Z', 7200)
    expect(a).toContain('17:41')
  })

  it('formats the full local timestamp with correct weekday and month names', () => {
    // The reference activity from the docstring. One weekday and one month
    // name; the table test below pins every entry of both.
    // 2026-08-25 is a Tuesday, 15:41:23Z at +7200 is 17:41 local.
    const result = formatLocal('2026-08-25T15:41:23Z', 7200)
    expect(result).toBe('Tuesday 25 August 2026 17:41')
  })

  it('formats dates in other months and weekdays correctly', () => {
    // A different month and weekday, so a single-element error cannot hide.
    // 2026-01-03 is a Saturday, 12:00:00Z at +3600 is 13:00 local.
    const result = formatLocal('2026-01-03T12:00:00Z', 3600)
    expect(result).toBe('Saturday 3 January 2026 13:00')
  })

  it('names every weekday and every month', () => {
    // Every slot of both tables, since a single mis-transcribed name moves
    // no other entry and so hides from spot checks. 2026-08-23 is a Sunday,
    // the first slot of WEEKDAYS; the 15th of each month walks MONTHS.
    const week = ['23', '24', '25', '26', '27', '28', '29'].map((day) =>
      localDateLabel(`2026-08-${day}T12:00:00Z`, 0),
    )
    expect(week).toEqual([
      'Sunday 23 August 2026',
      'Monday 24 August 2026',
      'Tuesday 25 August 2026',
      'Wednesday 26 August 2026',
      'Thursday 27 August 2026',
      'Friday 28 August 2026',
      'Saturday 29 August 2026',
    ])
    const year = Array.from({ length: 12 }, (_, i) =>
      localDateLabel(`2026-${String(i + 1).padStart(2, '0')}-15T12:00:00Z`, 0),
    )
    expect(year).toEqual([
      'Thursday 15 January 2026',
      'Sunday 15 February 2026',
      'Sunday 15 March 2026',
      'Wednesday 15 April 2026',
      'Friday 15 May 2026',
      'Monday 15 June 2026',
      'Wednesday 15 July 2026',
      'Saturday 15 August 2026',
      'Tuesday 15 September 2026',
      'Thursday 15 October 2026',
      'Sunday 15 November 2026',
      'Tuesday 15 December 2026',
    ])
  })
})

describe('short calendar date', () => {
  it('formats a bare calendar date without any offset arithmetic', () => {
    expect(shortCalendarDate('2026-08-25')).toBe('25 Aug')
  })

  it('does not shift the day across the UTC-midnight boundary', () => {
    // The classic bug this exists to catch: constructing `new Date(date)`
    // with no time component and then reading it back with a *local*
    // getter can land on the previous day west of UTC. Reading UTC fields
    // back, as this does, must not.
    expect(shortCalendarDate('2026-01-01')).toBe('1 Jan')
    expect(shortCalendarDate('2026-12-31')).toBe('31 Dec')
  })
})

describe('calendar date', () => {
  it('spells the month in full and includes the year', () => {
    // A week over a year old, where the year is what tells it apart.
    expect(calendarDate('2025-11-17')).toBe('17 November 2025')
  })

  it('does not shift the day across the UTC-midnight boundary', () => {
    expect(calendarDate('2026-01-01')).toBe('1 January 2026')
    expect(calendarDate('2026-12-31')).toBe('31 December 2026')
  })
})

describe('calendar month', () => {
  it('names the month a date falls in and drops the day', () => {
    // For heading a bar that covers a whole month, where the bucket's
    // `period_start` is the first of it.
    expect(calendarMonth('2026-08-01')).toBe('August 2026')
  })

  it('names the month whatever day of it the date is', () => {
    // Nothing serves a mid-month `period_start` today, but the month a
    // date belongs to is the question, not the month a series happens to
    // start its buckets on.
    expect(calendarMonth('2026-08-18')).toBe('August 2026')
    expect(calendarMonth('2026-08-31')).toBe('August 2026')
  })

  it('does not shift the month across the UTC-midnight boundary', () => {
    // The same trap `calendarDate` and `shortCalendarDate` guard: read
    // back with a local getter, 1 January west of UTC is December.
    expect(calendarMonth('2026-01-01')).toBe('January 2026')
    expect(calendarMonth('2026-12-31')).toBe('December 2026')
  })

  it('has a short form for an axis tick, which has no room for the full name', () => {
    // `Aug 2026`, for the full-history chart's x axis. The year is what the
    // short form exists to carry: 148 weekly bars labelled by bare day and
    // month repeat the same twelve names over three years without ever
    // saying which year one of them is.
    expect(shortCalendarMonth('2026-08-04')).toBe('Aug 2026')
    expect(shortCalendarMonth('2026-08-31')).toBe('Aug 2026')
  })

  it('does not shift the short form across the UTC-midnight boundary either', () => {
    expect(shortCalendarMonth('2026-01-01')).toBe('Jan 2026')
    expect(shortCalendarMonth('2026-12-31')).toBe('Dec 2026')
  })
})

describe('altitude', () => {
  it('renders whole metres', () => {
    expect(altitude(28.4)).toBe('28 m')
  })

  it('keeps a below-sea-level altitude negative rather than clamping it at zero', () => {
    // The reason this is not `ascent`, whose contract is that it is never
    // negative: an altitude is a position on a scale with an arbitrary
    // origin. Schiphol and the Dead Sea are both below it, and a
    // barometric altimeter drifts below it anywhere.
    expect(altitude(-4.2)).toBe('-4 m')
  })

  it('renders a real zero as a zero, not as the no-value glyph', () => {
    expect(altitude(0)).toBe('0 m')
  })

  it('renders the no-value glyph for a null or non-finite reading', () => {
    expect(altitude(null)).toBe(NO_VALUE)
    expect(altitude(Number.NaN)).toBe(NO_VALUE)
  })
})

describe('formatLocalShort', () => {
  // 2026-08-26T18:27:00Z at UTC+2 is Wednesday 26 August 2026, 20:27 local.
  const INSTANT = '2026-08-26T18:27:00Z'
  const OFFSET_PLUS_TWO = 7200

  it('renders a three-letter weekday and month with a zero-padded day', () => {
    expect(formatLocalShort(INSTANT, OFFSET_PLUS_TWO)).toBe('Wed 26 Aug 2026 20:27')
  })

  it('produces the same number of characters whatever the date, which is the point of it', () => {
    // The defect this exists for: `formatLocal`'s full names make the
    // column's width swing between "Sunday 3 May" and
    // "Wednesday 26 August", so nothing lines up down the page however
    // tabular the figures are.
    const shortDay = formatLocalShort('2026-05-03T08:05:00Z', OFFSET_PLUS_TWO)
    const longDay = formatLocalShort('2026-11-26T08:05:00Z', OFFSET_PLUS_TWO)
    expect(shortDay.length).toBe(longDay.length)
    expect(shortDay).toBe('Sun 03 May 2026 10:05')
    expect(longDay).toBe('Thu 26 Nov 2026 10:05')

    // And the long form genuinely does not, so this is a real difference.
    expect(formatLocal('2026-05-03T08:05:00Z', OFFSET_PLUS_TWO).length).not.toBe(
      formatLocal('2026-11-26T08:05:00Z', OFFSET_PLUS_TWO).length,
    )
  })

  it('applies the offset it is given rather than the machine timezone', () => {
    // 15 of the 335 real runs were recorded outside the athlete's usual
    // offsets, and assuming home puts all 15 at the wrong hour.
    expect(formatLocalShort(INSTANT, -25200)).toBe('Wed 26 Aug 2026 11:27')
  })

  it('marks a null offset as UTC rather than guessing the local hour', () => {
    // A GPX-sourced activity records no offset at all.
    expect(formatLocalShort(INSTANT, null)).toBe('Wed 26 Aug 2026 18:27 UTC')
  })

  it('crosses a day boundary the offset causes, rather than shortening the wrong day', () => {
    // 23:30 UTC at UTC+2 is 01:30 the next morning - and a Thursday, not a
    // Wednesday. Slicing the weekday off the wrong Date would keep the
    // instant's day name while showing the local hour.
    expect(formatLocalShort('2026-08-26T23:30:00Z', OFFSET_PLUS_TWO)).toBe('Thu 27 Aug 2026 01:30')
  })
})

describe('shortLocalDate', () => {
  const OFFSET_PLUS_TWO = 7200

  it('gives the calendar day with no weekday, no padding and no clock', () => {
    expect(shortLocalDate('2025-10-01T16:30:00Z', OFFSET_PLUS_TWO)).toBe('1 Oct 2025')
    expect(shortLocalDate('2026-08-26T18:27:00Z', OFFSET_PLUS_TWO)).toBe('26 Aug 2026')
  })

  it('names the day the athlete saw, not the day the instant fell on', () => {
    // 23:30 UTC at UTC+2 is 01:30 the next morning, and the run belongs to
    // that morning's date.
    expect(shortLocalDate('2026-08-26T23:30:00Z', OFFSET_PLUS_TWO)).toBe('27 Aug 2026')
  })

  it('applies the offset it is given rather than the machine timezone', () => {
    // 15 of the 307 real runs were recorded outside the athlete's usual offsets.
    expect(shortLocalDate('2026-08-26T18:27:00Z', -25_200)).toBe('26 Aug 2026')
  })

  it('keeps the UTC marker when there is no offset to apply', () => {
    expect(shortLocalDate('2026-08-26T23:30:00Z', null)).toBe('26 Aug 2026 UTC')
    // Unlike `localDateLabel`, which drops it because `localTimeLabel` is
    // always beside it and carries it there.
    expect(localDateLabel('2026-08-26T23:30:00Z', null)).not.toMatch(/UTC/)
  })
})

describe('distanceKeyLabel', () => {
  it('renders the analysis layer keys as human distances', () => {
    expect(distanceKeyLabel('400m')).toBe('400 m')
    expect(distanceKeyLabel('1k')).toBe('1 km')
    expect(distanceKeyLabel('1mi')).toBe('1 mile')
    expect(distanceKeyLabel('3k')).toBe('3 km')
    expect(distanceKeyLabel('5k')).toBe('5 km')
    expect(distanceKeyLabel('10k')).toBe('10 km')
    expect(distanceKeyLabel('15k')).toBe('15 km')
    expect(distanceKeyLabel('half')).toBe('Half marathon')
    expect(distanceKeyLabel('marathon')).toBe('Marathon')
  })

  it('reads a key the table does not carry rather than passing it through raw', () => {
    // The key set belongs to analysis/best_efforts.py. A closed mapping here
    // would break the whole view the day a distance is added, which is the
    // same reason `Record.distance_key` is a string and not an enum - but
    // "open" should mean the label degrades, not that it stops being a
    // label. The real derived store carries nineteen keys against the
    // table's nine, and `views/Progression.tsx` puts every one of them in
    // front of a reader as a picker.
    expect(distanceKeyLabel('50k')).toBe('50 km')
    expect(distanceKeyLabel('2k')).toBe('2 km')
    expect(distanceKeyLabel('3mi')).toBe('3 miles')
    expect(distanceKeyLabel('800m')).toBe('800 m')
    expect(distanceKeyLabel('21.1k')).toBe('21.1 km')
  })

  it('passes a key it cannot read at all through rather than throwing', () => {
    expect(distanceKeyLabel('ultra')).toBe('ultra')
    expect(distanceKeyLabel('')).toBe('')
  })
})

describe('formatDecoupling', () => {
  it('signs the value, because the direction is the meaning', () => {
    expect(formatDecoupling(3.5)).toBe('+3.5%')
    expect(formatDecoupling(-1.2)).toBe('-1.2%')
  })

  it('renders a zero as a signed zero, which is a measured value and not an absence', () => {
    expect(formatDecoupling(0)).toBe('+0.0%')
  })

  it('renders the empty glyph for a run with no value', () => {
    expect(formatDecoupling(null)).toBe(NO_VALUE)
    expect(formatDecoupling(undefined)).toBe(NO_VALUE)
  })
})

describe('formatVo2max', () => {
  it('shows one decimal, which is all the model supports', () => {
    // The estimate's residual against performance is 2.37 VDOT units, so a
    // second decimal would assert precision the model does not have.
    expect(formatVo2max(51.34)).toBe('51.3')
    expect(formatVo2max(41.68)).toBe('41.7')
  })

  it('renders the empty glyph for null and undefined', () => {
    expect(formatVo2max(null)).toBe(NO_VALUE)
    expect(formatVo2max(undefined)).toBe(NO_VALUE)
  })
})

describe('formatSlope', () => {
  it('signs the slope and carries the unit, to one decimal', () => {
    // Synthetic values in the shapes `docs/reference/math/efficiency.md`
    // reports: a cadence slope per m/s, which rounds up across a whole
    // number, and a heart rate time term per year, which is negative.
    expect(formatSlope(11.97, 'spm per m/s')).toBe('+12.0 spm per m/s')
    expect(formatSlope(-2.74, 'bpm per year')).toBe('-2.7 bpm per year')
  })

  it('is the bare no-value glyph for a missing slope, never the glyph with a unit stapled on', () => {
    expect(formatSlope(null, 'spm per m/s')).toBe(NO_VALUE)
    expect(formatSlope(undefined, 'spm per m/s')).toBe(NO_VALUE)
  })
})

describe('formatPredictionBand', () => {
  it('renders both bounds as durations joined by "to"', () => {
    expect(formatPredictionBand(1380, 1530)).toBe('23:00 to\u00a025:30')
  })

  it('keeps the connector with the bound it introduces, so a wrapped range never dangles its "to"', () => {
    // The space after the `to` is non-breaking and the one before it is
    // not, so the only place a range may break is before the connector -
    // see `RANGE_JOIN`. Asserted as the two spaces rather than as the whole
    // string, so the intent survives a change to either duration.
    const band = formatPredictionBand(1380, 1530)
    expect(band).toContain(' to\u00a0')
    expect(band).not.toContain('to ')
  })

  it('is the no-value glyph when either bound is missing', () => {
    // `RaceModel.low_s` and `high_s` are nullable together in practice, but
    // a band with one end is not a band and must not render as `– to 25:30`.
    expect(formatPredictionBand(null, 1530)).toBe(NO_VALUE)
    expect(formatPredictionBand(1380, null)).toBe(NO_VALUE)
    expect(formatPredictionBand(null, null)).toBe(NO_VALUE)
  })
})

describe('localCalendarDay', () => {
  it('is the day the athlete saw, not the UTC day', () => {
    // 22:30 UTC on 2025-10-01 is 00:30 on the 2nd at UTC+2. The day number
    // has to say the 2nd.
    const utcDay = localCalendarDay('2025-10-01T22:30:00Z', 0)
    const localDay = localCalendarDay('2025-10-01T22:30:00Z', 7200)
    expect(localDay).toBe(utcDay + 1)
    expect(dateOfCalendarDay(localDay).toISOString().slice(0, 10)).toBe('2025-10-02')
  })

  it('falls back to the UTC day for a GPX activity with no offset, rather than assuming home', () => {
    const day = localCalendarDay('2025-10-01T22:30:00Z', null)
    expect(dateOfCalendarDay(day).toISOString().slice(0, 10)).toBe('2025-10-01')
  })

  it('counts whole days from the epoch, so consecutive days differ by exactly one', () => {
    expect(localCalendarDay('1970-01-01T12:00:00Z', 0)).toBe(0)
    expect(localCalendarDay('1970-01-02T00:00:00Z', 0)).toBe(1)
  })
})

describe('localCalendarTime', () => {
  it('keeps two runs on one local day apart, on the same whole day', () => {
    // A morning easy run and an evening session on one day are two points on
    // a trend chart, not one overwriting the other; the labels still name
    // one day. 06:00Z and 16:00Z at UTC+2 are 08:00 and 18:00 local.
    const morning = localCalendarTime('2025-10-01T06:00:00Z', 7200)
    const evening = localCalendarTime('2025-10-01T16:00:00Z', 7200)
    expect(Math.floor(morning)).toBe(Math.floor(evening))
    expect(morning).toBeLessThan(evening)
    expect(morning - Math.floor(morning)).toBeCloseTo(8 / 24, 9)
    expect(evening - Math.floor(evening)).toBeCloseTo(18 / 24, 9)
  })

  it('floors to the local calendar day, across the UTC midnight the offset moves it over', () => {
    // 22:30 UTC at UTC+2 is 00:30 on the next local day.
    const t = localCalendarTime('2025-10-01T22:30:00Z', 7200)
    expect(Math.floor(t)).toBe(localCalendarDay('2025-10-01T22:30:00Z', 7200))
    expect(dateOfCalendarDay(Math.floor(t)).toISOString().slice(0, 10)).toBe('2025-10-02')
  })

  it('falls back to UTC for a GPX activity with no offset, like the whole-day form', () => {
    expect(Math.floor(localCalendarTime('2025-10-01T22:30:00Z', null))).toBe(
      localCalendarDay('2025-10-01T22:30:00Z', null),
    )
  })
})

describe('day number labels', () => {
  // 2025-10-01 is day 20362 since the epoch.
  const day = localCalendarDay('2025-10-01T16:30:00Z', 7200)

  it('writes the calendar day out in full', () => {
    expect(calendarDayLabel(day)).toBe('1 October 2025')
  })

  it('abbreviates the month for an axis tick and keeps the year, since a trend spans years', () => {
    expect(monthYearLabel(day)).toBe('Oct 2025')
  })

  it('gives a bare year for a year-boundary tick', () => {
    expect(yearLabel(day)).toBe('2025')
  })
})

describe('dayMonthLabel', () => {
  it('names an ordinary day without its year, for an axis inside one month', () => {
    expect(dayMonthLabel(localCalendarDay('2025-03-16T12:00:00Z', 0))).toBe('16 Mar')
    expect(dayMonthLabel(localCalendarDay('2026-01-02T12:00:00Z', 0))).toBe('2 Jan')
  })
})

describe('effortTagLabel', () => {
  it('renders the classifier\'s tags as words', () => {
    expect(effortTagLabel('easy')).toBe('Easy')
    expect(effortTagLabel('all_out')).toBe('All out')
    expect(effortTagLabel('intervals')).toBe('Intervals')
  })

  it('passes an unknown tag through rather than throwing', () => {
    // The tag set belongs to analysis/tags.py, so a tag added there must
    // degrade to a terse label rather than break a view.
    expect(effortTagLabel('tempo')).toBe('tempo')
  })
})

describe('formatPredictionSpan', () => {
  it('spans the fastest and slowest of several predictions', () => {
    expect(formatPredictionSpan([2854, 3487, 3073])).toBe('47:34 to\u00a058:07')
  })

  it('renders one time when every model agrees, rather than "x to x"', () => {
    expect(formatPredictionSpan([1500, 1500])).toBe('25:00')
  })

  it('renders one time when the models agree to the displayed second, rather than "50:00 to 50:00"', () => {
    // The real store's shape on 2026-10-06: both models anchor on a 10 km
    // best and return it a fraction of a second apart at that distance.
    expect(formatPredictionSpan([3000.1, 3000.3])).toBe('50:00')
  })

  it('is the no-value glyph when there is nothing to span', () => {
    expect(formatPredictionSpan([])).toBe(NO_VALUE)
    expect(formatPredictionSpan([Number.NaN])).toBe(NO_VALUE)
  })
})

describe('raceModelLabel', () => {
  it('renders the analysis layer keys as words', () => {
    expect(raceModelLabel('riegel')).toBe('Riegel')
    expect(raceModelLabel('ordinary_runs')).toBe('Ordinary runs')
  })

  it('passes an unknown model through rather than throwing', () => {
    // The model set belongs to analysis/fitness.py; a model added there
    // must degrade to its key rather than break the table.
    expect(raceModelLabel('pete_riegel_v2')).toBe('pete_riegel_v2')
  })
})

describe('fastestRankLabel', () => {
  it('reads rank 1 as plain "fastest", with no ordinal in front', () => {
    expect(fastestRankLabel(1)).toBe('fastest')
  })

  it('puts the English ordinal in front of every other rank', () => {
    expect(fastestRankLabel(2)).toBe('2nd fastest')
    expect(fastestRankLabel(3)).toBe('3rd fastest')
    expect(fastestRankLabel(4)).toBe('4th fastest')
    expect(fastestRankLabel(21)).toBe('21st fastest')
    expect(fastestRankLabel(22)).toBe('22nd fastest')
    expect(fastestRankLabel(23)).toBe('23rd fastest')
    expect(fastestRankLabel(101)).toBe('101st fastest')
  })

  it('reads the teens as "th", which is where the last-digit rule is wrong', () => {
    expect(fastestRankLabel(11)).toBe('11th fastest')
    expect(fastestRankLabel(12)).toBe('12th fastest')
    expect(fastestRankLabel(13)).toBe('13th fastest')
    expect(fastestRankLabel(111)).toBe('111th fastest')
    expect(fastestRankLabel(112)).toBe('112th fastest')
  })
})

describe('runCount', () => {
  it('counts runs in the plural, and one run in the singular', () => {
    expect(runCount(27)).toBe('27 runs')
    expect(runCount(1)).toBe('1 run')
    expect(runCount(0)).toBe('0 runs')
  })
})

describe('correlationLabel', () => {
  it('writes a coefficient to two decimals, keeping trailing zeros', () => {
    expect(correlationLabel(0.7)).toBe('0.70')
    expect(correlationLabel(0.736)).toBe('0.74')
    expect(correlationLabel(1)).toBe('1.00')
    expect(correlationLabel(-0.35)).toBe('-0.35')
  })

  it('prints a value that rounds to zero without a minus sign', () => {
    expect(correlationLabel(-0.004)).toBe('0.00')
    expect(correlationLabel(0)).toBe('0.00')
  })

  it('renders an absent or undefined coefficient as the no-value glyph', () => {
    expect(correlationLabel(null)).toBe(NO_VALUE)
    expect(correlationLabel(undefined)).toBe(NO_VALUE)
    expect(correlationLabel(Number.NaN)).toBe(NO_VALUE)
  })
})

describe('the Distributions bar values', () => {
  it('writes a count or a total with at most one decimal and no trailing zero', () => {
    expect(trimmedNumber(3)).toBe('3')
    expect(trimmedNumber(2.5)).toBe('2.5')
    expect(trimmedNumber(2.46)).toBe('2.5')
    expect(trimmedNumber(0)).toBe('0')
  })

  it('converts seconds to hours as a number, so a scale can pick round hours', () => {
    expect(hoursFromSeconds(5400)).toBe(1.5)
    expect(hoursFromSeconds(0)).toBe(0)
  })

  it('labels hours and shares with their unit', () => {
    expect(hoursLabel(2)).toBe('2 h')
    expect(hoursLabel(2.5)).toBe('2.5 h')
    expect(percentLabel(25)).toBe('25%')
    expect(percentLabel(12.5)).toBe('12.5%')
    expect(percentLabel(0)).toBe('0%')
  })
})

describe('ascentPerKm', () => {
  it('writes climb per kilometre to one decimal with its unit', () => {
    expect(ascentPerKm(5.269)).toBe('5.3 m/km')
    expect(ascentPerKm(0)).toBe('0.0 m/km')
  })

  it('is the bare no-value glyph with no value', () => {
    expect(ascentPerKm(null)).toBe(NO_VALUE)
    expect(ascentPerKm(Number.NaN)).toBe(NO_VALUE)
  })
})

describe('areaMeasure', () => {
  it('states square metres in square kilometres at two decimals', () => {
    expect(areaMeasure(12_345_678.9)).toEqual({ value: '12.35', unit: 'km²' })
    expect(areaMeasure(17_133.66)).toEqual({ value: '0.02', unit: 'km²' })
  })

  it('takes a digit count', () => {
    expect(areaMeasure(12_345_678.9, 1)).toEqual({ value: '12.3', unit: 'km²' })
  })

  it('renders a missing area as the bare glyph, never with a unit', () => {
    expect(areaMeasure(null)).toEqual({ value: NO_VALUE, unit: null })
    expect(areaMeasure(Number.NaN)).toEqual({ value: NO_VALUE, unit: null })
  })

  it('is the same answer as the composed string', () => {
    expect(area(34_594_989.97)).toBe('34.59 km²')
    expect(area(null)).toBe(NO_VALUE)
  })
})

describe('calendarDayOfDate', () => {
  it('is the day number of a bare calendar date, on the same axis as localCalendarTime', () => {
    // 2025-10-02 is day 20363, the figure Trends.test.tsx pins for a local run on that day.
    expect(calendarDayOfDate('2025-10-02')).toBe(20363)
  })
})

describe('formatWholeVo2max', () => {
  it('writes the watch number with no decimals', () => {
    expect(formatWholeVo2max(50)).toBe('50')
  })
  it('writes the no-value glyph for a missing number', () => {
    expect(formatWholeVo2max(undefined)).toBe(NO_VALUE)
  })
})
