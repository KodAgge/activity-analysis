import { describe, expect, it } from 'vitest'
import { DURABILITY_REFERENCE_PCT, durabilityReading } from './decouplingMath'

describe('durabilityReading', () => {
  it('is the conventional 5% line', () => {
    expect(DURABILITY_REFERENCE_PCT).toBe(5)
  })

  it('reads a value under the line as below it', () => {
    expect(durabilityReading(3.4)).toBe('Below the 5% durability line')
  })

  it('reads a value over the line as above it', () => {
    expect(durabilityReading(13.08)).toBe('Above the 5% durability line')
  })

  it('compares the value as displayed, so +5.0% never reads as below or above', () => {
    // formatDecoupling shows one decimal: 4.96 displays as +5.0%.
    expect(durabilityReading(4.96)).toBe('On the 5% durability line')
    expect(durabilityReading(5.04)).toBe('On the 5% durability line')
    // 5.05 is stored just under 5.05, so toFixed(1) displays it as +5.0%.
    expect(durabilityReading(5.05)).toBe('On the 5% durability line')
  })

  it('reads a negative value, a more efficient second half, as below the line', () => {
    expect(durabilityReading(-8.32)).toBe('Below the 5% durability line')
  })
})
