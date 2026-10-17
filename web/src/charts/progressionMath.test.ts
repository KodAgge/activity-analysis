import { describe, expect, it } from 'vitest'
import { localCalendarDay } from '../format'
import {
  DEFAULT_PLOT_HEIGHT,
  DEFAULT_PLOT_WIDTH,
  PLOT_INSET,
  DIAMOND_HALF_DIAGONAL_PER_RADIUS,
  diamondPath,
  durationAxisScale,
  inPaintOrder,
  timeAxisGutter,
  pointStyle,
  readoutFlipsBelow,
  scatterLayout,
  staircase,
  type EffortDatum,
} from './progressionMath'

function day(date: string): number {
  return localCalendarDay(`${date}T12:00:00Z`, 0)
}

function effort(date: string, elapsed: number, isRecord = false): EffortDatum {
  return { t: day(date), valueS: elapsed, isRecord }
}

describe('scatterLayout', () => {
  const efforts = [effort('2025-01-01', 1500), effort('2025-06-01', 1400), effort('2025-12-01', 1450)]
  const layout = scatterLayout(efforts)

  it('puts a faster effort lower on the chart, so improvement descends', () => {
    // SVG y grows downward, so "lower on the chart" is a *greater* y.
    expect(layout.y(1400)).toBeGreaterThan(layout.y(1500))
    expect(layout.y(1400)).toBeGreaterThan(layout.y(1450))
  })

  it('is one continuous linear axis, never broken or clipped', () => {
    // Equal time gaps map to equal pixel gaps everywhere on the axis.
    const step = layout.y(1400) - layout.y(1450)
    expect(layout.y(1450) - layout.y(1500)).toBeCloseTo(step, 9)
  })

  it('keeps every point inside the plot box', () => {
    for (const e of efforts) {
      expect(layout.x(e.t)).toBeGreaterThanOrEqual(layout.plot.left)
      expect(layout.x(e.t)).toBeLessThanOrEqual(layout.plot.right)
      expect(layout.y(e.valueS)).toBeGreaterThanOrEqual(layout.plot.top)
      expect(layout.y(e.valueS)).toBeLessThanOrEqual(layout.plot.bottom)
    }
    // And the box is the panel minus the stated chrome, with the ladder's
    // column solved from what the ladder says.
    expect(layout.plot.left).toBe(PLOT_INSET.left)
    expect(layout.plot.top).toBe(PLOT_INSET.top)
    expect(layout.plot.bottom).toBe(DEFAULT_PLOT_HEIGHT - PLOT_INSET.bottom)
    expect(layout.plot.right).toBeLessThan(DEFAULT_PLOT_WIDTH)
  })

  it('runs time left to right', () => {
    expect(layout.x(day('2025-12-01'))).toBeGreaterThan(layout.x(day('2025-01-01')))
  })

  it('gives a single effort a drawable position rather than dividing by zero', () => {
    const single = scatterLayout([effort('2025-01-01', 1500)])
    expect(Number.isFinite(single.x(day('2025-01-01')))).toBe(true)
    expect(Number.isFinite(single.y(1500))).toBe(true)
  })

  it('does not anchor the time axis at zero', () => {
    // A 5 km ladder lives within a few percent of its best time; on an axis
    // from zero it would be a few pixels of the panel.
    expect(layout.yDomain[0]).toBeGreaterThan(1000)
    expect(layout.yDomain[0]).toBeLessThan(1400)
    expect(layout.yDomain[1]).toBeGreaterThan(1500)
  })
})

describe('staircase', () => {
  it('steps through the records in time order and holds the last one to the end of the history', () => {
    const efforts = [
      effort('2025-01-01', 1500, true),
      effort('2025-03-01', 1550),
      effort('2025-06-01', 1400, true),
      effort('2025-12-01', 1450),
    ]
    const layout = scatterLayout(efforts)
    const steps = staircase(efforts, layout)
    expect(steps).toEqual([
      { x: layout.x(day('2025-01-01')), y: layout.y(1500) },
      { x: layout.x(day('2025-06-01')), y: layout.y(1500) },
      { x: layout.x(day('2025-06-01')), y: layout.y(1400) },
      { x: layout.x(day('2025-12-01')), y: layout.y(1400) },
    ])
  })

  it('is empty with no records', () => {
    const efforts = [effort('2025-01-01', 1500), effort('2025-03-01', 1550)]
    expect(staircase(efforts, scatterLayout(efforts))).toEqual([])
  })

  it('is a single horizontal hold for a distance with one record', () => {
    // The first eligible effort at a distance counts as a record, so a
    // distance with one effort has one step: the record, held to the end.
    const efforts = [effort('2025-01-01', 1500, true), effort('2025-03-01', 1550)]
    const layout = scatterLayout(efforts)
    expect(staircase(efforts, layout)).toEqual([
      { x: layout.x(day('2025-01-01')), y: layout.y(1500) },
      { x: layout.x(day('2025-03-01')), y: layout.y(1500) },
    ])
  })
})

/**
 * The invariant every case here runs through: **the ticks are the bounds.**
 *
 * A shared helper rather than a repeated assertion, on `trendChartMath`'s
 * own advice after the same bug: a later case that forgets to check coverage
 * is exactly how a chart ends up drawing 98% of its marks below its lowest
 * labelled rule, which is what this one did.
 */
function axisCovering(minS: number, maxS: number) {
  const axis = durationAxisScale(minS, maxS)
  const first = axis.ticks[0]
  const last = axis.ticks.at(-1)
  if (first === undefined || last === undefined) throw new Error('an axis with no ticks')
  // Every mark is inside a labelled band.
  expect(first).toBeLessThanOrEqual(minS)
  expect(last).toBeGreaterThanOrEqual(maxS)
  // And the overhang is on the scale, never on the ticks, so the outermost
  // rules sit inside the plot rather than on its edge.
  expect(axis.range[0]).toBeLessThan(first)
  expect(axis.range[1]).toBeGreaterThan(last)
  // An axis is a band, not a point.
  expect(axis.ticks.length).toBeGreaterThanOrEqual(2)
  return axis
}

describe('durationAxisScale', () => {
  it('covers a 5 km history shaped like the real one, which is the case that was broken', () => {
    // 24:02.5 to 58:00, the slowest 2.4 times the fastest. An axis ticking
    // 30:00, 40:00, 50:00 and 1:00:00 puts the fastest effort - the one the
    // screen is about - 357.5 s below the lowest rule, which is how the
    // real history once drew 98% of its mark ink under it.
    const axis = axisCovering(1442.5, 3480)
    expect(axis.ticks[0]).toBeLessThanOrEqual(1442.5)
    expect(axis.ticks.map((s) => s % 60)).toEqual(axis.ticks.map(() => 0))
  })

  it('picks a round step in seconds so every tick reads as a time', () => {
    const axis = axisCovering(1442, 1600)
    expect(axis.ticks.every((s) => s % 30 === 0)).toBe(true)
    expect(axis.ticks.length).toBeGreaterThanOrEqual(3)
    expect(axis.ticks.length).toBeLessThanOrEqual(8)
  })

  it('steps finely over a 400 m band and coarsely over a half marathon one', () => {
    const short = axisCovering(85, 130)
    const long = axisCovering(7200, 8400)
    const stepOf = (ticks: number[]) => (ticks[1] ?? 0) - (ticks[0] ?? 0)
    expect(stepOf(short.ticks)).toBeLessThan(stepOf(long.ticks))
    expect(short.ticks.length).toBeGreaterThanOrEqual(3)
  })

  it('covers a band whose ends are already whole increments', () => {
    // The off-by-one that a `<= last` loop bound hides: both ends land
    // exactly on a tick, so nothing has to be rounded outward and the last
    // tick is the one most easily dropped.
    axisCovering(1800, 3600)
  })

  it('gives a distance with a single effort a readable band rather than a five-second one', () => {
    const axis = axisCovering(1442.5, 1442.5)
    const span = (axis.ticks.at(-1) ?? 0) - (axis.ticks[0] ?? 0)
    expect(span).toBeGreaterThanOrEqual(60)
  })

  it('never labels a negative time, however narrow the band around a fast effort', () => {
    const axis = axisCovering(12, 12)
    expect(axis.ticks[0]).toBeGreaterThanOrEqual(0)
  })

  it('holds the invariant across the whole span of distances', () => {
    // 400 m through the half marathon, plus a 5 km band stretched by a
    // walked effort, which is the awkward one.
    for (const [lo, hi] of [
      [90, 250],
      [240, 420],
      [420, 720],
      [1442.5, 3480],
      [2880, 4200],
      [7200, 8400],
    ] as [number, number][]) {
      axisCovering(lo, hi)
    }
  })
})

describe('readoutFlipsBelow', () => {
  /** The readout with a date, a name, four rows and the record line, measured in Chromium. */
  const READOUT_H = 150
  /** Any measured panel. The height is the "has this been measured" flag now, not a divisor. */
  const MEASURED_PANEL_H = 240

  it('flips a point too near the top edge to fit the readout above it', () => {
    // The point's y is the pixel it is drawn at, because the viewBox is the
    // panel's own measured size - see `DEFAULT_PLOT_WIDTH`.
    expect(readoutFlipsBelow(60, MEASURED_PANEL_H, READOUT_H)).toBe(true)
  })

  it('leaves a point with room above it above the point', () => {
    expect(readoutFlipsBelow(200, MEASURED_PANEL_H, READOUT_H)).toBe(false)
  })

  it('decides in panel pixels, so a short panel and a tall one are told apart by where the point lands', () => {
    // The regression the old rule could not see: it took the point's y as a
    // fraction of a fixed 800x360 viewBox, so 30% down was judged the same
    // on a 360px panel and on the roughly 157px one a 390px viewport gives,
    // where it is 47px from the top and a 150px readout ran off above the
    // panel and over the legend. With the viewBox measured, the same effort
    // simply has a different y on the two panels, and this function only has
    // to compare two pixel counts.
    const onTallPanel = scatterLayout([effort('2025-01-01', 1500)], 800, 360).y(1500)
    const onShortPanel = scatterLayout([effort('2025-01-01', 1500)], 350, 157).y(1500)
    expect(readoutFlipsBelow(onTallPanel, 360, READOUT_H)).toBe(false)
    expect(readoutFlipsBelow(onShortPanel, 157, READOUT_H)).toBe(true)
  })

  it('counts the 10px gap the stylesheet leaves between the point and the readout', () => {
    // Exactly the readout's height above the point is not enough room: the
    // transform offsets it by another 10px.
    expect(readoutFlipsBelow(READOUT_H, MEASURED_PANEL_H, READOUT_H)).toBe(true)
    expect(readoutFlipsBelow(READOUT_H + 11, MEASURED_PANEL_H, READOUT_H)).toBe(false)
  })

  it('does not flip while nothing has been measured, which is jsdom and the first paint of a hover', () => {
    // An unmeasured height is not a reason to move the readout off the
    // placement a roomy panel already had.
    expect(readoutFlipsBelow(0, 0, 0)).toBe(false)
    expect(readoutFlipsBelow(30, MEASURED_PANEL_H, 0)).toBe(false)
    expect(readoutFlipsBelow(30, 0, READOUT_H)).toBe(false)
  })
})

describe('timeAxisGutter', () => {
  // Measured in Chromium with `getComputedTextLength` on the rendered
  // chart: at `--text-caption` with tabular figures every glyph advances
  // exactly 7px, so `50:00` is 35 and `1:00:00` is 49, and both direction
  // words are 48.28.
  it('reserves the column from the longest label, not an average one', () => {
    // The fault a blind critic measured: a fixed 52px column left
    // `1:00:00` clearing the gridline by 3px and `50:00` by 17.
    const gutter = timeAxisGutter(['30:00', '40:00', '50:00', '1:00:00'])
    expect(gutter).toBeGreaterThanOrEqual(49 + 10)
  })

  it('is never narrower than the two words that share the column', () => {
    // A 400m ladder ticks `1:00` and `2:00`, four glyphs, 28px - but
    // `SLOWER` and `FASTER` are in the same column and are 48.28.
    expect(timeAxisGutter(['1:00', '2:00', '3:00'])).toBeGreaterThanOrEqual(48 + 10)
  })

  it('grows for a ladder that needs more, so the longest tick always clears', () => {
    expect(timeAxisGutter(['10:00:00'])).toBeGreaterThan(timeAxisGutter(['1:00:00']))
  })

  it('has a column even with no ticks at all', () => {
    expect(timeAxisGutter([])).toBeGreaterThan(0)
  })
})

describe('the paint order', () => {
  it('names a point by the analysis layer\'s two flags and never by its time', () => {
    expect(pointStyle(true, true)).toBe('record')
    expect(pointStyle(false, true)).toBe('eligible')
    expect(pointStyle(false, false)).toBe('ineligible')
  })

  it('paints ineligible efforts first and records last, so a record cannot be covered', () => {
    const items = [
      { id: 'record', style: 'record' as const },
      { id: 'ineligible', style: 'ineligible' as const },
      { id: 'eligible', style: 'eligible' as const },
      { id: 'record-2', style: 'record' as const },
    ]
    expect(inPaintOrder(items, (item) => item.style).map((item) => item.id)).toEqual([
      'ineligible',
      'eligible',
      'record',
      'record-2',
    ])
  })

  it('keeps the order it was given within one style, so the payload order survives', () => {
    const items = [
      { id: 'b', style: 'eligible' as const },
      { id: 'a', style: 'eligible' as const },
    ]
    expect(inPaintOrder(items, (item) => item.style).map((item) => item.id)).toEqual(['b', 'a'])
  })
})

describe('diamondPath', () => {
  function vertices(d: string): [number, number][] {
    const numbers = d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g)?.map(Number) ?? []
    const pairs: [number, number][] = []
    for (let i = 0; i + 1 < numbers.length; i += 2) {
      const x = numbers[i]
      const y = numbers[i + 1]
      if (x !== undefined && y !== undefined) pairs.push([x, y])
    }
    return pairs
  }

  it('is centred on the point it marks', () => {
    const vs = vertices(diamondPath(40, 25, 3))
    expect(vs).toHaveLength(4)
    expect(vs.reduce((sum, [x]) => sum + x, 0) / 4).toBeCloseTo(40, 9)
    expect(vs.reduce((sum, [, y]) => sum + y, 0) / 4).toBeCloseTo(25, 9)
  })

  it('carries the same area as the circle of that radius', () => {
    // The shoelace formula over the four vertices.
    const vs = vertices(diamondPath(0, 0, 6))
    let twiceArea = 0
    vs.forEach(([x1, y1], i) => {
      const next = vs[(i + 1) % vs.length]
      if (next === undefined) return
      twiceArea += x1 * next[1] - next[0] * y1
    })
    expect(Math.abs(twiceArea) / 2).toBeCloseTo(Math.PI * 36, 9)
    expect(DIAMOND_HALF_DIAGONAL_PER_RADIUS).toBeCloseTo(1.2533, 4)
  })
})
