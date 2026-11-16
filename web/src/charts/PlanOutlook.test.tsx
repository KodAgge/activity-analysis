import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PlanOutlook } from './PlanOutlook'
import type { PlanOutlookProps } from './PlanOutlook'

const PROPS: PlanOutlookProps = {
  expected: [
    { date: '2026-11-22', vdot: 44.5, garmin: 47 },
    { date: '2026-11-29', vdot: 45, garmin: 47 },
    { date: '2026-12-06', vdot: 45.5, garmin: 48 },
  ],
  measured: [
    [
      { date: '2026-11-14', vdot: 44 },
      { date: '2026-11-28', vdot: 44.8 },
    ],
  ],
  targetVdot: 46,
  garmin: [
    { date: '2026-11-10', vo2max: 46 },
    { date: '2026-11-20', vo2max: 47 },
    { date: '2026-11-27', vo2max: 47 },
    { date: '2026-12-01', vo2max: 48 },
  ],
  startDate: '2026-11-16',
  raceDate: '2026-12-06',
}

describe('PlanOutlook', () => {
  it('leads with the VDOT expected by the race, the target and the latest measured', () => {
    const { container } = render(<PlanOutlook {...PROPS} />)
    const figures = Array.from(container.querySelectorAll('dl > div')).map((d) => d.textContent)
    expect(figures).toEqual(['VDOT at the race45.5', 'Target46.0', 'Latest measured44.8'])
  })

  it('PlanOutlook draws two panels and the target line', () => {
    const { container } = render(<PlanOutlook {...PROPS} />)

    const panels = Array.from(container.querySelectorAll('[data-panel]')).map((p) => p.getAttribute('data-panel'))
    expect(panels).toEqual(['vdot', 'garmin'])
    const vdot = container.querySelector('[data-panel="vdot"]')
    const garmin = container.querySelector('[data-panel="garmin"]')
    expect(vdot?.querySelectorAll('[data-mark="target"]')).toHaveLength(1)
    expect(garmin?.querySelectorAll('[data-mark="target"]')).toHaveLength(0)
    // The measured series is one line through its runs.
    const measured = vdot?.querySelectorAll('[data-mark="measured"]')
    expect(measured).toHaveLength(1)
    expect(measured?.[0]?.getAttribute('points')?.split(' ')).toHaveLength(2)
    expect(vdot?.querySelectorAll('[data-mark="expected"]')).toHaveLength(1)
    expect(garmin?.querySelectorAll('[data-mark="expected"]')).toHaveLength(1)
    expect(garmin?.querySelectorAll('[data-mark="device"]')).toHaveLength(1)
    expect(screen.getByText('Target 46.0')).toBeInTheDocument()

    // Each panel has its own scale: the target line sits inside the VDOT panel's box.
    const target = vdot?.querySelector('[data-mark="target"]')
    const rules = Array.from(vdot?.querySelectorAll('line[data-rule]') ?? []).map((r) => Number(r.getAttribute('y1')))
    const y = Number(target?.getAttribute('y1'))
    expect(y).toBeGreaterThanOrEqual(Math.min(...rules))
    expect(y).toBeLessThanOrEqual(Math.max(...rules))

    // One date axis, from the first measured day, before the plan, to the
    // race; Garmin's days outside it are left out rather than widening it,
    // the last one before it carried to its first day.
    expect(screen.getByText('14 Nov')).toBeInTheDocument()
    expect(screen.getByText('6 Dec')).toBeInTheDocument()

    const name = screen.getByRole('img', { name: /^VO2max outlook/ }).getAttribute('aria-label') ?? ''
    expect(name).toContain('expected VDOT 44.5 by 22 Nov')
    expect(name).toContain('measured VDOT 44.0 on 14 Nov to 44.8 on 28 Nov')
    expect(name).toContain('target VDOT 46.0')
    expect(name).toContain('expected Garmin VO2max 47.0 by 22 Nov, 47.0 by 29 Nov, 48.0 by 6 Dec')
    expect(name).toContain("Garmin's own 46.0 from 14 Nov, 47.0 from 20 Nov, 48.0 from 1 Dec")
    const line = garmin?.querySelector('[data-mark="device"]')?.getAttribute('points') ?? ''
    const firstX = Number(line.split(' ')[0]?.split(',')[0])
    const garminRules = Array.from(garmin?.querySelectorAll('line[data-rule]') ?? [])
    expect(firstX).toBeCloseTo(Number(garminRules[0]?.getAttribute('x1')), 6)
  })

  it('states why nothing is measured while the history loads, beside its other notes', () => {
    render(<PlanOutlook {...PROPS} measured={[]} measuredNote="Loading the measured predictions." />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading the measured predictions.')
  })

  it('puts the year on both end dates when the span crosses one', () => {
    render(<PlanOutlook {...PROPS} measured={[[{ date: '2025-11-14', vdot: 44 }]]} />)
    expect(screen.getByText('14 Nov 2025')).toBeInTheDocument()
    expect(screen.getByText('6 Dec 2026')).toBeInTheDocument()
  })

  it('draws a lone measured run as a dot', () => {
    const { container } = render(<PlanOutlook {...PROPS} measured={[[{ date: '2026-11-28', vdot: 44.8 }]]} />)
    expect(container.querySelector('circle[data-mark="measured"]')).not.toBeNull()
    expect(container.querySelector('polyline[data-mark="measured"]')).toBeNull()
  })

  it('draws each unbroken run of the measured series as its own line', () => {
    const { container } = render(
      <PlanOutlook
        {...PROPS}
        measured={[
          [
            { date: '2026-10-01', vdot: 43 },
            { date: '2026-10-05', vdot: 43.2 },
          ],
          [
            { date: '2026-11-20', vdot: 44.4 },
            { date: '2026-11-28', vdot: 44.8 },
          ],
        ]}
      />,
    )
    expect(container.querySelectorAll('polyline[data-mark="measured"]')).toHaveLength(2)
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('measured VDOT 43.0 on 1 Oct to 44.8 on 28 Nov')
  })

  it('PlanOutlook says so when no version is stamped', () => {
    render(<PlanOutlook {...PROPS} expected={[]} measured={[]} targetVdot={null} />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('No version of this plan carries a VO2max outlook.')).toBeInTheDocument()
  })

  it("says so when the shown version expects nothing, and when Garmin's panel is empty", () => {
    const { container } = render(<PlanOutlook {...PROPS} expected={[]} garmin={[]} />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'This version predates the VO2max outlook. No Garmin VO2max over this span, and this version expects none.',
    )
    expect(container.querySelector('[data-panel="garmin"]')).toBeNull()
    expect(container.querySelectorAll('[data-mark="measured"]')).toHaveLength(1)
  })

  it("labels Garmin's unrounded values to one decimal, a run of days by that label", () => {
    render(
      <PlanOutlook
        {...PROPS}
        expected={[{ date: '2026-12-06', vdot: 45.5, garmin: 51.64 }]}
        garmin={[
          { date: '2026-11-20', vo2max: 51.39386 },
          { date: '2026-11-22', vo2max: 51.36742 },
          { date: '2026-11-27', vo2max: 51.67146 },
        ]}
      />,
    )
    const name = screen.getByRole('img', { name: /^VO2max outlook/ }).getAttribute('aria-label') ?? ''
    expect(name).toContain('expected Garmin VO2max 51.6 by 6 Dec')
    expect(name).toContain("Garmin's own 51.4 from 20 Nov, 51.7 from 27 Nov")
  })
})
