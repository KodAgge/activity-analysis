import { describe, expect, it } from 'vitest'
import { localCalendarDay, localCalendarTime } from '../format'
import {
  alignSeries,
  axisRange,
  axisScale,
  bandRange,
  dateAxisSplits,
  dateTickLabels,
  paddedDayRange,
  seriesExtent,
  type TrendSeries,
} from './trendChartMath'

function day(date: string): number {
  return localCalendarDay(`${date}T12:00:00Z`, 0)
}

describe('alignSeries', () => {
  it('puts every series on one shared, sorted x axis', () => {
    const series: TrendSeries[] = [
      { label: 'a', points: [{ t: 3, v: 30 }, { t: 1, v: 10 }] },
      { label: 'b', points: [{ t: 2, v: 20 }] },
    ]
    const aligned = alignSeries(series)
    expect(aligned.x).toEqual([1, 2, 3])
    // A series with no point at another's instant is undefined there, not
    // null: uPlot draws through undefined and breaks only at null.
    expect(aligned.ys).toEqual([
      [10, undefined, 30],
      [undefined, 20, undefined],
    ])
  })

  it('draws a series on its own time base through the other series\' instants rather than breaking at each', () => {
    // Garmin's VO2max is one point per calendar day, the estimates one per
    // run, and the two almost never share an instant. Were each missing
    // instant a null, every line would break at every point of the other
    // and draw as dashes.
    const aligned = alignSeries([
      { label: 'per run', points: [{ t: 1.7, v: 50 }, { t: 3.7, v: null }, { t: 5.7, v: 52 }] },
      { label: 'per day', points: [{ t: 2, v: 48 }, { t: 4, v: 49 }] },
    ])
    expect(aligned.x).toEqual([1.7, 2, 3.7, 4, 5.7])
    expect(aligned.ys[0]).toEqual([50, undefined, null, undefined, 52])
    expect(aligned.ys[1]).toEqual([undefined, 48, undefined, 49, undefined])
  })

  it('keeps a null value as a null, so the line breaks there rather than interpolating', () => {
    // A run that produced no fit is a gap, not a straight segment through it.
    const aligned = alignSeries([{ label: 'a', points: [{ t: 1, v: 10 }, { t: 2, v: null }, { t: 3, v: 30 }] }])
    expect(aligned.ys[0]).toEqual([10, null, 30])
  })

  it('carries each point\'s note to its x position', () => {
    const aligned = alignSeries([
      { label: 'a', points: [{ t: 1, v: 10, note: 'easy' }, { t: 2, v: 12 }] },
      { label: 'b', points: [{ t: 2, v: 20, note: 'all_out' }] },
    ])
    expect(aligned.notes).toEqual(['easy', 'all_out'])
  })

  it('keeps two runs on the same day at different times as two x positions', () => {
    // A morning easy run and an evening all-out session on one day are two
    // points, in time order, each under its own effort tag. Collapsing them
    // to the day dropped the earlier run from every chart with no indication.
    const morning = localCalendarTime('2025-10-01T06:00:00Z', 7200)
    const evening = localCalendarTime('2025-10-01T16:00:00Z', 7200)
    const aligned = alignSeries([
      { label: 'a', points: [{ t: evening, v: 158, note: 'All out' }, { t: morning, v: 150, note: 'Easy' }] },
    ])
    expect(aligned.x).toEqual([morning, evening])
    expect(aligned.ys[0]).toEqual([150, 158])
    expect(aligned.notes).toEqual(['Easy', 'All out'])
  })

  it('collapses two points at the identical instant into one x position, value and note from the same point', () => {
    // uPlot needs strictly increasing x. When the later point wins the
    // value, its note wins too: a value shown under another run's effort
    // tag is the exact confusion the tag exists to prevent.
    const aligned = alignSeries([
      { label: 'a', points: [{ t: 5, v: 150, note: 'Easy' }, { t: 5, v: 158, note: 'All out' }] },
    ])
    expect(aligned.x).toEqual([5])
    expect(aligned.ys[0]).toEqual([158])
    expect(aligned.notes).toEqual(['All out'])
  })

  it('trims the axis to the first and last observed instant, so no tick names a year the chart never reaches', () => {
    // On the store of 2026-09-12, 51 of the 208 runs the efficiency fit
    // covered carried no heart rate at all, all of them the oldest stretch,
    // so untrimmed the heart rate chart's x scale ran over a year at which
    // every series was null: 35.0% of the plot's width held no ink and the
    // first tick named a year the chart never reaches. See `alignSeries`.
    const aligned = alignSeries([
      { label: 'a', points: [{ t: 1, v: null }, { t: 2, v: null }, { t: 3, v: 30 }, { t: 4, v: null }] },
      { label: 'b', points: [{ t: 1, v: null }, { t: 3, v: null }, { t: 4, v: null }] },
    ])
    expect(aligned.x).toEqual([3])
    expect(aligned.ys).toEqual([[30], [null]])
  })

  it('keeps an interior all-null instant, so the line still breaks there rather than being joined across it', () => {
    // The distinction the trim turns on. A run between two observations
    // that produced no fit is a gap in the record; dropping it would join
    // its neighbours with a straight segment through a value nobody
    // measured, which is what `spanGaps` would do and why it is off.
    const aligned = alignSeries([
      { label: 'a', points: [{ t: 1, v: 10 }, { t: 2, v: null }, { t: 3, v: 30 }] },
      { label: 'b', points: [{ t: 2, v: null }] },
    ])
    expect(aligned.x).toEqual([1, 2, 3])
    expect(aligned.ys[0]).toEqual([10, null, 30])
  })

  it('is empty when no series has a value anywhere, rather than an axis over nothing', () => {
    expect(alignSeries([{ label: 'a', points: [{ t: 1, v: null }] }]).x).toEqual([])
  })
})

describe('seriesExtent', () => {
  it('spans every series, ignoring the nulls between them', () => {
    const aligned = alignSeries([
      { label: 'a', points: [{ t: 1, v: 148 }, { t: 2, v: null }, { t: 3, v: 197.2 }] },
      { label: 'b', points: [{ t: 1, v: 117.4 }, { t: 3, v: 160 }] },
    ])
    expect(seriesExtent(aligned)).toEqual([117.4, 197.2])
  })

  it('is null when nothing has a value, so the caller states the absence rather than scaling to nothing', () => {
    expect(seriesExtent(alignSeries([{ label: 'a', points: [{ t: 1, v: null }] }]))).toBeNull()
  })

  it('spans only the rows it is given, which is what lets a split chart solve one extent per band', () => {
    // The subject and its raw inputs have to be solved apart, or the band
    // fitted to the lines is fitted to the scatter that forced the split.
    const aligned = alignSeries([
      { label: 'slow', points: [{ t: 1, v: 152 }, { t: 2, v: 174 }] },
      { label: 'per run', scatter: true, faint: true, points: [{ t: 1, v: 127.5 }, { t: 2, v: 197 }] },
    ])
    expect(seriesExtent(aligned, [0])).toEqual([152, 174])
    expect(seriesExtent(aligned, [1])).toEqual([127.5, 197])
    expect(seriesExtent(aligned)).toEqual([127.5, 197])
  })

  it('is null for a row that has no value, rather than reaching past the rows it was given', () => {
    const aligned = alignSeries([
      { label: 'a', points: [{ t: 1, v: 10 }] },
      { label: 'b', points: [{ t: 1, v: null }] },
    ])
    expect(seriesExtent(aligned, [1])).toBeNull()
  })
})

describe('axisScale', () => {
  /**
   * The one thing every case must satisfy: the labelled range and the drawn
   * range are the same range. Asserted as a helper so no case can forget it.
   */
  function covers(dataMin: number, dataMax: number, maxIntervals?: number) {
    const scale = axisScale(dataMin, dataMax, maxIntervals)
    expect(scale.min).toBeLessThanOrEqual(dataMin)
    expect(scale.max).toBeGreaterThanOrEqual(dataMax)
    // The bounds are themselves ticks, so a rule is drawn at both ends.
    expect(scale.splits[0]).toBe(scale.min)
    expect(scale.splits[scale.splits.length - 1]).toBe(scale.max)
    // Evenly spaced, which is what makes a ladder readable at all.
    const step = (scale.max - scale.min) / (scale.splits.length - 1)
    for (const [i, s] of scale.splits.entries()) {
      expect(s).toBeCloseTo(scale.min + i * step, 6)
    }
    return scale
  }

  it('contains the whole series, for a spread shaped like the real one that escaped its own axis', () => {
    // The measured fault's shape, with the analytic answer written out. On
    // the real heart rate chart uPlot drew four rules and part of the data
    // sat below the lowest labelled one with no rule and no label under it;
    // a synthetic 118.5 to 196.5 against rules at 140, 160, 180 and 200
    // reproduces that.
    const scale = covers(118.5, 196.5)
    expect(scale.min).toBe(100)
    expect(scale.max).toBe(200)
    expect(scale.splits).toEqual([100, 120, 140, 160, 180, 200])
  })

  it('contains the series for a spread of any shape', () => {
    // Cadence, decoupling either side of zero, a VO2max band, a slope in
    // single digits, a decimal band and a huge one. Every one has to hold.
    covers(155.5, 178.5)
    covers(-12.4, 31.8)
    covers(30.5, 60.5)
    covers(-3.1, 48.6)
    covers(0.42, 0.97)
    covers(12, 98_000)
  })

  it('never anchors to zero, because the finding is a small yearly change on a band far from zero', () => {
    // On a zero-anchored axis a year of change is under 5% of the panel
    // height; `axisScale`'s doc has the measurement.
    const scale = axisScale(148, 162)
    expect(scale.min).toBeGreaterThan(100)
    expect(scale.max).toBeLessThan(200)
  })

  it('gives a flat series a visible band rather than a zero-height one', () => {
    const scale = covers(150, 150)
    expect(scale.max - scale.min).toBeGreaterThan(0)
  })

  it('keeps the ladder inside its budget of labelled bands', () => {
    // Flooring and ceiling can each add an interval, so a first guess that
    // exactly fits the band overflows; the solver steps up rather than
    // returning more rungs than the panel can label.
    for (const [lo, hi] of [
      [99.9, 199.9],
      [118.5, 196.5],
      [1.01, 9.99],
      [-0.4, 0.4],
    ] as const) {
      expect(covers(lo, hi).splits.length).toBeLessThanOrEqual(6)
    }
  })

  it('emits ticks free of floating-point drift, so no label reads 2.5000000000000004', () => {
    // Built by multiplying the index rather than by repeated addition.
    const scale = axisScale(0.1, 1.1)
    for (const s of scale.splits) expect(String(s)).not.toMatch(/\d{6}/)
  })
})

describe('bandRange', () => {
  /** Where a value lands as a fraction of the plot's height, 0 at the bottom. */
  function at(range: [number, number], value: number): number {
    return (value - range[0]) / (range[1] - range[0])
  }

  it('puts a ladder in the part of the height it was asked for', () => {
    // The whole mechanism of a split chart: uPlot maps a scale across the
    // whole plot box, so confining a series to a band means widening its
    // scale past its data by exactly the right amount.
    const scale = axisScale(150.96, 170.71)
    const range = bandRange(scale, 0.38, 0.98)
    expect(at(range, scale.min)).toBeCloseTo(0.38, 9)
    expect(at(range, scale.max)).toBeCloseTo(0.98, 9)
  })

  it('places the strip and the subject without overlapping', () => {
    const subject = bandRange(axisScale(151.7, 174.0), 0.38, 0.98)
    const strip = bandRange(axisScale(127.8, 196.6, 1), 0.02, 0.16)
    expect(at(strip, 196.6)).toBeLessThan(at(subject, 151.7))
  })

  it('never moves a tick, only where the band lands', () => {
    // The ticks are the labels, and a widened range must not reach them:
    // every number written stays a value the data reaches.
    const scale = axisScale(117.4, 197.2)
    const before = [...scale.splits]
    bandRange(scale, 0.02, 0.16)
    expect(scale.splits).toEqual(before)
    expect(scale.min).toBe(100)
    expect(scale.max).toBe(200)
  })

  it('returns the ladder unchanged rather than dividing by zero on a band of no height', () => {
    const scale = axisScale(10, 20)
    expect(bandRange(scale, 0.5, 0.5)).toEqual([scale.min, scale.max])
  })
})

describe('axisRange', () => {
  it('puts the outer rules inside the plot, so an extreme mark is drawn whole', () => {
    // The ticks cover the data exactly, which means the extreme mark lands
    // on the bound and the canvas edge slices it in half - the 9 px
    // latest-observation halo worst of all. The overhang is on the scale
    // only, never on the ticks, so every rule stays a round number.
    const scale = axisScale(117.4, 197.2)
    const [min, max] = axisRange(scale)
    expect(min).toBeLessThan(scale.min)
    expect(max).toBeGreaterThan(scale.max)
    expect(scale.min - min).toBeCloseTo(max - scale.max, 9)
    expect(scale.splits).toEqual([100, 120, 140, 160, 180, 200])
  })
})

describe('paddedDayRange', () => {
  it('gives a mark at either extreme room to be drawn whole', () => {
    // The plot's left edge is the page gutter with zero uPlot padding, so a
    // point centred on the bound loses half of itself off the canvas.
    // Without a width - the first frame, before uPlot has measured itself -
    // the pad falls back to 1.5% of the span.
    const [min, max] = paddedDayRange(20000, 21000)
    expect(min).toBeLessThan(20000)
    expect(max).toBeGreaterThan(21000)
    expect(20000 - min).toBeCloseTo(15, 6)
    expect(max - 21000).toBeCloseTo(15, 6)
  })

  it('solves the pad against the plot width, because the clearance is a pixel measurement', () => {
    // A fraction that clears a 10 px mark on a 308 px phone plot leaves ten
    // times the needed dead space on a 920 px desktop one. Given the width,
    // the pad puts the extreme mark's centre exactly `clearance` pixels
    // inside the bound: 10 of (300 - 20) usable pixels, of a 1000-day span.
    const [min, max] = paddedDayRange(20000, 21000, 300, 10)
    expect(20000 - min).toBeCloseTo((1000 * 10) / 280, 6)
    expect(max - 21000).toBeCloseTo((1000 * 10) / 280, 6)
  })

  it('gives a single instant a band rather than a zero-width scale', () => {
    // Every point on one day is a real state - one run, or two at the same
    // instant - and uPlot cannot divide by a span of nothing.
    expect(paddedDayRange(20362, 20362)).toEqual([20361.5, 20362.5])
  })
})

describe('dateAxisSplits', () => {
  it('ticks at month starts over a span of a few months', () => {
    const splits = dateAxisSplits(day('2026-03-14'), day('2026-07-20'), 800)
    const dates = splits.map((d) => new Date(d * 86_400_000).toISOString().slice(0, 10))
    expect(dates).toEqual(['2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01'])
  })

  it('thins to a uniform stride of months when the span is longer, never dropping odd ticks', () => {
    const splits = dateAxisSplits(day('2024-01-15'), day('2025-12-15'), 800)
    // Every gap is the same number of months - a ladder stepping 1, 1, 1, 2
    // reads as an error even though every label on it is true.
    const months = splits.map((d) => {
      const date = new Date(d * 86_400_000)
      return date.getUTCFullYear() * 12 + date.getUTCMonth()
    })
    const gaps = months.slice(1).map((m, i) => m - (months[i] ?? 0))
    expect(new Set(gaps).size).toBe(1)
    expect(splits.length).toBeLessThanOrEqual(12)
    expect(splits.length).toBeGreaterThanOrEqual(4)
  })

  it('ticks at year starts over the whole history', () => {
    // A span of two years and ten months, a history of the order the
    // efficiency fit covers. At a narrow width the stride reaches a year and
    // every tick is a 1 January.
    const splits = dateAxisSplits(day('2021-11-01'), day('2024-08-31'), 320)
    const dates = splits.map((d) => new Date(d * 86_400_000).toISOString().slice(5, 10))
    expect(dates.every((d) => d === '01-01')).toBe(true)
    expect(splits.length).toBe(3)
  })

  it('places every tick inside the range', () => {
    const min = day('2024-01-15')
    const max = day('2025-12-15')
    for (const split of dateAxisSplits(min, max, 800)) {
      expect(split).toBeGreaterThanOrEqual(min)
      expect(split).toBeLessThanOrEqual(max)
    }
  })

  it('places whole-day month ticks inside a range with fractional bounds', () => {
    // The points are fractional days (`localCalendarTime`), so the scale's
    // min and max are too; the ticks themselves must stay whole month starts
    // and must not be lost to the range filter on either side.
    const min = localCalendarTime('2026-03-31T20:00:00Z', 7200)
    const max = localCalendarTime('2026-07-01T05:00:00Z', 7200)
    const splits = dateAxisSplits(min, max, 800)
    expect(splits.every((d) => Number.isInteger(d))).toBe(true)
    const dates = splits.map((d) => new Date(d * 86_400_000).toISOString().slice(0, 10))
    expect(dates).toEqual(['2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01'])
    for (const split of splits) {
      expect(split).toBeGreaterThanOrEqual(min)
      expect(split).toBeLessThanOrEqual(max)
    }
  })

  it('falls back to whole-day ticks when the range holds no first of the month', () => {
    // The progression chart pads a distance's history by 14 days either
    // side, so a single mid-March effort spans 2 March to 30 March and
    // contains no 1st. Month starts alone left that axis with no date
    // ticks at all.
    const min = day('2025-03-02')
    const max = day('2025-03-30')
    const splits = dateAxisSplits(min, max, 800)
    expect(splits.length).toBeGreaterThanOrEqual(3)
    for (const split of splits) {
      expect(Number.isInteger(split)).toBe(true)
      expect(split).toBeGreaterThanOrEqual(min)
      expect(split).toBeLessThanOrEqual(max)
    }
    // Uniform, like every other ladder here.
    const gaps = splits.slice(1).map((s, i) => s - (splits[i] ?? 0))
    expect(new Set(gaps).size).toBe(1)
  })

  it('thins the day ladder on a narrow panel rather than crowding it', () => {
    const splits = dateAxisSplits(day('2025-03-02'), day('2025-03-30'), 160)
    expect(splits.length).toBeGreaterThan(0)
    expect(splits.length).toBeLessThanOrEqual(2)
  })

  it('keeps a month ladder on a long range whose coarse stride skips every month start', () => {
    // At a plot under 216px only two ticks fit, so a four-year span picks the
    // 60-month stride, whose multiples are the Januaries of years divisible
    // by five - and 2020-12-05 to 2024-12-20 holds none of those. Falling
    // straight to the day ladder there gave 106 whole-day ticks, every one
    // labelled `D Mon` with no year, on a four-year axis. The retry at finer
    // month strides is what keeps this a calendar ladder.
    const min = day('2020-12-05')
    const max = day('2024-12-20')
    const splits = dateAxisSplits(min, max, 200)
    expect(splits.length).toBeGreaterThanOrEqual(1)
    expect(splits.length).toBeLessThanOrEqual(2)
    for (const split of splits) {
      expect(new Date(split * 86_400_000).getUTCDate()).toBe(1)
      expect(split).toBeGreaterThanOrEqual(min)
      expect(split).toBeLessThanOrEqual(max)
    }
    // A month ladder, so the labels carry the year the day ladder drops.
    expect(dateTickLabels(splits).every((l) => /\d{4}$/.test(l))).toBe(true)
  })

  it('still reaches the day ladder for a range that genuinely holds no first of the month', () => {
    // The retry above must not swallow the case the fallback exists for: no
    // month stride, however fine, can find a 1st inside 2 to 30 March.
    const splits = dateAxisSplits(day('2025-03-02'), day('2025-03-30'), 800)
    expect(splits.length).toBeGreaterThanOrEqual(3)
    expect(splits.some((d) => new Date(d * 86_400_000).getUTCDate() !== 1)).toBe(true)
    expect(dateTickLabels(splits).every((l) => /^\d{1,2} [A-Z][a-z]{2}$/.test(l))).toBe(true)
  })

  it('returns nothing for an empty or inverted range rather than looping', () => {
    expect(dateAxisSplits(10, 10, 800)).toEqual([])
    expect(dateAxisSplits(20, 10, 800)).toEqual([])
  })
})

describe('dateTickLabels', () => {
  it('labels month ticks with the month and the year, since a trend spans years', () => {
    expect(dateTickLabels([day('2025-10-01'), day('2025-11-01')])).toEqual(['Oct 2025', 'Nov 2025'])
  })

  it('labels a ladder of 1 Januaries with bare years', () => {
    expect(dateTickLabels([day('2024-01-01'), day('2025-01-01')])).toEqual(['2024', '2025'])
  })

  it('keeps the month on a single 1 January when the other ticks are months', () => {
    expect(dateTickLabels([day('2024-12-01'), day('2025-01-01')])).toEqual(['Dec 2024', 'Jan 2025'])
  })

  it('labels a day ladder as a day and a month, with no year to repeat', () => {
    expect(dateTickLabels([day('2025-03-08'), day('2025-03-15')])).toEqual(['8 Mar', '15 Mar'])
  })

  it('labels the real day ladder the March fallback produces', () => {
    const splits = dateAxisSplits(day('2025-03-02'), day('2025-03-30'), 800)
    for (const label of dateTickLabels(splits)) {
      expect(label).toMatch(/^\d{1,2} [A-Z][a-z]{2}$/)
    }
  })

  it('is empty for no ticks', () => {
    expect(dateTickLabels([])).toEqual([])
  })
})
