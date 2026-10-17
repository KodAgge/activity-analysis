import { act, fireEvent, render, screen } from '@testing-library/react'
import type uPlot from 'uplot'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../api/schema'
import { TerritoryGrowth, type TerritoryGrowthProps } from './TerritoryGrowth'

type TerritoryGrowthPoint = components['schemas']['TerritoryGrowthPoint']

/** uPlot needs a layout engine jsdom lacks, so its constructor is recorded rather than run. */
const { instances, MockUPlot, stepped } = vi.hoisted(() => {
  const stepped = vi.fn(() => () => null)
  class MockUPlot {
    static paths = { stepped }
    opts: uPlot.Options
    data: uPlot.AlignedData
    setData = () => {}
    setSize = () => {}
    destroy = () => {}
    constructor(opts: uPlot.Options, data: uPlot.AlignedData) {
      this.opts = opts
      this.data = data
      instances.push(this)
    }
  }
  const instances: InstanceType<typeof MockUPlot>[] = []
  return { instances, MockUPlot, stepped }
})

vi.mock('uplot', () => ({ default: MockUPlot }))
vi.mock('uplot/dist/uPlot.min.css', () => ({}))

beforeEach(() => {
  instances.length = 0
})

function lastInstance() {
  const instance = instances.at(-1)
  if (instance === undefined) throw new Error('uPlot was never constructed')
  return instance
}

function point(start: string, newM2: number, cumulative: number): TerritoryGrowthPoint {
  return {
    activity_id: start,
    start_time_utc: start,
    utc_offset_s: 7200,
    name: 'Run',
    region_id: 'r',
    enclosed_m2: newM2,
    new_m2: newM2,
    cumulative_m2: cumulative,
  }
}

const growth = [
  point('2024-05-01T08:00:00Z', 250_000, 250_000),
  point('2024-06-01T08:00:00Z', 0, 250_000),
  point('2025-02-01T08:00:00Z', 4_750_000, 5_000_000),
]

describe('TerritoryGrowth', () => {
  it('plots the total after each claiming run in km², as a step that holds between runs', () => {
    render(<TerritoryGrowth growth={growth} />)
    const chart = lastInstance()
    expect(chart.data[1]).toEqual([0.25, 0.25, 5])
    expect(stepped).toHaveBeenCalledWith({ align: 1 })
  })

  it('anchors the scale at zero and labels it in km²', () => {
    render(<TerritoryGrowth growth={growth} />)
    const opts = lastInstance().opts
    const yRange = opts.scales?.y?.range
    expect(typeof yRange === 'function' ? yRange({} as uPlot, 0, 5, 'y') : yRange).toEqual([0, 5])
    const yAxis = opts.axes?.[1]
    const splits = typeof yAxis?.splits === 'function' ? yAxis.splits({} as uPlot, 1, 0, 5, 2.5, 1) : []
    expect(splits).toEqual([0, 2.5, 5])
    const values = yAxis?.values
    expect(typeof values === 'function' ? values({} as uPlot, splits, 1, 2.5, 1) : []).toEqual(['0 km²', '2.5 km²', '5 km²'])
  })

  it('names the chart with the run count and the total it rises to', () => {
    render(<TerritoryGrowth growth={growth} />)
    expect(screen.getByRole('img')).toHaveAccessibleName('Claimed ground after each of 3 claiming runs, rising to 5.00 km²')
  })

  it('reads out a hovered run: its day, the total after it, and what it added, even when that is nothing', () => {
    render(<TerritoryGrowth growth={growth} />)
    const chart = lastInstance()
    const setCursor = chart.opts.hooks?.setCursor?.[0]
    const fake = {
      cursor: { idx: 1, left: 120 },
      over: { offsetLeft: 0 },
      width: 600,
      data: chart.data,
      valToPos: () => 120,
    } as unknown as uPlot
    act(() => setCursor?.(fake))
    const readout = screen.getByTestId('territory-growth-readout')
    expect(readout).toHaveTextContent('1 Jun 2024')
    expect(readout).toHaveTextContent('0.25 km² claimed')
    expect(readout).toHaveTextContent('+0.00 km² from this run')
  })

  it('names the hovered run’s place, and moves the readout to the foot for a total in the upper half', () => {
    const regions = [{ region_id: 'r', name: 'Lakeside' }] as unknown as TerritoryGrowthProps['regions']
    render(<TerritoryGrowth growth={growth} regions={regions} />)
    const chart = lastInstance()
    const setCursor = chart.opts.hooks?.setCursor?.[0]
    const hoverAt = (idx: number) =>
      act(() =>
        setCursor?.({
          cursor: { idx, left: 120 },
          over: { offsetLeft: 0 },
          width: 600,
          data: chart.data,
          valToPos: () => 120,
        } as unknown as uPlot),
      )
    hoverAt(0)
    const low = screen.getByTestId('territory-growth-readout')
    expect(low).toHaveTextContent('1 May 2024, Lakeside')
    const topClass = low.className
    // 5 km² on a 0..5 scale is the upper half; 0.25 km² is not.
    hoverAt(2)
    expect(screen.getByTestId('territory-growth-readout').className).not.toBe(topClass)
  })

  it('marks the last point, the total the screen states, with a dot ringed in the page colour', () => {
    render(<TerritoryGrowth growth={growth} />)
    const chart = lastInstance()
    const draw = chart.opts.hooks?.draw?.[0]
    const arcs: number[][] = []
    const fills: string[] = []
    const ctx = {
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      arc: (...args: number[]) => arcs.push(args),
      fill: () => fills.push(ctx.fillStyle),
      fillStyle: '',
    }
    draw?.({ ctx, data: chart.data, valToPos: (v: number) => v } as unknown as uPlot)
    expect(arcs.map((a) => [a[0], a[1]])).toEqual([
      [chart.data[0].at(-1), 5],
      [chart.data[0].at(-1), 5],
    ])
    // The ring first and larger, then the dot.
    expect((arcs[0]?.[2] ?? 0) > (arcs[1]?.[2] ?? 0)).toBe(true)
    expect(fills).toHaveLength(2)
  })

  it("ticks the foot of the plot at each of the marked place's runs, and nothing when no place is marked", () => {
    const mixed = growth.map((p, index) => (index === 1 ? { ...p, region_id: 'k' } : p))
    const ticksFor = (markedRegionId: string | undefined) => {
      const { unmount } = render(<TerritoryGrowth growth={mixed} markedRegionId={markedRegionId} />)
      const chart = lastInstance()
      const draw = chart.opts.hooks?.draw?.[1]
      const rects: number[][] = []
      const ctx = { save: () => {}, restore: () => {}, fillRect: (...args: number[]) => rects.push(args), fillStyle: '' }
      draw?.({
        ctx,
        data: chart.data,
        bbox: { top: 10, height: 100, left: 0, width: 600 },
        valToPos: (v: number) => v,
      } as unknown as uPlot)
      unmount()
      return rects
    }
    const marked = ticksFor('r')
    // Two of the three runs are in `r`; each tick stands on the plot's foot.
    expect(marked).toHaveLength(2)
    for (const [, y, , h] of marked) expect((y ?? 0) + (h ?? 0)).toBe(110)
    expect(ticksFor('k')).toHaveLength(1)
    expect(ticksFor(undefined)).toHaveLength(0)
  })

  it("chooses the hovered run's place when the plot is clicked", () => {
    const onSelectRegion = vi.fn()
    render(<TerritoryGrowth growth={growth} onSelectRegion={onSelectRegion} />)
    const chart = lastInstance()
    const setCursor = chart.opts.hooks?.setCursor?.[0]
    // Not hovering: a click chooses nothing.
    fireEvent.click(screen.getByRole('img'))
    expect(onSelectRegion).not.toHaveBeenCalled()
    act(() =>
      setCursor?.({
        cursor: { idx: 2, left: 120 },
        over: { offsetLeft: 0 },
        width: 600,
        data: chart.data,
        valToPos: () => 120,
      } as unknown as uPlot),
    )
    fireEvent.click(screen.getByRole('img'))
    expect(onSelectRegion).toHaveBeenCalledWith('r')
  })
})
