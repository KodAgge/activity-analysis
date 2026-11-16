import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { calendarDayOfDate } from '../format'
import { PlanLeadIn } from './PlanLeadIn'
import type { LeadInWeek } from './planShapeMath'

const START = calendarDayOfDate('2026-01-05')

function week(i: number, over: Partial<LeadInWeek> = {}): LeadInWeek {
  return {
    startDay: START + 7 * i,
    byCategory: { easy: 0, long: 0, intervals: 0, all_out: 0, unclassified: 0 },
    totalM: 0,
    runCount: 0,
    qualityCount: 0,
    longestM: null,
    records: [],
    ...over,
  }
}

const WEEKS: LeadInWeek[] = [
  week(0, {
    byCategory: { easy: 12000, long: 16000, intervals: 8000, all_out: 0, unclassified: 0 },
    totalM: 36000,
    runCount: 3,
    qualityCount: 1,
    longestM: 16000,
  }),
  week(1, {
    byCategory: { easy: 10000, long: 0, intervals: 0, all_out: 5000, unclassified: 2000 },
    totalM: 17000,
    runCount: 3,
    qualityCount: 1,
    longestM: 10000,
    records: [{ activityId: 'b', distanceM: 5000, distanceKeys: ['5k'] }],
  }),
  ...[2, 3, 4, 5, 6, 7].map((i) => week(i)),
]

/** The stat row's figures, each as its label and its value with the unit. */
function stats(container: HTMLElement): [string, string][] {
  return Array.from(container.querySelectorAll('dl > div')).map((d) => [
    d.querySelector('dt')?.textContent ?? '',
    d.querySelector('dd')?.textContent ?? '',
  ])
}

describe('PlanLeadIn', () => {
  it('stacks each week by effort and keeps an empty week as an empty slot', () => {
    const { container } = render(<PlanLeadIn weeks={WEEKS} note={null} />)
    const kinds = (w: string) =>
      Array.from(container.querySelectorAll(`[data-week="${w}"][data-segment]`)).map((r) => r.getAttribute('data-segment'))
    expect(kinds('1')).toEqual(['easy', 'long', 'intervals'])
    expect(kinds('2')).toEqual(['easy', 'all_out', 'unclassified'])
    expect(kinds('3')).toEqual([])
    // Every week keeps its slot and its label.
    expect(container.querySelectorAll('[data-slot]')).toHaveLength(8)
  })

  it('marks a week holding a record run with that run\'s distance', () => {
    const { container } = render(<PlanLeadIn weeks={WEEKS} note={null} />)
    expect(container.querySelectorAll('[data-mark="record"]')).toHaveLength(1)
    expect(container.querySelector('[data-mark="record"]')?.getAttribute('data-week')).toBe('2')
    expect(screen.getByText('PR 5.0 km')).toBeInTheDocument()
  })

  it('sums the weeks up in a stat row above the chart', () => {
    const { container } = render(<PlanLeadIn weeks={WEEKS} note={null} />)
    expect(stats(container)).toEqual([
      ['A week', '6.6 km'],
      ['Runs a week', '0.8'],
      ['Longest run', '16.0 km'],
      ['Quality sessions', '2'],
    ])
  })

  it('says one quality session in the singular, and keeps a summary when no run has a distance', () => {
    const one = Array.from({ length: 8 }, (_, i) =>
      week(i, {
        byCategory: { easy: 5000, long: 0, intervals: 0, all_out: 0, unclassified: 0 },
        totalM: 5000,
        runCount: 1,
        qualityCount: i === 0 ? 1 : 0,
        longestM: 5000,
      }),
    )
    const { container, unmount } = render(<PlanLeadIn weeks={one} note={null} />)
    expect(stats(container)).toEqual([
      ['A week', '5.0 km'],
      ['Runs a week', '1'],
      ['Longest run', '5.0 km'],
      ['Quality session', '1'],
    ])
    unmount()
    // Runs were recorded, but none with a distance: they are not "no runs".
    const undistanced = [week(0, { runCount: 4 }), ...[1, 2, 3, 4, 5, 6, 7].map((i) => week(i))]
    const second = render(<PlanLeadIn weeks={undistanced} note={null} />)
    expect(stats(second.container)).toEqual([
      ['A week', '0.0 km'],
      ['Runs a week', '0.5'],
      ['Quality sessions', '0'],
    ])
  })

  it('says so in a line when no run was recorded at all', () => {
    const { container } = render(<PlanLeadIn weeks={[0, 1, 2, 3, 4, 5, 6, 7].map((i) => week(i))} note={null} />)
    expect(container.querySelector('p')?.textContent).toBe('No runs in these weeks.')
    expect(stats(container)).toEqual([])
  })

  it('has an accessible name and states every week', () => {
    render(<PlanLeadIn weeks={WEEKS} note={null} />)
    const label = screen.getByRole('img', { name: /^Run distance per week/ }).getAttribute('aria-label') ?? ''
    expect(label).toContain('week of 5 Jan: 36.0 km in 3 runs, 12.0 km easy, 16.0 km long, 8.0 km intervals')
    expect(label).toContain('week of 12 Jan: 17.0 km in 3 runs')
    expect(label).toContain('a record over 5 km on a 5.0 km run')
    expect(label).toContain('week of 19 Jan: no runs')
  })

  it('draws no bars and no summary while the runs are unknown, and says why', () => {
    const { container } = render(<PlanLeadIn weeks={WEEKS} note="Loading the runs of the weeks before the plan." />)
    expect(container.querySelectorAll('[data-segment]')).toHaveLength(0)
    expect(screen.getByRole('status')).toHaveTextContent('Loading the runs of the weeks before the plan.')
    expect(container.textContent).not.toMatch(/runs a week/i)
  })
})
