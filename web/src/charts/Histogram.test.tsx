/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type uPlot from 'uplot'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Histogram, type HistogramProps, type HistogramSeries } from './Histogram'
import type { Bucket } from './histogramMath'

/**
 * The harness `VolumeBars.test.tsx` uses: uPlot needs a layout engine jsdom
 * does not have, so the constructor is replaced and the hooks the component
 * wires are driven by hand against a fake instance.
 */
const { instances, MockUPlot } = vi.hoisted(() => {
  class MockUPlot {
    opts: uPlot.Options
    data: uPlot.AlignedData
    setData = () => {}
    setSize = () => {}
    redraw = vi.fn()
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

/*
 * The two palette tokens, set on the root so `cssVar` resolves them the way
 * it does in a browser. jsdom applies no stylesheet, so without these both
 * would read back as the empty string and a colour assertion could not tell
 * the ink series from the accent one.
 */
const INK = '#10243a'
const ACCENT = '#bd1f44'

beforeEach(() => {
  instances.length = 0
  document.documentElement.style.setProperty('--ink', INK)
  document.documentElement.style.setProperty('--accent', ACCENT)
})

afterEach(() => {
  document.documentElement.style.removeProperty('--ink')
  document.documentElement.style.removeProperty('--accent')
})

function lastInstance(): InstanceType<typeof MockUPlot> {
  const instance = instances.at(-1)
  if (instance === undefined) throw new Error('uPlot was never constructed')
  return instance
}

const BUCKETS: Bucket[] = [
  { key: '4000', lo: 4000, hi: 5000, label: '4 to 5' },
  { key: '5000', lo: 5000, hi: 6000, label: '5 to 6' },
  { key: '6000', lo: 6000, hi: 7000, label: '6 to 7' },
  { key: '7000', lo: 7000, hi: 8000, label: '7 to 8' },
  { key: 'above', lo: 8000, hi: null, label: '≥ 8' },
]

const ALL_RUNS: HistogramSeries = { label: 'All runs', values: [3, 5, 8, 2, 1], medianAt: 2.4, n: 19 }
const RECENT: HistogramSeries = { label: 'Last 12 months', values: [10, 20, 40, 20, 10], medianAt: 2.5, n: 30 }
const EARLIER: HistogramSeries = { label: 'Previous 12 months', values: [0, 30, 30, 40, 0], medianAt: 2.9, n: 20 }

const LABEL = 'Distance, runs per bucket'

function formatValue(value: number): string {
  return `${String(Math.round(value))} runs`
}

function renderHistogram(overrides: Partial<HistogramProps> = {}) {
  const onSelect = vi.fn()
  const view = render(
    <Histogram
      buckets={BUCKETS}
      series={[ALL_RUNS]}
      formatValue={formatValue}
      selectedKey={null}
      onSelect={onSelect}
      label={LABEL}
      {...overrides}
    />,
  )
  return { ...view, onSelect }
}

/** The plotting area the fake uPlot reports, in canvas pixels. */
const BBOX = { left: 60, top: 10, width: 500, height: 200 }
const BASELINE_Y = 500

/** x: bucket i's centre at BBOX.left + 100 + 100i; y: 10 per unit above a baseline at 500. */
function valToPos(value: number, scale: string): number {
  return scale === 'y' ? BASELINE_Y - value * 10 : BBOX.left + 100 + value * 100
}

interface Bar {
  left: number
  right: number
  top: number
  bottom: number
  fillStyle: string
  alpha: number
}

interface Stroke {
  points: [number, number][]
  strokeStyle: string
  lineWidth: number
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
  fillStyle: string
}

/** Every call the draw hook made, in order, for assertions about paint order. */
type Op = 'bar' | 'stroke' | 'rect'

/**
 * Runs the `draw` hook the component wired against a fake uPlot and reports
 * what it painted. Bars are the filled paths (`fill`), the outline the
 * stroked ones (`stroke`), and the zero rule and median ticks the
 * rectangles (`fillRect`), told apart by their colour and position.
 */
function drawn(): { bars: Bar[]; strokes: Stroke[]; rects: Rect[]; ops: Op[] } {
  const hook = lastInstance().opts.hooks?.draw?.[0]
  if (hook === undefined || typeof hook !== 'function') throw new Error('no draw hook was wired')

  const bars: Bar[] = []
  const strokes: Stroke[] = []
  const rects: Rect[] = []
  const ops: Op[] = []
  let points: [number, number][] = []
  const ctx = {
    save: () => {},
    restore: () => {},
    fillStyle: '',
    strokeStyle: '',
    // Seeded with what uPlot leaves behind after this chart's 1 px grid,
    // so an unset width in the hook fails rather than passing by
    // inheritance. See "A drawAxes hook inherits the canvas state" in
    // frontend.md.
    lineWidth: 1 * window.devicePixelRatio,
    globalAlpha: 1,
    lineJoin: 'round',
    lineCap: 'round',
    beginPath: () => {
      points = []
    },
    moveTo: (x: number, y: number) => points.push([x, y]),
    lineTo: (x: number, y: number) => points.push([x, y]),
    arcTo: () => {},
    closePath: () => {},
    fill: () => {
      const xs = points.map(([x]) => x)
      const ys = points.map(([, y]) => y)
      bars.push({
        left: Math.min(...xs),
        right: Math.max(...xs),
        top: Math.min(...ys),
        bottom: Math.max(...ys),
        fillStyle: ctx.fillStyle,
        alpha: ctx.globalAlpha,
      })
      ops.push('bar')
    },
    stroke: () => {
      strokes.push({ points: [...points], strokeStyle: ctx.strokeStyle, lineWidth: ctx.lineWidth })
      ops.push('stroke')
    },
    fillRect: (x: number, y: number, w: number, h: number) => {
      rects.push({ x, y, w, h, fillStyle: ctx.fillStyle })
      ops.push('rect')
    },
  }

  hook({
    ctx,
    bbox: BBOX,
    valToPos,
    over: { offsetLeft: 0 },
    width: 600,
  } as unknown as uPlot)

  return { bars, strokes, rects, ops }
}

/** The median ticks: the rectangles hanging below the baseline. */
function ticks(rects: Rect[]): Rect[] {
  return rects.filter((rect) => rect.y >= BASELINE_Y - 1 && rect.h > 2)
}

function atRatio<T>(ratio: number, fn: () => T): T {
  const original = window.devicePixelRatio
  window.devicePixelRatio = ratio
  try {
    return fn()
  } finally {
    window.devicePixelRatio = original
  }
}

/** Fires the `setCursor` hook the way uPlot does on a pointer move. */
function moveCursorTo(idx: number | null, left = 150, plotLeftPx = 0): void {
  const hook = lastInstance().opts.hooks?.setCursor?.[0]
  if (hook === undefined || typeof hook !== 'function') throw new Error('no setCursor hook was wired')
  act(() => {
    hook({ cursor: { idx, left }, over: { offsetLeft: plotLeftPx }, width: 600 } as unknown as uPlot)
  })
}

describe('Histogram bars', () => {
  it('draws one bar per bucket', () => {
    renderHistogram()
    expect(drawn().bars).toHaveLength(BUCKETS.length)
  })

  it('draws the bars in --ink, centred on their own buckets', () => {
    renderHistogram()
    const { bars } = drawn()
    for (const bar of bars) expect(bar.fillStyle).toBe(INK)
    expect(bars.map((bar) => (bar.left + bar.right) / 2)).toEqual([160, 260, 360, 460, 560])
    for (const bar of bars) expect(bar.bottom).toBe(BASELINE_Y)
  })

  it('draws nothing for an empty bucket rather than a floor-height bar', () => {
    renderHistogram({ series: [{ ...ALL_RUNS, values: [3, 0, 8, 2, 1] }] })
    expect(drawn().bars).toHaveLength(4)
  })

  it('draws every bar at full opacity with nothing selected', () => {
    renderHistogram()
    expect(drawn().bars.map((bar) => bar.alpha)).toEqual([1, 1, 1, 1, 1])
  })

  it('dims every bar but the selected one', () => {
    renderHistogram({ selectedKey: '6000' })
    const alphas = drawn().bars.map((bar) => bar.alpha)
    expect(alphas[2]).toBe(1)
    for (const i of [0, 1, 3, 4]) {
      expect(alphas[i]).toBeGreaterThan(0)
      expect(alphas[i]).toBeLessThan(1)
    }
  })
})

describe('Histogram selection redraw', () => {
  it('keeps its uPlot instance across a selection change, and redraws it with the new selection', () => {
    // One `series` identity across both renders, as the view memoises it.
    const series: [HistogramSeries] = [ALL_RUNS]
    const { rerender } = renderHistogram({ series })
    const instance = lastInstance()
    expect(drawn().bars.map((bar) => bar.alpha)).toEqual([1, 1, 1, 1, 1])

    rerender(
      <Histogram
        buckets={BUCKETS}
        series={series}
        formatValue={formatValue}
        selectedKey="6000"
        onSelect={() => {}}
        label={LABEL}
      />,
    )

    expect(instances).toHaveLength(1)
    expect(lastInstance()).toBe(instance)
    expect(instance.redraw).toHaveBeenCalled()
    const alphas = drawn().bars.map((bar) => bar.alpha)
    expect(alphas[2]).toBe(1)
    expect(alphas[0]).toBeLessThan(1)
  })
})

describe('Histogram legend', () => {
  it('draws no legend for one group', () => {
    renderHistogram()
    expect(screen.queryByRole('list', { name: 'Groups' })).toBeNull()
  })

  it('names the bars and the outline in the order of the series', () => {
    renderHistogram({ series: [RECENT, EARLIER] })
    const items = within(screen.getByRole('list', { name: 'Groups' })).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual(['Last 12 months', 'Previous 12 months'])
    expect(items.map((item) => item.querySelector('[data-swatch]')?.getAttribute('data-swatch'))).toEqual([
      'bars',
      'outline',
    ])
  })

  it('sits outside the listbox, whose children are all options', () => {
    renderHistogram({ series: [RECENT, EARLIER] })
    const region = screen.getByRole('listbox', { name: LABEL })
    expect(within(region).queryByRole('list')).toBeNull()
  })

  it('keys its items by position, so two groups of one name both show', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      renderHistogram({ series: [RECENT, { ...EARLIER, label: RECENT.label }] })
      const items = within(screen.getByRole('list', { name: 'Groups' })).getAllByRole('listitem')
      expect(items).toHaveLength(2)
      expect(errors.mock.calls.some((call) => String(call[0]).includes('same key'))).toBe(false)
    } finally {
      errors.mockRestore()
    }
  })
})

describe('Histogram overlay', () => {
  it('hands uPlot the outline series only when there are two series', () => {
    renderHistogram()
    expect(lastInstance().opts.series).toHaveLength(2)
    expect(lastInstance().data).toHaveLength(2)

    renderHistogram({ series: [RECENT, EARLIER] })
    expect(lastInstance().opts.series).toHaveLength(3)
    expect(lastInstance().data).toHaveLength(3)
  })

  it('strokes no outline for one series', () => {
    renderHistogram()
    expect(drawn().strokes).toHaveLength(0)
  })

  it('strokes the second series as a stepped outline in --accent, over the first as bars', () => {
    renderHistogram({ series: [RECENT, EARLIER] })
    const { bars, strokes, ops } = drawn()

    expect(bars).toHaveLength(BUCKETS.length)
    for (const bar of bars) expect(bar.fillStyle).toBe(INK)
    expect(strokes).toHaveLength(1)
    const [outline] = strokes
    if (outline === undefined) throw new Error('no outline')
    expect(outline.strokeStyle).toBe(ACCENT)
    // Up from the baseline at bucket 1's left edge (scale 0.5), across it at
    // 30, and down at the right edge of bucket 3 (scale 3.5) from 40; the
    // two empty end buckets draw nothing.
    expect(outline.points[0]).toEqual([valToPos(0.5, 'x'), BASELINE_Y])
    expect(outline.points[1]).toEqual([valToPos(0.5, 'x'), valToPos(30, 'y')])
    expect(outline.points.at(-1)).toEqual([valToPos(3.5, 'x'), BASELINE_Y])
    expect(Math.min(...outline.points.map(([, y]) => y))).toBe(valToPos(40, 'y'))

    // After every bar, so the outline is never painted under one.
    expect(ops.lastIndexOf('bar')).toBeLessThan(ops.indexOf('stroke'))
  })

  it('strokes the outline at 2 CSS px on any display', () => {
    renderHistogram({ series: [RECENT, EARLIER] })
    expect(atRatio(1, () => drawn().strokes[0]?.lineWidth)).toBe(2)
    expect(atRatio(3, () => drawn().strokes[0]?.lineWidth)).toBe(6)
  })

  it("draws each series' median as a tick below the baseline in its own colour", () => {
    renderHistogram({ series: [RECENT, EARLIER] })
    const found = ticks(drawn().rects)
    expect(found.map((tick) => tick.fillStyle)).toEqual([INK, ACCENT])
    // Position 2.5 is scale 2, position 2.9 is scale 2.4.
    expect(found.map((tick) => tick.x + tick.w / 2)).toEqual([valToPos(2, 'x'), valToPos(2.4, 'x')])
    for (const tick of found) expect(tick.y).toBeGreaterThanOrEqual(BASELINE_Y)
  })

  it('draws no median tick for a group with no median', () => {
    renderHistogram({ series: [RECENT, { ...EARLIER, values: [0, 0, 0, 0, 0], medianAt: null, n: 0 }] })
    const { rects, strokes } = drawn()
    expect(ticks(rects).map((tick) => tick.fillStyle)).toEqual([INK])
    // An empty group's shares are all zero, and that is no outline at all.
    expect(strokes).toHaveLength(0)
  })

  it('draws the median tick at the same CSS size on a HiDPI display', () => {
    renderHistogram()
    const one = atRatio(1, () => ticks(drawn().rects)[0])
    const two = atRatio(2, () => ticks(drawn().rects)[0])
    expect(two?.w).toBe((one?.w ?? 0) * 2)
    expect(two?.h).toBe((one?.h ?? 0) * 2)
  })
})

describe('Histogram axes', () => {
  it('labels the x axis with the buckets\' own labels', () => {
    renderHistogram()
    const values = lastInstance().opts.axes?.[0]?.values
    if (typeof values !== 'function') throw new Error('no x axis formatter')
    expect(values({} as uPlot, [0, 2, 4], 0, 0, 0)).toEqual(['4 to 5', '6 to 7', '≥ 8'])
  })

  it('thins the x labels from the plot width uPlot reports', () => {
    renderHistogram()
    const splits = lastInstance().opts.axes?.[0]?.splits
    if (typeof splits !== 'function') throw new Error('no x axis splits')
    const wide = splits({ bbox: { width: 1000 } } as uPlot, 0, 0, 0, 0, 0)
    const narrow = splits({ bbox: { width: 120 } } as uPlot, 0, 0, 0, 0, 0)
    expect(wide).toEqual([0, 1, 2, 3, 4])
    expect(narrow.length).toBeLessThan(BUCKETS.length)
  })

  it('formats the y axis with formatValue', () => {
    renderHistogram()
    const values = lastInstance().opts.axes?.[1]?.values
    if (typeof values !== 'function') throw new Error('no y axis formatter')
    expect(values({} as uPlot, [0, 5, 10], 1, 0, 0)).toEqual(['0 runs', '5 runs', '10 runs'])
  })

  it('ranges y to a round top over the tallest bar of either series', () => {
    renderHistogram({ series: [RECENT, EARLIER] })
    const range = lastInstance().opts.scales?.y?.range
    if (typeof range !== 'function') throw new Error('no y range')
    // The tallest is 40, whose round top is 40 with a rule at 20.
    expect(range({} as never, 0, 40, 'y')).toEqual([0, 40])
  })

  it('puts the y rules on whole numbers when told the values are counts', () => {
    const series: [HistogramSeries] = [{ ...ALL_RUNS, values: [1, 5, 2, 0, 0] }]
    renderHistogram({ series, wholeNumbers: true })
    const splits = lastInstance().opts.axes?.[1]?.splits
    if (typeof splits !== 'function') throw new Error('no y axis splits')
    expect(splits({} as uPlot, 1, 0, 6, 0, 0)).toEqual([0, 3, 6])

    renderHistogram({ series })
    const fractional = lastInstance().opts.axes?.[1]?.splits
    if (typeof fractional !== 'function') throw new Error('no y axis splits')
    expect(fractional({} as uPlot, 1, 0, 5, 0, 0)).toEqual([0, 2.5, 5])
  })

  it('takes a shared y maximum, so small multiples compare by height', () => {
    renderHistogram({ yMax: 60 })
    const range = lastInstance().opts.scales?.y?.range
    if (typeof range !== 'function') throw new Error('no y range')
    expect(range({} as never, 0, 8, 'y')).toEqual([0, 60])
  })
})

describe('Histogram selection', () => {
  it('names the chart region with label and makes it focusable', () => {
    renderHistogram()
    const region = screen.getByRole('listbox', { name: LABEL })
    expect(region.tabIndex).toBe(0)
  })

  it('offers every bucket as an option naming its label and each value, marking the selected one', () => {
    renderHistogram({ series: [RECENT, EARLIER], selectedKey: '6000' })
    const options = within(screen.getByRole('listbox', { name: LABEL })).getAllByRole('option')
    expect(options).toHaveLength(BUCKETS.length)
    expect(options[2]).toHaveTextContent('6 to 7')
    expect(options[2]).toHaveTextContent('Last 12 months 40 runs')
    expect(options[2]).toHaveTextContent('Previous 12 months 30 runs')
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual([
      'false',
      'false',
      'true',
      'false',
      'false',
    ])
  })

  it("calls onSelect with the clicked bucket's key", () => {
    const { onSelect } = renderHistogram()
    moveCursorTo(3)
    fireEvent.click(screen.getByRole('listbox', { name: LABEL }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('7000')
  })

  it('selects nothing for a click with the pointer off the plot', () => {
    const { onSelect } = renderHistogram()
    moveCursorTo(3)
    moveCursorTo(null)
    fireEvent.click(screen.getByRole('listbox', { name: LABEL }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('moves a keyboard cursor with the arrow keys and selects with Enter', () => {
    const { onSelect } = renderHistogram()
    const region = screen.getByRole('listbox', { name: LABEL })
    const options = within(region).getAllByRole('option')

    fireEvent.keyDown(region, { key: 'ArrowRight' })
    expect(region.getAttribute('aria-activedescendant')).toBe(options[0]?.id)
    fireEvent.keyDown(region, { key: 'ArrowRight' })
    fireEvent.keyDown(region, { key: 'ArrowRight' })
    fireEvent.keyDown(region, { key: 'ArrowLeft' })
    expect(region.getAttribute('aria-activedescendant')).toBe(options[1]?.id)
    // Moving is not selecting.
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.keyDown(region, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('5000')
  })

  it('starts the keyboard cursor from the selected bucket', () => {
    const { onSelect } = renderHistogram({ selectedKey: '6000' })
    const region = screen.getByRole('listbox', { name: LABEL })
    fireEvent.keyDown(region, { key: 'ArrowRight' })
    fireEvent.keyDown(region, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('7000')
  })

  it('holds the keyboard cursor at the last bucket', () => {
    const { onSelect } = renderHistogram({ selectedKey: 'above' })
    const region = screen.getByRole('listbox', { name: LABEL })
    fireEvent.keyDown(region, { key: 'ArrowRight' })
    fireEvent.keyDown(region, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('above')
  })

  it('selects nothing on Enter while no option is active', () => {
    const { onSelect } = renderHistogram()
    fireEvent.keyDown(screen.getByRole('listbox', { name: LABEL }), { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('makes the first option active on focus when nothing is selected, without showing the readout', () => {
    renderHistogram()
    const region = screen.getByRole('listbox', { name: LABEL })
    const options = within(region).getAllByRole('option')
    fireEvent.focus(region)
    expect(region.getAttribute('aria-activedescendant')).toBe(options[0]?.id)
    expect(screen.queryByTestId('histogram-readout')).not.toBeInTheDocument()
  })

  it('makes the selected option active on focus', () => {
    const { onSelect } = renderHistogram({ selectedKey: '6000' })
    const region = screen.getByRole('listbox', { name: LABEL })
    const options = within(region).getAllByRole('option')
    fireEvent.focus(region)
    expect(region.getAttribute('aria-activedescendant')).toBe(options[2]?.id)
    fireEvent.keyDown(region, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('6000')
  })

  it('shows the first option on the first arrow key after focus, rather than stepping past it', () => {
    const { onSelect } = renderHistogram()
    const region = screen.getByRole('listbox', { name: LABEL })
    const options = within(region).getAllByRole('option')
    fireEvent.focus(region)
    fireEvent.keyDown(region, { key: 'ArrowRight' })
    expect(region.getAttribute('aria-activedescendant')).toBe(options[0]?.id)
    expect(screen.getByTestId('histogram-readout')).toHaveTextContent('4 to 5')
    fireEvent.keyDown(region, { key: 'ArrowRight' })
    fireEvent.keyDown(region, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('5000')
  })

  it('steps on from the clicked bucket while the pointer rests on it', () => {
    const { onSelect } = renderHistogram()
    const region = screen.getByRole('listbox', { name: LABEL })
    const options = within(region).getAllByRole('option')
    moveCursorTo(2)
    fireEvent.focus(region)
    fireEvent.click(region)
    fireEvent.keyDown(region, { key: 'ArrowRight' })
    expect(region.getAttribute('aria-activedescendant')).toBe(options[3]?.id)
    fireEvent.keyDown(region, { key: 'ArrowRight' })
    expect(region.getAttribute('aria-activedescendant')).toBe(options[4]?.id)
    fireEvent.keyDown(region, { key: 'Enter' })
    expect(onSelect).toHaveBeenLastCalledWith('above')
  })

  it('leaves no readout behind once the pointer leaves a clicked bucket, and steps on from it', () => {
    renderHistogram()
    const region = screen.getByRole('listbox', { name: LABEL })
    const options = within(region).getAllByRole('option')
    moveCursorTo(2)
    fireEvent.focus(region)
    fireEvent.click(region)
    moveCursorTo(null, -10)
    expect(screen.queryByTestId('histogram-readout')).not.toBeInTheDocument()
    fireEvent.keyDown(region, { key: 'ArrowRight' })
    expect(region.getAttribute('aria-activedescendant')).toBe(options[3]?.id)
    expect(screen.getByTestId('histogram-readout')).toHaveTextContent('7 to 8')
  })

  it('keeps stepping while the pointer rests on another bucket', () => {
    renderHistogram()
    const region = screen.getByRole('listbox', { name: LABEL })
    const options = within(region).getAllByRole('option')
    moveCursorTo(3)
    fireEvent.focus(region)
    fireEvent.keyDown(region, { key: 'ArrowRight' })
    expect(region.getAttribute('aria-activedescendant')).toBe(options[0]?.id)
    fireEvent.keyDown(region, { key: 'ArrowRight' })
    expect(region.getAttribute('aria-activedescendant')).toBe(options[1]?.id)
    fireEvent.keyDown(region, { key: 'ArrowRight' })
    expect(region.getAttribute('aria-activedescendant')).toBe(options[2]?.id)
  })

  it('selects the active option with Space as well as Enter', () => {
    const { onSelect } = renderHistogram()
    const region = screen.getByRole('listbox', { name: LABEL })
    fireEvent.focus(region)
    fireEvent.keyDown(region, { key: 'ArrowRight' })
    fireEvent.keyDown(region, { key: 'ArrowRight' })
    const space = fireEvent.keyDown(region, { key: ' ' })
    expect(onSelect).toHaveBeenCalledWith('5000')
    // Handled, so the page does not scroll as well.
    expect(space).toBe(false)
  })

  it('shows the readout for the keyboard cursor, and drops it on blur', () => {
    renderHistogram()
    const region = screen.getByRole('listbox', { name: LABEL })
    fireEvent.keyDown(region, { key: 'ArrowRight' })
    expect(screen.getByTestId('histogram-readout')).toHaveTextContent('4 to 5')
    fireEvent.blur(region)
    expect(screen.queryByTestId('histogram-readout')).not.toBeInTheDocument()
    expect(region.getAttribute('aria-activedescendant')).toBeNull()
  })
})

describe('Histogram hover readout', () => {
  it('shows nothing until the pointer is over a bucket', () => {
    renderHistogram()
    expect(screen.queryByTestId('histogram-readout')).not.toBeInTheDocument()
  })

  it("names the hovered bucket and each series' value", () => {
    renderHistogram({ series: [RECENT, EARLIER] })
    moveCursorTo(2)
    const readout = screen.getByTestId('histogram-readout')
    expect(readout).toHaveTextContent('6 to 7')
    expect(readout).toHaveTextContent('Last 12 months40 runs')
    expect(readout).toHaveTextContent('Previous 12 months30 runs')
  })

  it('clears itself when the pointer leaves, including on the negative offset uPlot reports', () => {
    renderHistogram()
    moveCursorTo(2)
    moveCursorTo(null)
    expect(screen.queryByTestId('histogram-readout')).not.toBeInTheDocument()
    moveCursorTo(2)
    moveCursorTo(2, -1)
    expect(screen.queryByTestId('histogram-readout')).not.toBeInTheDocument()
  })

  it("follows the cursor in the panel's own coordinates, not the plot area's", () => {
    renderHistogram()
    moveCursorTo(2, 317, 12)
    expect(screen.getByTestId('histogram-readout').style.left).toBe('329px')
  })

  it('keys its rows by position, so two groups of one name both show', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      renderHistogram({ series: [RECENT, { ...EARLIER, label: RECENT.label }] })
      moveCursorTo(2)
      const readout = screen.getByTestId('histogram-readout')
      expect(readout).toHaveTextContent('Last 12 months40 runs')
      expect(readout).toHaveTextContent('Last 12 months30 runs')
      expect(errors.mock.calls.some((call) => String(call[0]).includes('same key'))).toBe(false)
    } finally {
      errors.mockRestore()
    }
  })

  it('is hidden from assistive technology, which reads the options instead', () => {
    renderHistogram()
    moveCursorTo(2)
    const readout = screen.getByTestId('histogram-readout')
    expect(readout.getAttribute('aria-hidden')).toBe('true')
    expect(readout.getAttribute('aria-live')).toBeNull()
  })
})

/** A length token from `theme/tokens.css`, in CSS pixels; see `VolumeBars.test.tsx`. */
function tokenPx(name: string): number {
  const tokens = readFileSync(join(fileURLToPath(import.meta.url), '..', '..', 'theme', 'tokens.css'), 'utf8')
  const match = new RegExp(`--${name}:\\s*([0-9.]+)rem;`).exec(tokens)
  if (match === null || match[1] === undefined) throw new Error(`no rem --${name} in tokens.css`)
  return Number(match[1]) * 16
}

describe('Histogram height', () => {
  it('constructs the full chart at --chart-height', () => {
    renderHistogram()
    expect(lastInstance().opts.height).toBe(tokenPx('chart-height'))
  })

  it('constructs the compact small multiple at --chart-strip', () => {
    renderHistogram({ compact: true })
    expect(lastInstance().opts.height).toBe(tokenPx('chart-strip'))
  })
})
