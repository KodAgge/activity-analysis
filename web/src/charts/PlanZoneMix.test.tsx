import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PlanZoneMix } from './PlanZoneMix'

const WEEKS: { start: string; planned: [number, number, number] | null; run: [number, number, number] | null }[] = [
  { start: '2026-11-16', planned: [120, 20, 20], run: [100, 30, 10] },
  { start: '2026-11-23', planned: [140, 0, 30], run: [0, 0, 0] },
  { start: '2026-11-30', planned: [150, 20, 30], run: null },
]

function segments(container: HTMLElement, bar: 'planned' | 'run', week: string): string[] {
  return Array.from(container.querySelectorAll(`[data-bar="${bar}"][data-week="${week}"]`)).map(
    (el) => el.getAttribute('data-segment') ?? '',
  )
}

describe('PlanZoneMix', () => {
  it('leads with the planned minutes and the shares in zones 1-2 and 4-5', () => {
    const { container } = render(<PlanZoneMix weeks={WEEKS} runsNote={null} />)
    const figures = Array.from(container.querySelectorAll('dl > div')).map((d) => d.textContent)
    expect(figures).toEqual(['Planned530 min', 'In zones 1-277%', 'In zones 4-515%'])
  })

  it('draws the plan in grey and the run in the heart-rate zone colours, never a workout kind\'s', () => {
    const { container } = render(<PlanZoneMix weeks={WEEKS} runsNote={null} />)
    for (const band of Array.from(container.querySelectorAll('[data-bar]'))) {
      expect(band.getAttribute('class') ?? '').not.toMatch(/slot|series/i)
    }
  })

  it('PlanZoneMix stacks three bands', () => {
    const { container } = render(<PlanZoneMix weeks={WEEKS} runsNote={null} />)

    expect(segments(container, 'planned', '1')).toEqual(['z12', 'z3', 'z45'])
    expect(segments(container, 'run', '1')).toEqual(['z12', 'z3', 'z45'])
    // An empty band is not drawn, and a week not begun has no run bar.
    expect(segments(container, 'planned', '2')).toEqual(['z12', 'z45'])
    expect(segments(container, 'run', '3')).toEqual([])
    // The bands stack: zone 3 sits on top of zones 1-2.
    const [low, mid] = Array.from(container.querySelectorAll('[data-bar="planned"][data-week="1"]'))
    expect(Number(mid?.getAttribute('y')) + Number(mid?.getAttribute('height'))).toBeCloseTo(
      Number(low?.getAttribute('y')),
      6,
    )
    // The key draws planned and run as the bars are drawn.
    expect(container.querySelectorAll('[data-swatch="run"] rect')).toHaveLength(3)
    const plannedSwatch = Array.from(container.querySelectorAll('[data-swatch="planned"] rect'))
    expect(plannedSwatch).toHaveLength(3)
    // In the planned bars' own pale fill, not the run's.
    const plannedFill = (container.querySelector('[data-bar="planned"]')?.getAttribute('class') ?? '').split(' ')[0]
    expect(plannedSwatch[0]?.getAttribute('class')?.split(' ')[0]).toBe(plannedFill)
    expect(container.querySelector('[data-bar="run"]')?.getAttribute('class')?.split(' ')[0]).not.toBe(plannedFill)
    // The longest week, W3, is 200 minutes, the top of the ladder.
    expect(screen.getByText('200')).toBeInTheDocument()

    const name = screen.getByRole('img', { name: /^Heart-rate mix/ }).getAttribute('aria-label')
    expect(name).toContain('W1: planned 120, 20 and 20 min, run 100, 30 and 10 min.')
    expect(name).toContain('W3: planned 150, 20 and 30 min.')
  })

  it('says so for a version without zone minutes', () => {
    const weeks = WEEKS.map((w) => ({ ...w, planned: null }))
    const { container } = render(<PlanZoneMix weeks={weeks} runsNote={null} />)

    expect(container.querySelectorAll('[data-bar="planned"]')).toHaveLength(0)
    expect(screen.getByText('This version predates heart-rate planning.')).toBeInTheDocument()
  })

  it('states the absence rather than drawing an empty frame when nothing was planned or run', () => {
    const weeks = WEEKS.map((w) => ({ ...w, planned: null, run: null }))
    render(<PlanZoneMix weeks={weeks} runsNote={null} />)

    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('This version predates heart-rate planning.')).toBeInTheDocument()
  })

  it('draws no run bars while the runs are unknown, and says why', () => {
    const { container } = render(<PlanZoneMix weeks={WEEKS} runsNote="No threshold estimate yet." />)

    expect(container.querySelectorAll('[data-bar="run"]')).toHaveLength(0)
    expect(screen.getByRole('status')).toHaveTextContent('No threshold estimate yet.')
  })
})
