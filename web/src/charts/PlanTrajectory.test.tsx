import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PlanTrajectory } from './PlanTrajectory'
import { trajectoryLayout } from './planChartMath'

/*
 * Two versions, written on 6 and 18 February (noon UTC, so the local day
 * is the same in any zone from UTC-11 to UTC+11), predicting 26:00 and
 * 25:30 against a 25:00 target. The ladder brackets 25:00 to 26:00 with a
 * step past each end, 24:30 to 26:30, and is inverted, so 25:00 sits a
 * quarter of the plot's height below its top.
 */
const POINTS = [
  { number: 1, createdAt: '2027-02-06T12:00:00Z', bestEffortS: 1560 },
  { number: 2, createdAt: '2027-02-18T12:00:00Z', bestEffortS: 1530 },
]

const CHECKPOINTS = [
  {
    sessionId: 'tt',
    date: '2027-02-27',
    kind: 'time_trial',
    targetDistanceM: 3000,
    description: '3 km time trial',
    targetS: 690,
  },
  {
    sessionId: 'long',
    date: '2027-03-07',
    kind: 'long',
    targetDistanceM: 13000,
    description: 'Long run at goal effort',
    targetS: null,
  },
]

/** The y of a diamond path's top and bottom vertices, from its `d`. */
function diamondYs(d: string | null): number[] {
  const ys = (d ?? '').match(/-?\d+(\.\d+)?/g)?.map(Number).filter((_, i) => i % 2 === 1) ?? []
  return ys
}

/** jsdom measures nothing, so the chart lays out at its fallback width. */
const FALLBACK_WIDTH_PX = 600

describe('PlanTrajectory', () => {
  it('draws the target as a line at its time, labelled with that time', () => {
    const { container } = render(
      <PlanTrajectory points={POINTS} targetS={1500} raceDate="2027-03-13" checkpoints={CHECKPOINTS} />,
    )
    const line = container.querySelector('[data-mark="target"]')
    if (line === null) throw new Error('no target line')
    const { plot } = trajectoryLayout(FALLBACK_WIDTH_PX, 2, true)
    const expected = plot.top + (plot.bottom - plot.top) / 4
    expect(Number(line.getAttribute('y1'))).toBeCloseTo(expected, 6)
    expect(Number(line.getAttribute('y2'))).toBeCloseTo(expected, 6)
    expect(screen.getByText('Target 25:00')).toBeInTheDocument()
  })

  it('leads with the latest prediction, the target and the time between them', () => {
    const { container, unmount } = render(
      <PlanTrajectory points={POINTS} targetS={1500} raceDate="2027-03-13" checkpoints={[]} />,
    )
    // Version 2 predicts 25:30 against a 25:00 target.
    expect(Array.from(container.querySelectorAll('dl > div')).map((d) => d.textContent)).toEqual([
      'Latest prediction25:30',
      'Target25:00',
      'To find0:30',
    ])
    unmount()
    const ahead = render(<PlanTrajectory points={POINTS} targetS={1600} raceDate="2027-03-13" checkpoints={[]} />)
    expect(ahead.container.querySelector('dl > div:last-child')?.textContent).toBe('Inside target by1:10')
    ahead.unmount()
    const none = render(
      <PlanTrajectory
        points={[{ number: 1, createdAt: '2027-01-04T12:00:00Z', bestEffortS: null }]}
        targetS={1500}
        raceDate="2027-03-13"
        checkpoints={[]}
      />,
    )
    expect(Array.from(none.container.querySelectorAll('dl > div')).map((d) => d.textContent)).toEqual(['Target25:00'])
  })

  it('draws a filled point per version, faster higher, joined in version order', () => {
    const { container } = render(
      <PlanTrajectory points={POINTS} targetS={1500} raceDate="2027-03-13" checkpoints={[]} />,
    )
    const points = Array.from(container.querySelectorAll('[data-mark="prediction"]'))
    expect(points.map((p) => p.getAttribute('data-version'))).toEqual(['1', '2'])
    const [first, second] = points.map((p) => ({ x: Number(p.getAttribute('cx')), y: Number(p.getAttribute('cy')) }))
    if (first === undefined || second === undefined) throw new Error('two points expected')
    expect(second.x).toBeGreaterThan(first.x)
    expect(second.y).toBeGreaterThan(0)
    expect(second.y).toBeLessThan(first.y)
    const joint = container.querySelector('[data-mark="trajectory"]')
    expect(joint?.getAttribute('points')).toBe(`${String(first.x)},${String(first.y)} ${String(second.x)},${String(second.y)}`)
    // Each point is named with its version and time.
    expect(screen.getByText('v1 26:00')).toBeInTheDocument()
    expect(screen.getByText('v2 25:30')).toBeInTheDocument()
  })

  it('runs x from the first version to the race date', () => {
    const { container } = render(
      <PlanTrajectory points={POINTS} targetS={1500} raceDate="2027-03-13" checkpoints={[]} />,
    )
    const { plot } = trajectoryLayout(FALLBACK_WIDTH_PX, 2, false)
    const first = container.querySelector('[data-version="1"]')
    expect(Number(first?.getAttribute('cx'))).toBeCloseTo(plot.left, 6)
    expect(screen.getByText('6 Feb')).toBeInTheDocument()
    expect(screen.getByText('13 Mar')).toBeInTheDocument()
  })

  it('labels the right end with its own date when a version written after the race stretches the axis', () => {
    const late = [...POINTS, { number: 3, createdAt: '2027-03-23T12:00:00Z', bestEffortS: 1520 }]
    render(<PlanTrajectory points={late} targetS={1500} raceDate="2027-03-13" checkpoints={[]} />)
    expect(screen.getByText('13 Mar')).toBeInTheDocument()
    expect(screen.getByText('23 Mar')).toBeInTheDocument()
  })

  it('drops the right end\'s date when it would run into the race\'s', () => {
    // A closing version written the day after the race puts both dates a day apart.
    const closing = [...POINTS, { number: 3, createdAt: '2027-03-14T12:00:00Z', bestEffortS: 1520 }]
    render(<PlanTrajectory points={closing} targetS={1500} raceDate="2027-03-13" checkpoints={[]} />)
    expect(screen.getByText('13 Mar')).toBeInTheDocument()
    expect(screen.queryByText('14 Mar')).toBeNull()
  })

  it('marks each checkpoint with a diamond at its date in a strip below the plot, off the time axis', () => {
    const { container } = render(
      <PlanTrajectory points={POINTS} targetS={1500} raceDate="2027-03-13" checkpoints={CHECKPOINTS} />,
    )
    const { plot } = trajectoryLayout(FALLBACK_WIDTH_PX, 2, true)
    const diamonds = Array.from(container.querySelectorAll('[data-mark="checkpoint"]'))
    expect(diamonds.map((d) => d.getAttribute('data-session'))).toEqual(['tt', 'long'])
    // Wholly below the slowest rule, so no diamond reads as a time, and
    // below the date labels too, in a row named for the checkpoints.
    for (const d of diamonds) expect(Math.min(...diamondYs(d.getAttribute('d')))).toBeGreaterThan(plot.bottom)
    const dates = screen.getByText('13 Mar')
    const name = screen.getByText('Checkpoints')
    expect(Number(name.getAttribute('y'))).toBeGreaterThan(Number(dates.getAttribute('y')))
    for (const d of diamonds) {
      expect(Math.min(...diamondYs(d.getAttribute('d')))).toBeGreaterThan(Number(name.getAttribute('y')))
    }
  })

  it('labels a checkpoint with its distance and its own target, so it is not read as a goal-distance time', () => {
    render(<PlanTrajectory points={POINTS} targetS={1500} raceDate="2027-03-13" checkpoints={CHECKPOINTS} />)
    expect(screen.getByText('3 km TT 11:30')).toBeInTheDocument()
    expect(screen.getByText('Long run')).toBeInTheDocument()
    expect(screen.queryByText('11:30')).toBeNull()
    expect(screen.getByText('Checkpoint, target at its own distance')).toBeInTheDocument()
  })

  it('labels a checkpoint with no known distance by its kind alone', () => {
    const unknown = [{ ...CHECKPOINTS[0]!, targetDistanceM: null }]
    render(<PlanTrajectory points={POINTS} targetS={1500} raceDate="2027-03-13" checkpoints={unknown} />)
    expect(screen.getByText('Time trial 11:30')).toBeInTheDocument()
  })

  it('keeps the first point label off the slowest rule when the point sits just above it', () => {
    // 26:18 then 25:54 against 25:00: the ladder runs 24:30 to 26:30 and
    // the first point is 12 s, a tenth of the ladder, above its bottom.
    const near = [
      { number: 1, createdAt: '2027-02-06T12:00:00Z', bestEffortS: 1578 },
      { number: 2, createdAt: '2027-02-18T12:00:00Z', bestEffortS: 1554 },
    ]
    const { container } = render(
      <PlanTrajectory points={near} targetS={1500} raceDate="2027-03-13" checkpoints={CHECKPOINTS} />,
    )
    const { plot } = trajectoryLayout(FALLBACK_WIDTH_PX, 2, true)
    const point = container.querySelector('[data-version="1"]')
    const label = screen.getByText('v1 26:18')
    // Above its point, and so above the bottom rule and the strip below it.
    expect(Number(label.getAttribute('y'))).toBeLessThan(Number(point?.getAttribute('cy')))
    expect(Number(label.getAttribute('y'))).toBeLessThan(plot.bottom)
  })

  it('without a prediction still draws the target and the checkpoints', () => {
    const { container } = render(
      <PlanTrajectory
        points={[{ number: 1, createdAt: '2027-02-06T12:00:00Z', bestEffortS: null }]}
        targetS={1500}
        raceDate="2027-03-13"
        checkpoints={CHECKPOINTS}
      />,
    )
    expect(container.querySelectorAll('[data-mark="prediction"]')).toHaveLength(0)
    expect(container.querySelector('[data-mark="trajectory"]')).toBeNull()
    expect(container.querySelector('[data-mark="target"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-mark="checkpoint"]')).toHaveLength(2)
  })

  it('has an accessible name and states the versions, target and checkpoints in its text alternative', () => {
    render(<PlanTrajectory points={POINTS} targetS={1500} raceDate="2027-03-13" checkpoints={CHECKPOINTS} />)
    const chart = screen.getByRole('img', { name: /Best-effort prediction per plan version/ })
    const name = chart.getAttribute('aria-label') ?? ''
    expect(name).toContain('version 1, 6 Feb: 26:00')
    expect(name).toContain('version 2, 18 Feb: 25:30')
    expect(name).toContain('target 25:00 on 13 Mar')
    expect(name).toContain('checkpoint 27 Feb, 3 km time trial, target 11:30')
    expect(name).toContain('checkpoint 7 Mar, Long run at goal effort')
  })
})
