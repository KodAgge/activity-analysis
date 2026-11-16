/// <reference types="node" />
import { act, render, screen, within } from '@testing-library/react'
import type uPlot from 'uplot'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../api/schema'
import { calendarDayOfDate } from '../format'
import { TrainingLoadChart } from './TrainingLoadChart'

type LoadDay = components['schemas']['LoadDay']
type LoadWeek = components['schemas']['LoadWeek']

/** Same harness as `VolumeBars.test.tsx`: uPlot needs a layout engine jsdom lacks, so its constructor is spied on. */
const { instances, MockUPlot } = vi.hoisted(() => {
  class MockUPlot {
    // The stepped builder the distance line asks for; it draws nothing here.
    static paths = { stepped: () => () => null }
    opts: uPlot.Options
    data: uPlot.AlignedData
    setData = () => {}
    setSize = () => {}
    redraw = () => {}
    destroy = () => {}
    constructor(opts: uPlot.Options, data: uPlot.AlignedData) {
      this.opts = opts
      this.data = data
      instances.push(this)
    }
  }
  const instances: InstanceType<typeof MockUPlot>[] = []
  return { instances, MockUPlot }
})

vi.mock('uplot', () => ({ default: MockUPlot }))
vi.mock('uplot/dist/uPlot.min.css', () => ({}))
// A token resolves to its own name, so a test can say which token a mark took.
vi.mock('./cssVar', () => ({ cssVar: (name: string) => name }))

beforeEach(() => {
  instances.length = 0
})

function lastInstance(): InstanceType<typeof MockUPlot> {
  const instance = instances.at(-1)
  if (instance === undefined) throw new Error('uPlot was never constructed')
  return instance
}

function week(weekStart: string, overrides: Partial<LoadWeek> = {}): LoadWeek {
  return { week_start: weekStart, days: 7, trimp: 300, ctl_mean: 40, atl_mean: 50, form_mean: -10, distance_m: 30000, ...overrides }
}

function daysOf(monday: string, distance7d: number): LoadDay[] {
  const start = calendarDayOfDate(monday)
  return Array.from({ length: 7 }, (_, i) => ({
    local_date: new Date((start + i) * 86_400_000).toISOString().slice(0, 10),
    trimp: 0,
    ctl: 40,
    atl: 50,
    form: -10,
    distance_m: 0,
    distance_7d_m: distance7d,
  }))
}

const WEEKS = [
  week('2026-10-26', { trimp: 420, ctl_mean: 45, atl_mean: 55, form_mean: -10 }),
  // A week off: no bar, and its means still drawn.
  week('2026-11-02', { trimp: 0, ctl_mean: 43, atl_mean: 40, form_mean: 3 }),
  week('2026-11-09', { trimp: 510, ctl_mean: 47, atl_mean: 66, form_mean: -19 }),
]
const DAYS = [...daysOf('2026-10-26', 31000), ...daysOf('2026-11-02', 4000), ...daysOf('2026-11-09', 36000)]

/** The plotting area a fake uPlot reports, in canvas pixels. */
/** Inside the last of `WEEKS`. */
const TODAY = '2026-11-11'
const BBOX = { left: 0, top: 10, width: 600, height: 300 }

interface Stroke {
  points: [number, number][]
  strokeStyle: string
}

interface Fill {
  xs: number[]
  ys: number[]
  fillStyle: string
}

/** Runs every `drawAxes` and `draw` hook against a fake uPlot and records what was filled and stroked. */
function drawn(): { fills: Fill[]; strokes: Stroke[]; texts: string[] } {
  const hooks = [...(lastInstance().opts.hooks?.drawAxes ?? []), ...(lastInstance().opts.hooks?.draw ?? [])]
  const fills: Fill[] = []
  const strokes: Stroke[] = []
  const texts: string[] = []
  let xs: number[] = []
  let ys: number[] = []
  const ctx = {
    save: () => {},
    restore: () => {},
    clip: () => {},
    rect: () => {},
    setLineDash: () => {},
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    beginPath: () => {
      xs = []
      ys = []
    },
    moveTo: (x: number, y: number) => {
      xs.push(x)
      ys.push(y)
    },
    lineTo: (x: number, y: number) => {
      xs.push(x)
      ys.push(y)
    },
    arcTo: () => {},
    closePath: () => {},
    fill: () => fills.push({ xs, ys, fillStyle: ctx.fillStyle }),
    fillRect: () => {},
    stroke: () => strokes.push({ points: xs.map((x, i) => [x, ys[i] ?? Number.NaN]), strokeStyle: ctx.strokeStyle }),
    fillText: (text: string) => texts.push(text),
  }
  const fake = {
    ctx,
    bbox: BBOX,
    data: lastInstance().data,
    // x: a day is a pixel; each scale its own simple linear map.
    valToPos: (value: number, scale: string) => {
      if (scale === 'x') return value - calendarDayOfDate('2026-10-26')
      if (scale === 'form') return 280 - value
      if (scale === 'km') return 200 - value / 1000
      return 200 - value / 10
    },
  } as unknown as uPlot
  for (const hook of hooks) {
    if (typeof hook === 'function') hook(fake)
  }
  return { fills, strokes, texts }
}

describe('TrainingLoadChart', () => {
  it('TrainingLoadChart draws weekly bars, two lines and the distance line', () => {
    render(<TrainingLoadChart days={DAYS} weeks={WEEKS} ariaLabel="Training load" today={TODAY} />)
    const { opts, data } = lastInstance()
    // The distance line is drawn before fitness and fatigue, so on a
    // narrow plot its daily line passes under the two weekly ones.
    const labels = (opts.series ?? []).slice(1).map((s) => s.label)
    expect(labels).toEqual(['TRIMP per week', '7-day distance', 'Fitness (CTL) × 7', 'Fatigue (ATL) × 7', 'Form'])

    const defined = (row: number) => (data[row] as (number | null | undefined)[]).filter((v) => v !== undefined)
    // Weekly values, one per week, fitness and fatigue per day times seven.
    expect(defined(1)).toEqual([420, 0, 510])
    expect(defined(3)).toEqual([45 * 7, 43 * 7, 47 * 7])
    expect(defined(4)).toEqual([55 * 7, 40 * 7, 66 * 7])
    // The 7-day distance is daily, in metres, on its own right-hand scale,
    // stepped, and quieter than the lines over it.
    expect(defined(2)).toHaveLength(21)
    expect(opts.series?.[2]?.scale).toBe('km')
    expect(opts.series?.[2]?.alpha).toBeLessThan(1)
    expect(opts.series?.[2]?.paths).toBeTypeOf('function')
    expect(opts.axes?.find((a) => a.scale === 'km')?.side).toBe(1)

    // Fitness and fatigue share the bars' scale; each series keeps its slot's colour.
    expect(opts.series?.[3]?.scale).toBe('y')
    expect(opts.series?.[4]?.scale).toBe('y')
    expect(opts.series?.slice(1).map((s) => s.stroke)).toEqual([
      '--series-1',
      '--series-4',
      '--series-2',
      '--series-3',
      '--series-5',
    ])

    // The bars are drawn by hand, under the lines: one per week with TRIMP,
    // none for the week off.
    const bars = drawn().fills.filter((f) => f.fillStyle === '--series-1')
    expect(bars).toHaveLength(2)
    // The tallest is the 510 week, as tall as its value on the y scale.
    const tops = bars.map((b) => Math.min(...b.ys))
    expect(Math.min(...tops)).toBeCloseTo(200 - 51)
  })

  it('the form panel draws a zero line', () => {
    render(<TrainingLoadChart days={DAYS} weeks={WEEKS} ariaLabel="Training load" today={TODAY} />)
    const { opts } = lastInstance()
    expect(opts.series?.[5]?.scale).toBe('form')
    const zeroY = 280
    const zero = drawn().strokes.filter(
      (s) => s.strokeStyle === '--ink-dim' && s.points.length === 2 && s.points.every(([, y]) => Math.abs(y - zeroY) <= 1),
    )
    expect(zero).toHaveLength(1)
    // Across the whole plot.
    const xs = zero[0]?.points.map(([x]) => x) ?? []
    expect(Math.min(...xs)).toBe(BBOX.left)
    expect(Math.max(...xs)).toBe(BBOX.left + BBOX.width)
  })

  it('labels the form panel and its ladder, which uPlot has no axis for', () => {
    render(<TrainingLoadChart days={DAYS} weeks={WEEKS} ariaLabel="Training load" today={TODAY} />)
    const { texts } = drawn()
    expect(texts).toContain('Form')
    expect(texts).toContain('0')
  })

  it('keys every series, the bars as a bar and the lines as lines', () => {
    render(<TrainingLoadChart days={DAYS} weeks={WEEKS} ariaLabel="Training load" today={TODAY} />)
    const legend = screen.getByRole('list', { name: 'Training load legend' })
    const items = within(legend).getAllByRole('listitem').map((li) => li.textContent)
    expect(items).toEqual(['TRIMP per week', 'Fitness (CTL) × 7', 'Fatigue (ATL) × 7', '7-day distance (right)', 'Form (below)'])
  })

  it('marks the week in progress as so far in the readout, and a first partial week by its days', () => {
    const weeks = [week('2026-10-28', { days: 5 }), week('2026-11-02'), week('2026-11-09', { days: 3 })]
    render(<TrainingLoadChart days={[]} weeks={weeks} ariaLabel="Training load" today="2026-11-11" />)
    const hook = lastInstance().opts.hooks?.setCursor?.[0]
    if (typeof hook !== 'function') throw new Error('no setCursor hook')
    const xs = lastInstance().data[0] as number[]
    const hoverAt = (index: number) =>
      act(() => {
        hook({ cursor: { idx: index, left: 10 }, over: { offsetLeft: 0 }, width: 600 } as unknown as uPlot)
      })
    hoverAt(xs.length - 1)
    expect(screen.getByTestId('load-readout')).toHaveTextContent('Week of 9 November 2026, so far')
    hoverAt(0)
    expect(screen.getByTestId('load-readout')).toHaveTextContent('Week of 28 October 2026, 5 days')
    hoverAt(1)
    expect(screen.getByTestId('load-readout').querySelector('p')?.textContent).toBe('Week of 2 November 2026')
  })

  it('reads a short last week that ended before today by its days, not as so far', () => {
    // A custom period, or a store whose last run was weeks ago: the series
    // ends at the last run's week, which is short but over.
    const weeks = [week('2026-11-02'), week('2026-11-09', { days: 3 })]
    render(<TrainingLoadChart days={[]} weeks={weeks} ariaLabel="Training load" today="2026-12-01" />)
    const hook = lastInstance().opts.hooks?.setCursor?.[0]
    if (typeof hook !== 'function') throw new Error('no setCursor hook')
    const xs = lastInstance().data[0] as number[]
    act(() => {
      hook({ cursor: { idx: xs.length - 1, left: 10 }, over: { offsetLeft: 0 }, width: 600 } as unknown as uPlot)
    })
    expect(screen.getByTestId('load-readout').querySelector('p')?.textContent).toBe(
      'Week of 9 November 2026, 3 days',
    )
  })
})
