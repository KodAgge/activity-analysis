import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { calendarDayOfDate } from '../format'
import { PlanPhases } from './PlanPhases'
import type { PhaseBand } from './planShapeMath'

const day = calendarDayOfDate
const BANDS: PhaseBand[] = [
  { phase: 'Build', startDay: day('2026-03-02'), endDay: day('2026-03-16'), firstWeek: 1, lastWeek: 2 },
  { phase: 'Taper', startDay: day('2026-03-16'), endDay: day('2026-03-23'), firstWeek: 3, lastWeek: 3 },
]
const SPAN: [number, number] = [day('2026-03-02'), day('2026-03-23')]
const CHECKPOINT = {
  sessionId: 'tt',
  date: '2026-03-10',
  kind: 'time_trial' as const,
  targetDistanceM: 3000,
  description: 'A 3 km trial',
  targetS: 690,
}

describe('PlanPhases', () => {
  it('draws one band per phase with its name, the checkpoints, the race and today', () => {
    const { container } = render(
      <PlanPhases bands={BANDS} span={SPAN} today={day('2026-03-05')} checkpoints={[CHECKPOINT]} raceDate="2026-03-21" />,
    )
    expect(container.querySelectorAll('[data-mark="phase"]')).toHaveLength(2)
    expect(screen.getByText('Build')).toBeInTheDocument()
    expect(screen.getByText('Taper')).toBeInTheDocument()
    expect(container.querySelectorAll('[data-mark="checkpoint"]')).toHaveLength(1)
    expect(screen.getByText('3 km TT 11:30')).toBeInTheDocument()
    expect(container.querySelector('[data-mark="race"]')).not.toBeNull()
    expect(screen.getByText('Race 21 Mar')).toBeInTheDocument()
    expect(container.querySelector('[data-mark="today"]')).not.toBeNull()
    expect(screen.getByText('Today')).toBeInTheDocument()
  })

  it('a band twice as long is twice as wide', () => {
    const { container } = render(
      <PlanPhases bands={BANDS} span={SPAN} today={null} checkpoints={[]} raceDate="2026-03-21" />,
    )
    // A band grows with its weeks, after its own gaps between them, so its
    // width is in proportion to its weeks.
    const grows = Array.from(container.querySelectorAll<HTMLElement>('[data-mark="phase"]')).map((b) =>
      Number(b.style.flexGrow),
    )
    expect((grows[0] ?? 0) / (grows[1] ?? 1)).toBeCloseTo(2, 1)
  })

  it('draws one dash per week, done before today, current through it, to come after', () => {
    const { container } = render(
      <PlanPhases bands={BANDS} span={SPAN} today={day('2026-03-10')} checkpoints={[]} raceDate="2026-03-21" />,
    )
    const states = Array.from(container.querySelectorAll('[data-state]')).map((d) => d.getAttribute('data-state'))
    expect(states).toEqual(['done', 'current', 'todo'])
  })

  it('counts every week done once the plan is over, though today is off the strip', () => {
    const { container } = render(
      <PlanPhases
        bands={BANDS}
        span={SPAN}
        today={null}
        progressDay={day('2026-04-01')}
        checkpoints={[]}
        raceDate="2026-03-21"
      />,
    )
    const states = Array.from(container.querySelectorAll('[data-state]')).map((d) => d.getAttribute('data-state'))
    expect(states).toEqual(['done', 'done', 'done'])
  })

  it('draws no today marker when today is outside the plan', () => {
    const { container } = render(
      <PlanPhases bands={BANDS} span={SPAN} today={null} checkpoints={[]} raceDate="2026-03-21" />,
    )
    expect(container.querySelector('[data-mark="today"]')).toBeNull()
    expect(screen.queryByText('Today')).toBeNull()
  })

  it('draws every week one width: a group grows by its weeks after its own gaps between them', () => {
    const { container } = render(
      <PlanPhases bands={BANDS} span={SPAN} today={null} checkpoints={[]} raceDate="2026-03-21" />,
    )
    const groups = Array.from(container.querySelectorAll<HTMLElement>('[data-mark="phase"]'))
    expect(groups.map((g) => Number(g.style.flexGrow))).toEqual([2, 1])
    expect(groups[0]?.style.flexBasis).toBe('calc(1 * var(--week-gap))')
    expect(groups[1]?.style.flexBasis).toBe('calc(0 * var(--week-gap))')
  })

  it('stands today at the row start and draws the first phase as the coming one before the plan begins', () => {
    const { container } = render(
      <PlanPhases
        bands={BANDS}
        span={SPAN}
        today={null}
        progressDay={day('2026-03-01')}
        checkpoints={[]}
        raceDate="2026-03-21"
      />,
    )
    expect(container.querySelectorAll('[data-mark="today"]')).toHaveLength(1)
    expect(container.querySelector('[data-label="today"]')).toHaveTextContent('Today 1 Mar')
    expect(container.querySelector('[data-mark="phase"]')?.className).toMatch(/currentPhase/)
    const label = screen.getByRole('img', { name: /^Plan phases/ }).getAttribute('aria-label') ?? ''
    expect(label).toContain('today 1 Mar, before the plan begins')
    const states = Array.from(container.querySelectorAll('[data-state]')).map((d) => d.getAttribute('data-state'))
    expect(states).toEqual(['todo', 'todo', 'todo'])
  })

  it('leaves the race week unnamed, since the race label under it says Race', () => {
    const withRace: PhaseBand[] = [
      ...BANDS.slice(0, 1),
      { phase: 'Race', startDay: day('2026-03-16'), endDay: day('2026-03-23'), firstWeek: 3, lastWeek: 3 },
    ]
    render(<PlanPhases bands={withRace} span={SPAN} today={null} checkpoints={[]} raceDate="2026-03-21" />)
    expect(screen.queryByText('Race')).toBeNull()
    expect(screen.getByText('Race 21 Mar')).toBeInTheDocument()
    const label = screen.getByRole('img', { name: /^Plan phases/ }).getAttribute('aria-label') ?? ''
    expect(label).toContain('Race, week 3, 16 Mar to 22 Mar')
  })

  it('names a phase once, over its first group, and the phase today is in over its own', () => {
    // A recovery week splits one phase into two groups of the same name.
    const split: PhaseBand[] = [
      { phase: 'Base', startDay: day('2026-03-02'), endDay: day('2026-03-16'), firstWeek: 1, lastWeek: 2 },
      { phase: 'Recover', startDay: day('2026-03-16'), endDay: day('2026-03-23'), firstWeek: 3, lastWeek: 3 },
      { phase: 'Base', startDay: day('2026-03-23'), endDay: day('2026-04-06'), firstWeek: 4, lastWeek: 5 },
    ]
    const splitSpan: [number, number] = [day('2026-03-02'), day('2026-04-06')]
    const before = render(<PlanPhases bands={split} span={splitSpan} today={null} checkpoints={[]} raceDate="2026-04-05" />)
    expect(before.container.querySelectorAll('[data-mark="phase"]')).toHaveLength(3)
    expect(screen.getAllByText('Base')).toHaveLength(1)
    before.unmount()

    render(<PlanPhases bands={split} span={splitSpan} today={day('2026-03-25')} checkpoints={[]} raceDate="2026-04-05" />)
    expect(screen.getAllByText('Base')).toHaveLength(2)
  })

  it('labels every mark under it, the race closing the row', () => {
    const { container } = render(
      <PlanPhases bands={BANDS} span={SPAN} today={day('2026-03-05')} checkpoints={[CHECKPOINT]} raceDate="2026-03-21" />,
    )
    const labels = Array.from(container.querySelectorAll('[data-label]')).map((l) => l.getAttribute('data-label'))
    expect(labels.sort()).toEqual(['checkpoint', 'race', 'today'])
    // The race's diamond follows the last week's dashes, on their line.
    const race = container.querySelector('[data-mark="race"]')
    const phases = container.querySelectorAll('[data-mark="phase"]')
    expect(phases[phases.length - 1]?.compareDocumentPosition(race as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('has an accessible name and states every phase, checkpoint and the race', () => {
    render(
      <PlanPhases bands={BANDS} span={SPAN} today={day('2026-03-05')} checkpoints={[CHECKPOINT]} raceDate="2026-03-21" />,
    )
    const label = screen.getByRole('img', { name: /^Plan phases/ }).getAttribute('aria-label') ?? ''
    expect(label).toContain('Build, weeks 1 to 2, 2 Mar to 15 Mar')
    expect(label).toContain('Taper, week 3, 16 Mar to 22 Mar')
    expect(label).toContain('checkpoint 10 Mar, 3 km TT 11:30')
    expect(label).toContain('race 21 Mar')
    expect(label).toContain('today 5 Mar')
  })
})
