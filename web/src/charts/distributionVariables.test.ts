import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VARIABLE,
  VARIABLES,
  type DistributionRun,
  type VariableId,
  isVariableId,
  localParts,
  variableById,
} from './distributionVariables'

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

const SPEC_ORDER: VariableId[] = [
  'distance',
  'avg_hr',
  'avg_cadence',
  'moving_time',
  'start_hour',
  'weekday',
  'pace',
  'days_since_previous_run',
  'hr_at_reference',
  'cadence_at_reference',
  'climb_per_km',
  'month',
  'max_hr',
  'elapsed_time',
  'decoupling',
]

describe('VARIABLES', () => {
  it('holds the fifteen variables in the drop-down order', () => {
    expect(VARIABLES.map((variable) => variable.id)).toEqual(SPEC_ORDER)
  })

  it('defaults to distance', () => {
    expect(DEFAULT_VARIABLE).toBe('distance')
  })
})

describe('variableById / isVariableId', () => {
  it('finds every one of the fifteen variables by id', () => {
    for (const id of SPEC_ORDER) {
      expect(variableById(id).id).toBe(id)
    }
  })

  it('accepts only a known id', () => {
    expect(isVariableId('distance')).toBe(true)
    expect(isVariableId('nonsense')).toBe(false)
    expect(isVariableId(null)).toBe(false)
  })
})

describe('localParts', () => {
  it('shifts by the offset before reading the wall clock, crossing a UTC calendar day', () => {
    expect(localParts({ start_time_utc: '2026-06-01T23:30:00Z', utc_offset_s: 7200 })).toEqual({
      date: '2026-06-02',
      hour: 1,
      isoWeekday: 2,
      month: 6,
    })
  })

  it('falls back to UTC for a null offset, rather than assuming home', () => {
    expect(localParts({ start_time_utc: '2026-06-01T23:30:00Z', utc_offset_s: null })).toEqual({
      date: '2026-06-01',
      hour: 23,
      isoWeekday: 1,
      month: 6,
    })
  })
})

describe('pace', () => {
  it('reads as seconds per kilometre, not speed', () => {
    expect(variableById('pace').value(run({ avg_speed_mps: 2.5 }))).toBe(400)
  })

  it('is null when the run recorded no speed', () => {
    expect(variableById('pace').value(run({ avg_speed_mps: null }))).toBeNull()
  })
})

describe('decoupling', () => {
  it('carries the value only for a run the metric is defined over', () => {
    expect(variableById('decoupling').value(run({ is_aerobic_long_run: true, decoupling_pct: 5 }))).toBe(5)
  })

  it('is null when the run is not an aerobic long run', () => {
    expect(variableById('decoupling').value(run({ is_aerobic_long_run: false, decoupling_pct: 5 }))).toBeNull()
  })

  it('is null when eligibility itself is unknown', () => {
    expect(variableById('decoupling').value(run({ is_aerobic_long_run: null, decoupling_pct: 5 }))).toBeNull()
  })
})

describe('days_since_previous_run', () => {
  it('caps at 7, read as the open "7+" category', () => {
    expect(variableById('days_since_previous_run').value(run({ days_since_previous_run: 11 }))).toBe(7)
  })

  it('leaves a value inside the range untouched', () => {
    expect(variableById('days_since_previous_run').value(run({ days_since_previous_run: 3 }))).toBe(3)
  })
})

describe('reference-pace labels', () => {
  it('names the pace when the payload has one', () => {
    expect(variableById('hr_at_reference').label(2.6667)).toContain('6:15')
    expect(variableById('cadence_at_reference').label(2.6667)).toContain('6:15')
  })

  it('falls back to a pace-free label when the payload has none', () => {
    expect(variableById('hr_at_reference').label(null)).toBe('Heart rate at reference pace')
    expect(variableById('cadence_at_reference').label(null)).toBe('Cadence at reference pace')
  })
})

describe('caveatTarget', () => {
  it('points average heart rate, maximum heart rate and average cadence at their reference-pace variable', () => {
    expect(variableById('avg_hr').caveatTarget).toBe('hr_at_reference')
    expect(variableById('max_hr').caveatTarget).toBe('hr_at_reference')
    expect(variableById('avg_cadence').caveatTarget).toBe('cadence_at_reference')
  })

  it('carries no caveat target on any other variable', () => {
    expect(variableById('distance').caveatTarget).toBeUndefined()
    expect(variableById('hr_at_reference').caveatTarget).toBeUndefined()
  })
})

describe('unit', () => {
  it('says per kilometre for pace, whose edges are bare m:ss', () => {
    expect(variableById('pace').unit).toBe('min/km')
  })
})

describe('formatValue', () => {
  it('writes a numeric value in its own unit', () => {
    expect(variableById('distance').formatValue(6020)).toBe('6.02 km')
    expect(variableById('avg_hr').formatValue(150.4)).toBe('150 bpm')
    expect(variableById('max_hr').formatValue(181)).toBe('181 bpm')
    expect(variableById('avg_cadence').formatValue(161.6)).toBe('162 spm')
    expect(variableById('cadence_at_reference').formatValue(166.3)).toBe('166 spm')
    expect(variableById('moving_time').formatValue(1930)).toBe('32:10')
    expect(variableById('elapsed_time').formatValue(3930)).toBe('1:05:30')
    expect(variableById('climb_per_km').formatValue(5.269)).toBe('5.3 m/km')
    expect(variableById('decoupling').formatValue(5)).toBe('+5.0%')
  })

  it('writes pace, held in seconds per kilometre, as m:ss per km', () => {
    expect(variableById('pace').formatValue(375)).toBe('6:15/km')
  })

  it('names a category by its label, with the clock hour spelled as a time', () => {
    expect(variableById('start_hour').formatValue(7)).toBe('07:00')
    expect(variableById('weekday').formatValue(3)).toBe('Wed')
    expect(variableById('month').formatValue(5)).toBe('May')
    expect(variableById('days_since_previous_run').formatValue(0)).toBe('0 days')
    expect(variableById('days_since_previous_run').formatValue(1)).toBe('1 day')
    expect(variableById('days_since_previous_run').formatValue(7)).toBe('7+ days')
  })

  it('names a median between two categories by both, rather than rounding it into one', () => {
    // An even count's median averages the two middle values, so 3.5 is an
    // ordinary answer for a weekday, not an edge case.
    expect(variableById('weekday').formatValue(3.5)).toBe('Wed to Thu')
    expect(variableById('start_hour').formatValue(12.5)).toBe('12:00 to 13:00')
    expect(variableById('month').formatValue(11.5)).toBe('Nov to Dec')
    expect(variableById('days_since_previous_run').formatValue(2.5)).toBe('2 to 3 days')
  })
})

describe('note', () => {
  it('states the population decoupling is defined over', () => {
    expect(variableById('decoupling').note).toMatch(/aerobic long runs/)
  })

  it('is absent where every run can carry the value', () => {
    expect(variableById('distance').note).toBeUndefined()
  })
})
