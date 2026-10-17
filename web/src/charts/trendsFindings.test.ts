import { describe, expect, it } from 'vitest'
import type { components } from '../api/schema'
import {
  HOUR_OR_MORE_FIT_SECONDS,
  MIN_CORRELATION_PAIRS,
  MIN_MEDIAN_RUNS,
  MIN_RATIO_PAIRS,
  MIN_TREND_RUNS,
  cadenceLevelTrend,
  cadenceSlopeTrend,
  decouplingAcrossSessions,
  decouplingLevels,
  estimatesAgainstDevice,
  heartRateEstimateAgainstVdot,
  heartRateRecordStart,
  heartRateStepAgainstGap,
  linearTrend,
  mean,
  median,
  pairWithDevice,
  pearson,
  sampleStandardDeviation,
  sideOf,
} from './trendsFindings'

type TrendPoint = components['schemas']['TrendPoint']
type FitnessPoint = components['schemas']['FitnessPoint']

/** Day `day` of October 2025 at noon UTC, so no offset in these tests moves a run across midnight unless it means to. */
function octoberNoon(day: number): string {
  return `2025-10-${String(day).padStart(2, '0')}T12:00:00Z`
}

/** A run `i` days after 2025-01-01, at noon UTC. */
function dayAfterNewYear(i: number): string {
  return new Date(Date.UTC(2025, 0, 1 + i, 12)).toISOString().replace('.000Z', 'Z')
}

function run(overrides: Partial<TrendPoint> = {}): TrendPoint {
  return {
    activity_id: 'run',
    start_time_utc: '2025-01-01T12:00:00Z',
    utc_offset_s: 0,
    effort_tag: 'steady',
    hr_at_slow_bpm: 140,
    hr_at_median_bpm: 142,
    hr_at_fast_bpm: 144,
    cadence_at_slow_spm: 160,
    cadence_at_median_spm: 162,
    cadence_at_fast_spm: 164,
    hr_at_slow_smoothed_bpm: 140,
    hr_at_median_smoothed_bpm: 142,
    hr_at_fast_smoothed_bpm: 144,
    cadence_at_slow_smoothed_spm: 160,
    cadence_at_median_smoothed_spm: 162,
    cadence_at_fast_smoothed_spm: 164,
    hr_slope_shrunk_bpm_per_mps: 20,
    hr_slope_weight: 0.5,
    cadence_slope_shrunk_spm_per_mps: 12,
    cadence_slope_weight: 0.5,
    decoupling_pct: 4,
    is_aerobic_long_run: true,
    decoupling_smoothed_pct: 4,
    fit_seconds: 2400,
    ...overrides,
  }
}

const NO_HEART_RATE = { hr_at_slow_bpm: null, hr_at_median_bpm: null, hr_at_fast_bpm: null } as const

function fitness(overrides: Partial<FitnessPoint> = {}): FitnessPoint {
  return {
    activity_id: 'run',
    start_time_utc: '2025-10-01T12:00:00Z',
    hr_vo2max: 50,
    hr_vo2max_smoothed: 50,
    vdot: 40,
    vdot_distance_key: '5k',
    vdot_smoothed: 40,
    qualifying_segments: 40,
    ...overrides,
  }
}

describe('the summary statistics', () => {
  it('takes the middle value, or the mean of the two middle ones', () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBeNull()
  })

  it('averages, and has no mean of nothing', () => {
    expect(mean([1, 2, 6])).toBe(3)
    expect(mean([])).toBeNull()
  })

  it('divides the squared deviations by n - 1', () => {
    // Mean 5, squared deviations summing to 32: the population SD is 2 and
    // the sample SD sqrt(32 / 7).
    expect(sampleStandardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 12)
    expect(sampleStandardDeviation([3])).toBeNull()
  })

  it('correlates a straight line at exactly one, either sign', () => {
    expect(pearson([1, 2, 3, 4], [3, 5, 7, 9])).toBeCloseTo(1, 12)
    expect(pearson([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 12)
  })

  it('correlates a noisy line at Sxy over the root of Sxx Syy', () => {
    // Deviations -1.5, -0.5, 0.5, 1.5 and -3, -1, 0, 4: Sxy 11, Sxx 5, Syy 26.
    expect(pearson([1, 2, 3, 4], [2, 4, 5, 9])).toBeCloseTo(11 / Math.sqrt(130), 12)
  })

  it('has no correlation with a constant series', () => {
    expect(pearson([1, 2, 3], [5, 5, 5])).toBeNull()
  })
})

describe('linearTrend', () => {
  it('fits the least squares line and the textbook standard error of its slope', () => {
    // x 0..4, y 1, 3, 2, 5, 4: Sxy 8 over Sxx 10 gives 0.8, the residuals
    // -0.4, 0.8, -1.0, 1.2, -0.6 square to 3.6, so SE = sqrt(3.6 / 3 / 10).
    const fit = linearTrend([0, 1, 2, 3, 4], [1, 3, 2, 5, 4])
    expect(fit?.n).toBe(5)
    expect(fit?.slope).toBeCloseTo(0.8, 12)
    expect(fit?.standardError).toBeCloseTo(Math.sqrt(0.12), 12)
    expect(fit?.t).toBeCloseTo(0.8 / Math.sqrt(0.12), 12)
  })

  it('gives the same t whatever unit x is in', () => {
    const days = linearTrend([0, 1, 2, 3, 4], [1, 3, 2, 5, 4])
    const years = linearTrend([0, 1, 2, 3, 4].map((d) => d / 365.25), [1, 3, 2, 5, 4])
    expect(years?.t).toBeCloseTo(days?.t ?? Number.NaN, 9)
  })

  it('has no trend over fewer than three points, one x, or a perfect fit', () => {
    expect(linearTrend([0, 1], [1, 2])).toBeNull()
    expect(linearTrend([2, 2, 2], [1, 2, 3])).toBeNull()
    expect(linearTrend([0, 1, 2], [1, 2, 3])).toBeNull()
  })
})

describe('sideOf', () => {
  it('compares at the one decimal the page prints', () => {
    expect(sideOf(5.04, 5)).toBe('at')
    expect(sideOf(5.06, 5)).toBe('above')
    expect(sideOf(4.94, 5)).toBe('below')
    expect(sideOf(-0.04, 0)).toBe('at')
  })
})

describe('heartRateRecordStart', () => {
  it('counts the runs before the first with heart rate, and every run without', () => {
    const items = [
      run({ activity_id: 'a', start_time_utc: octoberNoon(1), ...NO_HEART_RATE }),
      run({ activity_id: 'b', start_time_utc: octoberNoon(2), ...NO_HEART_RATE }),
      run({ activity_id: 'c', start_time_utc: octoberNoon(3) }),
      run({ activity_id: 'd', start_time_utc: octoberNoon(4), ...NO_HEART_RATE }),
      run({ activity_id: 'e', start_time_utc: octoberNoon(5), cadence_at_median_spm: null }),
    ]
    // Handed out of order, because the payload's contract promises none.
    expect(heartRateRecordStart([...items].reverse())).toEqual({
      fitted: 5,
      withoutHeartRate: 3,
      beforeFirst: 2,
      withCadence: 4,
    })
  })

  it('has nothing to say when the first run already carries heart rate', () => {
    expect(
      heartRateRecordStart([
        run({ start_time_utc: octoberNoon(1) }),
        run({ start_time_utc: octoberNoon(2), ...NO_HEART_RATE }),
      ]),
    ).toBeNull()
  })

  it('has nothing to say when no run carries heart rate, where the chart is empty', () => {
    expect(heartRateRecordStart([run(NO_HEART_RATE), run(NO_HEART_RATE)])).toBeNull()
  })
})

describe('heartRateStepAgainstGap', () => {
  it('divides the median run-to-run step by the median fast-minus-slow gap', () => {
    // Alternating 140 and 150 at the median reference: every step is 10.
    // Gaps of 1, 2 and 3 bpm: median 2. So the step is five times the gap.
    const items = Array.from({ length: MIN_MEDIAN_RUNS }, (_, i) =>
      run({
        start_time_utc: octoberNoon(i + 1),
        hr_at_median_bpm: i % 2 === 0 ? 140 : 150,
        hr_at_slow_bpm: 140,
        hr_at_fast_bpm: 140 + (i % 3) + 1,
      }),
    )
    expect(heartRateStepAgainstGap(items)).toEqual({ runs: MIN_MEDIAN_RUNS, ratio: 5 })
  })

  it('steps in start-time order, skipping a run with no heart rate rather than breaking', () => {
    const items = Array.from({ length: MIN_MEDIAN_RUNS + 1 }, (_, i) =>
      run({
        start_time_utc: octoberNoon(i + 1),
        // Rising by 4 a run, with one run in the middle carrying none.
        ...(i === 5 ? NO_HEART_RATE : { hr_at_median_bpm: 140 + 4 * i, hr_at_slow_bpm: 140, hr_at_fast_bpm: 142 }),
      }),
    )
    // Eight steps of 4 and one of 8 across the missing run: the median is 4, over a gap of 2.
    expect(heartRateStepAgainstGap([...items].reverse())).toEqual({ runs: MIN_MEDIAN_RUNS, ratio: 2 })
  })

  it('makes no claim from too few runs, or when the step is no larger than the gap', () => {
    const few = Array.from({ length: MIN_MEDIAN_RUNS - 1 }, (_, i) =>
      run({ start_time_utc: octoberNoon(i + 1), hr_at_median_bpm: i % 2 === 0 ? 140 : 150 }),
    )
    expect(heartRateStepAgainstGap(few)).toBeNull()
    const steady = Array.from({ length: MIN_MEDIAN_RUNS }, (_, i) =>
      run({ start_time_utc: octoberNoon(i + 1), hr_at_median_bpm: 142 + (i % 2) }),
    )
    // Steps of 1 against a gap of 4.
    expect(heartRateStepAgainstGap(steady)).toBeNull()
  })

  it('makes no claim when the step exceeds the gap by less than the one decimal the page prints', () => {
    const stepping = (step: number) =>
      Array.from({ length: MIN_MEDIAN_RUNS }, (_, i) =>
        run({ start_time_utc: octoberNoon(i + 1), hr_at_median_bpm: i % 2 === 0 ? 140 : 140 + step }),
      )
    // Gap 4: a step of 4.16 is 1.04 times it, printed as 1, which is not further apart.
    expect(heartRateStepAgainstGap(stepping(4.16))).toBeNull()
    expect(heartRateStepAgainstGap(stepping(4.24))?.ratio).toBeCloseTo(1.06, 9)
  })
})

describe('heartRateEstimateAgainstVdot', () => {
  it('takes the median ratio as an offset and its sample standard deviation in points', () => {
    // Ratios 1.5, 1.6 and 1.7, repeated: median 1.6, so 60% above. The
    // sample SD of 1.5, 1.6, 1.7 four times over is 0.1 * sqrt(8 / 11).
    const ratios = [1.5, 1.6, 1.7]
    const items = Array.from({ length: 12 }, (_, i) =>
      fitness({ vdot_smoothed: 40, hr_vo2max_smoothed: 40 * (ratios[i % 3] ?? 1) }),
    )
    const result = heartRateEstimateAgainstVdot(items)
    expect(result?.pairs).toBe(12)
    expect(result?.medianOffsetPct).toBeCloseTo(60, 9)
    expect(result?.side).toBe('above')
    expect(result?.spreadPoints).toBeCloseTo(10 * Math.sqrt(8 / 11), 9)
  })

  it('pairs only the runs that carry both estimates', () => {
    const items = [
      ...Array.from({ length: MIN_RATIO_PAIRS - 1 }, () => fitness()),
      fitness({ vdot_smoothed: null }),
      fitness({ hr_vo2max_smoothed: null }),
    ]
    expect(heartRateEstimateAgainstVdot(items)).toBeNull()
    expect(heartRateEstimateAgainstVdot([...items, fitness()])?.pairs).toBe(MIN_RATIO_PAIRS)
  })

  it('says below when the heart rate estimate sits under VDOT', () => {
    const items = Array.from({ length: MIN_RATIO_PAIRS }, () => fitness({ hr_vo2max_smoothed: 36, vdot_smoothed: 40 }))
    expect(heartRateEstimateAgainstVdot(items)?.side).toBe('below')
    expect(heartRateEstimateAgainstVdot(items)?.medianOffsetPct).toBeCloseTo(-10, 9)
  })
})

describe('pairWithDevice', () => {
  const device = [
    { calendar_date: '2025-10-03', vo2max: 45, vo2max_reported: 45 },
    { calendar_date: '2025-10-01', vo2max: 44, vo2max_reported: 44 },
    { calendar_date: '2025-10-06', vo2max: 46, vo2max_reported: 46 },
  ]

  it("takes Garmin's value for the run's day, or the latest day before it", () => {
    const items = [
      fitness({ activity_id: 'same-day', start_time_utc: octoberNoon(3) }),
      fitness({ activity_id: 'between', start_time_utc: octoberNoon(5) }),
      fitness({ activity_id: 'after-last', start_time_utc: octoberNoon(9) }),
      fitness({ activity_id: 'first-day', start_time_utc: octoberNoon(1) }),
    ]
    const pairs = pairWithDevice(items, new Map(), device)
    expect(pairs.map((p) => [p.point.activity_id, p.garmin])).toEqual([
      ['same-day', 45],
      ['between', 45],
      ['after-last', 46],
      ['first-day', 44],
    ])
  })

  it("leaves out a run before Garmin's first day", () => {
    expect(pairWithDevice([fitness({ start_time_utc: '2025-09-30T12:00:00Z' })], new Map(), device)).toEqual([])
  })

  it("reads the run's local day through the trends payload's offset, and the UTC day without one", () => {
    // 22:30Z on 2 October is 00:30 on the 3rd at UTC+2, which is Garmin's
    // 3 October value; with no offset it stays the 2nd, the 1 October value.
    const late = fitness({ activity_id: 'late', start_time_utc: '2025-10-02T22:30:00Z' })
    expect(pairWithDevice([late], new Map([['late', 7200]]), device)[0]?.garmin).toBe(45)
    expect(pairWithDevice([late], new Map(), device)[0]?.garmin).toBe(44)
    expect(pairWithDevice([late], new Map([['late', null]]), device)[0]?.garmin).toBe(44)
  })
})

describe('estimatesAgainstDevice', () => {
  /** One Garmin day per run, each run on its own day, so every pair is known in advance. */
  function paired(estimates: { hr: number | null; vdot: number | null; garmin: number }[]) {
    const items = estimates.map((e, i) =>
      fitness({
        activity_id: `run-${String(i)}`,
        start_time_utc: dayAfterNewYear(i),
        hr_vo2max_smoothed: e.hr,
        vdot_smoothed: e.vdot,
      }),
    )
    const device = estimates.map((e, i) => {
      const date = dayAfterNewYear(i).slice(0, 10)
      return { calendar_date: date, vo2max: e.garmin, vo2max_reported: Math.round(e.garmin) }
    })
    return estimatesAgainstDevice(items, new Map(), device)
  }

  it('means the percentage offsets and correlates the heart rate estimate with Garmin', () => {
    // Garmin 40 and 50 alternating; the heart rate estimate 10% and 6% above
    // it alternately, so its mean offset is 8%; VDOT a third below it, at
    // two thirds of Garmin's value on every run.
    const rows = Array.from({ length: MIN_CORRELATION_PAIRS }, (_, i) => {
      const garmin = i % 2 === 0 ? 40 : 50
      return { garmin, hr: garmin * (i % 2 === 0 ? 1.1 : 1.06), vdot: (garmin * 2) / 3 }
    })
    const result = paired(rows)
    expect(result.heartRate?.pairs).toBe(MIN_CORRELATION_PAIRS)
    expect(result.heartRate?.meanOffsetPct).toBeCloseTo(8, 9)
    expect(result.heartRate?.side).toBe('above')
    expect(result.heartRate?.correlation).toBeCloseTo(
      pearson(
        rows.map((r) => r.hr),
        rows.map((r) => r.garmin),
      ) ?? Number.NaN,
      12,
    )
    expect(result.vdot?.meanOffsetPct).toBeCloseTo(-100 / 3, 9)
    expect(result.vdot?.side).toBe('below')
  })

  it('quotes an offset from ten pairs but no correlation below twenty', () => {
    const rows = Array.from({ length: MIN_CORRELATION_PAIRS - 1 }, (_, i) => ({
      garmin: 40 + i,
      hr: 44 + i,
      vdot: 30,
    }))
    const result = paired(rows)
    expect(result.heartRate?.pairs).toBe(MIN_CORRELATION_PAIRS - 1)
    expect(result.heartRate?.correlation).toBeNull()
  })

  it('drops each half on its own below ten pairs', () => {
    const rows = Array.from({ length: MIN_RATIO_PAIRS }, (_, i) => ({
      garmin: 45,
      hr: i === 0 ? null : 48,
      vdot: 30,
    }))
    const result = paired(rows)
    expect(result.heartRate).toBeNull()
    expect(result.vdot?.pairs).toBe(MIN_RATIO_PAIRS)
  })

  it('has nothing to compare without a Garmin series', () => {
    expect(estimatesAgainstDevice([fitness()], new Map(), [])).toEqual({ heartRate: null, vdot: null })
  })
})

describe('decouplingLevels', () => {
  it('takes the median over the population and over its runs of an hour or more, each against the line', () => {
    // Ten 40-minute runs at 6% to 15% and ten hour-long runs at 1% to 10%:
    // the population median is the middle of all twenty, 8.0%, and the
    // hour-long median 5.5%.
    const items = [
      ...Array.from({ length: 10 }, (_, i) => run({ decoupling_pct: 6 + i, fit_seconds: 2400 })),
      ...Array.from({ length: 10 }, (_, i) => run({ decoupling_pct: 1 + i, fit_seconds: HOUR_OR_MORE_FIT_SECONDS })),
    ]
    expect(decouplingLevels(items, 5)).toEqual({
      population: { runs: 20, medianPct: 8, side: 'above' },
      hourOrMore: { runs: 10, medianPct: 5.5, side: 'above' },
    })
  })

  it('reads only the population, never a run outside it', () => {
    const items = [
      ...Array.from({ length: MIN_MEDIAN_RUNS }, () => run({ decoupling_pct: 3 })),
      ...Array.from({ length: 30 }, () => run({ decoupling_pct: 20, is_aerobic_long_run: false })),
      ...Array.from({ length: 30 }, () => run({ decoupling_pct: 20, is_aerobic_long_run: null })),
    ]
    expect(decouplingLevels(items, 5)?.population).toEqual({ runs: MIN_MEDIAN_RUNS, medianPct: 3, side: 'below' })
  })

  it('says on the line when the median prints as the line', () => {
    const items = Array.from({ length: MIN_MEDIAN_RUNS }, () => run({ decoupling_pct: 5.04 }))
    expect(decouplingLevels(items, 5)?.population.side).toBe('at')
  })

  it('drops the hour-long reading below ten runs, and the whole reading below ten in the population', () => {
    const items = [
      ...Array.from({ length: MIN_MEDIAN_RUNS }, () => run({ decoupling_pct: 6 })),
      ...Array.from({ length: MIN_MEDIAN_RUNS - 1 }, () => run({ decoupling_pct: 2, fit_seconds: 4000 })),
    ]
    expect(decouplingLevels(items, 5)?.hourOrMore).toBeNull()
    expect(decouplingLevels(items.slice(0, MIN_MEDIAN_RUNS - 1), 5)).toBeNull()
  })
})

describe('decouplingAcrossSessions', () => {
  it('compares the all-out and easy medians across every run with a value', () => {
    const items = [
      ...Array.from({ length: MIN_MEDIAN_RUNS }, (_, i) =>
        run({ effort_tag: 'all_out', decoupling_pct: 9 + i, is_aerobic_long_run: false }),
      ),
      ...Array.from({ length: MIN_MEDIAN_RUNS }, (_, i) => run({ effort_tag: 'easy', decoupling_pct: 8 + i })),
      run({ effort_tag: 'easy', decoupling_pct: null }),
      run({ effort_tag: 'steady', decoupling_pct: 40 }),
    ]
    // Medians 13.5 and 12.5.
    expect(decouplingAcrossSessions(items)).toEqual({ allOutPct: 13.5, easyPct: 12.5, apartPoints: 1 })
  })

  it('makes no comparison when either tag has fewer than ten runs', () => {
    const items = [
      ...Array.from({ length: MIN_MEDIAN_RUNS }, () => run({ effort_tag: 'all_out', decoupling_pct: 10 })),
      ...Array.from({ length: MIN_MEDIAN_RUNS - 1 }, () => run({ effort_tag: 'easy', decoupling_pct: 9 })),
    ]
    expect(decouplingAcrossSessions(items)).toBeNull()
  })
})

describe('the cadence trends', () => {
  /** Runs one day apart whose value is `level(i)`, in shuffled order. */
  function daily(count: number, level: (i: number) => number, field: 'slope' | 'cadence'): TrendPoint[] {
    const items = Array.from({ length: count }, (_, i) =>
      run({
        start_time_utc: dayAfterNewYear(i),
        ...(field === 'slope'
          ? { cadence_slope_shrunk_spm_per_mps: level(i) }
          : { cadence_at_median_spm: level(i) }),
      }),
    )
    return [...items.filter((_, i) => i % 2 === 1), ...items.filter((_, i) => i % 2 === 0)]
  }

  it('reads a rising level as rising, by its t', () => {
    // A rise of 0.3 a day with a +-1 alternating wobble on top.
    const level = (i: number) => 160 + 0.3 * i + (i % 2 === 0 ? 1 : -1)
    const items = daily(MIN_TREND_RUNS, level, 'cadence')
    const xs = Array.from({ length: MIN_TREND_RUNS }, (_, i) => i)
    const expected = linearTrend(xs, xs.map(level))
    const finding = cadenceLevelTrend(items)
    expect(finding?.runs).toBe(MIN_TREND_RUNS)
    expect(finding?.standardErrors).toBeCloseTo(expected?.t ?? Number.NaN, 6)
    expect(finding?.standardErrors).toBeGreaterThan(2)
    expect(finding?.direction).toBe('rises')
  })

  it('reads a falling slope as falling', () => {
    const finding = cadenceSlopeTrend(daily(MIN_TREND_RUNS, (i) => 15 - 0.2 * i + (i % 2 === 0 ? 0.5 : -0.5), 'slope'))
    expect(finding?.direction).toBe('falls')
  })

  it('reads a slope that only wobbles as flat, under two standard errors', () => {
    // Mirror-image noise around 12 with no drift: the fitted slope is small
    // against its own error.
    const wobble = [0.9, -1.1, 0.4, -0.2, 1.3, -0.7, -0.9, 0.6, 0.1, -1.2, 1.0, -0.3, 0.8, -0.5, 0.2, -0.8, 1.1, -0.4, 0.3, -0.6]
    const finding = cadenceSlopeTrend(daily(MIN_TREND_RUNS, (i) => 12 + (wobble[i] ?? 0), 'slope'))
    expect(finding?.direction).toBe('flat')
    expect(finding?.standardErrors).toBeLessThan(2)
  })

  it('decides the direction on the ratio as printed, not on the raw ratio', () => {
    // Residuals 1, -1, -1, 1 repeated are orthogonal to the day and the
    // intercept, so the fitted slope is exactly the drift `a`, and its
    // standard error is sqrt(SSR / (n - 2) / Sxx) = sqrt(20 / 18 / 665).
    const se = Math.sqrt(20 / 18 / 665)
    const residual = [1, -1, -1, 1]
    const drifting = (t: number) => daily(MIN_TREND_RUNS, (i) => 160 + t * se * i + (residual[i % 4] ?? 0), 'cadence')
    // 1.97 prints as 2, which is two standard errors: not flat.
    expect(cadenceLevelTrend(drifting(1.97))).toMatchObject({ direction: 'rises' })
    expect(cadenceLevelTrend(drifting(1.97))?.standardErrors).toBeCloseTo(1.97, 9)
    // 1.94 prints as 1.9.
    expect(cadenceLevelTrend(drifting(1.94))?.direction).toBe('flat')
  })

  it('reads every run carrying the one shared slope as constant, with no standard error to divide by', () => {
    // Tau floored at zero: every shrunk slope is the shared slope exactly.
    // 0.1 is chosen so the mean of twenty copies is not exactly 0.1 in floating point.
    expect(cadenceSlopeTrend(daily(MIN_TREND_RUNS, () => 0.1, 'slope'))).toEqual({
      runs: MIN_TREND_RUNS,
      standardErrors: 0,
      direction: 'constant',
    })
  })

  it('makes no claim over fewer than twenty runs, and skips a run with no value', () => {
    const items = daily(MIN_TREND_RUNS, (i) => 160 + i + (i % 2), 'cadence')
    expect(cadenceLevelTrend(items.slice(1))).toBeNull()
    const withGap = [...items.slice(1), run({ start_time_utc: dayAfterNewYear(100), cadence_at_median_spm: null })]
    expect(cadenceLevelTrend(withGap)).toBeNull()
  })
})
