import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { calendarDayOfDate } from '../../format'
import { WeekLoad } from './WeekLoad'
import type { WeekLoadProps } from './WeekLoad'

const day = calendarDayOfDate

const PROPS: WeekLoadProps = {
  figures: {
    start: { local_date: '2027-02-14', ctl: 44, atl: 56.8, form: -12.8 },
    end: { local_date: '2027-02-21', ctl: 47.3, atl: 41.1, form: 6.2 },
    startLabel: 'Sun 14 Feb',
    endLabel: 'Sun 21 Feb',
    note: 'Fatigue falls below fitness: keep the strides short.',
  },
  fitness: {
    expected: [{ day: day('2027-02-18'), ctl: 45, atl: 50, form: -5 }],
    measured: [{ day: day('2027-02-11'), ctl: 44, atl: 58, form: -14 }],
    start: null,
    raceMorning: null,
    bridgedFrom: [],
    firstDay: day('2027-01-04'),
    raceDay: day('2027-03-13'),
  },
  weekFromDay: day('2027-02-15'),
  weekToDay: day('2027-02-22'),
  planStartDay: day('2027-02-15'),
  measuredNote: null,
}

describe('WeekLoad', () => {
  it('tables fitness, fatigue and form at the start and expected end, signed', () => {
    render(<WeekLoad {...PROPS} />)
    const table = screen.getByRole('table', { name: /fitness and fatigue/i })
    const rows = within(table).getAllByRole('row').map((r) => r.textContent)
    expect(rows).toEqual([
      'StartSun 14 FebExpected endSun 21 Feb',
      'Fitness (CTL)44.047.3',
      'Fatigue (ATL)56.841.1',
      'Form-12.8+6.2',
    ])
    expect(screen.getByText('Fatigue falls below fitness: keep the strides short.')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /^Fitness and fatigue/ })).toBeInTheDocument()
  })

  it("says why the chart draws no measured weeks while they load", () => {
    const note = 'Loading the measured fitness and fatigue.'
    render(<WeekLoad {...PROPS} fitness={{ ...PROPS.fitness, measured: [] }} measuredNote={note} />)
    expect(screen.getByText(note)).toBeInTheDocument()
  })

  it('shows the note alone without the stamp', () => {
    render(<WeekLoad {...PROPS} figures={{ ...PROPS.figures, start: null, end: null }} />)
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByText(/keep the strides short/)).toBeInTheDocument()
  })

  it('renders nothing with neither figures nor a note', () => {
    const { container } = render(
      <WeekLoad {...PROPS} figures={{ ...PROPS.figures, start: null, end: null, note: null }} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
