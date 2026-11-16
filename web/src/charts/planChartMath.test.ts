import { describe, expect, it } from 'vitest'
import {
  LABEL_CHAR_PX,
  PLAN_CHART_HEIGHT_PX,
  besideLabels,
  labelBox,
  distanceLadder,
  linearScale,
  plotBox,
  roundedTopBar,
  spanEndLabels,
  placeStripLabels,
  thinLabels,
  timeLadder,
  trajectoryLayout,
  trajectoryDays,
  volumeSlots,
  vo2maxLadder,
  weekStride,
  wholeLadder,
} from './planChartMath'
import type { BesideItem } from './planChartMath'

describe('distanceLadder', () => {
  it('rules zero, a whole-kilometre half and twice that, the top at or above the largest week', () => {
    expect(distanceLadder(33000)).toEqual({ min: 0, max: 40000, ticks: [0, 20000, 40000] })
    expect(distanceLadder(9000)).toEqual({ min: 0, max: 10000, ticks: [0, 5000, 10000] })
    // A half of 2.5 km would not be whole kilometres, so it rounds up to 3.
    expect(distanceLadder(5000)).toEqual({ min: 0, max: 6000, ticks: [0, 3000, 6000] })
    expect(distanceLadder(40000)).toEqual({ min: 0, max: 40000, ticks: [0, 20000, 40000] })
  })

  it('keeps a kilometre step for a plan with no distance at all', () => {
    expect(distanceLadder(0)).toEqual({ min: 0, max: 2000, ticks: [0, 1000, 2000] })
    expect(distanceLadder(300)).toEqual({ min: 0, max: 2000, ticks: [0, 1000, 2000] })
  })
})

describe('wholeLadder', () => {
  it('rules zero, a whole half and its double for a unitless count', () => {
    expect(wholeLadder(320)).toEqual({ min: 0, max: 400, ticks: [0, 200, 400] })
    expect(wholeLadder(150)).toEqual({ min: 0, max: 160, ticks: [0, 80, 160] })
    expect(wholeLadder(0)).toEqual({ min: 0, max: 2, ticks: [0, 1, 2] })
  })
})

describe('vo2maxLadder', () => {
  it('brackets every value strictly, on the smallest step that keeps to three intervals', () => {
    expect(vo2maxLadder([44.2, 44.8])).toEqual({ min: 44, max: 45, ticks: [44, 44.5, 45] })
    // 44 and 46 lie on every step, so each end reaches a step past them.
    expect(vo2maxLadder([44, 44.8, 45.5, 46])).toEqual({ min: 42, max: 48, ticks: [42, 44, 46, 48] })
  })
})

describe('timeLadder', () => {
  it('brackets every value strictly, in half minutes', () => {
    // 25:00 lies on a half minute, so the ladder reaches one step past it.
    expect(timeLadder([1500, 1563, 1548])).toEqual({
      min: 1470,
      max: 1590,
      ticks: [1470, 1500, 1530, 1560, 1590],
    })
  })

  it('widens the step to whole multiples of half a minute when the values spread', () => {
    // 30 s and 60 s steps need more than four intervals for 25:00 to 30:00.
    expect(timeLadder([1500, 1800])).toEqual({
      min: 1440,
      max: 1920,
      ticks: [1440, 1560, 1680, 1800, 1920],
    })
  })

  it('brackets a single value from both sides', () => {
    expect(timeLadder([1500])).toEqual({ min: 1470, max: 1530, ticks: [1470, 1500, 1530] })
    expect(timeLadder([1511])).toEqual({ min: 1500, max: 1530, ticks: [1500, 1530] })
  })
})

describe('linearScale', () => {
  it('maps the domain onto the range, either way round', () => {
    const y = linearScale(1470, 1590, 10, 130)
    expect(y(1470)).toBe(10)
    expect(y(1500)).toBe(40)
    expect(y(1590)).toBe(130)
  })

  it('puts a degenerate domain at the middle of the range', () => {
    expect(linearScale(5, 5, 0, 100)(5)).toBe(50)
  })
})

describe('plotBox', () => {
  it('leaves the ladder its gutter on the right and the labels room below', () => {
    const plot = plotBox(600, PLAN_CHART_HEIGHT_PX)
    expect(plot.left).toBeGreaterThanOrEqual(0)
    expect(plot.right).toBeLessThan(600)
    expect(plot.top).toBeGreaterThan(0)
    expect(plot.bottom).toBeLessThan(PLAN_CHART_HEIGHT_PX)
  })
})

describe('trajectoryLayout', () => {
  it('without checkpoints is the plot and the date labels under it', () => {
    const { plot, dateY, strip, height } = trajectoryLayout(600, 5, false)
    expect(plot.left).toBe(plotBox(600, 0).left)
    expect(plot.right).toBe(plotBox(600, 0).right)
    expect(strip).toBeNull()
    expect(dateY).toBeGreaterThan(plot.bottom)
    expect(height).toBeGreaterThan(dateY)
  })

  it('seats the checkpoints in a row of their own below the date labels, off the time axis', () => {
    const { plot, dateY, strip, height } = trajectoryLayout(600, 5, true)
    if (strip === null) throw new Error('a strip was asked for')
    expect(strip.ruleY).toBeGreaterThan(dateY)
    expect(strip.nameY).toBeGreaterThan(strip.ruleY)
    // Room for a diamond between the row's name and its marks, and under them.
    expect(strip.markY).toBeGreaterThan(strip.nameY + 6)
    expect(height).toBeGreaterThan(strip.markY + 6)
    expect(plot.bottom).toBeLessThan(dateY)
  })

  it('draws a shorter plot for three predictions or fewer at a phone width', () => {
    const tall = trajectoryLayout(366, 4, false).plot
    const short = trajectoryLayout(366, 3, false).plot
    expect(short.bottom - short.top).toBeLessThan(tall.bottom - tall.top)
    // Beside the target paces on a desktop, it keeps the full height of their shared row.
    const wide = trajectoryLayout(600, 3, false).plot
    expect(wide.bottom - wide.top).toBe(tall.bottom - tall.top)
  })
})

describe('weekStride', () => {
  it('labels every week when they have room', () => {
    expect(weekStride([50, 150, 250, 350])).toEqual([true, true, true, true])
  })

  it('labels W1 and every kth week after it when they are crowded', () => {
    const centres = Array.from({ length: 35 }, (_, i) => 4 + i * 9)
    const shown = weekStride(centres)
    expect(shown[0]).toBe(true)
    const kept = shown.flatMap((s, i) => (s ? [i] : []))
    const gaps = new Set(kept.slice(1).map((k, i) => k - (kept[i] as number)))
    // One even stride, wide enough for `W35` at the label size.
    expect(gaps.size).toBe(1)
    const stride = [...gaps][0] as number
    expect(stride * 9).toBeGreaterThanOrEqual(3 * LABEL_CHAR_PX)
  })
})

describe('besideLabels', () => {
  const bounds = { left: 0, right: 600, top: 0, bottom: 200 }
  const item = (over: Partial<BesideItem> = {}): BesideItem => ({
    cx: 100,
    half: 5,
    top: 90,
    bottom: 110,
    text: '4:15-4:20',
    width: 63,
    prefer: 'start',
    ...over,
  })

  it('sets a label beside its mark, level with its middle, on the side it prefers', () => {
    const [placed] = besideLabels([item()], [], bounds)
    expect(placed?.anchor).toBe('start')
    expect(placed?.x).toBeGreaterThan(105)
    // The label's box straddles the mark's middle.
    expect((placed?.baseline ?? 0) - 10).toBeLessThan(100)
    expect(placed?.baseline ?? 0).toBeGreaterThan(100)
  })

  it('takes the other side when the preferred one is blocked, and slides off a line it would cross', () => {
    const blockRight = { left: 106, right: 300, top: 0, bottom: 200 }
    expect(besideLabels([item()], [blockRight], bounds)[0]?.anchor).toBe('end')
    const line = { left: 0, right: 600, top: 98, bottom: 102 }
    const placed = besideLabels([item()], [line], bounds)[0]
    if (placed === null || placed === undefined) throw new Error('no place found')
    const box = labelBox(placed.anchor === 'start' ? placed.x : placed.x - 63, 63, placed.baseline)
    expect(box.bottom <= line.top || box.top >= line.bottom).toBe(true)
  })

  it('prints a repeated text once, and drops a label with nowhere to go', () => {
    const placed = besideLabels([item(), item({ cx: 300 })], [], bounds)
    expect(placed[0]).not.toBeNull()
    expect(placed[1]).toBeNull()
    const walled = [
      { left: 0, right: 95, top: 0, bottom: 200 },
      { left: 105, right: 600, top: 0, bottom: 200 },
    ]
    expect(besideLabels([item()], walled, bounds)).toEqual([null])
  })
})

describe('volumeSlots', () => {
  it('splits the plot into one slot per week, the planned bar left of the run bar', () => {
    const slots = volumeSlots(4, 0, 400)
    expect(slots.map((s) => s.centre)).toEqual([50, 150, 250, 350])
    for (const s of slots) {
      expect(s.plannedX + s.barWidth).toBeLessThanOrEqual(s.runX)
      expect(s.plannedX).toBeGreaterThan(s.centre - 50)
      expect(s.runX + s.barWidth).toBeLessThan(s.centre + 50)
    }
  })

  it('caps the bar width, so a five-week plan on a desktop column is not five slabs', () => {
    const [slot] = volumeSlots(1, 0, 1200)
    expect(slot?.barWidth).toBeLessThanOrEqual(32)
  })
})

describe('trajectoryDays', () => {
  it('runs from the first point to the race', () => {
    expect(trajectoryDays([100, 112], [120], 135)).toEqual([100, 135])
  })

  it('reaches back to a checkpoint dated before the first point', () => {
    expect(trajectoryDays([100], [95], 135)).toEqual([95, 135])
  })


  it('gives a week before the race when nothing else is dated', () => {
    expect(trajectoryDays([], [], 135)).toEqual([128, 135])
    expect(trajectoryDays([135], [], 135)).toEqual([128, 135])
  })
})

describe('spanEndLabels', () => {
  it('names the day alone within a year, and adds the year to both ends across one', () => {
    const day = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000
    expect(spanEndLabels(day('2027-02-05'), day('2027-03-13'))).toEqual(['5 Feb', '13 Mar'])
    expect(spanEndLabels(day('2026-11-14'), day('2027-12-05'))).toEqual(['14 Nov 2026', '5 Dec 2027'])
  })
})

describe('thinLabels', () => {
  it('keeps the latest label and drops any that would sit too close to the one after it', () => {
    expect(thinLabels([0, 10, 100, 200], 48)).toEqual([false, true, true, true])
    expect(thinLabels([0, 30, 60], 48)).toEqual([true, false, true])
    expect(thinLabels([], 48)).toEqual([])
  })
})

describe('placeStripLabels', () => {
  // Diamonds of radius 5, labels 9 px from their centre, 8 px of padding,
  // inside a strip from 0 to 300.
  const place = (items: { cx: number; width: number }[]) => placeStripLabels(items, 0, 300, 9, 5, 8)

  it('reads a label rightward when it fits, else leftward', () => {
    expect(place([{ cx: 20, width: 80 }])).toEqual(['start'])
    // 290 + 9 + 80 runs past 300.
    expect(place([{ cx: 290, width: 80 }])).toEqual(['end'])
  })

  it('never covers another checkpoint\'s diamond', () => {
    // The later label reads rightward; the earlier one would run into it
    // and into the later diamond that way, so it reads left.
    expect(place([{ cx: 150, width: 80 }, { cx: 200, width: 80 }])).toEqual(['end', 'start'])
    // Close together near the right edge: rightward the later label runs
    // past the strip and leftward it covers the earlier diamond.
    expect(place([{ cx: 250, width: 60 }, { cx: 275, width: 60 }])).toEqual(['end', null])
  })

  it('drops a label with room on neither side rather than drawing one over another', () => {
    expect(place([{ cx: 100, width: 80 }, { cx: 130, width: 80 }, { cx: 160, width: 80 }])).toEqual([
      'end',
      null,
      'start',
    ])
  })
})

describe('roundedTopBar', () => {
  it('rounds the top corners by a quarter of the width, at most 4 px', () => {
    expect(roundedTopBar(10, 20, 8, 100)).toBe('M 10 100 V 22 Q 10 20 12 20 H 16 Q 18 20 18 22 V 100 Z')
    expect(roundedTopBar(0, 0, 40, 100)).toContain('Q 0 0 4 0')
  })

  it('never rounds more than the bar is tall, so a short bar stays flat-topped', () => {
    expect(roundedTopBar(0, 99, 20, 100)).toBe('M 0 100 V 100 Q 0 99 1 99 H 19 Q 20 99 20 100 V 100 Z')
    expect(roundedTopBar(0, 100, 20, 100)).toBe('M 0 100 V 100 Q 0 100 0 100 H 20 Q 20 100 20 100 V 100 Z')
  })
})
