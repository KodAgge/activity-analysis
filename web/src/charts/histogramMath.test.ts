import { describe, expect, it } from 'vitest'
import { variableById, type DistributionRun } from './distributionVariables'
import {
  barFormatter,
  barValues,
  bucketIndex,
  bucketListTitle,
  bucketRowParts,
  bucketRuns,
  bucketsFor,
  estimateLabelWidthPx,
  groupCaption,
  groupSeries,
  histogramScale,
  median,
  medianOf,
  medianScaleX,
  outlineSegments,
  positionOf,
  runsInBucket,
  shares,
  slotCentrePx,
  stepBucket,
  tally,
  variableCaption,
  xLabelIndices,
} from './histogramMath'

function run(overrides: Partial<DistributionRun> = {}): DistributionRun {
  return {
    activity_id: 'a1',
    start_time_utc: '2026-01-01T06:00:00Z',
    utc_offset_s: 3600,
    is_indoor: false,
    distance_m: 5000,
    moving_time_s: 1800,
    elapsed_time_s: 1850,
    avg_speed_mps: 2.78,
    avg_hr_bpm: 150,
    max_hr_bpm: 170,
    avg_cadence_spm: 160,
    ascent_per_km_m: 5,
    hr_at_median_bpm: 150,
    cadence_at_median_spm: 160,
    decoupling_pct: 3,
    is_aerobic_long_run: true,
    days_since_previous_run: 1,
    ...overrides,
  }
}

const distance = variableById('distance')
const avgCadence = variableById('avg_cadence')
const pace = variableById('pace')
const decoupling = variableById('decoupling')
const startHour = variableById('start_hour')
const weekday = variableById('weekday')
const movingTime = variableById('moving_time')

describe('bucketsFor: distance (1 km wide, open at 22 km)', () => {
  const runs = [1200, 6000, 6999, 25000].map((distance_m) => run({ distance_m }))
  const buckets = bucketsFor(distance, runs)

  it('runs a regular ladder from the floored minimum to the open edge, then one open bucket', () => {
    expect(buckets).toHaveLength(22)
    expect(buckets[0]?.key).toBe('1000')
    expect(buckets[19]?.key).toBe('20000')
    expect(buckets[20]?.key).toBe('21000')
    expect(buckets[21]?.key).toBe('above')
  })

  it('puts 6000 and 6999 in the same bucket', () => {
    const key6000 = buckets[bucketIndex(distance, buckets, 6000)]?.key
    const key6999 = buckets[bucketIndex(distance, buckets, 6999)]?.key
    expect(key6000).toBe('6000')
    expect(key6999).toBe('6000')
  })

  it('puts 25000 in the open bucket', () => {
    expect(buckets[bucketIndex(distance, buckets, 25000)]?.key).toBe('above')
  })
})

describe('bucketsFor: average cadence (2 spm wide, open below 140)', () => {
  const runs = [94, 139.9, 140, 171].map((avg_cadence_spm) => run({ avg_cadence_spm }))
  const buckets = bucketsFor(avgCadence, runs)

  it('opens the first bucket below 140', () => {
    expect(buckets[0]?.key).toBe('below')
    expect(bucketIndex(avgCadence, buckets, 94)).toBe(0)
    expect(bucketIndex(avgCadence, buckets, 139.9)).toBe(0)
  })

  it('lands exactly 140 in the regular bucket starting at 140, not the open one below it', () => {
    const idx = bucketIndex(avgCadence, buckets, 140)
    expect(buckets[idx]?.key).toBe('140')
  })

  it('labels the open-below bucket with no unit, since the axis carries spm', () => {
    expect(buckets[0]?.label).toBe('< 140')
  })
})

describe('bucketsFor: pace (15 s/km wide, open at or above 540)', () => {
  const runs = [539.9, 540].map((paceSecondsPerKm) => run({ avg_speed_mps: 1000 / paceSecondsPerKm }))
  const buckets = bucketsFor(pace, runs)

  it('sends exactly 540 to the open bucket', () => {
    expect(buckets[bucketIndex(pace, buckets, 540)]?.key).toBe('above')
  })

  it('sends 539.9 to the regular bucket starting at 525', () => {
    expect(buckets[bucketIndex(pace, buckets, 539.9)]?.key).toBe('525')
  })

  it('labels the open-above bucket in pace, not raw seconds per kilometre', () => {
    expect(buckets[bucketIndex(pace, buckets, 540)]?.label).toBe('≥ 9:00')
  })
})

describe('bucketsFor: pace labels a regular bucket in m:ss on both edges', () => {
  // A single value at 5:16/km floors to the 315-330 s/km bucket, i.e. 5:15 to 5:30.
  const runs = [316].map((paceSecondsPerKm) => run({ avg_speed_mps: 1000 / paceSecondsPerKm }))
  const buckets = bucketsFor(pace, runs)

  it('labels the regular bucket "5:15 to 5:30", never the bare seconds', () => {
    expect(buckets).toHaveLength(1)
    expect(buckets[0]?.label).toBe('5:15 to 5:30')
  })
})

describe('bucketsFor: decoupling (2.5 % wide, no open edges)', () => {
  const runs = [0, 5, 10].map((decoupling_pct) => run({ is_aerobic_long_run: true, decoupling_pct }))
  const buckets = bucketsFor(decoupling, runs)

  it('lands 5.0 in the bucket keyed 5, not 2.5 through float error', () => {
    // Fifty additions of 0.1 stop short of 5, at 4.999999999999998, which a
    // raw comparison against the edge at 5 puts in the bucket below.
    let five = 0
    for (let i = 0; i < 50; i++) five += 0.1
    expect(five).toBeLessThan(5)
    expect(buckets[bucketIndex(decoupling, buckets, five)]?.key).toBe('5')
  })
})

describe('bucketsFor: moving time (10 min wide, open at or above 2:20)', () => {
  // 90 minutes and 2:25:00, so the population reaches the open edge.
  const runs = [5400, 8700].map((moving_time_s) => run({ moving_time_s }))
  const buckets = bucketsFor(movingTime, runs)

  it('labels the open-above bucket in hours and minutes', () => {
    expect(buckets[buckets.length - 1]?.key).toBe('above')
    // Run time's open edge: `≥ 2:20`.
    expect(buckets[buckets.length - 1]?.label).toBe('≥ 2:20')
  })
})

describe('bucketsFor: empty and degenerate populations', () => {
  it('is empty for no values at all', () => {
    expect(bucketsFor(distance, [])).toEqual([])
    expect(bucketsFor(distance, [run({ distance_m: null })])).toEqual([])
  })

  it('is exactly one bucket for a single value', () => {
    expect(bucketsFor(distance, [run({ distance_m: 5000 })])).toHaveLength(1)
  })

  it('is exactly one bucket when every value is identical', () => {
    const runs = [run({ distance_m: 5000 }), run({ distance_m: 5000 }), run({ distance_m: 5000 })]
    expect(bucketsFor(distance, runs)).toHaveLength(1)
  })
})

describe('bucketsFor: categories', () => {
  it('carries all 24 hour buckets even when only some hold a run', () => {
    const runs = [7, 12, 22].map((hour) => run({ start_time_utc: `2026-01-01T${String(hour).padStart(2, '0')}:00:00Z`, utc_offset_s: 0 }))
    const buckets = bucketsFor(startHour, runs)
    expect(buckets).toHaveLength(24)
    expect(buckets.map((bucket) => bucket.key)).toEqual(Array.from({ length: 24 }, (_, hour) => String(hour)))
  })
})

describe('tally', () => {
  const runs = [
    run({ distance_m: 500, moving_time_s: 200 }),
    run({ distance_m: 1500, moving_time_s: 400 }),
    run({ distance_m: null, moving_time_s: null }),
  ]
  const buckets = bucketsFor(distance, runs)

  it('sums metres under the distance measure', () => {
    const result = tally(distance, buckets, runs, 'distance')
    expect(result.totals.reduce((a, b) => a + b, 0)).toBe(2000)
  })

  it('sums moving_time_s under the time measure', () => {
    const result = tally(distance, buckets, runs, 'time')
    expect(result.totals.reduce((a, b) => a + b, 0)).toBe(600)
  })

  it('counts a run with no value as missing, not zero', () => {
    const result = tally(distance, buckets, runs, 'runs')
    expect(result.counted).toBe(2)
    expect(result.missing).toBe(1)
  })
})

describe('shares', () => {
  it('is all zero, not NaN, when the sum is zero', () => {
    expect(shares([0, 0, 0])).toEqual([0, 0, 0])
  })

  it('normalises to a percentage of the sum', () => {
    expect(shares([1, 3])).toEqual([25, 75])
  })
})

describe('median', () => {
  it('is null with no values', () => {
    expect(median([])).toBeNull()
  })

  it('is the middle value on an odd count', () => {
    expect(median([3, 1, 2])).toBe(2)
  })

  it('averages the two middle values on an even count', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
})

describe('medianOf', () => {
  it('skips runs with no value for the variable', () => {
    const runs = [run({ distance_m: 1000 }), run({ distance_m: null }), run({ distance_m: 3000 })]
    expect(medianOf(distance, runs)).toBe(2000)
  })
})

describe('positionOf', () => {
  const runs = [1200, 6000, 6999, 25000].map((distance_m) => run({ distance_m }))
  const buckets = bucketsFor(distance, runs)

  it('places a value proportionally inside its regular bucket', () => {
    // 6500 is halfway through the 6000-7000 bucket.
    const idx = bucketIndex(distance, buckets, 6500)
    expect(positionOf(distance, buckets, 6500)).toBeCloseTo(idx + 0.5, 9)
  })

  it('places an open-bucket value at that bucket\'s centre', () => {
    const idx = bucketIndex(distance, buckets, 25000)
    expect(positionOf(distance, buckets, 25000)).toBeCloseTo(idx + 0.5, 9)
  })

  it('places a category at index + 0.5', () => {
    const hourRuns = [7, 22].map((hour) => run({ start_time_utc: `2026-01-01T${String(hour).padStart(2, '0')}:00:00Z`, utc_offset_s: 0 }))
    const hourBuckets = bucketsFor(startHour, hourRuns)
    const idx = bucketIndex(startHour, hourBuckets, 7)
    expect(positionOf(startHour, hourBuckets, 7)).toBe(idx + 0.5)
  })

  it('places a fractional category median continuously, rather than vanishing off an exact key', () => {
    // 2026-01-07 is a Wednesday (isoWeekday 3), 2026-01-08 a Thursday (4):
    // medianOf(weekday, ...) is 3.5, which bucketIndex/an exact key lookup
    // cannot place, and the median tick must not disappear for it.
    const weekdayRuns = [
      run({ start_time_utc: '2026-01-07T12:00:00Z', utc_offset_s: 0 }),
      run({ start_time_utc: '2026-01-08T12:00:00Z', utc_offset_s: 0 }),
    ]
    const weekdayBuckets = bucketsFor(weekday, weekdayRuns)
    const weekdayMedian = medianOf(weekday, weekdayRuns)
    expect(weekdayMedian).toBe(3.5)
    // Monday is key 1, the first bucket, so 3.5 sits at (3.5 - 1) + 0.5 = 3.0.
    expect(positionOf(weekday, weekdayBuckets, weekdayMedian as number)).toBe(3.0)
  })

  it('clamps a category position into [0, buckets.length]', () => {
    const restDays = variableById('days_since_previous_run')
    const buckets = bucketsFor(restDays, [run({ days_since_previous_run: 2 })])
    expect(positionOf(restDays, buckets, -5)).toBe(0)
    expect(positionOf(restDays, buckets, 50)).toBe(buckets.length)
  })
})

describe('runsInBucket', () => {
  it('is empty for a key naming no bucket', () => {
    const runs = [run({ distance_m: 1000 })]
    const buckets = bucketsFor(distance, runs)
    expect(runsInBucket(distance, buckets, 'not-a-real-key', runs)).toEqual([])
  })

  it('finds every run whose value falls in the named bucket', () => {
    const runs = [run({ activity_id: 'a', distance_m: 6000 }), run({ activity_id: 'b', distance_m: 6999 }), run({ activity_id: 'c', distance_m: 1200 })]
    const buckets = bucketsFor(distance, runs)
    const found = runsInBucket(distance, buckets, '6000', runs)
    expect(found.map((r) => r.activity_id).sort()).toEqual(['a', 'b'])
  })
})

describe('estimateLabelWidthPx', () => {
  it('is the widest label, at a fixed width per character', () => {
    // "140 to 142" is ten characters, the widest here.
    expect(estimateLabelWidthPx(['< 140', '140 to 142', '≥ 190'], 6)).toBe(60)
  })

  it('is zero for no labels, rather than the -Infinity of an empty Math.max', () => {
    expect(estimateLabelWidthPx([], 6)).toBe(0)
  })
})

describe('xLabelIndices', () => {
  // Ten buckets over a 300 px plot: every slot is 30 px, a label is 50 px
  // and wants 10 px of air, so every second slot at most carries one.
  const BASE = { count: 10, plotWidthPx: 300, labelWidthPx: 50, gapPx: 10, rightRoomPx: 40 }

  it('thins to every n-th bucket so neighbouring labels cannot touch', () => {
    const indices = xLabelIndices(BASE)
    expect(indices).toEqual([1, 3, 5, 7, 9])
    const slot = BASE.plotWidthPx / BASE.count
    for (let i = 1; i < indices.length; i++) {
      const gap = ((indices[i] ?? 0) - (indices[i - 1] ?? 0)) * slot
      expect(gap).toBeGreaterThanOrEqual(BASE.labelWidthPx + BASE.gapPx)
    }
  })

  it('never labels a bucket whose label would hang off the canvas on the left', () => {
    // Bucket 0's centre is 15 px from the plot's left edge, which is the
    // canvas edge, and half its label is 25 px: it would be sliced.
    expect(xLabelIndices(BASE)[0]).toBe(1)
  })

  it('lets the last label use the y-axis gutter on the right, and no more', () => {
    // With the 40 px gutter bucket 9's label ends at 310 of 340 and fits;
    // with none it ends past the 300 px plot and is dropped, and the
    // remaining ladder is re-centred in what does fit.
    expect(xLabelIndices(BASE).at(-1)).toBe(9)
    expect(xLabelIndices({ ...BASE, rightRoomPx: 0 })).toEqual([1, 3, 5, 7])
  })

  it('labels every bucket when there is room for all of them', () => {
    expect(xLabelIndices({ ...BASE, count: 5, plotWidthPx: 500 })).toEqual([0, 1, 2, 3, 4])
  })

  it('holds at least the label spacing at the 412 px phone width', () => {
    // A 412 px viewport less the 24 px gutter either side and the 40 px
    // axis column is a 324 px plot. Thirty-one cadence buckets of up to
    // ten characters: a slot is about 10 px, so a label spans several.
    const count = 31
    const plotWidthPx = 324
    const labelWidthPx = estimateLabelWidthPx(['140 to 142'], 6.5)
    const indices = xLabelIndices({ count, plotWidthPx, labelWidthPx, gapPx: 8, rightRoomPx: 40 })
    expect(indices.length).toBeGreaterThan(1)
    const slot = plotWidthPx / count
    for (let i = 1; i < indices.length; i++) {
      expect(((indices[i] ?? 0) - (indices[i - 1] ?? 0)) * slot).toBeGreaterThanOrEqual(labelWidthPx + 8)
    }
    const first = indices[0] ?? 0
    expect((first + 0.5) * slot - labelWidthPx / 2).toBeGreaterThanOrEqual(0)
  })

  it('has nothing to label with no buckets or an unmeasured plot', () => {
    expect(xLabelIndices({ ...BASE, count: 0 })).toEqual([])
    expect(xLabelIndices({ ...BASE, plotWidthPx: 0 })).toEqual([])
  })
})

describe('outlineSegments', () => {
  it('steps across each bucket at its value, from the baseline and back to it', () => {
    // Bucket i spans [i - 0.5, i + 0.5] on the x scale.
    expect(outlineSegments([2, 5])).toEqual([
      [
        [-0.5, 0],
        [-0.5, 2],
        [0.5, 2],
        [0.5, 5],
        [1.5, 5],
        [1.5, 0],
      ],
    ])
  })

  it('lifts the pen across an empty bucket rather than stroking the baseline', () => {
    // The zero rule is already there; an accent stroke along it would read
    // as a mark on the axis rather than as the second group having nothing.
    expect(outlineSegments([2, 0, 0, 3])).toEqual([
      [
        [-0.5, 0],
        [-0.5, 2],
        [0.5, 2],
        [0.5, 0],
      ],
      [
        [2.5, 0],
        [2.5, 3],
        [3.5, 3],
        [3.5, 0],
      ],
    ])
  })

  it('draws nothing for an empty group, whose shares are all zero', () => {
    expect(outlineSegments([0, 0, 0])).toEqual([])
    expect(outlineSegments([])).toEqual([])
  })
})

describe('medianScaleX', () => {
  it('converts a fractional bucket position to the x scale, where bucket i is centred on i', () => {
    // Position 0 is the left edge of bucket 0, which the scale puts at -0.5.
    expect(medianScaleX(0, 4)).toBe(-0.5)
    expect(medianScaleX(2.5, 4)).toBe(2)
    expect(medianScaleX(4, 4)).toBe(3.5)
  })

  it('has no tick for a missing median, or one positionOf could not place', () => {
    expect(medianScaleX(null, 4)).toBeNull()
    expect(medianScaleX(-1, 4)).toBeNull()
    expect(medianScaleX(4.5, 4)).toBeNull()
    expect(medianScaleX(Number.NaN, 4)).toBeNull()
    expect(medianScaleX(0, 0)).toBeNull()
  })
})

describe('stepBucket', () => {
  it('moves one bucket either way, and stops at the ends', () => {
    expect(stepBucket(2, 1, 5)).toBe(3)
    expect(stepBucket(2, -1, 5)).toBe(1)
    expect(stepBucket(4, 1, 5)).toBe(4)
    expect(stepBucket(0, -1, 5)).toBe(0)
  })

  it('enters from the end the key points away from', () => {
    expect(stepBucket(null, 1, 5)).toBe(0)
    expect(stepBucket(null, -1, 5)).toBe(4)
  })

  it('has nowhere to go with no buckets', () => {
    expect(stepBucket(null, 1, 0)).toBeNull()
    expect(stepBucket(3, 1, 0)).toBeNull()
  })
})

describe('slotCentrePx', () => {
  it('is half a slot into the bucket, from the plot origin', () => {
    // Four buckets over 400 px starting 12 px into the panel.
    expect(slotCentrePx(0, 4, 12, 400)).toBe(62)
    expect(slotCentrePx(3, 4, 12, 400)).toBe(362)
  })
})

describe('barValues', () => {
  it('is each group\'s share when comparing, whatever the measure', () => {
    expect(barValues([1, 3], 'runs', true)).toEqual([25, 75])
    expect(barValues([1800, 5400], 'time', true)).toEqual([25, 75])
  })

  it('is the absolute total otherwise, with time in hours so the scale picks round hours', () => {
    expect(barValues([1, 3], 'runs', false)).toEqual([1, 3])
    expect(barValues([6000, 12000], 'distance', false)).toEqual([6000, 12000])
    expect(barValues([1800, 5400], 'time', false)).toEqual([0.5, 1.5])
  })

  it('is all zeros for an empty group rather than NaN', () => {
    expect(barValues([0, 0], 'runs', true)).toEqual([0, 0])
  })
})

describe('barFormatter', () => {
  it('writes the unit the bars are in', () => {
    expect(barFormatter('runs', false)(3)).toBe('3')
    expect(barFormatter('distance', false)(20000)).toBe('20 km')
    expect(barFormatter('distance', false)(7300)).toBe('7.3 km')
    expect(barFormatter('time', false)(2.5)).toBe('2.5 h')
    expect(barFormatter('distance', true)(12.5)).toBe('12.5%')
  })

  it('hands back the same function for the same choice, so the chart is not rebuilt', () => {
    expect(barFormatter('distance', false)).toBe(barFormatter('distance', false))
    expect(barFormatter('runs', true)).toBe(barFormatter('time', true))
  })
})

describe('groupSeries', () => {
  const runs = [run({ distance_m: 5200 }), run({ distance_m: 6100 }), run({ distance_m: 6900 }), run({ distance_m: null })]
  const buckets = bucketsFor(distance, runs)

  it('tallies, normalises and places the median of one group', () => {
    const series = groupSeries(distance, buckets, runs, 'runs', false)
    expect(series.tally).toEqual({ totals: [1, 2], counted: 3, missing: 1 })
    expect(series.values).toEqual([1, 2])
    expect(series.median).toBe(6100)
    // 6100 m sits a tenth of the way into the 6 to 7 km bucket, index 1.
    expect(series.medianAt).toBeCloseTo(1.1, 9)
  })

  it('is shares when comparing', () => {
    const series = groupSeries(distance, buckets, runs, 'runs', true)
    expect(series.values[0]).toBeCloseTo(100 / 3, 9)
  })

  it('has no median and no tick for a group with no values', () => {
    const series = groupSeries(distance, buckets, [], 'runs', true)
    expect(series).toEqual({ tally: { totals: [0, 0], counted: 0, missing: 0 }, values: [0, 0], median: null, medianAt: null })
  })
})

describe('bucketRuns', () => {
  it('lists a bucket\'s runs newest first', () => {
    const older = run({ activity_id: 'older', start_time_utc: '2025-03-01T06:00:00Z', distance_m: 6100 })
    const newer = run({ activity_id: 'newer', start_time_utc: '2026-03-01T06:00:00Z', distance_m: 6500 })
    const other = run({ activity_id: 'other', start_time_utc: '2026-04-01T06:00:00Z', distance_m: 9000 })
    const runs = [older, newer, other]
    const buckets = bucketsFor(distance, runs)
    expect(bucketRuns(distance, buckets, '6000', runs).map((r) => r.activity_id)).toEqual(['newer', 'older'])
  })

  it('is empty for a key that names no bucket', () => {
    const runs = [run()]
    expect(bucketRuns(distance, bucketsFor(distance, runs), 'nonsense', runs)).toEqual([])
  })
})

describe('groupCaption', () => {
  it('counts the runs with a value against the group, and says how many were left out', () => {
    expect(groupCaption(null, { totals: [], counted: 7, missing: 3 }, '150 bpm')).toBe(
      '7 of 10 runs, 3 left out, median run 150 bpm',
    )
  })

  it('never drops the count when nothing is missing', () => {
    expect(groupCaption('2024', { totals: [], counted: 8, missing: 0 }, '6.02 km')).toBe(
      '2024: 8 of 8 runs, median run 6.02 km',
    )
  })

  it('reads an empty group as zero of zero, with no median', () => {
    expect(groupCaption('Weekends', { totals: [], counted: 0, missing: 0 }, null)).toBe('Weekends: 0 of 0 runs')
  })
})

describe('variableCaption', () => {
  it('names the variable and its unit', () => {
    expect(variableCaption(variableById('avg_hr'), null, 'runs', false)).toBe('Average heart rate, bpm.')
    expect(variableCaption(variableById('pace'), null, 'runs', false)).toBe('Average pace, min/km.')
  })

  it('names a unitless variable alone', () => {
    expect(variableCaption(weekday, null, 'runs', false)).toBe('Weekday.')
  })

  it('names the reference pace from the payload', () => {
    expect(variableCaption(variableById('cadence_at_reference'), 2.6667, 'runs', false)).toBe('Cadence at 6:15/km, spm.')
  })

  it('says what a comparison\'s bars are a share of', () => {
    expect(variableCaption(distance, null, 'distance', true)).toBe(
      'Distance, km. Each bar is a share of its own group\'s kilometres.',
    )
    expect(variableCaption(distance, null, 'runs', true)).toContain('its own group\'s runs')
    expect(variableCaption(distance, null, 'time', true)).toContain('its own group\'s hours')
  })

  it('carries the variable\'s own note', () => {
    expect(variableCaption(decoupling, null, 'runs', false)).toBe(`Aerobic decoupling, %. ${decoupling.note ?? ''}`)
  })
})

describe('histogramScale', () => {
  it('rounds the midpoint rule up to a whole run when the bars count runs', () => {
    // 5 runs would put the midpoint at 2.5 runs.
    expect(histogramScale(5, true)).toEqual({ max: 6, splits: [0, 3, 6] })
    // One run would put it at 0.5.
    expect(histogramScale(1, true)).toEqual({ max: 2, splits: [0, 1, 2] })
    expect(histogramScale(3, true)).toEqual({ max: 4, splits: [0, 2, 4] })
  })

  it('keeps a ladder that is already whole', () => {
    expect(histogramScale(45, true)).toEqual({ max: 50, splits: [0, 25, 50] })
    expect(histogramScale(8, true)).toEqual({ max: 8, splits: [0, 4, 8] })
  })

  it('keeps fractional rungs for kilometres, hours and shares', () => {
    expect(histogramScale(5, false)).toEqual({ max: 5, splits: [0, 2.5, 5] })
  })

  it('is a single rule at zero for nothing to draw', () => {
    expect(histogramScale(0, true)).toEqual({ max: 1, splits: [0] })
  })
})

describe('bucketListTitle', () => {
  it('names a category bucket the way a reader reads it', () => {
    const hours = bucketsFor(startHour, [])
    expect(bucketListTitle(startHour, hours[17]!, 'All runs')).toBe('All runs, 17:00')
    const rest = variableById('days_since_previous_run')
    expect(bucketListTitle(rest, bucketsFor(rest, []).at(-1)!, 'All runs')).toBe('All runs, 7+ days')
    expect(bucketListTitle(weekday, bucketsFor(weekday, [])[5]!, 'Weekends')).toBe('Weekends, Sat')
  })

  it('names a numeric bucket by its range and unit', () => {
    const buckets = bucketsFor(distance, [run({ distance_m: 6500 })])
    expect(bucketListTitle(distance, buckets[0]!, 'All runs')).toBe('All runs, 6 to 7 km')
  })

  it('names a duration bucket by its range alone, whose h:mm carries its own shape', () => {
    const buckets = bucketsFor(movingTime, [run({ moving_time_s: 1800 })])
    expect(bucketListTitle(movingTime, buckets[0]!, 'All runs')).toBe('All runs, 0:30 to 0:40')
  })
})

describe('bucketRowParts', () => {
  // 6 km at 6:00/km.
  const sixK = run({ distance_m: 6000, avg_speed_mps: 1000 / 360, avg_hr_bpm: 151 })

  it("shows the variable's value, with distance and pace as meta", () => {
    expect(bucketRowParts(variableById('avg_hr'), sixK)).toEqual({ value: '151 bpm', meta: ['6.00 km', '6:00/km'] })
  })

  it('shows the distance for a variable the start time already names, so the row does not repeat its own label', () => {
    for (const variable of [startHour, weekday, variableById('month')]) {
      expect(bucketRowParts(variable, sixK)).toEqual({ value: '6.00 km', meta: ['6:00/km'] })
    }
  })

  it('does not repeat distance or pace in the meta when it is the value', () => {
    expect(bucketRowParts(distance, sixK)).toEqual({ value: '6.00 km', meta: ['6:00/km'] })
    expect(bucketRowParts(pace, sixK)).toEqual({ value: '6:00/km', meta: ['6.00 km'] })
  })

  it('shows the no-value mark for a run with no value', () => {
    expect(bucketRowParts(variableById('avg_hr'), { ...sixK, avg_hr_bpm: null }).value).toBe('–')
  })
})
