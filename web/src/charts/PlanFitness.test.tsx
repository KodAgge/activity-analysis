import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { calendarDayOfDate } from '../format'
import { NO_EXPECTED_LOAD, PlanFitness } from './PlanFitness'
import type { PlanFitnessProps } from './PlanFitness'

const day = calendarDayOfDate

const PROPS: PlanFitnessProps = {
  measured: [
    { day: day('2027-01-07'), ctl: 52, atl: 60, form: -8 },
    { day: day('2027-02-11'), ctl: 57, atl: 80, form: -23 },
  ],
  expected: [
    { day: day('2027-02-11'), ctl: 57, atl: 79, form: -22 },
    { day: day('2027-02-18'), ctl: 56, atl: 69, form: -13 },
    { day: day('2027-03-11'), ctl: 57, atl: 52, form: 5 },
  ],
  start: { local_date: '2027-02-13', ctl: 44.0, atl: 61.5, form: -17.5 },
  raceMorning: { local_date: '2027-03-12', ctl: 43.1, atl: 37.0, form: 6.1 },
  bridgedFrom: [],
  planStartDay: day('2027-02-15'),
  firstDay: day('2027-01-04'),
  raceDay: day('2027-03-13'),
}

describe('PlanFitness', () => {
  it('leads with race-morning form and fitness against the fitness it started from', () => {
    const { container } = render(<PlanFitness {...PROPS} />)
    const figures = Array.from(container.querySelectorAll('dl > div')).map((d) => d.textContent)
    expect(figures).toEqual(['Form on race morning+6.1', 'Fitness on race morning43.1', 'Fitness on 13 Feb44.0'])
  })

  it('draws fitness and fatigue above form, measured and expected, and the race', () => {
    const { container } = render(<PlanFitness {...PROPS} />)
    const load = container.querySelector('[data-panel="load"]')
    const form = container.querySelector('[data-panel="form"]')
    expect(load?.querySelectorAll('[data-mark="measured"] polyline')).toHaveLength(2)
    expect(load?.querySelectorAll('[data-mark="expected"] polyline')).toHaveLength(2)
    expect(form?.querySelectorAll('[data-mark] polyline')).toHaveLength(2)
    expect(container.querySelectorAll('[data-mark="race"]')).toHaveLength(1)
    expect(screen.getByText('4 Jan')).toBeInTheDocument()
    expect(screen.getByText('13 Mar')).toBeInTheDocument()
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('form on race morning +6.1')
  })

  it('centres form on zero, the same step either side', () => {
    const { container } = render(<PlanFitness {...PROPS} />)
    const labels = Array.from(container.querySelectorAll('[data-panel="form"] text')).map((t) => t.textContent)
    expect(labels).toEqual(['Form', '-30', '0', '+30'])
  })

  it('names the plan an expected line runs before this one', () => {
    render(<PlanFitness {...PROPS} bridgedFrom={['five-k']} planStartDay={day('2027-03-15')} />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Until 15 Mar the expected line runs the plan of five-k.',
    )
  })

  it('draws the measured series alone for a version without the stamp, and says why', () => {
    const { container } = render(<PlanFitness {...PROPS} expected={[]} start={null} raceMorning={null} />)
    expect(screen.getByRole('status')).toHaveTextContent(NO_EXPECTED_LOAD)
    expect(container.querySelectorAll('[data-mark="expected"]')).toHaveLength(0)
    expect(container.querySelectorAll('dl')).toHaveLength(0)
  })

  it('draws a series of one week as dots', () => {
    const { container } = render(<PlanFitness {...PROPS} measured={PROPS.measured.slice(1)} />)
    expect(container.querySelectorAll('[data-mark="measured"] circle')).toHaveLength(3)
    expect(container.querySelectorAll('[data-mark="measured"] polyline')).toHaveLength(0)
  })

  it('shades a week and marks where fitness and fatigue start and end it', () => {
    const week = {
      fromDay: day('2027-02-15'),
      toDay: day('2027-02-22'),
      start: { local_date: '2027-02-14', ctl: 44, atl: 61.5, form: -17.5 },
      end: { local_date: '2027-02-21', ctl: 45, atl: 58, form: -13 },
    }
    const { container } = render(<PlanFitness {...PROPS} week={week} />)
    expect(container.querySelectorAll('[data-mark="week"]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-mark="week-point"]')).toHaveLength(6)
  })

  it('draws no stat row when compact', () => {
    const { container } = render(<PlanFitness {...PROPS} compact />)
    expect(container.querySelectorAll('dl')).toHaveLength(0)
  })

  it('stands absent with neither series', () => {
    render(<PlanFitness {...PROPS} expected={[]} measured={[]} start={null} raceMorning={null} measuredNote="Loading." />)
    expect(screen.getByRole('note')).toHaveTextContent('No measured or expected fitness and fatigue over this plan. Loading.')
  })
})
