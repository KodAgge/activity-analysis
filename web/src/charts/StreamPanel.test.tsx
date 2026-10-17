import { act, render, screen } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import type uPlot from 'uplot'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_VALUE, pace, paceSecondsPerKm, speedFromPaceSeconds } from '../format'
import type { MomentStore } from '../moment/momentStore'
import { MomentProvider } from '../moment/MomentProvider'
import { useMomentStore } from '../moment/useMoment'
import { useReplay, type Replay } from '../moment/useReplay'
import { cssPixelRatio, scaleDash } from './canvasPixels'
import { StreamPanel } from './StreamPanel'
import {
  ANNOTATION_LINE_WIDTH_PX,
  AVERAGE_DASH,
  MIN_ELEVATION_BAND_M,
  PAUSE_BAND_DASH,
  computePauseBands,
  containsNearZeroSpeed,
  elevationYRange,
  formatAverage,
  paceAxisSplits,
  paceTick,
  paceYRange,
  STOP_SPEED_MPS,
} from './streamPanelMath'

/**
 * uPlot needs a real layout engine to draw, which jsdom does not have, so
 * these tests spy on the constructor instead of letting uPlot actually run
 * (see this task's brief, "uPlot in jsdom"). `UPlot.tsx` is the only file
 * that imports the real `uplot` package, so mocking that one specifier here
 * is enough to intercept every chart built on top of it.
 */
const { instances, MockUPlot } = vi.hoisted(() => {
  class MockUPlot {
    static paths = { bars: () => undefined }
    opts: uPlot.Options
    data: uPlot.AlignedData
    setData = () => {}
    setSize = () => {}
    destroy = () => {}
    // The moment: a real cursor's own state, and the calls StreamPanel.tsx
    // makes against it, both recorded so a test can assert on them without
    // uPlot actually drawing anything.
    cursor = { idx: null as number | null, left: -10 }
    setCursorCalls: { left: number; top: number; fireHook: boolean | undefined }[] = []
    setCursor = (opts: { left: number; top: number }, fireHook?: boolean) => {
      this.setCursorCalls.push({ ...opts, fireHook })
    }
    // 1 (ready) by default, so most tests need not simulate uPlot's own
    // async startup by hand: a real chart's first commit, and therefore its
    // `ready` hook, fires as a microtask very soon after construction - well
    // before anything in one of these synchronous test bodies gets to run.
    // The dedicated "not ready yet" test below sets this back to 0 to
    // exercise that narrower window directly.
    status: 0 | 1 = 1
    // Unusable before the chart is ready, exactly like the real uPlot 1.6.32
    // (confirmed directly against it, in a browser): its x
    // scale has no range until the first commit's own `setScales()` runs,
    // and `valToPos` returns `Infinity` before that.
    valToPos = (v: number) => (this.status === 1 ? v * 10 : Infinity)
    posToIdx = (left: number) => Math.round(left / 10)
    over = document.createElement('div')
    constructor(opts: uPlot.Options, data: uPlot.AlignedData) {
      this.opts = opts
      this.data = data
      instances.push(this)
      // uPlot's own `mouseleave` listener on `over`, which hides the cursor.
      // Registered here, at construction, as the real one is, so it runs
      // ahead of any listener `StreamPanel.tsx` adds to the same element.
      // Recorded with an undefined `fireHook`, the one call a caller never
      // makes.
      this.over.addEventListener('mouseleave', () => {
        this.setCursorCalls.push({ left: -10, top: -10, fireHook: undefined })
      })
      // Fires `ready` synchronously when constructed already "ready",
      // mirroring what a real chart's own first commit does moments after
      // construction - `StreamPanel.tsx`'s `placeCursor` relies on exactly
      // this hook to place a moment already active on a freshly built chart.
      if (this.status === 1) {
        // `Options['hooks']` types each hook as an array *or* a bare
        // function (`Hooks.ArraysOrFuncs`); `StreamPanel.tsx` always hands
        // an array, but normalising both keeps this mock honest to the
        // wider type rather than assuming its one caller's shape.
        const readyHooks = opts.hooks?.ready
        const readyList = Array.isArray(readyHooks) ? readyHooks : readyHooks === undefined ? [] : [readyHooks]
        for (const fn of readyList) fn?.(this as unknown as uPlot)
      }
    }
  }
  const instances: InstanceType<typeof MockUPlot>[] = []
  return { instances, MockUPlot }
})

vi.mock('uplot', () => ({ default: MockUPlot }))
vi.mock('uplot/dist/uPlot.min.css', () => ({}))

/**
 * `cssVar` resolves a token through `getComputedStyle`, which jsdom cannot
 * do without a real stylesheet loaded - and would return the same empty
 * string for every token regardless, which cannot tell `--ink` apart from
 * `--ink-dim`. Mocked to echo the token name back verbatim so the average
 * reference line's own colour wiring (M5: it used to be handed `--ink`
 * where `--ink-dim` was meant) is directly observable.
 */
vi.mock('./cssVar', () => ({ cssVar: (name: string) => name }))

beforeEach(() => {
  instances.length = 0
})

function lastInstance(): InstanceType<typeof MockUPlot> {
  const instance = instances.at(-1)
  if (instance === undefined) throw new Error('uPlot was never constructed')
  return instance
}

const FLAT = (n: number, value = false) => Array.from({ length: n }, () => value)

/**
 * A touch pointer event on the chart at client `(x, y)`, landing at
 * `offsetX` on the plot, from the finger `pointerId`.
 */
function touchEvent(type: string, x: number, y: number, offsetX: number, pointerId = 1): PointerEvent {
  const event = new PointerEvent(type, { pointerType: 'touch', pointerId, clientX: x, clientY: y, cancelable: true })
  Object.defineProperty(event, 'offsetX', { value: offsetX })
  return event
}

/**
 * Renders `children` inside a `MomentProvider` and hands back the store it
 * creates, captured through a tiny component that does nothing else - the
 * store itself has no public way to reach from outside a mounted tree.
 */
function renderWithMoment(children: ReactNode): MomentStore {
  let captured: MomentStore | null = null
  function Capture() {
    const store = useMomentStore()
    useEffect(() => {
      captured = store
    })
    return null
  }
  render(
    <MomentProvider>
      <Capture />
      {children}
    </MomentProvider>,
  )
  if (captured === null) throw new Error('no moment store was provided')
  return captured
}

describe('StreamPanel', () => {
  describe('the time axis', () => {
    const renderPanel = (timeAxis?: boolean) =>
      render(
        <StreamPanel
          channel="hr"
          t={[0, 60, 120]}
          values={[150, 160, 170]}
          paused={FLAT(3)}
          outage={FLAT(3)}
          average={null}
          {...(timeAxis === undefined ? {} : { timeAxis })}
        />,
      )
    const panelBox = (container: HTMLElement) => {
      const box = container.querySelector<HTMLElement>('[style*="--stream-chart-furniture"]')
      if (box === null) throw new Error('no panel box')
      return box
    }

    it('is drawn by default, with its title, and reserves its space below the plot', () => {
      const { container } = renderPanel()
      const { opts } = lastInstance()
      const xAxis = opts.axes?.[0]
      expect(xAxis?.label).toBe('Elapsed time')
      expect(xAxis?.size).toBe(50)
      expect(xAxis?.labelSize).toBe(22)
      expect(opts.padding).toEqual([8, 8, 0, 0])
      // 8 above the plot, 50 + 22 of axis below: a 200px panel, a 120px plot.
      expect(panelBox(container).style.getPropertyValue('--stream-chart-furniture')).toBe('80px')
      const values = xAxis?.values
      if (typeof values !== 'function') throw new Error('no time formatter')
      expect(values(lastInstance() as unknown as uPlot, [0, 60], 0, 0, 0)).toEqual(['0:00', '1:00'])
    })

    it('keeps only its grid when another panel draws it, and gives its space to the plot', () => {
      const { container } = renderPanel(false)
      const { opts } = lastInstance()
      const xAxis = opts.axes?.[0]
      // The grid stays: `show: false` would drop it with the rest.
      expect(xAxis?.show).not.toBe(false)
      expect(xAxis?.grid).toEqual({ stroke: '--grid' })
      expect(xAxis?.label).toBeUndefined()
      expect(xAxis?.size).toBe(0)
      expect(xAxis?.ticks).toEqual({ show: false })
      const values = xAxis?.values
      if (typeof values !== 'function') throw new Error('no label callback')
      expect(values(lastInstance() as unknown as uPlot, [0, 60], 0, 0, 0)).toEqual([null, null])
      // Room under the plot for the y label on the floor gridline, and no more.
      expect(opts.padding).toEqual([8, 8, 8, 0])
      expect(panelBox(container).style.getPropertyValue('--stream-chart-furniture')).toBe('16px')
    })
  })

  it('plots speed for the pace channel, not pace, when nothing is paused', () => {
    const t = [0, 1, 2, 3, 4]
    const values = [3, 3.2, 3.4, 3.3, 3.1]

    render(
      <StreamPanel
        channel="pace"
        t={t}
        values={values}
        paused={FLAT(5)}
        outage={FLAT(5)}
        average={null}
      />,
    )

    const instance = lastInstance()
    // The whole point under test: the y-series handed to uPlot is the raw
    // m/s array, not a pace-converted one - a mutation that ran the values
    // through `paceSecondsPerKm` here would change every entry.
    expect(instance.data).toEqual([t, values])
  })

  it("labels the pace axis's ticks as pace even though the scale itself is speed", () => {
    render(
      <StreamPanel
        channel="pace"
        t={[0, 1]}
        values={[3, 3]}
        paused={FLAT(2)}
        outage={FLAT(2)}
        average={null}
      />,
    )

    const instance = lastInstance()
    const yAxis = instance.opts.axes?.[1]
    if (yAxis?.values === undefined || typeof yAxis.values !== 'function') {
      throw new Error('pace axis has no dynamic value formatter')
    }
    const labels = yAxis.values(instance as unknown as uPlot, [3.333, 0], 1, 0, 0)
    expect(labels).toEqual(['5:00', 'stop'])
  })

  it('the paceTick formatter turns 3.333 m/s into 5:00 and 0 into stop', () => {
    expect(paceTick(3.333)).toBe('5:00')
    expect(paceTick(0)).toBe('stop')
  })

  it('places most pace-axis gridlines inside the band the run actually occupies', () => {
    // The 2026-08-25 reference activity's moving pace: 3:55 to 32:40 per
    // km. The axis's y-scale always pins its minimum to 0 (so a stop is
    // always on the axis), which is exactly the trap an earlier version
    // fell into: deriving the tick step from that clamped, near-infinite
    // "slowest pace" put 17 of 18 gridlines below 1.667 m/s and none in
    // this band at all.
    const fastest = speedFromPaceSeconds(235) // 3:55/km
    const slowest = speedFromPaceSeconds(1960) // 32:40/km

    const splits = paceAxisSplits(0, fastest)
    const nonZero = splits.filter((s) => s > 0)
    const inBand = nonZero.filter((s) => s >= slowest && s <= fastest)

    expect(nonZero.length).toBeGreaterThan(0)
    expect(inBand.length / nonZero.length).toBeGreaterThan(0.5)
  })

  it('nulls the series across a paused stretch, breaking the line uPlot draws', () => {
    const t = [0, 1, 2, 3, 4, 5]
    // Deliberately non-null everywhere: if the component only trusted the
    // caller's data instead of masking it itself, this test would pass for
    // the wrong reason.
    const values = [140, 141, 142, 143, 144, 145]
    const paused = [false, true, true, false, false, false]

    render(
      <StreamPanel channel="hr" t={t} values={values} paused={paused} outage={FLAT(6)} average={null} />,
    )

    const instance = lastInstance()
    expect(instance.data[1]).toEqual([140, null, null, 143, 144, 145])
  })

  it('also breaks the line across an outage, independently of paused', () => {
    const t = [0, 1, 2, 3]
    const values = [80, 81, 82, 83]
    const outage = [false, false, true, false]

    render(
      <StreamPanel channel="cadence" t={t} values={values} paused={FLAT(4)} outage={outage} average={null} />,
    )

    const instance = lastInstance()
    expect(instance.data[1]).toEqual([80, 81, null, 83])
  })

  it('produces one band per contiguous paused/outage run, matching the 2026-08-25 shape (19 s, 376 s)', () => {
    const length = 3000
    const t = Array.from({ length }, (_, i) => i)
    const paused = FLAT(length)
    const outage = FLAT(length)
    for (let i = 100; i < 100 + 19; i++) paused[i] = true
    for (let i = 500; i < 500 + 376; i++) paused[i] = true

    const bands = computePauseBands(t, paused, outage)

    expect(bands).toHaveLength(2)
    const first = bands[0]
    const second = bands[1]
    if (first === undefined || second === undefined) throw new Error('expected two bands')
    expect(first.endT - first.startT + 1).toBe(19)
    expect(second.endT - second.startT + 1).toBe(376)
  })

  it('draws the average line dashed at the given value, and puts its number in the heading rather than on the canvas', () => {
    const t = [0, 1, 2, 3, 4]
    const values = [140, 142, 144, 141, 143]

    render(
      <StreamPanel channel="hr" t={t} values={values} paused={FLAT(5)} outage={FLAT(5)} average={142} />,
    )

    const instance = lastInstance()
    const drawHooks = instance.opts.hooks?.drawAxes
    const hook = drawHooks?.[0]
    if (hook === undefined || typeof hook !== 'function') {
      throw new Error('no drawAxes hook was wired for the average line')
    }

    const fillText = vi.fn()
    // Every dash pattern this hook sets, in order, so the pattern in force
    // at the moment `stroke()` ran can be read back - the alternative is
    // asserting on the last value, which a trailing reset to `[]` would
    // make pass whether the line was dashed or not.
    const dashAtStroke: number[][] = []
    const dashPatterns: number[][] = []
    const fakeCtx = {
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {
        const current = dashPatterns[dashPatterns.length - 1]
        dashAtStroke.push(current === undefined ? [] : [...current])
      },
      fillRect: () => {},
      setLineDash: (pattern: number[]) => {
        dashPatterns.push([...pattern])
      },
      fillText,
      globalAlpha: 1,
      fillStyle: '',
      strokeStyle: '',
      textAlign: '',
      textBaseline: '',
    }
    const valToPos = vi.fn((_val: number, scale: string) => (scale === 'y' ? 55 : 0))
    const fakeU = {
      ctx: fakeCtx,
      bbox: { left: 0, top: 0, width: 100, height: 100 },
      valToPos,
    }

    hook(fakeU as unknown as uPlot)

    // Positioned at the given average value on the y scale.
    expect(valToPos).toHaveBeenCalledWith(142, 'y', true)

    // Dashed, and dashed *at the moment it was stroked*. This activity has
    // no pause, so the only stroke the hook makes is the average's.
    expect(dashAtStroke).toEqual([AVERAGE_DASH])

    // The number is not drawn on the canvas at all any more. It used to be,
    // at the plot's right edge two pixels above the line, and collided with
    // the trace on every run finishing near its own average.
    expect(fillText).not.toHaveBeenCalled()

    // It is in the DOM instead, beside the panel's heading, where a canvas
    // stroke cannot reach it.
    expect(screen.getByText('142 bpm')).toBeInTheDocument()

    // M5: the average line draws in the dim ink token, not full-strength
    // ink - `cssVar` is mocked above to echo the token name back, so a
    // caller that hands `backgroundHook` `--ink` where `--ink-dim` belongs
    // is directly observable here rather than reading the same on screen
    // either way.
    expect(fakeCtx.strokeStyle).toBe('--ink-dim')
  })

  it('renders no series and no average when the whole channel is null', () => {
    render(
      <StreamPanel
        channel="cadence"
        t={[0, 1, 2]}
        values={[null, null, null]}
        paused={FLAT(3)}
        outage={FLAT(3)}
        average={150}
      />,
    )

    expect(instances).toHaveLength(0)
    expect(screen.getByText(/no cadence recorded/i)).toBeInTheDocument()
    // I6: through the shared `Absent` component, not a component-local
    // `.empty` paragraph - `role="note"` is `Absent`'s own contract.
    expect(screen.getByRole('note')).toBeInTheDocument()
  })

  it('also renders the absence when every non-null sample falls inside a pause', () => {
    // The raw `values` are not all null - a check made before masking would
    // pass - but every sample that survives masking is, which is the fact
    // that should decide this.
    const t = [0, 1, 2]
    const values = [140, 141, 142]
    const paused = [true, true, true]

    render(
      <StreamPanel channel="hr" t={t} values={values} paused={paused} outage={FLAT(3)} average={140} />,
    )

    expect(instances).toHaveLength(0)
    expect(screen.getByText(/no heart rate recorded/i)).toBeInTheDocument()
  })

  describe('the pace y-scale range', () => {
    it('anchors at zero when the channel contains a pause', () => {
      const values = [3, 3, 3, 3]
      const paused = [false, true, false, false]
      const outage = [false, false, false, false]

      expect(containsNearZeroSpeed(values, paused, outage)).toBe(true)
      expect(paceYRange(values, paused, outage, 2.9, 3.1)).toEqual([0, 3.1])
    })

    it('anchors at zero when the channel contains an outage, independently of paused', () => {
      const values = [3, 3, 3, 3]
      const paused = [false, false, false, false]
      const outage = [false, false, true, false]

      expect(containsNearZeroSpeed(values, paused, outage)).toBe(true)
      expect(paceYRange(values, paused, outage, 2.9, 3.1)).toEqual([0, 3.1])
    })

    it('anchors at zero when a raw sample is below the stop threshold, even with no pause flag', () => {
      // A brief near-stop can be real without crossing the derived layer's
      // own 15 s gap rule, so `paused` never fires for it - the axis
      // should still reach zero for a moment this slow.
      const values = [3, 3, 0.2, 3]
      const paused = [false, false, false, false]
      const outage = [false, false, false, false]

      expect(containsNearZeroSpeed(values, paused, outage)).toBe(true)
      expect(paceYRange(values, paused, outage, 0.2, 3)).toEqual([0, 3])
    })

    it('crops to a padded range around the data instead of anchoring at zero when the channel has no stop', () => {
      const values = [2.7, 2.75, 2.8]
      const paused = [false, false, false]
      const outage = [false, false, false]

      expect(containsNearZeroSpeed(values, paused, outage)).toBe(false)
      const [lo, hi] = paceYRange(values, paused, outage, 2.7, 2.8)
      expect(lo).toBeGreaterThan(0)
      expect(lo).toBeLessThan(2.7)
      expect(hi).toBeGreaterThan(2.8)
    })

    it('never crops below zero, so a run with no stop is never given a "stop" gridline', () => {
      // An interval session with a walked segment: the slowest recorded
      // second is a 0.55 m/s walk, the fastest a 7 m/s stride. The pad is
      // a tenth of the span (0.645), which is larger than the minimum
      // itself, so an unclamped `dataMin - pad` is negative. That is not
      // just a meaningless negative speed - it puts `paceAxisSplits` back
      // on its `scaleMin <= 0` branch, which pushes a split at 0 that
      // `paceTick` labels `stop`, on the one run this branch has already
      // established never stopped.
      const values = [0.55, 7]
      const paused = [false, false]
      const outage = [false, false]

      expect(containsNearZeroSpeed(values, paused, outage)).toBe(false)
      const [lo, hi] = paceYRange(values, paused, outage, 0.55, 7)

      expect(lo).toBeGreaterThanOrEqual(STOP_SPEED_MPS)
      expect(lo).toBeLessThanOrEqual(0.55)
      expect(hi).toBeGreaterThan(7)
      expect(paceAxisSplits(lo, hi).map((split) => paceTick(split))).not.toContain('stop')
    })

    it('gives the cropped case substantially more than 4% of the panel for a genuinely even-paced run', () => {
      // A synthetic run shaped like the even-paced real one that exposed
      // this (no paused or outage seconds, speed coefficient of variation
      // 1.5%): moving speed spanning 2.5-2.8 m/s, with a 5th-to-95th-
      // percentile band of 2.65-2.78 m/s. Zero-anchoring this (the pre-fix
      // behaviour) gives (2.78 - 2.65) / 2.8 = 4.6% of the panel - the
      // exact defect this round exists to fix. This is a real threshold,
      // not a loose inequality, because "loose" would still pass for the
      // old, broken behaviour.
      const dataMin = 2.5
      const dataMax = 2.8
      const p5 = 2.65
      const p95 = 2.78
      const values = [dataMin, dataMax] // no sample below the stop threshold
      const paused = [false, false]
      const outage = [false, false]

      const [lo, hi] = paceYRange(values, paused, outage, dataMin, dataMax)
      const bandPercent = ((p95 - p5) / (hi - lo)) * 100

      expect(bandPercent).toBeGreaterThan(25)
    })
  })

  describe('the cropped pace axis places its gridlines where the run is', () => {
    it('keeps most gridlines inside the band, including the fast half, on a run with a walked recovery', () => {
      // The trace that exposed this: slowest recorded second a 0.8 m/s
      // walked recovery, fastest a 4.5 m/s stride, nothing under
      // STOP_SPEED_MPS, so the cropped branch runs. Deriving the step from
      // the *pace* span (2000 s at the bottom against 205 s at the top)
      // saturates at the 600 s fallback and puts gridlines at 0.556, 0.833
      // and 1.667 m/s - nothing at all in the 1.7-4.87 m/s band where the
      // running happened. That mutation fails both assertions below: it
      // lands 2 of 3 in the band and none above the midpoint.
      const dataMin = 0.8
      const dataMax = 4.5
      const values = [dataMin, 3.9, 4.2, dataMax]
      const paused = [false, false, false, false]
      const outage = [false, false, false, false]

      expect(containsNearZeroSpeed(values, paused, outage)).toBe(false)
      const [lo, hi] = paceYRange(values, paused, outage, dataMin, dataMax)
      const splits = paceAxisSplits(lo, hi)

      expect(splits.length).toBeGreaterThanOrEqual(4)

      const inBand = splits.filter((s) => s >= dataMin && s <= dataMax)
      expect(inBand.length / splits.length).toBeGreaterThan(0.5)

      // Not merely "inside the band": the fast half of the panel, where
      // this session's reps actually sat, must carry gridlines of its own.
      const midpoint = (dataMin + dataMax) / 2
      expect(splits.filter((s) => s >= midpoint).length).toBeGreaterThanOrEqual(2)
    })

    it('still picks the fine step the narrow even-paced run needed', () => {
      // The same even-paced shape (2.5-2.8 m/s, no stop): the case the
      // cropped branch was added for. The step has to stay fine enough to
      // place more than one gridline in a band only 0.3 m/s wide, which
      // is what the previous pace-span formulation got right and this must
      // not regress.
      const dataMin = 2.5
      const dataMax = 2.8
      const values = [dataMin, dataMax]
      const paused = [false, false]
      const outage = [false, false]

      const [lo, hi] = paceYRange(values, paused, outage, dataMin, dataMax)
      const splits = paceAxisSplits(lo, hi)

      expect(splits.filter((s) => s >= dataMin && s <= dataMax).length).toBeGreaterThanOrEqual(2)
      expect(splits.every((s) => s > lo && s <= hi)).toBe(true)
    })
  })

  describe('pace tick thinning', () => {
    /** Where a tick lands on a linear-in-speed axis of this height. */
    function yPx(speed: number, scaleMin: number, scaleMax: number, heightPx: number): number {
      return heightPx * (1 - (speed - scaleMin) / (scaleMax - scaleMin))
    }

    it('thins a crowded axis to a uniform stride rather than dropping whichever labels collide', () => {
      // The measured shape of 854fd775d479ca9f: a cropped range of
      // 1.132-3.002 m/s on a 140px plot, where the round-minute labels from
      // 6:00 down to 11:00 sit at successive gaps of 29.7, 22.3, 17.3, 13.8
      // and 11.4 px. Two of those collide at a 12px font.
      const lo = 1.132
      const hi = 3.002
      const height = 140

      const thinned = paceAxisSplits(lo, hi, height).map((split) => paceSecondsPerKm(split))

      // Every retained label is a round minute, and they step *evenly* -
      // this is the assertion that distinguishes a uniform stride from
      // greedy dropping, which on this exact input keeps 6:00, 7:00, 8:00,
      // 9:00 and 11:00: legible, and a ladder that skips 10:00 for no
      // reason a reader can see.
      const rounded = thinned.map((seconds) => Math.round(seconds))
      expect(rounded.length).toBeGreaterThanOrEqual(2)
      const steps = rounded.slice(1).map((seconds, i) => seconds - (rounded[i] ?? 0))
      expect(new Set(steps).size).toBe(1)
      expect(rounded.every((seconds) => seconds % 60 === 0)).toBe(true)
    })

    it('leaves every retained tick at least one label-height from its neighbour', () => {
      const lo = 1.132
      const hi = 3.002
      const height = 140

      const splits = paceAxisSplits(lo, hi, height)
      const ys = splits.map((speed) => yPx(speed, lo, hi, height)).sort((a, b) => a - b)
      const gaps = ys.slice(1).map((y, i) => y - (ys[i] ?? 0))

      // 14px is the constant in `streamPanelMath.ts`, one 12px em box plus
      // air. Asserted as a floor rather than by importing the constant, so
      // lowering the constant does not also lower the bar this checks it
      // against.
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(14)
    })

    it('keeps every tick when no height is supplied, so the pure function is unchanged without one', () => {
      // The parameter is optional and the two-argument form is what every
      // other caller and test in this file uses; thinning must be opt-in.
      const withoutHeight = paceAxisSplits(1.132, 3.002)
      const withHeight = paceAxisSplits(1.132, 3.002, 140)
      expect(withoutHeight.length).toBeGreaterThan(withHeight.length)
    })

    /**
     * The pace axis's own `splits` callback, as uPlot would call it: with a
     * `bbox.height` in *canvas* pixels for a plot of `cssHeightPx` CSS
     * pixels at the given device pixel ratio.
     */
    function splitsThroughThePanel(
      scaleMin: number,
      scaleMax: number,
      cssHeightPx: number,
      pixelRatio: number,
    ): number[] {
      const original = window.devicePixelRatio
      window.devicePixelRatio = pixelRatio
      try {
        instances.length = 0
        const { unmount } = render(
          <StreamPanel
            channel="pace"
            t={[0, 1]}
            values={[scaleMin, scaleMax]}
            paused={FLAT(2)}
            outage={FLAT(2)}
            average={null}
          />,
        )
        const yAxis = lastInstance().opts.axes?.[1]
        if (yAxis?.splits === undefined || typeof yAxis.splits !== 'function') {
          throw new Error('the pace axis has no dynamic split placer')
        }
        const fakeU = { bbox: { left: 0, top: 0, width: 100, height: cssHeightPx * pixelRatio } }
        const splits = yAxis.splits(fakeU as unknown as uPlot, 1, scaleMin, scaleMax, 0, 0)
        unmount()
        return splits
      } finally {
        window.devicePixelRatio = original
      }
    }

    it('thins the same axis identically on a HiDPI display, because the threshold is CSS pixels', () => {
      // The unit that crosses the boundary. `u.bbox.height` is canvas
      // pixels - uPlot scales the plot's CSS height by the device pixel
      // ratio when it computes `bbox` - while the separation the thinning
      // tests against is one 12px CSS em box plus air. Compared raw, every
      // gap on a ratio-2 display measures double, all of them clear the
      // threshold, nothing is thinned, and the bottom two labels overlap on
      // screen exactly as reported. Same range, same CSS height, so the
      // same labels must survive at either ratio.
      const lo = 1.132
      const hi = 3.002
      const cssHeight = 140

      const atOne = splitsThroughThePanel(lo, hi, cssHeight, 1)
      const atTwo = splitsThroughThePanel(lo, hi, cssHeight, 2)

      expect(atTwo).toEqual(atOne)
      // And thinning actually happened at both, rather than the two agreeing
      // because neither did anything.
      expect(atOne.length).toBeLessThan(paceAxisSplits(lo, hi).length)
    })

    it('never empties the axis, even on a height too small to separate any two labels', () => {
      // The invariant four separate defects on the previous branch came
      // from breaking. One tick is a poor axis; none is a broken one - and
      // exactly one is what this height can honestly carry, which is the
      // last-resort branch of the thinning rather than any stride it tried.
      const splits = paceAxisSplits(1.132, 3.002, 4)
      expect(splits).toHaveLength(1)
      expect(splits.every((speed) => Number.isFinite(speed))).toBe(true)
      // The fastest of the ladder, not an arbitrary survivor: at a height
      // this small the reader gets the one number the axis is anchored on.
      expect(paceTick(splits[0] ?? 0)).toBe('6:00')
    })
  })

  describe('the elevation channel', () => {
    // The gap this fills: the panel's own doc, the commit message and
    // `frontend.md` all state that the *fill* breaks at a pause rather than
    // closing across it - and nothing asserted it.
    //
    // Two contracts are tangled in that one sentence and only one is ours.
    // Ours: the channel is nulled at every masked second, and elevation opts
    // into a fill. uPlot's: a filled series is clipped to its non-gap
    // stretches - asserting that here would be testing uPlot. Verified at
    // source instead: `strokeFill` applies `gapsClip`, built by `clipGaps`
    // from what `findGaps` locates in the data, with `ctx.clip()` immediately
    // before `doFill`.

    it('opts into a fill, which the stroke-only channels do not', () => {
      const t = [0, 1, 2, 3, 4]
      render(
        <StreamPanel
          channel="elevation"
          t={t}
          values={[10, 12, 14, 13, 11]}
          paused={FLAT(5)}
          outage={FLAT(5)}
          average={null}
        />,
      )
      expect(lastInstance().opts.series[1]?.fill).toBeDefined()

      render(
        <StreamPanel
          channel="hr"
          t={t}
          values={[140, 142, 144, 141, 143]}
          paused={FLAT(5)}
          outage={FLAT(5)}
          average={null}
        />,
      )
      // A filled heart rate reads as an area under a curve, which is not a
      // quantity anybody has.
      expect(lastInstance().opts.series[1]?.fill).toBeUndefined()
    })

    /**
     * One altitude band per sign, all three of which the real store held
     * when measured on 2026-09-03, the positive one the reference fixture's.
     * The reason all three are here: a positive range renders
     * correctly under uPlot's *default* baseline too, so pinning that one
     * alone would keep passing for the wrong reason.
     */
    const ALTITUDE_BANDS: [number, number, string][] = [
      [-80.0, -60.0, 'a band entirely below zero'],
      [-20.0, 2.0, 'a band straddling zero'],
      [3.4, 28.0, '854fd775d479ca9f, entirely above zero'],
    ]

    /** The fill baseline the panel resolves for one band, through its own scale range and `fillTo`. */
    function fillBaselineFor(dataMin: number, dataMax: number): { baseline: number; min: number; max: number } {
      instances.length = 0
      render(
        <StreamPanel
          channel="elevation"
          t={[0, 1, 2, 3]}
          values={[dataMin, dataMax, dataMin, dataMax]}
          paused={FLAT(4)}
          outage={FLAT(4)}
          average={null}
        />,
      )

      const range = lastInstance().opts.scales?.y?.range
      if (typeof range !== 'function') throw new Error('the elevation scale has no range callback')
      const resolved = range(lastInstance() as unknown as uPlot, dataMin, dataMax, 'y')
      const [min, max] = resolved as [number, number]

      const fillTo = lastInstance().opts.series[1]?.fillTo
      if (typeof fillTo !== 'function') throw new Error('the elevation series has no fillTo callback')
      const baseline = fillTo({ scales: { y: { min, max } } } as unknown as uPlot, 1, dataMin, dataMax)

      return { baseline, min, max }
    }

    it('closes its fill at the panel floor, whatever the altitude sign', () => {
      // uPlot's default baseline for a linear scale is the literal value 0,
      // which is not a datum altitude is measured from - the same fact that
      // keeps this axis from being zero-anchored. Below sea level the
      // default fills upward to a line above the plot: the sky rather than
      // the ground, on a panel that exists because a fill reads as terrain.
      for (const [dataMin, dataMax, id] of ALTITUDE_BANDS) {
        const { baseline, min } = fillBaselineFor(dataMin, dataMax)
        expect(baseline, `${id} does not fill to its own panel floor`).toBeCloseTo(min, 5)
      }
    })

    it('does not leave that baseline at zero on the two bands where zero is visible or above the plot', () => {
      // What makes the assertion above more than a restatement of the
      // default. The first band's whole range sits below zero, so the
      // default baseline is off the top of the plot; the second straddles
      // it, so the default lands mid-panel with an empty strip beneath the
      // trace.
      const negative = fillBaselineFor(-80.0, -60.0)
      expect(negative.max).toBeLessThan(0)
      expect(negative.baseline).toBeLessThan(negative.max)

      const straddling = fillBaselineFor(-20.0, 2.0)
      expect(straddling.min).toBeLessThan(0)
      expect(straddling.max).toBeGreaterThan(0)
      expect(straddling.baseline).toBeLessThan(0)
      expect(straddling.baseline).not.toBe(0)
    })

    it('leaves the stroke-only channels without a baseline to resolve', () => {
      // `fillTo` travels with the fill: a channel that draws no fill has
      // nothing to close, and setting one would be dead configuration.
      render(
        <StreamPanel
          channel="hr"
          t={[0, 1, 2]}
          values={[140, 142, 144]}
          paused={FLAT(3)}
          outage={FLAT(3)}
          average={null}
        />,
      )
      expect(lastInstance().opts.series[1]?.fillTo).toBeUndefined()
    })

    it('hands uPlot nulls across a paused stretch, so the fill has a gap to break at', () => {
      // The shape of the fixture `6116b2e90f551a6c`, which carries 395 paused
      // seconds with altitude recorded across all 3714 of its samples: the
      // altimeter keeps reporting while the athlete stands still, so the
      // *raw* channel has no gap and the mask is the only thing that puts one
      // there. A closed fill over that stretch would paint the gap as if the
      // athlete were at ground level through it, which is the same class of
      // error as holding distance across a stop.
      render(
        <StreamPanel
          channel="elevation"
          t={[0, 1, 2, 3, 4, 5]}
          values={[10, 12, 14, 14, 14, 16]}
          paused={[false, false, true, true, false, false]}
          outage={FLAT(6)}
          average={null}
        />,
      )

      const [, series] = lastInstance().data
      expect(series).toEqual([10, 12, null, null, 14, 16])
    })

    it('gets no average line, unlike every other channel', () => {
      // A mean altitude is not a quantity anybody trains against, and a flat
      // line through the middle of a terrain profile would read as a target
      // rather than as arithmetic. `ActivityDetail` passes null; this pins
      // that the panel renders no legend for it rather than a stray dash.
      render(
        <StreamPanel
          channel="elevation"
          t={[0, 1, 2]}
          values={[20, 25, 30]}
          paused={FLAT(3)}
          outage={FLAT(3)}
          average={null}
        />,
      )
      expect(screen.queryByText(/^average/)).toBeNull()
    })
  })

  describe('hand-drawn constants and the pixel ratio', () => {
    /** Runs `fn` with `devicePixelRatio` pinned, then restores it. */
    function atRatio<T>(ratio: number, fn: () => T): T {
      const original = window.devicePixelRatio
      window.devicePixelRatio = ratio
      try {
        return fn()
      } finally {
        window.devicePixelRatio = original
      }
    }

    it('scales a dash pattern so it measures the same in CSS pixels at any ratio', () => {
      // A canvas draws in its backing store's pixels and uPlot sizes that
      // store at the device ratio, so a raw constant halves on a HiDPI
      // display. Measured before the fix by intercepting `setLineDash` in a
      // real browser: `[6, 4]` arrived unchanged at both ratio 1 and 2.
      expect(atRatio(1, () => scaleDash(AVERAGE_DASH))).toEqual([6, 4])
      expect(atRatio(2, () => scaleDash(AVERAGE_DASH))).toEqual([12, 8])
      expect(atRatio(3, () => scaleDash(PAUSE_BAND_DASH))).toEqual([12, 9])
    })

    it('leaves the constants themselves in CSS pixels, comparable with the font sizes', () => {
      // Not pre-scaled. They were chosen against uPlot's 12px axis font and
      // the panel's own type, and they have to stay readable beside those.
      expect(AVERAGE_DASH).toEqual([6, 4])
      expect(PAUSE_BAND_DASH).toEqual([4, 3])
    })

    it('falls back to 1 where the platform has no usable ratio', () => {
      // A headless environment can leave it undefined or zero, and either
      // one turns a finite measurement into a meaningless one.
      expect(atRatio(0, () => cssPixelRatio())).toBe(1)
      expect(atRatio(Number.NaN, () => cssPixelRatio())).toBe(1)
      expect(atRatio(-2, () => cssPixelRatio())).toBe(1)
    })

    it('draws the average dashed at twice the pattern on a HiDPI display', () => {
      // The end-to-end version of the two assertions above: what actually
      // reaches the context, through the real hook.
      const drawn = atRatio(2, () => {
        instances.length = 0
        render(
          <StreamPanel
            channel="hr"
            t={[0, 1, 2]}
            values={[140, 142, 144]}
            paused={FLAT(3)}
            outage={FLAT(3)}
            average={142}
          />,
        )
        const hook = lastInstance().opts.hooks?.drawAxes?.[0]
        if (hook === undefined || typeof hook !== 'function') {
          throw new Error('no drawAxes hook was wired')
        }
        const dashes: number[][] = []
        const ctx = {
          save: () => {},
          restore: () => {},
          beginPath: () => {},
          moveTo: () => {},
          lineTo: () => {},
          stroke: () => {},
          fillRect: () => {},
          setLineDash: (pattern: number[]) => dashes.push([...pattern]),
          fillText: () => {},
          globalAlpha: 1,
          fillStyle: '',
          strokeStyle: '',
          textAlign: '',
          textBaseline: '',
        }
        hook({
          ctx,
          bbox: { left: 0, top: 0, width: 200, height: 200 },
          valToPos: () => 100,
        } as unknown as uPlot)
        return dashes
      })

      // Twice the CSS pattern, which is the same length on screen.
      expect(drawn).toContainEqual([12, 8])
      expect(drawn).not.toContainEqual([6, 4])
    })

    it('strokes its own lines at its own width rather than at whatever uPlot last set', () => {
      // `ctx.save()` preserves the context's state, it does not reset it,
      // and uPlot fires `drawAxes` straight after drawing each axis grid at
      // `grid.width * pxRatio` with `grid.width` defaulting to 2. So an
      // unset `lineWidth` here inherited 2 CSS px - heavier than the 1.5 px
      // series being annotated - and its unit was uPlot's business rather
      // than this module's. Measured in CSS pixels, the width now has to
      // come out the same at either ratio, which is the same contract the
      // dash assertions above hold.
      const widthsInCssPx = [1, 2, 3].map((ratio) =>
        atRatio(ratio, () => {
          instances.length = 0
          render(
            <StreamPanel
              channel="hr"
              t={[0, 1, 2, 3]}
              values={[140, 142, 144, 146]}
              paused={[false, true, true, false]}
              outage={FLAT(4)}
              average={143}
            />,
          )
          const hook = lastInstance().opts.hooks?.drawAxes?.[0]
          if (hook === undefined || typeof hook !== 'function') {
            throw new Error('no drawAxes hook was wired')
          }
          // uPlot's own last write before the hook fires: the grid at
          // `grid.width * pxRatio`. An inherited width shows up as this
          // value surviving into every stroke.
          const strokeWidths: number[] = []
          const ctx = {
            lineWidth: 2 * ratio,
            save: () => {},
            restore: () => {},
            beginPath: () => {},
            moveTo: () => {},
            lineTo: () => {},
            stroke: () => strokeWidths.push(ctx.lineWidth),
            fillRect: () => {},
            setLineDash: () => {},
            fillText: () => {},
            globalAlpha: 1,
            fillStyle: '',
            strokeStyle: '',
            textAlign: '',
            textBaseline: '',
          }
          hook({
            ctx,
            bbox: { left: 0, top: 0, width: 200, height: 200 },
            valToPos: () => 100,
          } as unknown as uPlot)
          // Both the pause band's boundaries and the average line.
          expect(strokeWidths.length).toBeGreaterThanOrEqual(2)
          return strokeWidths.map((width) => width / ratio)
        }),
      )

      for (const perRatio of widthsInCssPx) {
        for (const cssPx of perRatio) expect(cssPx).toBeCloseTo(ANNOTATION_LINE_WIDTH_PX, 5)
      }
    })

    it('keeps the annotation lighter than the series it annotates', () => {
      // 1 CSS px against the 1.5 px stroke `StreamPanel` gives the data
      // series. An annotation heavier than its data reads as a second
      // series drawn flat, which is the fault the dash fixed by other
      // means.
      render(
        <StreamPanel
          channel="hr"
          t={[0, 1, 2]}
          values={[140, 142, 144]}
          paused={FLAT(3)}
          outage={FLAT(3)}
          average={142}
        />,
      )

      const seriesWidth = lastInstance().opts.series[1]?.width
      expect(seriesWidth).toBe(1.5)
      expect(ANNOTATION_LINE_WIDTH_PX).toBeLessThan(seriesWidth ?? 0)
    })
  })

  describe('elevationYRange', () => {
    it('crops to the run\'s own band and never anchors at zero', () => {
      // Altitude is a position on a scale with an arbitrary origin, not a
      // magnitude from zero. The reference activity's samples span a
      // 24.6 m band; on a sea-level axis that is a flat line.
      const [lo, hi] = elevationYRange(3.4, 28.0)
      expect(lo).toBeGreaterThan(0)
      expect(lo).toBeCloseTo(3.4 - 2.46, 5)
      expect(hi).toBeCloseTo(28.0 + 2.46, 5)
    })

    it('keeps a below-sea-level band below sea level rather than clamping it up', () => {
      const [lo, hi] = elevationYRange(-12, -4)
      expect(lo).toBeLessThan(-12)
      expect(hi).toBeLessThan(0)
    })

    it('widens a flat band instead of returning a degenerate scale', () => {
      // A treadmill, or a device reporting one constant. A zero-width
      // range would make the scale degenerate and the series undrawable.
      const [lo, hi] = elevationYRange(15, 15)
      expect(hi - lo).toBeGreaterThan(0)
      expect(lo).toBeLessThan(15)
      expect(hi).toBeGreaterThan(15)
    })

    /**
     * uPlot's own y-axis tick spacing, `yAxisOpts.space`, and the plot
     * height this panel measures at its 12.5rem container - 142 CSS px,
     * read off `u.bbox.height / devicePixelRatio` in Chromium.
     *
     * Together they bound the tick increment from below: uPlot never
     * places ticks closer than `space`, so whatever nice number it picks
     * is at least `span * space / plotHeight`. That is all this test needs
     * - if the *smallest* increment uPlot could choose is a whole metre,
     * no two `Math.round`ed labels can collide, whichever coarser
     * increment it actually lands on.
     */
    const Y_AXIS_TICK_SPACE_PX = 30
    const PLOT_HEIGHT_CSS_PX = 142

    /**
     * Bands of the three widths the real store's altitude bands under 3 m
     * had when measured on 2026-09-03, recorded at a synthetic height.
     */
    const NARROW_BANDS: [number, number, string][] = [
      [50.0, 50.6, 'the 0.6 m band'],
      [49.0, 50.4, 'the 1.4 m band'],
      [48.0, 50.4, 'the 2.4 m band'],
    ]

    it('never hands the axis a band so narrow that uPlot has to pick a sub-metre increment', () => {
      // The fault a test on the exactly-zero case alone could not see. At
      // the padded 0.72 m range the 0.6 m band used to get, the smallest
      // increment uPlot could choose is 0.15 m, and on the real run its
      // four labels came out as three copies of one integer and the next
      // in Chromium.
      for (const [dataMin, dataMax, id] of [...NARROW_BANDS, [62.0, 63.0, 'the 1 m band'] as const]) {
        const [lo, hi] = elevationYRange(dataMin, dataMax)
        const smallestIncrementM = ((hi - lo) * Y_AXIS_TICK_SPACE_PX) / PLOT_HEIGHT_CSS_PX
        expect(smallestIncrementM, `${String(id)} can still be labelled in sub-metre steps`).toBeGreaterThanOrEqual(1)
      }
    })

    it('renders a distinct label for every gridline of a near-flat run', () => {
      // Through the panel's own axis formatter rather than around it, on
      // the *densest* tick set uPlot could choose for the range: ticks one
      // minimum increment apart. Any nice number it actually lands on is
      // coarser than that, so distinct labels here mean distinct labels on
      // screen. At the padded 0.72 m range the 0.6 m band used to get,
      // that increment is 0.15 m and every tick in it rounds to 50 or 51.
      for (const [dataMin, dataMax, id] of NARROW_BANDS) {
        instances.length = 0
        render(
          <StreamPanel
            channel="elevation"
            t={[0, 1, 2, 3]}
            values={[dataMin, dataMax, dataMin, dataMax]}
            paused={FLAT(4)}
            outage={FLAT(4)}
            average={null}
          />,
        )

        const [lo, hi] = elevationYRange(dataMin, dataMax)
        const increment = ((hi - lo) * Y_AXIS_TICK_SPACE_PX) / PLOT_HEIGHT_CSS_PX
        const ticks: number[] = []
        for (let tick = lo; tick <= hi; tick += increment) ticks.push(tick)
        expect(ticks.length).toBeGreaterThan(2)

        const values = lastInstance().opts.axes?.[1]?.values
        if (typeof values !== 'function') throw new Error('the elevation axis has no values formatter')
        const labels = values(lastInstance() as unknown as uPlot, ticks, 1, 0, increment) as string[]

        expect(labels).toHaveLength(ticks.length)
        expect(new Set(labels).size, `${id} repeats a label down its axis`).toBe(labels.length)
      }
    })

    it('leaves a band wider than the floor exactly where the padding put it', () => {
      // No step where the two rules meet: 8.5 m pads to 10.2 m, which is
      // already past the floor, so the floor must not pull it back to 10.
      const [lo, hi] = elevationYRange(20, 28.5)
      expect(hi - lo).toBeCloseTo(8.5 * 1.2, 5)
      expect(lo).toBeCloseTo(20 - 0.85, 5)
      expect(hi).toBeCloseTo(28.5 + 0.85, 5)
    })

    it('centres a widened band on the data rather than shifting it', () => {
      // A 0.6 m band recorded at 50 m has to stay a run at 50 m.
      const [lo, hi] = elevationYRange(50.0, 50.6)
      expect((lo + hi) / 2).toBeCloseTo(50.3, 5)
      expect(hi - lo).toBeCloseTo(MIN_ELEVATION_BAND_M, 5)
    })
  })

  describe('paceAxisSplits guards', () => {
    it('returns the single value rather than an empty array when scaleMin equals scaleMax', () => {
      const splits = paceAxisSplits(2.5, 2.5)
      expect(splits).toEqual([2.5])
    })

    it('labels at least one gridline, inside the range, for a displayed band of any width', () => {
      // The invariant the panel actually needs, asserted across widths
      // rather than on one instance: a pace axis with no gridline at all
      // is the degenerate case of the defect the cropped branch exists to
      // fix, and it fails silently - nothing throws, the panel simply
      // renders unlabelled.
      //
      // The narrow cases here all came back empty before this round.
      // `NICE_PACE_STEPS_S` began at 15 s/km, so a band spanning less
      // than that got its raw step rounded *up* past the whole band:
      // 2.78-2.80 m/s spans 3.1 s/km, the first candidate pace of 360
      // s/km sits at 2.7778 m/s just below `scaleMin`, and every later
      // candidate is slower still.
      //
      // `least` is per range because "non-empty" alone is too weak to pin
      // the fix: the midpoint fallback would satisfy it on its own.
      // Restoring the 15 s/km floor to the ladder drops the first three
      // ranges to that single fallback tick and fails their `least` of 2.
      // The last two ranges are the fallback's own cases - their spans are
      // 0.03 and 0 s/km, so no whole second of pace lies strictly inside
      // either - and deleting the fallback empties both, failing `least`
      // of 1. Between them the two mutations cover every line the fix
      // added.
      const ranges: { lo: number; hi: number; least: number }[] = [
        // The traced near-constant-pace run, 2.78-2.80 m/s of data.
        { lo: 2.778, hi: 2.802, least: 2 },
        { lo: 3.2, hi: 3.3, least: 2 },
        { lo: 2.75, hi: 2.85, least: 2 },
        // The 2.547-2.855 m/s even-paced reference run, padded.
        { lo: 2.5162, hi: 2.8858, least: 2 },
        // The walked-recovery run, padded.
        { lo: 0.5, hi: 4.87, least: 4 },
        // Narrower than the finest step on the ladder, and the degenerate
        // single-sample range: one honest gridline is all either can carry.
        { lo: 2.7999, hi: 2.8001, least: 1 },
        { lo: 2.5, hi: 2.5, least: 1 },
      ]

      for (const { lo, hi, least } of ranges) {
        const splits = paceAxisSplits(lo, hi)
        expect(splits.length, `range ${lo}-${hi}`).toBeGreaterThanOrEqual(least)
        expect(
          splits.every((split) => split >= lo && split <= hi),
          `range ${lo}-${hi} produced ${JSON.stringify(splits)}`,
        ).toBe(true)
      }
    })

    it('never returns an empty split set, at any width, anywhere paceYRange can put the range', () => {
      // The plain invariant, swept rather than sampled: three separate
      // narrow-range shapes have slipped through instance-by-instance
      // tests on this branch, so this asserts the property itself over
      // every combination of a plausible range bottom and a width from
      // degenerate to a whole run's worth of speed. `paceYRange` floors a
      // cropped bottom at STOP_SPEED_MPS and anchors at 0 otherwise, so
      // these bottoms are the ones it can actually hand over.
      //
      // Deleting the midpoint fallback fails this at the three narrowest
      // widths; restoring a 15 s/km floor to `NICE_PACE_STEPS_S` does not
      // (the fallback covers it), which is why the table-driven test
      // above keeps its per-range `least` floors.
      const bottoms = [STOP_SPEED_MPS, 0.8, 1.5, 2.8, 4.5, 6]
      const widths = [0, 1e-6, 0.0002, 0.002, 0.024, 0.1, 0.31, 1, 4.37]

      for (const lo of bottoms) {
        for (const width of widths) {
          const hi = lo + width
          const splits = paceAxisSplits(lo, hi)
          expect(splits.length, `range ${lo}-${hi}`).toBeGreaterThanOrEqual(1)
          expect(
            splits.every((split) => split >= lo && split <= hi),
            `range ${lo}-${hi} produced ${JSON.stringify(splits)}`,
          ).toBe(true)
        }
      }

      // The zero-anchored branch, which `paceYRange` takes whenever the
      // run holds a real stop: every split must still sit in the range,
      // and the stop tick at 0 is one of them.
      for (const hi of [0.06, 1, 2.855, 7]) {
        const splits = paceAxisSplits(0, hi)
        expect(splits.length, `range 0-${hi}`).toBeGreaterThanOrEqual(1)
        expect(
          splits.every((split) => split >= 0 && split <= hi),
          `range 0-${hi} produced ${JSON.stringify(splits)}`,
        ).toBe(true)
      }
    })

    it('does not produce an absurd label from a single near-zero sample', () => {
      // 1000 / 0.001 is a 16:40:00 kilometre - the original pathology this
      // guards against, reproducible with no real activity involved.
      const splits = paceAxisSplits(0, 0.001)
      const labels = splits.map((s) => paceTick(s))
      for (const label of labels) {
        // No colon-separated value should run past a sane number of
        // minutes - the point is that nothing like "16680:00" appears.
        if (label === 'stop') continue
        const minutes = Number(label.split(':')[0])
        expect(minutes).toBeLessThan(500)
      }
    })
  })

  describe('the moment', () => {
    it('shows the value at the moment in place of the average', () => {
      const t = [0, 1, 2]
      const values = [3, 3.2, 3.4]
      const store = renderWithMoment(
        <StreamPanel channel="pace" t={t} values={values} paused={FLAT(3)} outage={FLAT(3)} average={3} />,
      )

      expect(screen.getByText(pace(3))).toBeInTheDocument()
      expect(screen.queryByText(pace(3.2))).toBeNull()

      act(() => store.setPointer(1))
      expect(screen.getByText(pace(3.2))).toBeInTheDocument()
      // The bare average value is no longer its own element - it survives
      // only folded into the sr-only "average <value>" text asserted below.
      expect(screen.queryByText(pace(3), { exact: true })).toBeNull()

      act(() => store.setPointer(null))
      expect(screen.getByText(pace(3))).toBeInTheDocument()
      expect(screen.queryByText(pace(3.2))).toBeNull()
    })

    it('says stopped for a paused second', () => {
      const t = [0, 1, 2]
      const values = [140, 141, 142]
      const paused = [false, true, false]
      const store = renderWithMoment(
        <StreamPanel channel="hr" t={t} values={values} paused={paused} outage={FLAT(3)} average={141} />,
      )

      act(() => store.setPointer(1))
      expect(screen.getByText('stopped')).toBeInTheDocument()
    })

    it('shows the no-value mark for a missing value outside a stop', () => {
      const t = [0, 1, 2]
      const values = [3, null, 3]
      const store = renderWithMoment(
        <StreamPanel channel="pace" t={t} values={values} paused={FLAT(3)} outage={FLAT(3)} average={3} />,
      )

      act(() => store.setPointer(1))
      expect(screen.getByText(NO_VALUE)).toBeInTheDocument()
    })

    it('moves its cursor to a moment set elsewhere, with fireHook false so its own hook never fires', () => {
      const t = [0, 1, 2]
      const values = [3, 3.2, 3.4]
      const store = renderWithMoment(
        <StreamPanel channel="pace" t={t} values={values} paused={FLAT(3)} outage={FLAT(3)} average={null} />,
      )
      const instance = lastInstance()

      act(() => store.setReplay(2))
      // valToPos is mocked as v * 10, so t[2] (= 2) lands at 20.
      expect(instance.setCursorCalls.at(-1)?.left).toBe(20)
      expect(instance.setCursorCalls.at(-1)?.fireHook).toBe(false)

      act(() => store.setReplay(null))
      expect(instance.setCursorCalls.at(-1)?.left).toBe(-10)
      expect(instance.setCursorCalls.at(-1)?.fireHook).toBe(false)

      // Placing the cursor programmatically never routes back through
      // `setPointer` - only a native pointer event (see the tests below)
      // does that.
      expect(store.getSnapshot().pointer).toBeNull()
    })

    it('never wires a setCursor hook at all - the moment comes from native pointer events instead', () => {
      // Measured directly against uPlot 1.6.32 across three rounds of this
      // fix: that hook fires from far more than a real pointer move
      // (construction, setData, a scale change), it can replay an
      // already-stale `cursor.event`, and a held-button drag out of the
      // panel is a case it gets wrong that a native `pointerleave` gets
      // right by construction (see the tests below and StreamPanel.tsx's
      // own comment on `onChart`). So there is nothing here to guard - the
      // hook itself is gone.
      const t = [0, 1, 2]
      const values = [140, 141, 142]
      renderWithMoment(
        <StreamPanel channel="hr" t={t} values={values} paused={FLAT(3)} outage={FLAT(3)} average={null} />,
      )
      expect(lastInstance().opts.hooks?.setCursor).toBeUndefined()
    })

    it('reports the pointer through a native pointermove on the chart, for a mouse or pen', () => {
      const t = [0, 1, 2]
      const values = [140, 141, 142]
      const store = renderWithMoment(
        <StreamPanel channel="hr" t={t} values={values} paused={FLAT(3)} outage={FLAT(3)} average={null} />,
      )
      const instance = lastInstance()

      const move = new PointerEvent('pointermove', { pointerType: 'mouse' })
      Object.defineProperty(move, 'offsetX', { value: 20 })
      act(() => {
        instance.over.dispatchEvent(move)
      })
      // posToIdx is mocked as round(left / 10): 20 lands on index 2.
      expect(store.getSnapshot().pointer).toBe(2)

      act(() => {
        instance.over.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }))
      })
      expect(store.getSnapshot().pointer).toBeNull()
    })

    it('clears the pointer on a native pointerleave even with the mouse button still held, dragged out of the panel', () => {
      // The exact case a `setCursor`-hook-driven moment got wrong (measured
      // against uPlot 1.6.32 in a browser): with a button held,
      // `mouseLeave` reports the drag's edge-snapped position before it
      // reports the actual leave, so a guard keyed on that hook's own
      // `cursor.idx`/`cursor.event` forwarded the first and dropped the
      // second, leaving the moment stuck at the last sample. A native
      // `pointerleave` carries no such ambiguity - it always means "gone".
      const t = [0, 1, 2]
      const values = [140, 141, 142]
      const store = renderWithMoment(
        <StreamPanel channel="hr" t={t} values={values} paused={FLAT(3)} outage={FLAT(3)} average={null} />,
      )
      const instance = lastInstance()

      const down = new PointerEvent('pointerdown', { pointerType: 'mouse' })
      Object.defineProperty(down, 'offsetX', { value: 10 })
      act(() => instance.over.dispatchEvent(down))

      const move = new PointerEvent('pointermove', { pointerType: 'mouse' })
      Object.defineProperty(move, 'offsetX', { value: 15 })
      act(() => instance.over.dispatchEvent(move))
      expect(store.getSnapshot().pointer).toBe(2)

      act(() => {
        instance.over.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }))
      })
      expect(store.getSnapshot().pointer).toBeNull()
    })

    it('does not place the cursor until the chart reports ready, since valToPos is unusable before then', () => {
      // Mirrors uPlot 1.6.32's own lifecycle, confirmed directly against
      // it: `valToPos` returns `Infinity` before the chart's first commit
      // sets up its x scale, and `status` does not become 1 until the
      // moment its `ready` hook fires. Calling `setCursor` with a position
      // computed from that `Infinity` is what put the hover dot on the
      // plot's right edge, over the last sample, on a chart rebuilt while a
      // moment was already active.
      const t = [0, 1, 2]
      const values = [3, 3.2, 3.4]
      const store = renderWithMoment(
        <StreamPanel channel="pace" t={t} values={values} paused={FLAT(3)} outage={FLAT(3)} average={null} />,
      )
      const instance = lastInstance()
      instance.status = 0
      instance.setCursorCalls.length = 0

      act(() => store.setPointer(1))
      // The reactive placement effect still ran - it always does, on every
      // moment change - but `placeCursor`'s own guard skipped the actual
      // `setCursor` call rather than handing uPlot a position computed
      // from an unusable `valToPos`.
      expect(instance.setCursorCalls).toHaveLength(0)

      const readyHook = instance.opts.hooks?.ready?.[0]
      if (readyHook === undefined || typeof readyHook !== 'function') {
        throw new Error('no ready hook was wired')
      }
      act(() => {
        instance.status = 1
        readyHook(instance as unknown as uPlot)
      })

      // valToPos is mocked as v * 10 once ready, so t[1] (= 1) lands at 10.
      expect(instance.setCursorCalls.at(-1)?.left).toBe(10)
    })

    it('places a newly (re)built chart at the current moment, not only a freshly mounted one', () => {
      // `UPlot.tsx` tears down and reconstructs the whole instance whenever
      // `options` changes - here, a changed `average` - and the placement
      // effect keyed on `[index, t]` does not rerun on its own for that,
      // since neither changed. The chart still has to come up showing the
      // moment that was already active, which is the fresh instance's own
      // `ready` hook's job now (see `placeCursor`'s comment on why `onChart`
      // itself cannot do this any more).
      const t = [0, 1, 2]
      const values = [140, 141, 142]
      let captured: MomentStore | null = null
      function Capture() {
        const store = useMomentStore()
        useEffect(() => {
          captured = store
        })
        return null
      }
      const { rerender } = render(
        <MomentProvider>
          <Capture />
          <StreamPanel channel="hr" t={t} values={values} paused={FLAT(3)} outage={FLAT(3)} average={100} />
        </MomentProvider>,
      )
      if (captured === null) throw new Error('no moment store was provided')
      const store: MomentStore = captured

      act(() => store.setPointer(1))
      const firstInstanceCount = instances.length

      rerender(
        <MomentProvider>
          <Capture />
          <StreamPanel channel="hr" t={t} values={values} paused={FLAT(3)} outage={FLAT(3)} average={101} />
        </MomentProvider>,
      )

      expect(instances.length).toBeGreaterThan(firstInstanceCount)
      const rebuilt = lastInstance()
      // valToPos is mocked as v * 10, so t[1] (= 1) lands at 10.
      expect(rebuilt.setCursorCalls.at(-1)?.left).toBe(10)
    })

    it("suppresses the touch pointerdown's compatibility mouse events with preventDefault", () => {
      // Per the Pointer Events spec, `preventDefault()` on `pointerdown` is
      // what stops a touch browser from also sending mousedown/mousemove/
      // mouseup for the same gesture - the exact compatibility mousemove
      // that used to reach uPlot's own listener on `over` after our
      // `pointerup` had already cleared the moment, setting it right back.
      const t = [0, 1, 2]
      const values = [140, 141, 142]
      const store = renderWithMoment(
        <StreamPanel channel="hr" t={t} values={values} paused={FLAT(3)} outage={FLAT(3)} average={null} />,
      )
      const instance = lastInstance()

      const down = new PointerEvent('pointerdown', { pointerType: 'touch', cancelable: true })
      Object.defineProperty(down, 'offsetX', { value: 20 })
      act(() => {
        instance.over.dispatchEvent(down)
      })

      expect(down.defaultPrevented).toBe(true)
      // A plain tap, with no sideways travel yet, picks nothing.
      expect(store.getSnapshot().pointer).toBeNull()
    })

    it('picks the moment from a touch drag once it has moved sideways more than vertically', () => {
      const t = [0, 1, 2]
      const values = [140, 141, 142]
      const store = renderWithMoment(
        <StreamPanel channel="hr" t={t} values={values} paused={FLAT(3)} outage={FLAT(3)} average={null} />,
      )
      const instance = lastInstance()

      act(() => instance.over.dispatchEvent(touchEvent('pointerdown', 10, 100, 10)))
      // Within the slop: still possibly a scroll swipe.
      act(() => instance.over.dispatchEvent(touchEvent('pointermove', 13, 101, 13)))
      expect(store.getSnapshot().pointer).toBeNull()

      // posToIdx is mocked as round(left / 10): 20 lands on index 2.
      act(() => instance.over.dispatchEvent(touchEvent('pointermove', 20, 102, 20)))
      expect(store.getSnapshot().pointer).toBe(2)

      // Once dragging, a move with more vertical than sideways travel still follows.
      act(() => instance.over.dispatchEvent(touchEvent('pointermove', 10, 130, 10)))
      expect(store.getSnapshot().pointer).toBe(1)

      act(() => instance.over.dispatchEvent(touchEvent('pointerup', 10, 130, 10)))
      expect(store.getSnapshot().pointer).toBeNull()
    })

    it('clears the moment when the dragging finger lifts, whatever a second finger does meanwhile', () => {
      const t = [0, 1, 2]
      const values = [140, 141, 142]
      const store = renderWithMoment(
        <StreamPanel channel="hr" t={t} values={values} paused={FLAT(3)} outage={FLAT(3)} average={null} />,
      )
      const instance = lastInstance()

      act(() => instance.over.dispatchEvent(touchEvent('pointerdown', 10, 100, 10, 1)))
      act(() => instance.over.dispatchEvent(touchEvent('pointermove', 20, 100, 20, 1)))
      expect(store.getSnapshot().pointer).toBe(2)

      // A second finger lands and drags sideways: it does not take over.
      act(() => instance.over.dispatchEvent(touchEvent('pointerdown', 0, 100, 0, 2)))
      act(() => instance.over.dispatchEvent(touchEvent('pointermove', 10, 100, 10, 2)))
      expect(store.getSnapshot().pointer).toBe(2)

      act(() => instance.over.dispatchEvent(touchEvent('pointerup', 20, 100, 20, 1)))
      expect(store.getSnapshot().pointer).toBeNull()

      act(() => instance.over.dispatchEvent(touchEvent('pointerup', 10, 100, 10, 2)))
      expect(store.getSnapshot().pointer).toBeNull()

      // With both lifted, a fresh drag picks the moment again.
      act(() => instance.over.dispatchEvent(touchEvent('pointerdown', 0, 100, 0, 3)))
      act(() => instance.over.dispatchEvent(touchEvent('pointermove', 10, 100, 10, 3)))
      expect(store.getSnapshot().pointer).toBe(1)
    })

    it('never sets the moment or pauses a playing replay on a vertical scroll swipe that starts on a chart', () => {
      vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
      try {
        const t = Array.from({ length: 121 }, (_, i) => i)
        const values = t.map((i) => 140 + i / 10)
        const grid = { t, paused: FLAT(121), outage: FLAT(121) }
        let replay: Replay | null = null
        function Replayer() {
          const current = useReplay(grid, useMomentStore())
          useEffect(() => {
            replay = current
          })
          return null
        }
        const store = renderWithMoment(
          <>
            <Replayer />
            <StreamPanel channel="hr" t={t} values={values} paused={grid.paused} outage={grid.outage} average={null} />
          </>,
        )
        const instance = lastInstance()
        const started = (): Replay => {
          if (replay === null) throw new Error('no replay was rendered')
          return replay
        }

        act(() => started().play())
        act(() => {
          vi.advanceTimersByTime(100)
        })
        expect(started().status).toBe('playing')

        // A swipe up the page: the browser sends a few mostly vertical
        // moves, then takes the gesture over with a pointercancel.
        act(() => instance.over.dispatchEvent(touchEvent('pointerdown', 50, 300, 50)))
        act(() => instance.over.dispatchEvent(touchEvent('pointermove', 52, 290, 52)))
        act(() => instance.over.dispatchEvent(touchEvent('pointermove', 55, 270, 55)))
        expect(store.getSnapshot().pointer).toBeNull()
        act(() => instance.over.dispatchEvent(touchEvent('pointercancel', 55, 270, 55)))

        expect(store.getSnapshot().pointer).toBeNull()
        expect(started().status).toBe('playing')
        act(() => {
          vi.advanceTimersByTime(100)
        })
        expect(started().status).toBe('playing')
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps the average for assistive technology while a value shows', () => {
      const t = [0, 1, 2]
      const values = [3, 3.2, 3.4]
      const store = renderWithMoment(
        <StreamPanel channel="pace" t={t} values={values} paused={FLAT(3)} outage={FLAT(3)} average={3} />,
      )

      act(() => store.setPointer(1))

      const value = screen.getByText(pace(3.2))
      expect(value).toHaveAttribute('aria-hidden', 'true')
      expect(screen.getByText(`average ${pace(3)}`)).toBeInTheDocument()
    })

    it('renders no dash swatch beside a hovered elevation value, which has no average line to swatch', () => {
      // Elevation's average is always null (`streamAverage` in
      // ActivityDetail.tsx never gives it one), so the swatch - which marks
      // the dashed *average* line - must never appear here at all: not at
      // rest (no average line covered that already) and not while hovering,
      // where it would key a dashed line this chart never draws.
      const t = [0, 1, 2]
      const values = [10, 12, 14]
      const store = renderWithMoment(
        <StreamPanel channel="elevation" t={t} values={values} paused={FLAT(3)} outage={FLAT(3)} average={null} />,
      )

      act(() => store.setPointer(1))

      expect(screen.getByText(formatAverage('elevation', 12))).toBeInTheDocument()
      expect(document.querySelector('[class*="dash"]')).toBeNull()
    })

    it('renders no dash swatch beside a hovered value on a channel that does have an average line', () => {
      // The swatch marks the dashed average line specifically - beside the
      // hovered value it would mislabel that value as the average, which is
      // the defect this fixes on every channel, not only elevation.
      const t = [0, 1, 2]
      const values = [140, 141, 142]
      const store = renderWithMoment(
        <StreamPanel channel="hr" t={t} values={values} paused={FLAT(3)} outage={FLAT(3)} average={141} />,
      )

      act(() => store.setPointer(1))

      expect(document.querySelector('[class*="dash"]')).toBeNull()

      act(() => store.setPointer(null))
      expect(document.querySelector('[class*="dash"]')).not.toBeNull()
    })

    it('puts its cursor back at the replay head after the pointer leaves, once uPlot has hidden it', () => {
      // A browser fires `pointerleave` and then `mouseleave`. The first
      // clears the pointer and the cursor moves to the replay's head; the
      // second is uPlot's own, and hides the cursor again, so the chart the
      // pointer left was the one chart without a line.
      const t = [0, 1, 2]
      const values = [140, 141, 142]
      const store = renderWithMoment(
        <StreamPanel channel="hr" t={t} values={values} paused={FLAT(3)} outage={FLAT(3)} average={null} />,
      )
      const instance = lastInstance()
      act(() => store.setReplay(2))

      const move = new PointerEvent('pointermove', { pointerType: 'mouse' })
      Object.defineProperty(move, 'offsetX', { value: 10 })
      act(() => instance.over.dispatchEvent(move))
      expect(instance.setCursorCalls.at(-1)?.left).toBe(10)

      act(() => instance.over.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' })))
      act(() => instance.over.dispatchEvent(new MouseEvent('mouseleave')))

      // valToPos is mocked as v * 10, so t[2] (= 2) lands at 20.
      expect(instance.setCursorCalls.at(-1)).toEqual({ left: 20, top: 1, fireHook: false })
    })

    it('puts its cursor back when the pointer leaves on the very sample the replay head is on', () => {
      // The moment does not change here - pointer 2 gives way to replay
      // head 2 - so no effect reruns to place the cursor after uPlot hides
      // it.
      const t = [0, 1, 2]
      const values = [140, 141, 142]
      const store = renderWithMoment(
        <StreamPanel channel="hr" t={t} values={values} paused={FLAT(3)} outage={FLAT(3)} average={null} />,
      )
      const instance = lastInstance()
      act(() => store.setReplay(2))

      const move = new PointerEvent('pointermove', { pointerType: 'mouse' })
      Object.defineProperty(move, 'offsetX', { value: 20 })
      act(() => instance.over.dispatchEvent(move))

      act(() => instance.over.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' })))
      act(() => instance.over.dispatchEvent(new MouseEvent('mouseleave')))

      expect(instance.setCursorCalls.at(-1)).toEqual({ left: 20, top: 1, fireHook: false })
    })

    it('leaves its cursor hidden after the pointer leaves when there is no other moment', () => {
      const t = [0, 1, 2]
      const values = [140, 141, 142]
      renderWithMoment(
        <StreamPanel channel="hr" t={t} values={values} paused={FLAT(3)} outage={FLAT(3)} average={null} />,
      )
      const instance = lastInstance()

      const move = new PointerEvent('pointermove', { pointerType: 'mouse' })
      Object.defineProperty(move, 'offsetX', { value: 10 })
      act(() => instance.over.dispatchEvent(move))
      act(() => instance.over.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' })))
      act(() => instance.over.dispatchEvent(new MouseEvent('mouseleave')))

      expect(instance.setCursorCalls.at(-1)?.left).toBe(-10)
    })
  })

  describe('the heading row', () => {
    it('keeps its legend line whether it shows the average, a moment or nothing', () => {
      // The row's height must not depend on what the legend holds, or a
      // hover moves every chart below the hovered one. The line itself is
      // held by CSS (`.legend:empty::before` in StreamPanel.module.css),
      // which jsdom does not lay out; what it can see is that the element
      // the CSS sizes is there in every state.
      const t = [0, 1, 2]
      const values = [10, 12, 14]
      const legend = () => document.querySelector('[class*="legend"]')
      const store = renderWithMoment(
        <StreamPanel channel="elevation" t={t} values={values} paused={FLAT(3)} outage={FLAT(3)} average={null} />,
      )
      expect(legend()).not.toBeNull()
      expect(legend()?.textContent).toBe('')

      act(() => store.setPointer(1))
      expect(legend()?.textContent).toBe(formatAverage('elevation', 12))
    })
  })

  describe('the drag', () => {
    it('never zooms: a drag selects nothing and leaves the scale alone', () => {
      // The activity view's stacked charts share one time axis, drawn by
      // the bottom chart, so a zoom on any one of them mislabels the rest.
      const t = [0, 1, 2]
      renderWithMoment(
        <StreamPanel channel="hr" t={t} values={[140, 141, 142]} paused={FLAT(3)} outage={FLAT(3)} average={null} />,
      )
      expect(lastInstance().opts.cursor?.drag).toEqual({ x: false, y: false, setScale: false })
    })
  })
})
