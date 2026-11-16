import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { components } from '../api/schema'
import { PlanTrajectory } from './PlanTrajectory'
import type { PlanTrajectoryProps } from './PlanTrajectory'
import { trajectoryLayout } from './planChartMath'

type HistoryPoint = components['schemas']['PredictionHistoryPoint']

function history(
  start: string,
  bestS: number | null,
  ordinaryS: number | null,
  offset: number | null = 3600,
): HistoryPoint {
  return {
    activity_id: start,
    start_time_utc: start,
    utc_offset_s: offset,
    best_efforts_vdot: bestS === null ? null : 40,
    best_efforts_s: bestS,
    ordinary_runs_s: ordinaryS,
    ordinary_runs_low_s: ordinaryS === null ? null : ordinaryS - 60,
    ordinary_runs_high_s: ordinaryS === null ? null : ordinaryS + 60,
  }
}

/*
 * A plan from Monday 8 February to a race on 13 March with a 25:00
 * target. The expected line starts at data_through, 5 February, at 26:00
 * and reaches 25:20 by the race. Three runs since the first week measure
 * 25:55 to 25:45 from best efforts and 27:30 to 27:20 from ordinary runs;
 * the run on 1 February is before the first week and is not drawn.
 */
const EXPECTED = [
  { date: '2027-02-05', valueS: 1560 },
  { date: '2027-02-14', valueS: 1550 },
  { date: '2027-02-21', valueS: 1540 },
  { date: '2027-03-13', valueS: 1520 },
]

const HISTORY = [
  history('2027-02-01T07:00:00Z', 1580, 1660),
  history('2027-02-09T07:00:00Z', 1555, 1650),
  history('2027-02-16T07:00:00Z', 1548, 1645),
  history('2027-02-20T07:00:00Z', 1545, 1640),
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

const BASE: PlanTrajectoryProps = {
  expected: EXPECTED,
  history: HISTORY,
  targetS: 1500,
  raceDate: '2027-03-13',
  measuredFrom: '2027-02-08',
  checkpoints: [],
  measuredNote: null,
}

function draw(over: Partial<PlanTrajectoryProps> = {}) {
  return render(<PlanTrajectory {...BASE} {...over} />)
}

/** The y of a diamond path's top and bottom vertices, from its `d`. */
function diamondYs(d: string | null): number[] {
  const ys = (d ?? '').match(/-?\d+(\.\d+)?/g)?.map(Number).filter((_, i) => i % 2 === 1) ?? []
  return ys
}

/** A polyline's vertices. */
function vertices(line: Element | null): { x: number; y: number }[] {
  return (line?.getAttribute('points') ?? '')
    .split(' ')
    .filter((xy) => xy !== '')
    .map((xy) => {
      const [x, y] = xy.split(',').map(Number)
      return { x: x ?? Number.NaN, y: y ?? Number.NaN }
    })
}

/** jsdom measures nothing, so the chart lays out at its fallback width. */
const FALLBACK_WIDTH_PX = 600

describe('PlanTrajectory', () => {
  it('draws the target as a line at its time, faster than every measured run, labelled with that time', () => {
    const { container } = draw()
    const line = container.querySelector('[data-mark="target"]')
    if (line === null) throw new Error('no target line')
    const y = Number(line.getAttribute('y1'))
    expect(Number(line.getAttribute('y2'))).toBe(y)
    for (const v of vertices(container.querySelector('[data-series="best_efforts"]'))) expect(v.y).toBeGreaterThan(y)
    expect(screen.getByText('Target 25:00')).toBeInTheDocument()
  })

  it('leads with the latest measured prediction, the target and the time between them', () => {
    const { container, unmount } = draw()
    expect(Array.from(container.querySelectorAll('dl > div')).map((d) => d.textContent)).toEqual([
      'Latest prediction25:45',
      'Target25:00',
      'To find0:45',
    ])
    unmount()
    const ahead = draw({ targetS: 1600 })
    expect(ahead.container.querySelector('dl > div:last-child')?.textContent).toBe('Inside target by0:55')
    ahead.unmount()
    const none = draw({ history: [] })
    expect(Array.from(none.container.querySelectorAll('dl > div')).map((d) => d.textContent)).toEqual(['Target25:00'])
  })

  it('states no latest prediction when the newest run has no best-efforts value, as the header and the table', () => {
    // An older run's value does not stand in: /api/predictions serves the newest row.
    const { container } = draw({ history: [...HISTORY, history('2027-02-21T07:00:00Z', null, 1638)] })
    expect(Array.from(container.querySelectorAll('dl > div')).map((d) => d.textContent)).toEqual(['Target25:00'])
  })

  it('draws the expected line dashed and both measured lines solid', () => {
    const { container } = draw()
    const expected = container.querySelector('[data-series="expected"]')
    expect(vertices(expected)).toHaveLength(4)
    expect(expected?.getAttribute('stroke-dasharray')).not.toBeNull()
    expect(expected?.getAttribute('stroke')).toBe('var(--series-5)')
    const best = container.querySelector('[data-series="best_efforts"]')
    const ordinary = container.querySelector('[data-series="ordinary_runs"]')
    expect(best?.getAttribute('stroke')).toBe('var(--series-5)')
    expect(ordinary?.getAttribute('stroke')).toBe('var(--series-2)')
    for (const line of [best, ordinary]) {
      expect(line?.getAttribute('stroke-dasharray')).toBeNull()
      expect(vertices(line)).toHaveLength(3)
    }
    // Ordinary runs are drawn fainter than the best efforts they sit beside.
    expect(Number(ordinary?.getAttribute('stroke-opacity'))).toBeLessThan(1)
    expect(screen.getByText('Expected by the plan')).toBeInTheDocument()
    expect(screen.getByText('Best efforts')).toBeInTheDocument()
    expect(screen.getByText('Ordinary runs')).toBeInTheDocument()
  })

  it('ends the measured lines at the newest run, before the race', () => {
    const { container } = draw()
    const raceX = vertices(container.querySelector('[data-series="expected"]')).at(-1)?.x ?? Number.NaN
    const best = vertices(container.querySelector('[data-series="best_efforts"]'))
    const ordinary = vertices(container.querySelector('[data-series="ordinary_runs"]'))
    expect(best.at(-1)?.x).toBe(ordinary.at(-1)?.x)
    expect(best.at(-1)?.x).toBeLessThan(raceX)
    // Faster up: 25:45 sits above 25:55.
    expect(best.at(-1)?.y).toBeLessThan(best[0]?.y ?? Number.NaN)
  })

  it('draws the runs from measuredFrom on, each on its own local day', () => {
    // 23:30Z on 7 February is the 8th at UTC+1, inside; 22:30Z at UTC+0 is the 7th, outside.
    const { container } = draw({
      history: [history('2027-02-07T22:30:00Z', 1570, 1655, 0), history('2027-02-07T23:30:00Z', 1565, 1652), ...HISTORY.slice(1)],
    })
    expect(vertices(container.querySelector('[data-series="best_efforts"]'))).toHaveLength(4)
  })

  it('breaks a measured line at a run without a value, and draws a lone run as a dot', () => {
    const { container } = draw({
      history: [HISTORY[1]!, history('2027-02-12T07:00:00Z', null, 1648), HISTORY[2]!, HISTORY[3]!],
    })
    expect(container.querySelectorAll('[data-series="best_efforts"]')).toHaveLength(2)
    expect(container.querySelector('circle[data-series="best_efforts"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-series="ordinary_runs"]')).toHaveLength(1)
  })

  it('breaks a measured line where runs are more than six weeks apart', () => {
    const { container } = draw({
      raceDate: '2027-06-30',
      history: [...HISTORY.slice(1), history('2027-04-20T07:00:00Z', 1530, 1620), history('2027-04-25T07:00:00Z', 1528, 1618)],
    })
    expect(container.querySelectorAll('polyline[data-series="best_efforts"]')).toHaveLength(2)
    expect(container.querySelectorAll('polyline[data-series="ordinary_runs"]')).toHaveLength(2)
  })

  it('names the expected, measured and target times in its accessible name', () => {
    draw({ checkpoints: CHECKPOINTS })
    const chart = screen.getByRole('img', { name: /^Predicted time, expected and measured, against the target/ })
    const name = chart.getAttribute('aria-label') ?? ''
    expect(name).toContain('expected 26:00 on 5 Feb to 25:20 on 13 Mar')
    expect(name).toContain('best efforts 25:55 on 9 Feb to 25:45 on 20 Feb')
    expect(name).toContain('ordinary runs 27:30 on 9 Feb to 27:20 on 20 Feb')
    expect(name).toContain('target 25:00 on 13 Mar')
    expect(name).toContain('checkpoint 27 Feb, 3 km time trial, target 11:30')
    expect(name).toContain('checkpoint 7 Mar, Long run at goal effort')
  })

  it('draws an expected line of one point as a dot', () => {
    const { container } = draw({ expected: [{ date: '2027-03-13', valueS: 1520 }] })
    expect(container.querySelector('polyline[data-series="expected"]')).toBeNull()
    expect(container.querySelector('circle[data-series="expected"]')).not.toBeNull()
    expect(screen.getByText('Expected by the plan')).toBeInTheDocument()
  })

  it('says the version has no expected line when expected_prediction is empty', () => {
    const { container } = draw({ expected: [] })
    expect(screen.getByRole('status')).toHaveTextContent('This version predates the expected prediction.')
    expect(container.querySelector('[data-series="expected"]')).toBeNull()
    expect(container.querySelector('[data-series="best_efforts"]')).not.toBeNull()
    expect(screen.queryByText('Expected by the plan')).toBeNull()
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('no expected line')
  })

  it('runs x from the expected line\'s start to the race date', () => {
    const { container } = draw()
    const { plot } = trajectoryLayout(FALLBACK_WIDTH_PX, 7, false)
    const first = vertices(container.querySelector('[data-series="expected"]'))[0]
    expect(first?.x).toBeCloseTo(plot.left, 6)
    expect(screen.getByText('5 Feb')).toBeInTheDocument()
    expect(screen.getByText('13 Mar')).toBeInTheDocument()
  })

  it('draws no run after the race, and ends the axis at the race', () => {
    const { container } = draw({
      history: [...HISTORY, history('2027-03-13T20:00:00Z', 1530, 1610), history('2027-03-14T07:00:00Z', 1520, 1600)],
    })
    const { plot } = trajectoryLayout(FALLBACK_WIDTH_PX, 8, false)
    // The race-day run is drawn; the next day's is not, nor does it widen the axis.
    const best = vertices(container.querySelector('[data-series="best_efforts"]'))
    expect(best).toHaveLength(4)
    expect(best.at(-1)?.x).toBeLessThanOrEqual(plot.right)
    expect(vertices(container.querySelector('[data-series="expected"]')).at(-1)?.x).toBeCloseTo(plot.right, 6)
    expect(screen.queryByText('14 Mar')).toBeNull()
  })

  it('puts the year on both end dates when the span crosses one', () => {
    draw({
      expected: [
        { date: '2026-11-14', valueS: 13700 },
        { date: '2027-12-05', valueS: 13500 },
      ],
      history: [],
      targetS: 13500,
      raceDate: '2027-12-05',
      measuredFrom: '2026-10-03',
    })
    expect(screen.getByText('14 Nov 2026')).toBeInTheDocument()
    expect(screen.getByText('5 Dec 2027')).toBeInTheDocument()
  })

  it('states why the measured lines are missing while the history loads or failed', () => {
    draw({ history: [], measuredNote: 'Loading the measured predictions.' })
    expect(screen.getByRole('status')).toHaveTextContent('Loading the measured predictions.')
  })

  it('marks each checkpoint with a diamond at its date in a strip below the plot, off the time axis', () => {
    const { container } = draw({ checkpoints: CHECKPOINTS })
    const { plot } = trajectoryLayout(FALLBACK_WIDTH_PX, 7, true)
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
    draw({ checkpoints: CHECKPOINTS })
    expect(screen.getByText('3 km TT 11:30')).toBeInTheDocument()
    expect(screen.getByText('Long run')).toBeInTheDocument()
    expect(screen.queryByText('11:30')).toBeNull()
    expect(screen.getByText('Checkpoint, target at its own distance')).toBeInTheDocument()
  })

  it('labels a checkpoint with no known distance by its kind alone', () => {
    draw({ checkpoints: [{ ...CHECKPOINTS[0]!, targetDistanceM: null }] })
    expect(screen.getByText('Time trial 11:30')).toBeInTheDocument()
  })

  it('without a prediction still draws the target and the checkpoints', () => {
    const { container } = draw({ expected: [], history: [], checkpoints: CHECKPOINTS })
    expect(container.querySelector('[data-series]')).toBeNull()
    expect(container.querySelector('[data-mark="target"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-mark="checkpoint"]')).toHaveLength(2)
  })
})
