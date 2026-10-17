import { render } from '@testing-library/react'
import type uPlot from 'uplot'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UPlot } from './UPlot'

/**
 * The four lifecycle rules this wrapper exists to enforce (see its own doc
 * comment): build once per `options` identity, destroy on cleanup, push a
 * data-only change through `setData` rather than rebuilding, and size from
 * a `ResizeObserver` via `setSize`. None of this can be watched by letting
 * the real `uplot` package draw - jsdom has no layout engine for it to draw
 * into - so, as in `StreamPanel.test.tsx`, the constructor itself is
 * spied on.
 */
const { instances, MockUPlot } = vi.hoisted(() => {
  class MockUPlot {
    opts: uPlot.Options
    data: uPlot.AlignedData
    target: unknown
    setData = vi.fn()
    setSize = vi.fn()
    redraw = vi.fn()
    destroy = vi.fn()
    constructor(opts: uPlot.Options, data: uPlot.AlignedData, target: unknown) {
      this.opts = opts
      this.data = data
      this.target = target
      instances.push(this)
    }
  }
  const instances: InstanceType<typeof MockUPlot>[] = []
  return { instances, MockUPlot }
})

vi.mock('uplot', () => ({ default: MockUPlot }))
vi.mock('uplot/dist/uPlot.min.css', () => ({}))

// jsdom has no `ResizeObserver` at all (see UPlot.tsx's own doc comment),
// so this stands in for a real one and hands the test the callback it was
// constructed with, to fire by hand.
let resizeCallback: ResizeObserverCallback | null = null

class FakeResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback
  }
}

beforeEach(() => {
  instances.length = 0
  resizeCallback = null
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function lastInstance(): InstanceType<typeof MockUPlot> {
  const instance = instances.at(-1)
  if (instance === undefined) throw new Error('uPlot was never constructed')
  return instance
}

function baseOptions(): uPlot.Options {
  return { width: 10, height: 10, series: [{}] }
}

describe('UPlot', () => {
  it('builds the chart once per distinct options identity, and rebuilds only when it changes', () => {
    const options = baseOptions()
    const { rerender } = render(<UPlot data={[[0, 1]]} options={options} />)
    expect(instances).toHaveLength(1)

    // The same `options` reference across a re-render: no second build.
    rerender(<UPlot data={[[0, 1]]} options={options} />)
    expect(instances).toHaveLength(1)

    // A genuinely new `options` identity does rebuild the chart.
    rerender(<UPlot data={[[0, 1]]} options={baseOptions()} />)
    expect(instances).toHaveLength(2)
  })

  it('destroys the chart on unmount', () => {
    const { unmount } = render(<UPlot data={[[0, 1]]} options={baseOptions()} />)
    const instance = lastInstance()

    unmount()

    expect(instance.destroy).toHaveBeenCalledTimes(1)
  })

  it('pushes a data-only change through setData rather than recreating the chart', () => {
    const options = baseOptions()
    const { rerender } = render(<UPlot data={[[0, 1]]} options={options} />)
    const instance = lastInstance()

    rerender(<UPlot data={[[0, 2]]} options={options} />)

    // Still the one instance from the first render...
    expect(instances).toHaveLength(1)
    // ...pushed the new data through setData instead.
    expect(instance.setData).toHaveBeenCalledWith([[0, 2]])
  })

  it('redraws the same chart when redrawKey changes, rather than rebuilding it', () => {
    const options = baseOptions()
    const data: uPlot.AlignedData = [[0, 1]]
    const { rerender } = render(<UPlot data={data} options={options} redrawKey={-1} />)
    const instance = lastInstance()
    expect(instance.redraw).not.toHaveBeenCalled()

    rerender(<UPlot data={data} options={options} redrawKey={2} />)

    expect(instances).toHaveLength(1)
    expect(instance.redraw).toHaveBeenCalledTimes(1)
    expect(instance.setData).not.toHaveBeenCalled()

    // The same key again is no change.
    rerender(<UPlot data={data} options={options} redrawKey={2} />)
    expect(instance.redraw).toHaveBeenCalledTimes(1)
  })

  it('does not call setData again right after construction with the same data reference', () => {
    const data: uPlot.AlignedData = [[0, 1]]
    render(<UPlot data={data} options={baseOptions()} />)
    const instance = lastInstance()

    expect(instance.setData).not.toHaveBeenCalled()
  })

  it('sizes the chart from its container via a ResizeObserver, calling setSize', () => {
    render(<UPlot data={[[0, 1]]} options={baseOptions()} />)
    const instance = lastInstance()
    if (resizeCallback === null) throw new Error('no ResizeObserver was installed')

    resizeCallback([{ contentRect: { width: 320, height: 180 } } as ResizeObserverEntry], {} as ResizeObserver)

    expect(instance.setSize).toHaveBeenCalledWith({ width: 320, height: 180 })
  })

  describe('the size the chart is built at', () => {
    /** Gives every element in the render the client size a laid-out container would have. */
    function stubClientSize(width: number, height: number) {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width)
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(height)
    }

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it("builds the chart at its container's size, not the options' placeholder", () => {
      // At 360px wide the 600px placeholder made the document 624px wide
      // until the first observation arrived; tests/chartFirstSize.spec.ts.
      stubClientSize(320, 180)
      render(<UPlot data={[[0, 1]]} options={{ ...baseOptions(), width: 600, height: 200 }} />)

      expect(lastInstance().opts.width).toBe(320)
      expect(lastInstance().opts.height).toBe(180)
    })

    it("keeps the options' size while the container has none to give", () => {
      stubClientSize(0, 0)
      render(<UPlot data={[[0, 1]]} options={{ ...baseOptions(), width: 600, height: 200 }} />)

      expect(lastInstance().opts.width).toBe(600)
      expect(lastInstance().opts.height).toBe(200)
    })
  })

  // The resize-loop regression: see UPlot.tsx's own module doc, "Why the
  // chart is built with `legend: { show: false }`".
  describe('legend default and the resize loop it exists to prevent', () => {
    it('builds the chart with the legend off when the caller does not ask for one', () => {
      render(<UPlot data={[[0, 1]]} options={baseOptions()} />)
      const instance = lastInstance()

      expect(instance.opts.legend).toEqual({ show: false })
    })

    it('leaves a caller-supplied legend option untouched', () => {
      const options = { ...baseOptions(), legend: { show: true, live: false } }
      render(<UPlot data={[[0, 1]]} options={options} />)
      const instance = lastInstance()

      expect(instance.opts.legend).toEqual({ show: true, live: false })
    })

    /**
     * Models exactly what a real browser reports back through the
     * observer: the container's rendered height is uPlot's own wrapping
     * element (whatever `setSize` last wrote onto it) plus a legend
     * table's height, because the legend is a sibling of that wrapping
     * element rather than something inside it - see uPlot's own source,
     * `placeTag("table", LEGEND, root)`. Every container in this project
     * also has no height of its own imposed from outside (a percentage
     * that resolves to `auto`, or - before this fix - none at all, as
     * with VolumeBars), so nothing stops the observed height from
     * including whatever extra chrome the chart drew.
     *
     * Feeding that whole reported height back into `setSize`, the way the
     * resize effect genuinely does, adds the legend's height to the
     * wrapping element on every tick when a legend is showing: mutate
     * `LEGEND_HEIGHT_PX` here to 0 and this still passes trivially, but
     * mutate UPlot.tsx to always pass `options` through unmodified
     * (dropping the `legend: { show: false }` default) and this test
     * fails, because `instance.opts.legend` reverts to `undefined` and the
     * loop below sees a non-zero legend chrome to add back in every
     * iteration.
     */
    it('does not grow the container without bound across repeated observations', () => {
      const LEGEND_HEIGHT_PX = 22

      render(<UPlot data={[[0, 1]]} options={baseOptions()} />)
      const instance = lastInstance()
      if (resizeCallback === null) throw new Error('no ResizeObserver was installed')

      // uPlot's own default is `legend.show: true`; only an explicit
      // `false` removes the legend's height from what a browser would
      // report for the container.
      const legendChromePx = instance.opts.legend?.show === false ? 0 : LEGEND_HEIGHT_PX

      let wrapHeight = 10 // baseOptions().height, the chart's initial size.
      const observedHeights: number[] = []

      for (let i = 0; i < 6; i++) {
        const containerHeight = wrapHeight + legendChromePx
        observedHeights.push(containerHeight)

        resizeCallback(
          [{ contentRect: { width: 320, height: containerHeight } } as ResizeObserverEntry],
          {} as ResizeObserver,
        )

        const lastCall = instance.setSize.mock.calls.at(-1) as [{ width: number; height: number }] | undefined
        if (lastCall === undefined) throw new Error('setSize was never called')
        wrapHeight = lastCall[0].height
      }

      // Converged: the last two observations reported the same height, not
      // a strictly larger one every time.
      expect(observedHeights.at(-1)).toBe(observedHeights.at(-2))
    })
  })
})
