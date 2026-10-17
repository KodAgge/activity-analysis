import { act, render, screen, within } from '@testing-library/react'
import type uPlot from 'uplot'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localCalendarDay, localCalendarTime } from '../format'
import { TrendChart, type TrendSeries } from './TrendChart'

/**
 * Same harness shape as `VolumeBars.test.tsx`: uPlot needs a real layout
 * engine jsdom does not have, so the constructor is spied on rather than
 * let run for real.
 */
const { instances, MockUPlot } = vi.hoisted(() => {
  class MockUPlot {
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
  return { instances, MockUPlot }
})

vi.mock('uplot', () => ({ default: MockUPlot }))
vi.mock('uplot/dist/uPlot.min.css', () => ({}))
// jsdom has no stylesheet to resolve a token against, so the resolved
// colour is the token's own name: enough to assert *which* palette entry a
// series was given, which is what the palette-order rule is about.
vi.mock('./cssVar', () => ({ cssVar: (name: string) => name }))

beforeEach(() => {
  instances.length = 0
})

function lastInstance(): InstanceType<typeof MockUPlot> {
  const instance = instances.at(-1)
  if (instance === undefined) throw new Error('uPlot was never constructed')
  return instance
}

function day(date: string): number {
  return localCalendarDay(`${date}T12:00:00Z`, 7200)
}

const DAYS = [day('2025-09-01'), day('2025-09-08'), day('2025-09-15'), day('2025-09-22')]

/**
 * Three reference-pace series over four runs; the third run produced no fit.
 * The labels are synthetic reference paces (2.5, 2.6667 and 3.125 m/s, as
 * `athlete_fit` would store them), though this component only ever
 * renders the labels it is handed - `views/Trends.tsx` is what computes them
 * from the payload, and its own test is what pins that.
 */
function threePaces(): TrendSeries[] {
  const at = (values: (number | null)[], note?: string) =>
    DAYS.map((t, i) => ({ t, v: values[i] ?? null, ...(note === undefined ? {} : { note }) }))
  return [
    { label: '6:40/km', points: at([148, 147, null, 146], 'easy') },
    { label: '6:15/km', points: at([151, 150, null, 149]) },
    { label: '5:20/km', points: at([154, 153, null, 152]) },
  ]
}

function renderChart(series: TrendSeries[] = threePaces()) {
  return render(
    <TrendChart
      series={series}
      yLabel="bpm"
      formatValue={(v) => `${String(Math.round(v))} bpm`}
      emptyReason="No efficiency fit has been computed yet."
      ariaLabel="Heart rate at the reference paces"
    />,
  )
}

function seriesOptions(): uPlot.Series[] {
  return lastInstance().opts.series.slice(1)
}

describe('TrendChart', () => {
  it('draws the three paces in palette entries 1, 2 and 3, in that order', () => {
    renderChart()
    expect(seriesOptions().map((s) => s.stroke)).toEqual(['--series-1', '--series-2', '--series-3'])
  })

  it('draws every series at the same width, so only colour separates them', () => {
    // Weight was the old separator and it did not work: a 1 px line against
    // a 2.4 px one reads as two chart elements of different importance
    // rather than as two positions on one ordinal scale. The ramp in
    // `theme/tokens.css` carries the ordering now, so the widths must not
    // also try to.
    renderChart()
    const widths = seriesOptions().map((s) => s.width)
    expect(new Set(widths).size).toBe(1)
  })

  it('takes a named colour variable when one is given, rather than a palette slot', () => {
    renderChart([
      { label: 'slow', colorVar: '--pace-1', points: DAYS.map((t) => ({ t, v: 150 })) },
      { label: 'fast', colorVar: '--pace-3', points: DAYS.map((t) => ({ t, v: 160 })) },
    ])
    expect(seriesOptions().map((s) => s.stroke)).toEqual(['--pace-1', '--pace-3'])
  })

  it('names every series in an HTML legend outside the chart box', () => {
    renderChart()
    const legend = screen.getByRole('list', { name: /legend/ })
    expect(within(legend).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '6:40/km',
      '6:15/km',
      '5:20/km',
    ])
    // Outside the observed box: a sibling of it, not content inside it.
    const chart = screen.getByRole('img', { name: 'Heart rate at the reference paces' })
    expect(chart.contains(legend)).toBe(false)
  })

  it('hands uPlot a null where a run produced no value, and does not ask it to span the gap', () => {
    renderChart()
    const [, ...ys] = lastInstance().data
    for (const y of ys) expect(y[2]).toBeNull()
    // uPlot breaks the line at a null unless told to span it; this chart
    // must never tell it to.
    for (const s of seriesOptions()) expect(s.spanGaps).not.toBe(true)
  })

  it('does not anchor the y axis at zero', () => {
    renderChart()
    const range = lastInstance().opts.scales?.y?.range
    if (typeof range !== 'function') throw new Error('the y scale has no range function')
    const [min, max] = range({} as uPlot, 146, 154, 'y')
    expect(min).toBeGreaterThan(100)
    expect(min).toBeLessThan(146)
    expect(max).toBeGreaterThan(154)
  })

  it('writes the unit on every rung of the ladder rather than as an axis title', () => {
    // Nothing in the six reference screenshots draws an axis title, and the
    // rotated `bpm` this replaced was the last piece of chrome between the
    // plot and the page gutter. The unit rides on the rungs instead, which
    // is what the reference's own `40 km / 20 km / 0 km` does - so the
    // title being absent is the assertion, not an omission from one.
    renderChart()
    const axes = lastInstance().opts.axes ?? []
    expect(axes[0]?.label).toBeUndefined()
    expect(axes[1]?.label).toBeUndefined()

    const yValues = axes[1]?.values
    if (typeof yValues !== 'function') throw new Error('the y axis has no values formatter')
    expect(yValues({} as uPlot, [150, 160], 1, 0, 0)).toEqual(['150 bpm', '160 bpm'])

    const values = axes[0]?.values
    if (typeof values !== 'function') throw new Error('the x axis has no values formatter')
    expect(values({} as uPlot, [day('2025-09-01'), day('2025-10-01')], 0, 0, 0)).toEqual(['Sep 2025', 'Oct 2025'])
  })

  it('registers its axes the way the Overview registers its bars, so the two screens are one chart language', () => {
    // The plot's left edge is the chart element's left edge is the page
    // gutter, the ladder takes its room on the right with its labels' own
    // right edge on the page's right gutter, and the only rules drawn are
    // the horizontal ones. Pinned because it is exactly the kind of
    // registration a later edit undoes without noticing.
    renderChart()
    const opts = lastInstance().opts
    const [x, y] = opts.axes ?? []
    expect(opts.padding?.[1]).toBe(0)
    expect(opts.padding?.[3]).toBe(0)
    expect(x?.grid?.show).toBe(false)
    expect(x?.ticks?.show).toBe(false)
    expect(x?.border?.show).toBe(false)
    expect(y?.side).toBe(1)
    expect(y?.align).toBe(2)
    expect(y?.alignTo).toBe(2)
    expect(y?.gap).toBe(0)
    expect(y?.ticks?.show).toBe(false)
    expect(y?.border?.show).toBe(false)
    // The chart ladder's own token, not the page's `--grid`: a rule inside
    // a plot is 1.83:1 against the page where a page rule is 1.13, which is
    // the reference's own pair of figures. See `theme/tokens.css`.
    expect(y?.grid?.stroke).toBe('--chart-rule')
  })

  it('labels a band that contains every mark, because the bounds are the ticks', () => {
    // The fault this closes, measured: `paddedRange` returned a range and
    // left the ticks to uPlot, which places nice increments *inside* a
    // range, so 159 device px of data sat below the lowest labelled rule with no
    // rule and no label under it. `trendChartMath.test.ts` owns the
    // arithmetic; this is the statement that the chart wires both halves to
    // the same solved ladder.
    renderChart([{ label: 'hr', points: DAYS.map((t, i) => ({ t, v: [118.5, 150, 170, 196.5][i] ?? null })) }])
    const opts = lastInstance().opts
    const splits = opts.axes?.[1]?.splits
    if (typeof splits !== 'function') throw new Error('the y axis has no splits')
    expect(splits({} as uPlot, 1, 0, 0, 0, 0)).toEqual([100, 120, 140, 160, 180, 200])

    const range = opts.scales?.y?.range
    if (typeof range !== 'function') throw new Error('the y scale has no range function')
    const [min, max] = range({} as uPlot, 117.4, 197.2, 'y')
    expect(min).toBeLessThanOrEqual(100)
    expect(max).toBeGreaterThanOrEqual(200)
  })

  it('draws a scatter series as points only, faintly, in the palette slot it was tied to', () => {
    renderChart([
      { label: 'Heart rate, smoothed', points: DAYS.map((t) => ({ t, v: 50 })) },
      { label: 'Heart rate, per run', scatter: true, paletteSlot: 1, points: DAYS.map((t) => ({ t, v: 52 })) },
    ])
    const [line, dots] = seriesOptions()
    expect(dots?.stroke).toBe(line?.stroke)
    expect(dots?.points?.show).toBe(true)
    expect(dots?.alpha).toBeLessThan(1)
    const paths = dots?.paths
    if (typeof paths !== 'function') throw new Error('the scatter series has no paths override')
    expect(paths({} as uPlot, 2, 0, 0)).toBeNull()
  })

  it('draws an envelope between its edges and strokes nothing but the subject', () => {
    // Three near-identical series cannot be separated as three curves - the
    // swing along them is more than eight times the between-series span - so
    // the outer two bound a band around the middle one and are not stroked
    // at all. Stroking them faintly as well was tried and was the worst of
    // both: faint enough not to compete reads as an artefact, strong enough
    // to read rebuilds the braid. With no edge strokes the plot holds
    // exactly one line, and it is the one the headline above names.
    renderChart([
      { label: 'slow', colorVar: '--pace-1', edge: true, points: DAYS.map((t) => ({ t, v: 150 })) },
      { label: 'median', colorVar: '--pace-2', points: DAYS.map((t) => ({ t, v: 155 })) },
      { label: 'fast', colorVar: '--pace-3', edge: true, points: DAYS.map((t) => ({ t, v: 160 })) },
    ])
    const opts = lastInstance().opts

    // **`width: 0`, not `paths: () => null`.** The edges must still build
    // their paths - the fill is drawn between them - but must not stroke.
    const [slow, median, fast] = seriesOptions()
    for (const edge of [slow, fast]) {
      expect(edge?.width).toBe(0)
      expect(edge?.points?.show).toBe(false)
      expect(edge?.paths).toBeUndefined()
    }
    expect(median?.width).toBeGreaterThan(0)

    // The fill is drawn in `drawAxes`, which fires after uPlot's grid and
    // before its series: over the furniture because it is data, under the
    // subject because it is that subject's context. uPlot's own `bands`
    // would fill while drawing the *upper* edge, which is after the middle
    // series, and paint over the one line the chart is about.
    expect(opts.bands ?? []).toHaveLength(0)
    const hook = opts.hooks?.drawAxes?.[0]
    if (typeof hook !== 'function') throw new Error('no drawAxes hook for the envelope')

    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      fillStyle: '',
      globalAlpha: 0.18,
    }
    hook({
      ctx,
      data: [DAYS, DAYS.map(() => 150), DAYS.map(() => 155), DAYS.map(() => 160)],
      bbox: { left: 0, top: 0, width: 100, height: 100 },
      valToPos: (v: number) => v,
    } as unknown as uPlot)
    expect(ctx.fill).toHaveBeenCalled()
    expect(ctx.fillStyle).toBe('--pace-band')
    // Opaque: the band is a data mark, not a wash over one.
    expect(ctx.globalAlpha).toBe(1)
  })

  it('keys the band as a band and the subject as a line, so the legend names the mark to look for', () => {
    renderChart([
      { label: 'slow', colorVar: '--pace-1', edge: true, points: DAYS.map((t) => ({ t, v: 150 })) },
      { label: 'median', colorVar: '--pace-2', points: DAYS.map((t) => ({ t, v: 155 })) },
      { label: 'fast', colorVar: '--pace-3', edge: true, points: DAYS.map((t) => ({ t, v: 160 })) },
    ])
    const legend = screen.getByRole('list', { name: /legend/ })
    const swatches = within(legend)
      .getAllByRole('listitem')
      .map((li) => li.querySelector('span')?.className ?? '')
    // Exactly one line swatch, and it belongs to the series in the middle.
    expect(swatches.filter((c) => c.includes('swatch') && !c.includes('Band')).length).toBe(1)
    expect(swatches.filter((c) => c.includes('swatchBand')).length).toBe(2)
  })

  it('draws no band when nothing is marked as an edge', () => {
    renderChart()
    expect(lastInstance().opts.bands ?? []).toHaveLength(0)
  })

  it('takes the strip\'s room on top of the height it was asked for, rather than out of it', () => {
    // A split chart carries a second band for its raw inputs. Carving that
    // out of the requested height would shrink the thing the chart is named
    // after, so it is added - and the box around the canvas has to move with
    // it, for the unbounded-growth reason `UPlot.tsx` documents.
    renderChart()
    const unsplit = lastInstance().opts.height
    const unsplitBox = screen.getByRole('img', { name: 'Heart rate at the reference paces' }).className

    render(
      <TrendChart
        series={[
          // The subject spans 10 and the raw points 80, so the scatter
          // widens the axis eightfold - well past the threshold at which a
          // split buys more than the shared scale it costs.
          { label: 'smoothed', points: DAYS.map((t, i) => ({ t, v: 155 + i * 3 })) },
          { label: 'per run', scatter: true, faint: true, points: DAYS.map((t, i) => ({ t, v: 120 + i * 27 })) },
        ]}
        yLabel="bpm"
        formatValue={(v) => `${String(v)} bpm`}
        emptyReason="none"
        ariaLabel="Split"
      />,
    )
    expect(lastInstance().opts.height).toBeGreaterThan(unsplit ?? 0)
    expect(screen.getByRole('img', { name: 'Split' }).className).not.toBe(unsplitBox)
  })

  it('draws a tall chart taller than a standard one, in the canvas and in the box around it', () => {
    // The box's height is imposed from outside and must keep matching
    // `options.height`, for the reason UPlot.tsx documents at length: a
    // content-sized container grows without bound, one legend-height per
    // resize observation. So the two have to move together.
    renderChart()
    const standard = lastInstance().opts.height
    const standardBox = screen.getByRole('img', { name: 'Heart rate at the reference paces' }).className

    render(
      <TrendChart
        series={threePaces()}
        yLabel="VO2max"
        formatValue={(v) => String(v)}
        emptyReason="none"
        ariaLabel="VO2max"
        height="tall"
      />,
    )
    expect(lastInstance().opts.height).toBeGreaterThan(standard)
    expect(screen.getByRole('img', { name: 'VO2max' }).className).not.toBe(standardBox)
  })

  it('draws a reference line when one is given, and names it', () => {
    // An unexplained horizontal rule on a chart reads as a second series
    // drawn flat. The line is dashed, stroked in the dim ink rather than a
    // palette entry, and carries its own legend entry saying what it is.
    render(
      <TrendChart
        series={threePaces()}
        yLabel="%"
        formatValue={(v) => `${String(v)}%`}
        emptyReason="none"
        ariaLabel="Aerobic decoupling"
        referenceLine={{ value: 5, label: '5% durability' }}
      />,
    )

    const hook = lastInstance().opts.hooks?.draw?.[0]
    if (typeof hook !== 'function') throw new Error('no draw hook for the reference line')

    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      // uPlot leaves its own grid width on the context before a hook runs,
      // and `save` preserves state rather than resetting it - so an unset
      // `lineWidth` here would inherit 2 and pass silently.
      lineWidth: 2 * 47,
      strokeStyle: '',
    }
    hook({
      ctx,
      bbox: { left: 50, top: 8, width: 500, height: 200 },
      valToPos: (v: number, scale: string) => (scale === 'y' ? 100 - v : v),
    } as unknown as uPlot)

    expect(ctx.stroke).toHaveBeenCalled()
    // Across the plot at the reference value's own y position.
    expect(ctx.moveTo).toHaveBeenCalledWith(50, 95)
    expect(ctx.lineTo).toHaveBeenCalledWith(550, 95)
    // Dashed, and at a width this chart chose rather than uPlot's leftover.
    expect(ctx.setLineDash).toHaveBeenCalledWith(expect.not.objectContaining({ length: 0 }))
    expect(ctx.lineWidth).not.toBe(2 * 47)

    expect(screen.getByText(/5% durability/)).toBeInTheDocument()
  })

  it('does not stroke the reference line when its value falls outside the plot box', () => {
    // uPlot fires `draw` with an unclipped context, and the y scale is
    // fitted to the data rather than to this value. The decoupling
    // population's median sits above the 5% rule
    // (`docs/reference/math/efficiency.md`), so a stretch of history that
    // stays above the line - or any x-zoom into one - resolves the rule to a
    // position under the axis labels, where it would be painted across them
    // while the legend still named it.
    render(
      <TrendChart
        series={threePaces()}
        yLabel="%"
        formatValue={(v) => `${String(v)}%`}
        emptyReason="none"
        ariaLabel="Aerobic decoupling"
        referenceLine={{ value: 5, label: '5% durability' }}
      />,
    )

    const hook = lastInstance().opts.hooks?.draw?.[0]
    if (typeof hook !== 'function') throw new Error('no draw hook for the reference line')

    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      lineWidth: 0,
      strokeStyle: '',
    }
    // A y scale of roughly 5.5% to 9.5%, a stretch of decoupling history
    // that stays above the line: 5 is below the bottom of the box, at
    // y = 220 against a box ending at 208.
    const outside = {
      ctx,
      bbox: { left: 50, top: 8, width: 500, height: 200 },
      valToPos: (v: number, scale: string) => (scale === 'y' ? 320 - 20 * v : v),
    } as unknown as uPlot
    hook(outside)

    expect(ctx.stroke).not.toHaveBeenCalled()
    expect(ctx.moveTo).not.toHaveBeenCalled()
    // And the legend still says what the rule marks, so the reader is not
    // told a line is there with nothing to find.
    expect(screen.getByText(/5% durability/)).toBeInTheDocument()
  })

  it('draws no reference line when none is given', () => {
    renderChart()
    expect(lastInstance().opts.hooks?.draw ?? []).toHaveLength(0)
  })

  it('states the absence in words when no series has a value to draw', () => {
    renderChart([{ label: 'a', points: DAYS.map((t) => ({ t, v: null })) }])
    expect(screen.getByRole('note')).toHaveTextContent('No efficiency fit has been computed yet.')
    expect(instances).toHaveLength(0)
  })
})

describe('TrendChart hover readout', () => {
  const PLOT_LEFT_PX = 50

  function moveCursorTo(idx: number | null, left: number): void {
    const hook = lastInstance().opts.hooks?.setCursor?.[0]
    if (hook === undefined || typeof hook !== 'function') {
      throw new Error('no setCursor hook was wired for the hover readout')
    }
    act(() => {
      hook({ cursor: { idx, left }, over: { offsetLeft: PLOT_LEFT_PX }, width: 600 } as unknown as uPlot)
    })
  }

  it('shows nothing until the pointer is over a point', () => {
    renderChart()
    expect(screen.queryByTestId('trend-readout')).toBeNull()
  })

  it('reads out the day, the effort tag and every series value, with the glyph for a missing one', () => {
    renderChart()
    moveCursorTo(1, 200)
    const readout = screen.getByTestId('trend-readout')
    expect(readout).toHaveTextContent('8 September 2025')
    expect(readout).toHaveTextContent('easy')
    expect(readout).toHaveTextContent('147 bpm')
    expect(readout).toHaveTextContent('150 bpm')
    expect(readout).toHaveTextContent('153 bpm')

    moveCursorTo(2, 300)
    expect(screen.getByTestId('trend-readout')).toHaveTextContent('–')
  })

  it('does not rebuild the chart as the pointer moves', () => {
    // The hover state re-renders the component; `options` identity is
    // uPlot's recreation key, so a default formatter created per render
    // rebuilt the chart on every mousemove, resetting its cursor each time.
    renderChart()
    expect(instances).toHaveLength(1)
    moveCursorTo(1, 200)
    moveCursorTo(2, 300)
    expect(instances).toHaveLength(1)
    expect(screen.getByTestId('trend-readout')).toBeInTheDocument()
  })

  it('names the whole day for a run at a time of day, and keeps two runs on one day apart', () => {
    const morning = localCalendarTime('2025-09-08T06:00:00Z', 7200)
    const evening = localCalendarTime('2025-09-08T16:00:00Z', 7200)
    renderChart([
      {
        label: 'a',
        points: [
          { t: morning, v: 150, note: 'Easy' },
          { t: evening, v: 158, note: 'All out' },
        ],
      },
    ])
    expect(lastInstance().data[0]).toEqual([morning, evening])
    moveCursorTo(1, 300)
    const readout = screen.getByTestId('trend-readout')
    expect(readout).toHaveTextContent('8 September 2025')
    expect(readout).toHaveTextContent('All out')
    expect(readout).toHaveTextContent('158 bpm')
    expect(readout).not.toHaveTextContent('150 bpm')
  })

  it('clears when the pointer leaves the plot', () => {
    renderChart()
    moveCursorTo(1, 200)
    moveCursorTo(null, -1)
    expect(screen.queryByTestId('trend-readout')).toBeNull()
  })

  it('renders inside the fixed-height chart box and leaves its height unchanged, so it cannot restart the resize loop', () => {
    // jsdom applies no CSS module styles and has no layout, so the height
    // measured here is the same before and after by construction; the
    // browser suite measures the real thing (`web/tests/smoke.spec.ts`).
    // What this asserts is the structural half: the readout is *inside*
    // `.chart`, the box whose height is imposed from outside, and not a
    // sibling further up the tree whose height content can move.
    renderChart()
    const chart = screen.getByRole('img', { name: 'Heart rate at the reference paces' })
    const before = chart.getBoundingClientRect().height
    moveCursorTo(1, 200)
    const readout = screen.getByTestId('trend-readout')
    expect(chart.contains(readout)).toBe(true)
    expect(readout.getAttribute('aria-hidden')).toBe('true')
    expect(chart.getBoundingClientRect().height).toBe(before)
  })
})

describe('TrendChart hover on series with their own instants', () => {
  function moveCursorTo(idx: number, left: number): void {
    const hook = lastInstance().opts.hooks?.setCursor?.[0]
    if (hook === undefined || typeof hook !== 'function') throw new Error('no setCursor hook')
    act(() => {
      hook({ cursor: { idx, left }, over: { offsetLeft: 50 }, width: 600 } as unknown as uPlot)
    })
  }

  const perRunAndHeld: TrendSeries[] = [
    { label: 'per run', points: [{ t: 20000, v: 150 }, { t: 20002, v: 152 }] },
    { label: 'held', holdsLastForReadout: true, points: [{ t: 20001, v: 148 }] },
  ]

  it("pins each series' cursor dot to the hovered instant rather than moving it to the series' nearest point", () => {
    // uPlot's default moves a dot off an undefined value to the nearest
    // defined one, with no distance limit, which drew a hidden run's scatter
    // dot on its neighbour's value.
    renderChart(perRunAndHeld)
    const dataIdx = lastInstance().opts.cursor?.dataIdx
    if (dataIdx === undefined) throw new Error('no cursor.dataIdx override')
    expect(dataIdx(lastInstance() as unknown as uPlot, 1, 2, 20002)).toBe(2)
  })

  it('reads a held series at its last value at or before the hovered instant', () => {
    renderChart(perRunAndHeld)
    moveCursorTo(2, 300)
    expect(screen.getByTestId('trend-readout')).toHaveTextContent('148 bpm')
  })

  it('reads a held series as missing before its first value, and a per-run series as missing between its runs', () => {
    renderChart(perRunAndHeld)
    moveCursorTo(0, 100)
    const before = screen.getByTestId('trend-readout')
    expect(before).toHaveTextContent('150 bpm')
    expect(before).toHaveTextContent('–')
    moveCursorTo(1, 200)
    const between = screen.getByTestId('trend-readout')
    expect(between).toHaveTextContent('148 bpm')
    expect(between).not.toHaveTextContent('150 bpm')
  })
})
