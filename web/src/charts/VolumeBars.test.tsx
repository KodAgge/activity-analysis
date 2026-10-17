/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, render, screen } from '@testing-library/react'
import type uPlot from 'uplot'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VolumeBars, type VolumePeriod } from './VolumeBars'
import {
  barGeometry,
  barScaleRange,
  emptyMarkGeometry,
  bucketHeading,
  clampReadoutLeft,
  periodTickIndices,
  volumeScale,
} from './volumeBarsMath'

/**
 * Same harness shape as `StreamPanel.test.tsx`: uPlot needs a real layout
 * engine jsdom does not have, so the constructor is spied on rather than
 * let run for real.
 */
const { instances, MockUPlot } = vi.hoisted(() => {
  class MockUPlot {
    static paths = { bars: () => undefined }
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

beforeEach(() => {
  instances.length = 0
})

function lastInstance(): InstanceType<typeof MockUPlot> {
  const instance = instances.at(-1)
  if (instance === undefined) throw new Error('uPlot was never constructed')
  return instance
}

/** The plotting area a fake uPlot reports, in canvas pixels. */
const BBOX = { left: 60, top: 10, width: 600, height: 200 }

/** Every filled rectangle the `draw` hook emits, as `{x, y, w, h}`. */
interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Every rounded-bar path the `draw` hook emits, as its extents. */
interface Bar {
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * Every empty-period mark the `draw` hook emits, as the ring a reader sees
 * rather than as the path the canvas strokes: a stroke is centred on its
 * path, so the outer diameter is `2 * radius + lineWidth`.
 */
interface Mark {
  cx: number
  /** The mark's lowest point, which is where it meets the baseline. */
  bottom: number
  diameter: number
  lineWidth: number
}

/** Every line the `draw` hook strokes, as its points and its paint. */
interface Line {
  points: [number, number][]
  strokeStyle: string
  lineWidth: number
}

/**
 * Runs the component's `draw` hook against a fake uPlot and reports what
 * it drew.
 *
 * Bars are paths rather than rectangles now, so they are captured from the
 * `moveTo`/`lineTo` calls `fillBarPath` makes: the first `moveTo` is the
 * bar's bottom-left corner and the last `lineTo` its bottom-right, and the
 * top edge is the smaller of the two y values seen. That is enough to
 * assert width, height and position without asserting the shape of the
 * corner, which is a drawing detail rather than a geometric claim.
 *
 * `valToPos` is the identity on x and a simple linear map on y, so every
 * expectation below is arithmetic on numbers the test itself chose.
 */
function drawnGeometry(props: {
  markEmpty: boolean
  periods?: VolumePeriod[]
  trend?: { window: number; lastIndex: number }
}): {
  rects: Rect[]
  bars: Bar[]
  marks: Mark[]
  lines: Line[]
  order: ('bar' | 'line')[]
} {
  instances.length = 0
  render(
    <VolumeBars
      periods={props.periods ?? PERIODS_WITH_A_GAP}
      metric="distance"
      bucket="week"
      markEmpty={props.markEmpty}
      trend={props.trend}
    />,
  )
  const hook = lastInstance().opts.hooks?.draw?.[0]
  if (hook === undefined || typeof hook !== 'function') {
    throw new Error('no draw hook was wired')
  }

  const rects: Rect[] = []
  const bars: Bar[] = []
  const marks: Mark[] = []
  const lines: Line[] = []
  const order: ('bar' | 'line')[] = []
  let xs: number[] = []
  let ys: number[] = []
  let arc: { cx: number; cy: number; radius: number } | null = null
  const ctx = {
    save: () => {},
    restore: () => {},
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    lineCap: '',
    arc: (cx: number, cy: number, radius: number) => {
      arc = { cx, cy, radius }
    },
    stroke: () => {
      if (arc === null) {
        // A stroke with no arc is a line: the trend.
        lines.push({
          points: xs.map((x, i) => [x, ys[i] ?? NaN]),
          strokeStyle: ctx.strokeStyle,
          lineWidth: ctx.lineWidth,
        })
        order.push('line')
        return
      }
      const { cx, cy, radius } = arc
      marks.push({
        cx,
        bottom: cy + radius + ctx.lineWidth / 2,
        diameter: 2 * radius + ctx.lineWidth,
        lineWidth: ctx.lineWidth,
      })
      arc = null
    },
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
    fill: () => {
      order.push('bar')
      bars.push({
        left: Math.min(...xs),
        right: Math.max(...xs),
        top: Math.min(...ys),
        bottom: Math.max(...ys),
      })
    },
    fillRect: (x: number, y: number, w: number, h: number) => rects.push({ x, y, w, h }),
  }

  hook({
    ctx,
    bbox: BBOX,
    // y: 1000 metres to 1 pixel below a baseline at 500; x: the index
    // scaled by 100 and offset, so slot centres are far apart and easy to
    // read back.
    valToPos: (value: number, scale: string) =>
      scale === 'y' ? 500 - value / 1000 : BBOX.left + 100 + value * 100,
  } as unknown as uPlot)

  return { rects, bars, marks, lines, order }
}

function drawnRects(props: { markEmpty: boolean }): Rect[] {
  return drawnGeometry(props).rects
}

// A dense weekly-shaped series: two real weeks either side of one week off,
// the exact pattern `/api/overview` now sends and the frontend must not
// filter (see docs/reference/api.md, "GET /api/overview" and this
// component's own doc comment on `periods`).
const PERIODS_WITH_A_GAP: VolumePeriod[] = [
  { period_start: '2026-08-04', runs: 3, distance_m: 15000, moving_time_s: 4500 },
  { period_start: '2026-08-11', runs: 0, distance_m: 0, moving_time_s: 0 },
  { period_start: '2026-08-18', runs: 4, distance_m: 20000, moving_time_s: 6000 },
]

/** The x axis's own formatter, run over the split indices given. */
function xAxisLabels(splits: number[]): string[] {
  const values = lastInstance().opts.axes?.[0]?.values
  if (typeof values !== 'function') throw new Error('no x axis formatter')
  return values({} as uPlot, splits, 0, 0, 0) as string[]
}

describe('VolumeBars', () => {
  it('keeps every period in the series handed to uPlot, the zero-run week included', () => {
    render(<VolumeBars periods={PERIODS_WITH_A_GAP} metric="distance" bucket="week" />)

    const instance = lastInstance()
    const [x, y] = instance.data
    expect(x).toHaveLength(3)
    // Not filtered out and not merged away: the middle bar is a real 0,
    // sitting between two real distances, not simply absent from the array.
    expect(y).toEqual([15000, 0, 20000])
  })

  it('marks a zero-run period on the baseline only when markEmpty is set', () => {
    expect(drawnGeometry({ markEmpty: true }).marks).toHaveLength(1)
    expect(drawnGeometry({ markEmpty: false }).marks).toHaveLength(0)
    // The zero rule is the only rectangle either way: the mark is a ring,
    // and a rectangle sitting on the axis of a bar chart is a bar.
    expect(drawnRects({ markEmpty: true })).toHaveLength(1)
    expect(drawnRects({ markEmpty: false })).toHaveLength(1)
  })

  it('draws the zero rule across the plot, over the bars rather than under them', () => {
    // The round-1 fault: uPlot's own y grid draws the zero rule before the
    // series, so twelve bars and their near-zero stubs sat on top of it -
    // measured at 472px of visible rule across x 100..1037 where the two
    // rules above it each showed 973px across x 72..1082. The axis claimed
    // three levels and drew two.
    const rects = drawnRects({ markEmpty: false })
    const rule = rects[0]
    if (rule === undefined) throw new Error('no zero rule was drawn')

    // Spans the plot's own x extent exactly: `bbox.left` to `bbox.left +
    // bbox.width`, which is what the y grid's own rules span.
    expect(rule.x).toBe(BBOX.left)
    expect(rule.w).toBe(BBOX.width)
  })

  it('draws the trend through each period that has one, over the bars', () => {
    // A 2-period window over 15 km, 0 km, 20 km: 7.5 km at the second
    // period and 10 km at the third, and nothing at the first, where the
    // window is not yet full.
    const { lines, order } = drawnGeometry({ markEmpty: false, trend: { window: 2, lastIndex: 2 } })
    const trend = lines.at(-1)
    if (trend === undefined) throw new Error('no trend was drawn')
    expect(trend.points).toEqual([
      [260, 492.5],
      [360, 490],
    ])
    expect(order.lastIndexOf('bar')).toBeLessThan(order.indexOf('line'))
  })

  it('stops the trend at the last known period', () => {
    const { lines } = drawnGeometry({ markEmpty: false, trend: { window: 2, lastIndex: 1 } })
    expect(lines.at(-1)?.points).toEqual([[260, 492.5]])
  })

  it('draws no line without a trend', () => {
    expect(drawnGeometry({ markEmpty: false }).lines).toHaveLength(0)
  })

  it('labels the x axis by day and month by default, which is what the twelve-week chart wants', () => {
    render(<VolumeBars periods={PERIODS_WITH_A_GAP} metric="distance" bucket="week" />)
    expect(xAxisLabels([0, 2])).toEqual(['4 Aug', '18 Aug'])
  })

  it('labels the full-history axis by month and year, not by day', () => {
    // 148 weeks of bare day-and-month labels repeat the same twelve month
    // names over three years without ever saying which year one of them is.
    render(<VolumeBars periods={PERIODS_WITH_A_GAP} metric="distance" bucket="week" axisLabel="monthYear" />)
    expect(xAxisLabels([0, 2])).toEqual(['Aug 2026', 'Aug 2026'])
  })

  it('labels the series with a real name, not the raw metric token', () => {
    render(<VolumeBars periods={PERIODS_WITH_A_GAP} metric="moving_time" bucket="week" />)
    const instance = lastInstance()
    const series = instance.opts.series[1]
    expect(series?.label).toBe('Moving time')
    expect(series?.label).not.toBe('moving_time')
  })
})

describe('VolumeBars hover readout', () => {
  /**
   * The y-axis gutter uPlot insets its plotting area by, which is what
   * `u.over.offsetLeft` reports and what `cursor.left` is measured from.
   * Non-zero on purpose: at 0 this harness could not tell a readout
   * positioned in plot coordinates from one positioned in the panel's.
   */
  const PLOT_LEFT_PX = 50
  const PANEL_WIDTH_PX = 600

  /**
   * Fires the `setCursor` hook the component wired, as uPlot would - with
   * the same geometry a real instance carries: `cursor.left` relative to
   * the plotting area, `over.offsetLeft` the plot's own origin within the
   * chart, and `width` the panel's full CSS width.
   */
  function moveCursorTo(idx: number | null, left: number, plotLeftPx = PLOT_LEFT_PX): void {
    const hooks = lastInstance().opts.hooks?.setCursor
    const hook = hooks?.[0]
    if (hook === undefined || typeof hook !== 'function') {
      throw new Error('no setCursor hook was wired for the hover readout')
    }
    act(() => {
      hook({
        cursor: { idx, left },
        over: { offsetLeft: plotLeftPx },
        width: PANEL_WIDTH_PX,
      } as unknown as uPlot)
    })
  }

  it('shows nothing until the pointer is over a bar', () => {
    render(<VolumeBars periods={PERIODS_WITH_A_GAP} metric="distance" bucket="week" />)
    expect(screen.queryByText(/km/)).not.toBeInTheDocument()
  })

  it("reports the hovered period's own week, distance, moving time and run count", () => {
    render(<VolumeBars periods={PERIODS_WITH_A_GAP} metric="distance" bucket="week" />)

    moveCursorTo(2, 300)

    // The third period's values, not the first's and not a total: 20000 m
    // over 6000 s across 4 runs, in the week beginning 18 August 2026.
    // Headed with the *period*, not a bare date: "18 August 2026" above
    // four runs and 20 km reads as one calendar day's training.
    expect(screen.getByText('Week of 18 August 2026')).toBeInTheDocument()
    expect(screen.getByText('20.00 km')).toBeInTheDocument()
    expect(screen.getByText('1:40:00')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.getByText(/runs/)).toBeInTheDocument()
  })

  it('says a week with no runs had none, rather than showing nothing at all', () => {
    // The series is dense on purpose - a week off is a fact about the
    // training, not missing data - so the readout has to say so too.
    render(<VolumeBars periods={PERIODS_WITH_A_GAP} metric="distance" bucket="week" />)

    moveCursorTo(1, 150)

    expect(screen.getByText('Week of 11 August 2026')).toBeInTheDocument()
    expect(screen.getByText('No runs')).toBeInTheDocument()
    expect(screen.queryByText('0.00 km')).not.toBeInTheDocument()
  })

  it("reads the hovered period's trend beside its own total", () => {
    render(
      <VolumeBars
        periods={PERIODS_WITH_A_GAP}
        metric="distance"
        bucket="week"
        trend={{ window: 2, lastIndex: 2 }}
      />,
    )

    moveCursorTo(2, 300)

    expect(screen.getByText('2-week average')).toBeInTheDocument()
    expect(screen.getByText('10.00 km')).toBeInTheDocument()
  })

  it('gives the trend a row on a week off too, since the average still has a value there', () => {
    render(
      <VolumeBars
        periods={PERIODS_WITH_A_GAP}
        metric="distance"
        bucket="week"
        trend={{ window: 2, lastIndex: 2 }}
      />,
    )

    moveCursorTo(1, 150)

    expect(screen.getByText('No runs')).toBeInTheDocument()
    expect(screen.getByText('7.50 km')).toBeInTheDocument()
  })

  it('has no trend row where the trend has no value', () => {
    render(
      <VolumeBars
        periods={PERIODS_WITH_A_GAP}
        metric="distance"
        bucket="week"
        trend={{ window: 2, lastIndex: 2 }}
      />,
    )

    moveCursorTo(0, 50)

    expect(screen.getByText('Week of 4 August 2026')).toBeInTheDocument()
    expect(screen.queryByText(/average/)).not.toBeInTheDocument()
  })

  it('pluralises a single run correctly', () => {
    render(
      <VolumeBars
        periods={[{ period_start: '2026-08-04', runs: 1, distance_m: 5000, moving_time_s: 1500 }]}
        metric="distance"
        bucket="week"
      />,
    )

    moveCursorTo(0, 40)

    expect(screen.getByText(/\brun\b/)).toBeInTheDocument()
    expect(screen.queryByText(/\bruns\b/)).not.toBeInTheDocument()
  })

  it('clears itself when the pointer leaves the plot', () => {
    render(<VolumeBars periods={PERIODS_WITH_A_GAP} metric="distance" bucket="week" />)

    moveCursorTo(2, 300)
    expect(screen.getByText('20.00 km')).toBeInTheDocument()

    // uPlot reports a null `idx` once the pointer is outside.
    moveCursorTo(null, 300)
    expect(screen.queryByText('20.00 km')).not.toBeInTheDocument()
  })

  it('clears itself on the negative cursor offset uPlot reports on the way out', () => {
    // Without this the readout stays pinned to the panel edge after the
    // pointer has gone, because `idx` is still the last bar it was over.
    render(<VolumeBars periods={PERIODS_WITH_A_GAP} metric="distance" bucket="week" />)

    moveCursorTo(2, 300)
    expect(screen.getByText('20.00 km')).toBeInTheDocument()

    moveCursorTo(2, -1)
    expect(screen.queryByText('20.00 km')).not.toBeInTheDocument()
  })

  it("follows the cursor in the panel's own coordinates, not the plot area's", () => {
    // The offset uPlot reports is relative to its plotting area, which it
    // insets from the chart's left edge by the y-axis gutter; the readout
    // is positioned against `.chart`. Passed through unshifted, the readout
    // sat a gutter's width - about 50px, most of a bar at twelve bars
    // across - to the left of the bar it was describing.
    render(<VolumeBars periods={PERIODS_WITH_A_GAP} metric="distance" bucket="week" />)

    moveCursorTo(2, 317)

    const readout = screen.getByText('Week of 18 August 2026').parentElement
    if (readout === null) throw new Error('the readout has no wrapper')
    expect(readout.style.left).toBe('367px')
  })

  it('tracks a plot origin of any width, rather than one baked-in offset', () => {
    // uPlot sizes that gutter from the widest y-axis label it has to draw,
    // so it is not a constant and cannot be compensated for with one.
    render(<VolumeBars periods={PERIODS_WITH_A_GAP} metric="distance" bucket="week" />)

    moveCursorTo(2, 100, 12)
    const readout = screen.getByText('Week of 18 August 2026').parentElement
    expect(readout?.style.left).toBe('112px')
  })

  it('is not a live region, so a pointer sweep does not announce every week it crosses', () => {
    // `setCursor` fires on every pointer move. As a `role="status"` with
    // `aria-live="polite"` - which the first version was - a screen reader
    // would announce a new week several times a second for as long as the
    // pointer crossed the chart, and it put a second `role="status"` on the
    // page beside the header's activity count.
    render(<VolumeBars periods={PERIODS_WITH_A_GAP} metric="distance" bucket="week" />)

    moveCursorTo(2, 300)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    const readout = screen.getByText('Week of 18 August 2026').parentElement
    expect(readout?.getAttribute('aria-live')).toBeNull()
    expect(readout?.getAttribute('aria-hidden')).toBe('true')
  })

  it('renders inside the container whose height is externally imposed', () => {
    // Half of why this cannot restart the resize loop UPlot.tsx documents:
    // it is inside `.chart`, whose height is fixed in CSS, rather than a
    // sibling further up the tree whose height content can move.
    //
    // The other half - that it is `position: absolute` and so contributes
    // no layout height at all - is a CSS fact, and jsdom applies no CSS
    // module styles, so `getComputedStyle` here reports `static` whatever
    // the stylesheet says. That half is asserted in the Playwright suite
    // instead, by hovering and measuring that the chart's own height does
    // not move: see `web/tests/smoke.spec.ts`.
    const { container } = render(<VolumeBars periods={PERIODS_WITH_A_GAP} metric="distance" bucket="week" />)

    moveCursorTo(2, 300)

    const readout = screen.getByText('Week of 18 August 2026').parentElement
    if (readout === null) throw new Error('the readout has no wrapper')
    expect(container.firstElementChild?.contains(readout)).toBe(true)
  })
})

/**
 * A length token from `theme/tokens.css`, in CSS pixels at the 16px root.
 * Read from the file for the reasons `theme/rampContrast.test.ts` gives:
 * jsdom applies no CSS module styles, and a `?raw` import is stubbed empty.
 */
function tokenPx(name: string): number {
  const tokens = readFileSync(join(fileURLToPath(import.meta.url), '..', '..', 'theme', 'tokens.css'), 'utf8')
  const match = new RegExp(`--${name}:\\s*([0-9.]+)rem;`).exec(tokens)
  if (match === null || match[1] === undefined) throw new Error(`no rem --${name} in tokens.css`)
  return Number(match[1]) * 16
}

describe('VolumeBars height', () => {
  // The box around the canvas is sized by these tokens in CSS, and the
  // canvas by `options.height`. They must agree, or the first paint is at
  // the wrong size until the ResizeObserver corrects it - see UPlot.tsx.
  it('constructs the full chart at --chart-height', () => {
    render(<VolumeBars periods={PERIODS_WITH_A_GAP} metric="distance" bucket="week" />)
    expect(lastInstance().opts.height).toBe(tokenPx('chart-height'))
  })

  it('constructs the compact strip at --chart-strip', () => {
    render(<VolumeBars periods={PERIODS_WITH_A_GAP} metric="distance" bucket="week" compact />)
    expect(lastInstance().opts.height).toBe(tokenPx('chart-strip'))
  })
})

describe('clampReadoutLeft', () => {
  // 130px is about what the three-row form measures in a real browser; the
  // panel width is the Overview's 12-week chart at a desktop viewport.
  const READOUT = 130
  const PANEL = 1000

  it('leaves a readout in the middle of the panel exactly where the pointer is', () => {
    expect(clampReadoutLeft(500, READOUT, PANEL)).toBe(500)
  })

  it('keeps the left half on screen when the pointer is at the panel edge', () => {
    // Centred with `translateX(-50%)`, so an offset of 0 puts 65px of the
    // readout outside the panel; the clamp holds its centre a half-width in.
    expect(clampReadoutLeft(0, READOUT, PANEL)).toBe(65)
    expect(clampReadoutLeft(20, READOUT, PANEL)).toBe(65)
  })

  it('keeps the right half on screen when the pointer is at the far edge', () => {
    // Hovering the last bar of the 12-week chart. `.chart` sets no
    // `overflow`, so this half used to join the document's scrollable area.
    expect(clampReadoutLeft(1000, READOUT, PANEL)).toBe(935)
    expect(clampReadoutLeft(990, READOUT, PANEL)).toBe(935)
  })

  it('centres a readout too wide to fit rather than pushing it off one edge', () => {
    // The phone-width case: half of it visible either side beats all of it
    // off the right.
    expect(clampReadoutLeft(300, 400, 320)).toBe(160)
  })

  it('degenerates to passing the offset through when the width is unmeasured', () => {
    // jsdom reports 0 for `offsetWidth`, and the first paint of a hover has
    // no measurement yet either. Neither may move the readout off the
    // pointer it is annotating.
    expect(clampReadoutLeft(317, 0, PANEL)).toBe(317)
  })
})

describe('bucketHeading', () => {
  it('names a week as a week rather than as the day it starts on', () => {
    expect(bucketHeading('week', '2026-08-18')).toBe('Week of 18 August 2026')
  })

  it('names a month by its own name, without the day it starts on', () => {
    // A month has a name and a week does not, so this is the one that can
    // drop the bare date entirely - "Month of 1 August 2026" reintroduces
    // exactly the day-for-a-period misreading the heading removes.
    expect(bucketHeading('month', '2026-08-01')).toBe('August 2026')
  })

  it('takes the period from the caller, since the data cannot say which series it is', () => {
    // `period_start` is a bare date for a week and for a month alike, so
    // the same string has to be able to head either.
    expect(bucketHeading('week', '2026-08-01')).toBe('Week of 1 August 2026')
    expect(bucketHeading('month', '2026-08-01')).toBe('August 2026')
  })
})

describe('the empty-period mark and the pixel ratio', () => {
  /** Every mark the draw hook emits at a pinned device ratio. */
  function marksAtRatio(ratio: number): Mark[] {
    const original = window.devicePixelRatio
    window.devicePixelRatio = ratio
    try {
      return drawnGeometry({ markEmpty: true }).marks
    } finally {
      window.devicePixelRatio = original
    }
  }

  it('draws the mark at the same CSS size on a HiDPI display', () => {
    // The mark exists so a week off "still reads as deliberate rather than
    // as a bar too short to see". Measured before the fix by intercepting
    // the draw calls in a real browser: an unscaled size arrived unchanged
    // at devicePixelRatio 2, so it rendered at half what it claimed and
    // started failing at its one job on exactly the displays most people
    // have. The harness's slot is 100px wide, so the bar width the mark is
    // sized off is well over the 12px cap at ratio 1 and the mark is drawn
    // at the cap in CSS pixels, twice that in canvas pixels at ratio 2.
    expect(marksAtRatio(1).map((mark) => [mark.diameter, mark.lineWidth])).toEqual([[12, 2]])
    expect(marksAtRatio(2).map((mark) => [mark.diameter, mark.lineWidth])).toEqual([[24, 4]])
  })

  it('marks exactly the periods with no runs, and only those', () => {
    // One mark, for the single zero-run week in the fixture - not one per
    // period, and not none.
    expect(marksAtRatio(1)).toHaveLength(
      PERIODS_WITH_A_GAP.filter((period) => period.runs === 0).length,
    )
  })

  it('rests the mark on the baseline, centred on its own slot', () => {
    // `valToPos` in the harness puts index i at BBOX.left + 100 + 100i and
    // the baseline at y 500. The mark sits on the line rather than across
    // it: a circle hanging below the zero rule would be the one mark on the
    // page that leaves the plot.
    const [mark] = marksAtRatio(1)
    if (mark === undefined) throw new Error('no empty-period mark was drawn')
    expect(mark.cx).toBe(BBOX.left + 200)
    expect(mark.bottom).toBeCloseTo(500, 6)
  })
})

describe('the bars themselves', () => {
  it('draws one bar per period that has any height, and none for a zero week', () => {
    // The zero week is not promoted into a short bar: it has no height, so
    // it draws nothing and the accent tick is what says "no runs". That
    // distinction is the whole argument for bars over an area.
    const { bars } = drawnGeometry({ markEmpty: true })
    expect(bars).toHaveLength(2)
  })

  it('draws every bar at the same width, the first one included', () => {
    // The round-1 fault, measured on the capture: twelve bars came out 28,
    // 11, 55, 55, ... 55, 11, 12 device px, the leading 28 being the first
    // bar clipped in half by the plot's own left bound.
    const { bars } = drawnGeometry({
      markEmpty: false,
      periods: PERIODS_WITH_A_GAP.map((period) => ({ ...period, distance_m: 15000 })),
    })
    const widths = bars.map((bar) => bar.right - bar.left)
    expect(new Set(widths).size).toBe(1)
  })

  it('centres each bar on its own slot', () => {
    // `valToPos` in the harness puts index i at BBOX.left + 100 + 100i.
    const { bars } = drawnGeometry({
      markEmpty: false,
      periods: PERIODS_WITH_A_GAP.map((period) => ({ ...period, distance_m: 15000 })),
    })
    const centres = bars.map((bar) => (bar.left + bar.right) / 2)
    expect(centres).toEqual([BBOX.left + 100, BBOX.left + 200, BBOX.left + 300])
  })

  it('sits every bar on the baseline', () => {
    const { bars } = drawnGeometry({ markEmpty: false })
    for (const bar of bars) expect(bar.bottom).toBe(500)
  })
})

describe('volumeScale', () => {
  it('puts the top rule and the midpoint on round numbers above the tallest bar', () => {
    // The reference's own case: a twelve-week series topping out near
    // 30 km draws rules at 0, 20 km and 40 km.
    expect(volumeScale(30_000)).toEqual({ max: 40_000, splits: [0, 20_000, 40_000] })
  })

  it('never draws a top rule below the tallest bar', () => {
    // A bar clipped by its own scale is the one failure this must not
    // have, so it is asserted across the whole mantissa ladder rather than
    // at one convenient value.
    for (const value of [1, 7, 999, 1001, 12_345, 32_187, 49_999, 250_001]) {
      const { max, splits } = volumeScale(value)
      expect(max).toBeGreaterThanOrEqual(value)
      expect(splits.at(-1)).toBe(max)
      expect(splits[0]).toBe(0)
    }
  })

  it('draws a midpoint that is exactly half the top', () => {
    const { max, splits } = volumeScale(12_345)
    expect(splits).toHaveLength(3)
    expect(splits[1]).toBe(max / 2)
  })

  it('gives an all-zero series a baseline rather than dividing by nothing', () => {
    // A store whose every week is a week off. The chart still has to draw
    // its zero axis, and the scale still has to have a positive range.
    expect(volumeScale(0)).toEqual({ max: 1, splits: [0] })
    expect(volumeScale(Number.NaN)).toEqual({ max: 1, splits: [0] })
  })
})

describe('periodTickIndices', () => {
  it('labels at most the number of bars asked for', () => {
    for (const count of [1, 3, 12, 52, 148, 1000]) {
      expect(periodTickIndices(count, 5).length).toBeLessThanOrEqual(5)
    }
  })

  it('leaves the outermost labels off the edge of a long series', () => {
    // The fault this replaces: uPlot chose its own splits from the numeric
    // range and put one on the last bar, whose label was then clipped by
    // the canvas at a desktop width.
    const indices = periodTickIndices(148, 5)
    expect(indices).toEqual([13, 43, 73, 103, 133])
    expect(indices[0]).toBeGreaterThan(0)
    expect(indices.at(-1)).toBeLessThan(147)
  })

  it('centres the ticks in a twelve-week window', () => {
    expect(periodTickIndices(12, 5)).toEqual([1, 4, 7, 10])
  })

  it('is evenly spaced and ascending', () => {
    const indices = periodTickIndices(52, 5)
    const gaps = indices.slice(1).map((value, i) => value - (indices[i] ?? 0))
    expect(new Set(gaps).size).toBe(1)
  })

  it('labels every bar of a series shorter than the tick budget', () => {
    expect(periodTickIndices(3, 5)).toEqual([0, 1, 2])
  })

  it('has nothing to label in an empty series', () => {
    expect(periodTickIndices(0, 5)).toEqual([])
  })
})

describe('the chart grid', () => {
  it('draws no vertical gridlines and no tick marks', () => {
    // Measured on the reference: three horizontal rules across the plot
    // and nothing vertical at all. Ours drew one vertical per x tick, and
    // they overshot the plot 28px above the topmost horizontal and 10px
    // below the zero axis, because uPlot draws grid over the padding.
    render(<VolumeBars periods={PERIODS_WITH_A_GAP} metric="distance" bucket="week" />)
    const [xAxis, yAxis] = lastInstance().opts.axes ?? []

    expect(xAxis?.grid?.show).toBe(false)
    expect(xAxis?.ticks?.show).toBe(false)
    expect(yAxis?.ticks?.show).toBe(false)
    expect(yAxis?.grid?.show).not.toBe(false)
  })

  it('puts the y axis on the right, so the plot starts at the page gutter', () => {
    // Side 1 is the right edge. With the label column there and no left
    // padding, the plot's left edge is the chart element's left edge,
    // which is the gutter every stat and every heading above it starts at.
    render(<VolumeBars periods={PERIODS_WITH_A_GAP} metric="distance" bucket="week" />)
    const instance = lastInstance()

    expect(instance.opts.axes?.[1]?.side).toBe(1)
    expect(instance.opts.padding?.[0]).toBeGreaterThan(0)
    expect(instance.opts.padding?.[3]).toBe(0)
  })

  it('ranges the y scale to the solved top rather than to the tallest bar', () => {
    render(<VolumeBars periods={PERIODS_WITH_A_GAP} metric="distance" bucket="week" />)
    const range = lastInstance().opts.scales?.y?.range
    if (typeof range !== 'function') throw new Error('the y scale carries no range function')

    // The fixture tops out at 20 000 m, so the rules are 0, 10 km, 20 km.
    expect(range({} as never, 0, 20_000, 'y')).toEqual([0, 20_000])
  })
})

describe('barScaleRange', () => {
  it('holds half a slot at each end, so no bar is clipped by the plot bound', () => {
    // Over [-0.5, 11.5] a slot is plotWidth/12 and index 0 sits half a slot
    // in from the left, where uPlot's own [0, 11] puts its centre *on* the
    // bound and draws half of it outside.
    expect(barScaleRange(12)).toEqual([-0.5, 11.5])
  })

  it('gives a single period a whole slot rather than a zero-width range', () => {
    expect(barScaleRange(1)).toEqual([-0.5, 0.5])
  })

  it('never returns an inverted range, even for an empty series', () => {
    const [low, high] = barScaleRange(0)
    expect(high).toBeGreaterThan(low)
  })
})

describe('barGeometry', () => {
  const BASE = {
    centreX: 100,
    slotWidth: 50,
    baselineY: 200,
    widthFactor: 0.6,
    maxWidthPx: 48,
    minHeightPx: 2,
    radiusFactor: 0.2,
  }

  it('is a plain rectangle for an ordinary bar, centred on its slot', () => {
    // width 50 * 0.6 = 30, under the 48 cap; height 200 - 100 = 100, over
    // the 2px floor; radius 0.2 * 30 = 6, under both clamps.
    expect(barGeometry({ ...BASE, valueY: 100 })).toEqual({
      x: 85,
      y: 100,
      width: 30,
      height: 100,
      radius: 6,
    })
  })

  it('caps the width, so a wide plot does not draw slabs', () => {
    // 200 * 0.6 = 120 wanted, 48 allowed.
    const bar = barGeometry({ ...BASE, slotWidth: 200, valueY: 100 })
    expect(bar?.width).toBe(48)
    // Still centred on the slot, not anchored to one side of it.
    expect((bar?.x ?? 0) + (bar?.width ?? 0) / 2).toBe(BASE.centreX)
  })

  it('gives a near-zero week a floor height instead of a one-pixel scratch', () => {
    // 0.4px of real height. Drawn at that height it is wider than it is
    // tall, which reads as a scratch on the axis rather than as a bar.
    const bar = barGeometry({ ...BASE, valueY: 199.6 })
    expect(bar?.height).toBe(2)
    expect(bar?.y).toBe(198)
  })

  it('clamps the radius to half the drawn height, so a short bar is not an anvil', () => {
    // Radius wants 0.2 * 30 = 6 from the width, which is three times the
    // whole height of a floor-height bar.
    expect(barGeometry({ ...BASE, valueY: 199.6 })?.radius).toBe(1)
  })

  it('clamps the radius to half the width as well', () => {
    const bar = barGeometry({ ...BASE, valueY: 100, radiusFactor: 5 })
    expect(bar?.radius).toBe((bar?.width ?? 0) / 2)
  })

  it('draws nothing at all for a period of exactly zero', () => {
    // A zero week must read as "no runs", which the empty-period mark says.
    // Promoting it to a floor-height bar would make it read as a light
    // week, which is the one distinction bars exist here to keep.
    expect(barGeometry({ ...BASE, valueY: BASE.baselineY })).toBeNull()
  })

  it('draws nothing for a value below the baseline', () => {
    // Not reachable from a distance or a count, but a negative height would
    // otherwise be drawn upside down rather than not at all.
    expect(barGeometry({ ...BASE, valueY: 210 })).toBeNull()
  })
})

describe('emptyMarkGeometry', () => {
  const BASE = {
    centreX: 100,
    slotWidth: 30,
    baselineY: 200,
    widthFactor: 0.6,
    maxWidthPx: 48,
    maxDiameterPx: 12,
    minDiameterPx: 3,
    strokePx: 2,
  }

  /** The ring a reader sees, not the path the canvas strokes. */
  function outerDiameter(mark: { radius: number; lineWidth: number } | null): number {
    if (mark === null) throw new Error('no mark')
    return 2 * mark.radius + mark.lineWidth
  }

  it('rests the ring on the baseline rather than across it', () => {
    // Its lowest point is the baseline: `cy + radius + lineWidth / 2`.
    const mark = emptyMarkGeometry(BASE)
    if (mark === null) throw new Error('no mark')
    expect(mark.cy + mark.radius + mark.lineWidth / 2).toBeCloseTo(BASE.baselineY, 6)
    expect(mark.cx).toBe(BASE.centreX)
  })

  it('takes the bar width where that is inside the bounds', () => {
    // 0.6 of a 15px slot is 9px, between the 3px floor and the 12px cap, so
    // the mark is exactly as wide as the bar it replaces - one mark per
    // slot, all the same size, rather than an annotation at a size of its
    // own.
    expect(outerDiameter(emptyMarkGeometry({ ...BASE, slotWidth: 15 }))).toBeCloseTo(9, 6)
  })

  it('caps the diameter on a wide plot', () => {
    // Twelve slots across a desktop plot give a bar far wider than the mark
    // should ever be: a ring at 48px would be a target, not a mark.
    expect(outerDiameter(emptyMarkGeometry({ ...BASE, slotWidth: 200 }))).toBe(12)
  })

  it('floors the diameter in a dense series, and resolves the ring into a dot there', () => {
    // The 148-week history strip: a slot is about 2px, so the bar width is
    // about 1.2px and the floor is what keeps the mark visible. At that
    // size the stroke clamps to the radius, which is a solid dot - a ring
    // with a hole smaller than a pixel is a smudge.
    const mark = emptyMarkGeometry({ ...BASE, slotWidth: 2 })
    if (mark === null) throw new Error('no mark')
    expect(outerDiameter(mark)).toBe(3)
    expect(mark.lineWidth).toBe(1.5)
    expect(mark.radius).toBe(0.75)
  })

  it('draws nothing when there is no slot to draw in', () => {
    expect(emptyMarkGeometry({ ...BASE, slotWidth: 0, minDiameterPx: 0 })).toBeNull()
  })
})
