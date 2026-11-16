import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PlanVolume } from './PlanVolume'
import { barHeight } from './planBarTestUtils'

const WEEKS = [
  { startDate: '2026-11-16', plannedM: 30000, runM: 28400 },
  { startDate: '2026-11-23', plannedM: 26000, runM: 0 },
  { startDate: '2026-11-30', plannedM: 33000, runM: null },
]

function bars(container: HTMLElement, kind: 'planned' | 'run'): Element[] {
  return Array.from(container.querySelectorAll(`[data-bar="${kind}"]`))
}

describe('PlanVolume', () => {
  it('draws a planned and a run bar for each past week and only a planned bar for a future week', () => {
    const { container } = render(<PlanVolume weeks={WEEKS} runsNote={null} />)

    expect(bars(container, 'planned').map((b) => b.getAttribute('data-week'))).toEqual(['1', '2', '3'])
    // A past week with nothing run still has its run bar, at zero.
    expect(bars(container, 'run').map((b) => b.getAttribute('data-week'))).toEqual(['1', '2'])
    expect(barHeight(bars(container, 'run')[1])).toBe(0)
    expect(barHeight(bars(container, 'run')[0])).toBeGreaterThan(0)
  })

  it('labels the weeks W1 to Wn', () => {
    render(<PlanVolume weeks={WEEKS} runsNote={null} />)
    for (const label of ['W1', 'W2', 'W3']) expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('scales a bar to its distance on the ladder', () => {
    const { container } = render(<PlanVolume weeks={WEEKS} runsNote={null} />)
    // The ladder tops out at 40 km, so 30 km is three quarters of 40 km's bar.
    const planned = bars(container, 'planned').map(barHeight)
    const run = bars(container, 'run').map(barHeight)
    expect(planned[0]).toBeCloseTo(((planned[2] ?? 0) * 30) / 33, 6)
    expect(run[0]).toBeCloseTo(((planned[0] ?? 0) * 28.4) / 30, 6)
    expect(screen.getByText('40 km')).toBeInTheDocument()
  })

  it('has an accessible name and states every week in its text alternative', () => {
    render(<PlanVolume weeks={WEEKS} runsNote={null} />)
    const chart = screen.getByRole('img', { name: /Weekly distance, planned against run/ })
    const name = chart.getAttribute('aria-label') ?? ''
    expect(name).toContain('W1: 30.0 km planned, 28.4 km run')
    expect(name).toContain('W2: 26.0 km planned, 0.0 km run')
    expect(name).toContain('W3: 33.0 km planned')
    expect(name).not.toContain('W3: 33.0 km planned,')
  })

  it('draws no run bars while the runs are unknown, and says why, rather than drawing zeros', () => {
    const { container } = render(<PlanVolume weeks={WEEKS} runsNote="Loading the runs done on these days." />)

    expect(bars(container, 'planned')).toHaveLength(3)
    expect(bars(container, 'run')).toHaveLength(0)
    expect(screen.getByRole('status')).toHaveTextContent('Loading the runs done on these days.')
    expect(screen.getByRole('img').getAttribute('aria-label')).not.toContain('run,')
  })

  it("leads with the plan's distance, its biggest week and what has been run so far", () => {
    const { container } = render(<PlanVolume weeks={WEEKS} runsNote={null} />)
    const figures = Array.from(container.querySelectorAll('dl > div')).map((d) => d.textContent)
    expect(figures).toEqual(['Planned89.0 km', 'Biggest week33.0 km', 'Run so far28.4 km'])
  })

  it('leaves what has been run out of the stat row while the runs are unknown', () => {
    const { container } = render(<PlanVolume weeks={WEEKS} runsNote="Loading the runs done on these days." />)
    const labels = Array.from(container.querySelectorAll('dt')).map((d) => d.textContent)
    expect(labels).toEqual(['Planned', 'Biggest week'])
  })

  it('states an absence for a plan with no weeks', () => {
    render(<PlanVolume weeks={[]} runsNote={null} />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText(/no weeks/i)).toBeInTheDocument()
  })
})
