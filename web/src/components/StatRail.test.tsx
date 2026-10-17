import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NO_VALUE } from '../format'
import { StatRail } from './StatRail'
import type { StatRailWeek } from './StatRail'

/**
 * `StatRail` was, per the branch's final review, the one of the five view
 * components carrying an unguarded unit composition (`` `${distanceKm(...)}
 * km` `` with no null check at all) to have no test file of its own - which
 * is exactly how the defect stayed unnoticed: the composition rendered
 * `– km` only when `weeks` was empty, and `Overview` always guards that
 * case before `StatRail` is reached, so nothing here exercised the branch.
 * This file tests the component directly, independent of that guard.
 *
 * The rail now composes `components/Stat`, which renders the number and
 * the unit as two elements - so a value is read as the `<dd>`'s whole text
 * rather than as one text node, and the `– km` regression these tests
 * exist for would appear as exactly that string.
 */

function statValue(label: string): string | null {
  const dt = screen.getByText(label)
  const dd = dt.closest('div')?.querySelector('dd')
  return dd?.textContent ?? null
}

describe('StatRail', () => {
  it('renders a real week and a real four-week sum in kilometres', () => {
    const weeks: StatRailWeek[] = [{ distance_m: 5000 }, { distance_m: 6000 }, { distance_m: 7000 }, { distance_m: 8000 }]
    render(
      <StatRail
        weeks={weeks}
        streak={{ current_weeks: 2, longest_weeks: 5, longest_ended_week: null }}
        consistency={{ weeks_considered: 10, weeks_with_a_run: 8 }}
      />,
    )

    expect(statValue('This week')).toBe('8.00 km')
    expect(statValue('Last 4 weeks')).toBe('26.00 km')
  })

  it('renders the bare no-value glyph, never "– km", when there is no week to sum', () => {
    // A mutation that reintroduces the naive composition -
    // `` `${distanceKm(thisWeek?.distance_m ?? null)} km` `` - renders
    // "– km" here instead of the bare glyph, which is what this asserts
    // against.
    render(
      <StatRail
        weeks={[]}
        streak={{ current_weeks: 0, longest_weeks: 0, longest_ended_week: null }}
        consistency={{ weeks_considered: 0, weeks_with_a_run: 0 }}
      />,
    )

    expect(statValue('This week')).toBe(NO_VALUE)
    expect(statValue('Last 4 weeks')).toBe(NO_VALUE)
    expect(statValue('This week')).not.toBe(`${NO_VALUE} km`)
    expect(statValue('Last 4 weeks')).not.toBe(`${NO_VALUE} km`)
  })

  it('pluralises a one-week streak', () => {
    // `weeksMeasure` is in `src/format` rather than here precisely so the
    // two streak stats and any later screen spell the unit the same way.
    render(
      <StatRail
        weeks={[{ distance_m: 5000 }]}
        streak={{ current_weeks: 1, longest_weeks: 30, longest_ended_week: null }}
        consistency={{ weeks_considered: 52, weeks_with_a_run: 47 }}
      />,
    )

    expect(statValue('Current streak')).toBe('1 week')
    expect(statValue('Longest streak')).toBe('30 weeks')
  })

  it('lays the second row out on the first row\'s columns', () => {
    // Three thirds, then two thirds and a third. The halves this replaced
    // filled their row but landed on columns the row above does not use,
    // so "Consistency" started 65px from "Last 4 weeks" and the block read
    // as two grids stacked rather than one (round-3 critic). Asserted on
    // the class hook rather than on a rendered width: jsdom applies no CSS
    // module styles, and the geometry is a screenshot's job.
    const { container } = render(
      <StatRail
        weeks={[{ distance_m: 5000 }]}
        streak={{ current_weeks: 0, longest_weeks: 30, longest_ended_week: '2026-01-05' }}
        consistency={{ weeks_considered: 52, weeks_with_a_run: 47 }}
      />,
    )

    const shares = Array.from(container.querySelectorAll('dl > div'), (cell) =>
      /twoThirds/.test(cell.className) ? 'two-thirds' : 'third',
    )
    expect(shares).toEqual(['third', 'third', 'third', 'two-thirds', 'third'])
  })

  it('carries a qualifier on exactly the two stats that need one', () => {
    // Which matters to the layout as well as to the reading: those two are
    // the ones that share the second row of a three-column grid, so the
    // row has no item taller than the rest of it. The three on the first
    // row are two lines each.
    const { container } = render(
      <StatRail
        weeks={[{ distance_m: 5000 }]}
        streak={{ current_weeks: 0, longest_weeks: 30, longest_ended_week: '2026-01-05' }}
        consistency={{ weeks_considered: 52, weeks_with_a_run: 47 }}
      />,
    )

    const details = Array.from(container.querySelectorAll('dd + dd'), (dd) => dd.textContent)
    expect(details).toEqual(['through 5 January 2026', 'weeks with a run'])
  })

  it('states consistency as a count out of a count, never a percentage', () => {
    render(
      <StatRail
        weeks={[{ distance_m: 5000 }]}
        streak={{ current_weeks: 0, longest_weeks: 0, longest_ended_week: null }}
        consistency={{ weeks_considered: 52, weeks_with_a_run: 47 }}
      />,
    )

    expect(statValue('Consistency')).toBe('47 of 52')
    expect(screen.queryByText(/%/)).not.toBeInTheDocument()
  })
})
