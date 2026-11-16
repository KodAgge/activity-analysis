import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { kindSlotClass } from '../components/plan/sessionMarks'
import { calendarDayOfDate } from '../format'
import { PlanPaces } from './PlanPaces'
import type { PaceMark } from './planShapeMath'

const day = calendarDayOfDate
const SPAN: [number, number] = [day('2026-03-02'), day('2026-03-23')]

function mark(over: Partial<PaceMark> & { low: number; high: number }): PaceMark {
  return {
    sessionId: 'i',
    kind: 'intervals',
    day: day('2026-03-04'),
    speed: { low_mps: over.low, high_mps: over.high },
    fastS: 1000 / over.high,
    slowS: 1000 / over.low,
    index: 0,
    count: 1,
    ...over,
  }
}

const MARKS = [
  mark({ low: 3.9, high: 4.0, index: 0, count: 2 }),
  mark({ low: 4.5, high: 5.0, index: 1, count: 2 }),
  mark({ sessionId: 'r', kind: 'race', day: day('2026-03-21'), low: 3.7, high: 3.75 }),
]

describe('PlanPaces', () => {
  it('draws a range bar per step, faster up, side by side on one day', () => {
    const { container } = render(
      <PlanPaces marks={MARKS} span={SPAN} goalPaceS={270} easy={{ fastS: 357, slowS: 400 }} raceDate="2026-03-21" />,
    )
    const bars = Array.from(container.querySelectorAll('[data-mark="pace"]'))
    expect(bars).toHaveLength(3)
    const [a, b] = bars
    // The 4.5-5.0 m/s step is faster than the 3.9-4.0 one, so it sits higher.
    expect(Number(b?.getAttribute('y'))).toBeLessThan(Number(a?.getAttribute('y')))
    expect(Number(b?.getAttribute('x'))).toBeGreaterThan(Number(a?.getAttribute('x')))
    expect(bars.map((r) => r.getAttribute('data-kind'))).toEqual(['intervals', 'intervals', 'race'])
  })

  it('labels each range with its paces where the label fits', () => {
    const { container } = render(
      <PlanPaces marks={MARKS} span={SPAN} goalPaceS={270} easy={{ fastS: 357, slowS: 400 }} raceDate="2026-03-21" />,
    )
    const labels = Array.from(container.querySelectorAll('[data-label="pace"]')).map((t) => t.textContent)
    expect(labels).toContain('4:10-4:16')
    expect(labels).toContain('4:27-4:30')
  })

  it('draws the goal pace as a labelled line, and the easy range as a band labelled with its paces below it', () => {
    const { container } = render(
      <PlanPaces marks={MARKS} span={SPAN} goalPaceS={270} easy={{ fastS: 357, slowS: 400 }} raceDate="2026-03-21" />,
    )
    expect(screen.getByText('Goal 4:30/km')).toBeInTheDocument()
    expect(screen.getByText('Easy 5:57-6:40/km')).toBeInTheDocument()
    const goal = Number(container.querySelector('[data-mark="goal"]')?.getAttribute('y1'))
    const band = container.querySelector('[data-mark="easy"]')
    expect(Number(band?.getAttribute('y'))).toBeGreaterThan(goal)
  })

  it('draws one dashed column per plan week, labelled W1 to Wn, with faster and slower named', () => {
    const { container } = render(
      <PlanPaces marks={MARKS} span={SPAN} goalPaceS={270} easy={null} raceDate="2026-03-21" />,
    )
    // Three weeks: four edges, three labels.
    expect(container.querySelectorAll('line[class*="column"]')).toHaveLength(4)
    for (const label of ['W1', 'W2', 'W3', 'Faster', 'Slower']) expect(screen.getByText(label)).toBeInTheDocument()
    expect(container.querySelectorAll('[data-mark="race"]')).toHaveLength(1)
  })

  it('on a long plan draws only the columns of the weeks it labels, and keeps every mark inside the plot', () => {
    const long: [number, number] = [day('2026-04-06'), day('2026-12-06')]
    const late = mark({ sessionId: 'r', kind: 'race', day: day('2026-12-05'), low: 3.7, high: 3.75 })
    const { container } = render(
      <PlanPaces marks={[...MARKS, late]} span={long} goalPaceS={270} easy={null} raceDate="2026-12-05" />,
    )
    const weekLabels = Array.from(container.querySelectorAll('text')).filter((t) => /^W\d+$/.test(t.textContent ?? ''))
    // 35 weeks at the fallback width: fewer labels than weeks, one column
    // per label plus the plot's right edge.
    expect(weekLabels.length).toBeLessThan(35)
    expect(weekLabels[0]?.textContent).toBe('W1')
    expect(container.querySelectorAll('line[class*="column"]')).toHaveLength(weekLabels.length + 1)
    const right = Math.max(...Array.from(container.querySelectorAll('line[class*="column"]')).map((l) => Number(l.getAttribute('x1'))))
    for (const dot of Array.from(container.querySelectorAll('circle'))) {
      expect(Number(dot.getAttribute('cx')) + Number(dot.getAttribute('r'))).toBeLessThanOrEqual(right)
    }
  })

  it('sets each range label beside its range, never above or below it', () => {
    const { container } = render(
      <PlanPaces marks={MARKS} span={SPAN} goalPaceS={270} easy={null} raceDate="2026-03-21" />,
    )
    const bars = Array.from(container.querySelectorAll('[data-mark="pace"]'))
    for (const label of Array.from(container.querySelectorAll('[data-label="pace"]'))) {
      const bar = bars.find((b) => b.parentElement?.parentElement === label.parentElement)
      const x = Number(bar?.getAttribute('x'))
      const w = Number(bar?.getAttribute('width'))
      const lx = Number(label.getAttribute('x'))
      // Wholly to one side of its range: starting right of it, or ending left of it.
      if (label.getAttribute('text-anchor') === 'start') expect(lx).toBeGreaterThan(x + w)
      else expect(lx).toBeLessThan(x)
    }
  })

  it('keys the race tick, and the faster and slower ends in a kind colour', () => {
    const { container } = render(
      <PlanPaces marks={MARKS} span={SPAN} goalPaceS={270} easy={null} raceDate="2026-03-21" />,
    )
    const key = Array.from(container.querySelectorAll('ul li')).map((li) => li.textContent)
    expect(key).toEqual(['Intervals', 'Time trial or race', 'Faster end', 'Slower end', 'Goal pace', 'Race day'])
    // The end dots carry a kind's slot class, as the marks do.
    const ends = Array.from(container.querySelectorAll('ul li')).slice(2, 4)
    for (const li of ends) expect(li.querySelector('span')?.getAttribute('class')).toContain(kindSlotClass('intervals'))
  })

  it('leads with the goal pace, the fastest target and the number of sessions', () => {
    const { container } = render(
      <PlanPaces marks={MARKS} span={SPAN} goalPaceS={270} easy={null} raceDate="2026-03-21" />,
    )
    const figures = Array.from(container.querySelectorAll('dl > div')).map((d) => d.textContent)
    expect(figures).toEqual(['Goal pace4:30/km', 'Fastest target3:20/km', 'Sessions2'])
  })

  it('draws no easy band when the plan gives no easy pace', () => {
    const { container } = render(
      <PlanPaces marks={MARKS} span={SPAN} goalPaceS={270} easy={null} raceDate="2026-03-21" />,
    )
    expect(container.querySelector('[data-mark="easy"]')).toBeNull()
  })

  it('has an accessible name and states every range, the goal and the easy range', () => {
    render(<PlanPaces marks={MARKS} span={SPAN} goalPaceS={270} easy={{ fastS: 357, slowS: 400 }} raceDate="2026-03-21" />)
    const label = screen.getByRole('img', { name: /^Target paces/ }).getAttribute('aria-label') ?? ''
    expect(label).toContain('4 Mar, intervals 4:10-4:16/km')
    expect(label).toContain('4 Mar, intervals 3:20-3:42/km')
    expect(label).toContain('21 Mar, race 4:27-4:30/km')
    expect(label).toContain('goal 4:30/km')
    expect(label).toContain('easy 5:57-6:40/km')
  })

  it('says so when the plan sets no pace for a quality session yet', () => {
    render(<PlanPaces marks={[]} span={SPAN} goalPaceS={270} easy={null} raceDate="2026-03-21" />)
    expect(screen.getByText(/no target pace/i)).toBeInTheDocument()
  })
})
