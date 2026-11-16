import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PlanIntensity } from './PlanIntensity'
import type { MixWeek } from './planShapeMath'

const WEEKS: MixWeek[] = [
  { startDate: '2026-03-02', easyM: 20000, qualityM: 6000, raceM: 0, outlineM: null },
  { startDate: '2026-03-09', easyM: 18000, qualityM: 4000, raceM: 3000, outlineM: null },
  { startDate: '2026-03-16', easyM: 0, qualityM: 0, raceM: 0, outlineM: 30000 },
]

function segments(container: HTMLElement, week: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of Array.from(container.querySelectorAll(`[data-week="${week}"]`))) {
    out[r.getAttribute('data-segment') ?? ''] = Number(r.getAttribute('height'))
  }
  return out
}

describe('PlanIntensity', () => {
  it('stacks each detailed week by intensity and draws an outline week as one bar', () => {
    const { container } = render(<PlanIntensity weeks={WEEKS} />)
    const w1 = segments(container, '1')
    expect(Object.keys(w1).sort()).toEqual(['easy', 'quality'])
    expect((w1.easy ?? 0) / (w1.quality ?? 1)).toBeCloseTo(20 / 6, 6)
    expect(Object.keys(segments(container, '2')).sort()).toEqual(['easy', 'quality', 'race'])
    expect(Object.keys(segments(container, '3'))).toEqual(['outline'])
    expect(screen.getByText('W3')).toBeInTheDocument()
  })

  it('stacks the segments without gaps, easy at the bottom', () => {
    const { container } = render(<PlanIntensity weeks={WEEKS} />)
    const rect = (s: string) => container.querySelector(`[data-week="2"][data-segment="${s}"]`)
    const easyTop = Number(rect('easy')?.getAttribute('y'))
    const qualityBottom = Number(rect('quality')?.getAttribute('y')) + Number(rect('quality')?.getAttribute('height'))
    expect(qualityBottom).toBeCloseTo(easyTop, 6)
  })

  it('keys the three intensities, and not yet detailed when a week is an outline', () => {
    const { container } = render(<PlanIntensity weeks={WEEKS} />)
    const key = Array.from(container.querySelectorAll('ul li')).map((li) => li.textContent)
    expect(key).toEqual(['Easy', 'Quality', 'Race or trial', 'Not yet detailed'])
  })

  it('leads with the detailed weeks\' kilometres of each intensity', () => {
    const { container } = render(<PlanIntensity weeks={WEEKS} />)
    const figures = Array.from(container.querySelectorAll('dl > div')).map((d) => d.textContent)
    expect(figures).toEqual(['Easy38.0 km', 'Quality10.0 km', 'Race or trial3.0 km'])
  })

  it('has an accessible name and states every week', () => {
    render(<PlanIntensity weeks={WEEKS} />)
    const label = screen.getByRole('img', { name: /^Weekly intensity mix/ }).getAttribute('aria-label') ?? ''
    expect(label).toContain('W1: 26.0 km, 20.0 km easy, 6.0 km quality')
    expect(label).toContain('W2: 25.0 km, 18.0 km easy, 4.0 km quality, 3.0 km race or trial')
    expect(label).toContain('W3: 30.0 km, not yet detailed')
  })

  it('states an absence for a plan with no weeks', () => {
    render(<PlanIntensity weeks={[]} />)
    expect(screen.queryByRole('img')).toBeNull()
  })
})
