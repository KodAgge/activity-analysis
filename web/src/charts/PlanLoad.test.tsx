import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PREDATES_PLANNED_TRIMP, PREDATES_HR_PLANNING } from '../components/plan/planLoadMath'
import { PlanLoad } from './PlanLoad'
import { barHeight } from './planBarTestUtils'

const WEEKS = [
  { start: '2026-11-16', planned: 320, run: 280 },
  { start: '2026-11-23', planned: 360, run: 0 },
  { start: '2026-11-30', planned: 400, run: null },
]

function bars(container: HTMLElement, kind: 'planned' | 'run'): Element[] {
  return Array.from(container.querySelectorAll(`[data-bar="${kind}"]`))
}

describe('PlanLoad', () => {
  it('leads with the planned TRIMP, the biggest week and what has been run so far', () => {
    const { container } = render(<PlanLoad weeks={WEEKS} plannedNote={null} runsNote={null} />)
    const figures = Array.from(container.querySelectorAll('dl > div')).map((d) => d.textContent)
    expect(figures).toEqual(['Planned1,080 TRIMP', 'Biggest week400 TRIMP', 'Run so far280 TRIMP'])
  })

  it('PlanLoad draws planned and run bars per week', () => {
    const { container } = render(<PlanLoad weeks={WEEKS} plannedNote={null} runsNote={null} />)

    expect(bars(container, 'planned').map((b) => b.getAttribute('data-week'))).toEqual(['1', '2', '3'])
    // A begun week with nothing run has its bar at zero; a week not begun has none.
    expect(bars(container, 'run').map((b) => b.getAttribute('data-week'))).toEqual(['1', '2'])
    expect(barHeight(bars(container, 'run')[1])).toBe(0)
    expect(barHeight(bars(container, 'run')[0])).toBeGreaterThan(0)
    // The ladder tops out at 400, so 320 is four fifths of 400's bar.
    const planned = bars(container, 'planned').map(barHeight)
    expect(planned[0]).toBeCloseTo(((planned[2] ?? 0) * 320) / 400, 6)
    for (const label of ['W1', 'W2', 'W3']) expect(screen.getByText(label)).toBeInTheDocument()

    const name = screen.getByRole('img', { name: /^Weekly load, planned against run/ }).getAttribute('aria-label')
    expect(name).toContain('W1: 320 planned, 280 run.')
    expect(name).toContain('W2: 360 planned, 0 run.')
    expect(name).toContain('W3: 400 planned.')
  })

  it('a plan without zone minutes draws no planned load', () => {
    const weeks = WEEKS.map((w) => ({ ...w, planned: null }))
    const { container } = render(<PlanLoad weeks={weeks} plannedNote={PREDATES_HR_PLANNING} runsNote={null} />)

    expect(bars(container, 'planned')).toHaveLength(0)
    expect(bars(container, 'run')).toHaveLength(2)
    expect(screen.getByText('This version predates heart-rate planning.')).toBeInTheDocument()
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('W1: 280 run.')
  })

  it('draws no run bars while the runs are unknown, and says why', () => {
    const { container } = render(<PlanLoad weeks={WEEKS} plannedNote={null} runsNote="The runs' heart rate could not be loaded." />)

    expect(bars(container, 'planned')).toHaveLength(3)
    expect(bars(container, 'run')).toHaveLength(0)
    expect(screen.getByRole('status')).toHaveTextContent("The runs' heart rate could not be loaded.")
  })

  it('states both reasons when it has nothing to draw', () => {
    const weeks = WEEKS.map((w) => ({ ...w, planned: null }))
    render(<PlanLoad weeks={weeks} plannedNote={PREDATES_HR_PLANNING} runsNote="Loading." />)

    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('This version predates heart-rate planning. Loading.')).toBeInTheDocument()
  })

  it('states the absence rather than drawing an empty frame when nothing was planned or run', () => {
    const weeks = WEEKS.map((w) => ({ ...w, planned: null, run: w.run === null ? null : 0 }))
    render(<PlanLoad weeks={weeks} plannedNote={PREDATES_HR_PLANNING} runsNote={null} />)

    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('This version predates heart-rate planning.')).toBeInTheDocument()
  })

  it('a version without the TRIMP per minute stamp draws no planned bars and says so', () => {
    const weeks = WEEKS.map((w) => ({ ...w, planned: null }))
    const { container } = render(<PlanLoad weeks={weeks} plannedNote={PREDATES_PLANNED_TRIMP} runsNote={null} />)

    expect(bars(container, 'planned')).toHaveLength(0)
    expect(bars(container, 'run')).toHaveLength(2)
    expect(screen.getByRole('status')).toHaveTextContent(PREDATES_PLANNED_TRIMP)
  })

  it('draws the planned bars it has beside a note on the weeks it lacks', () => {
    const weeks = WEEKS.map((w, i) => (i === 1 ? { ...w, planned: null } : w))
    const note = 'A week has no planned bar.'
    const { container } = render(<PlanLoad weeks={weeks} plannedNote={note} runsNote={null} />)

    expect(bars(container, 'planned').map((b) => b.getAttribute('data-week'))).toEqual(['1', '3'])
    expect(screen.getByRole('status')).toHaveTextContent(note)
  })

  it('states an absence for a plan with no weeks', () => {
    render(<PlanLoad weeks={[]} plannedNote={null} runsNote={null} />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText(/no weeks/i)).toBeInTheDocument()
  })
})
