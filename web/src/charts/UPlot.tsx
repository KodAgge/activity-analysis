import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'

export interface UPlotProps {
  /** Column-major series data, x first: exactly what uPlot itself takes. */
  data: uPlot.AlignedData
  /**
   * uPlot's own options object. Its identity is the recreation key (see the
   * component doc below): pass a memoised object, built fresh only when the
   * chart's shape genuinely changes - series, axes, scales, hooks. A change
   * to `data` alone should reuse the same `options` reference.
   */
  options: uPlot.Options
  /** See the module doc below, "`onChart` is the one way a caller reaches the instance itself." */
  onChart?: (chart: uPlot | null) => void
  /**
   * A value whose change repaints the chart through `redraw`, for a picture
   * that depends on state the caller's own draw hooks read from a ref, such
   * as which bar is selected. Neither `data` nor `options` changes then, so
   * neither of the other two paths would repaint it.
   */
  redrawKey?: unknown
}

/**
 * The only file in this project that constructs or destroys a uPlot
 * instance.
 *
 * uPlot owns its own canvas and DOM node once constructed - it is not a
 * declarative React tree, so this wrapper has five jobs:
 *
 * - Build the chart once per distinct `options` identity, in an effect, and
 *   destroy it on cleanup or before rebuilding. Recreating on every render
 *   would throw away uPlot's own cursor position and any zoom the reader had
 *   set, which is why `setData` (below) exists as the other path.
 * - Push a changed `data` array through `setData` rather than rebuilding.
 *   This is the path a chart whose shape hasn't changed - only its values -
 *   should take.
 * - Repaint the same instance through `redraw` when `redrawKey` changes,
 *   for state that only the caller's draw hooks read.
 * - Measure its own container with a `ResizeObserver` and call `setSize`.
 *   uPlot does not watch its container; a `width`/`height` baked into
 *   `options` at construction time would never follow a layout change, and
 *   this project's charts all live inside a flexible page layout rather
 *   than a fixed-size box.
 * - Hand the instance to the caller's `onChart` after construction and
 *   before destruction (below).
 *
 * `ResizeObserver` does not exist in jsdom, so the resize effect is a no-op
 * there rather than throwing - real browsers all implement it.
 *
 * **`onChart` is the one way a caller reaches the instance itself.** It is
 * called with the constructed chart right after `new uPlot(...)`, and with
 * `null` right before `chart.destroy()`. A caller that wants imperative
 * access - placing the cursor with `setCursor`, converting a value to a
 * pixel with `valToPos`, reading `posToIdx` off a pointer event - takes it
 * through here rather than importing `uplot` itself, so this file stays the
 * only one that constructs or destroys an instance. The callback is held in
 * a ref, updated every render, so a caller that passes a fresh function
 * identity on every render (an inline closure, say) never becomes part of
 * the recreation key - only `options` is that (see below).
 *
 * **Why the chart is built with `legend: { show: false }` unless the caller
 * asks for one.** uPlot renders its legend as a `<table>` that is a sibling
 * of the plot's own wrapping element, both inside the root node this
 * component hands to the resize observer below. `setSize` only ever writes
 * the size *it* was given onto that inner wrapping element - it has no way
 * to know a legend (or a title) sits below it and adds to the root node's
 * total rendered height. Left with a legend showing and a container whose
 * own height is driven by its content rather than imposed from outside (as
 * every current call site's CSS does - see UPlot.test.tsx and the
 * resize-loop regression test), every observation reported the *whole*
 * root height, including the legend, back into `setSize`, which grew the
 * wrapping element by the legend's height, which grew the root by the same
 * amount again next tick: unbounded growth, one legend-height per
 * observation, forever. None of this project's charts draw a legend today,
 * so the safe default is off; a future chart that wants one can still pass
 * its own `legend` and take responsibility for sizing around it.
 */
export function UPlot({ data, options, onChart, redrawKey }: UPlotProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<uPlot | null>(null)
  const lastDataRef = useRef<uPlot.AlignedData | null>(null)
  const lastRedrawKeyRef = useRef<unknown>(redrawKey)
  // Updated every render rather than depended on: see the module doc's
  // `onChart` paragraph above.
  const onChartRef = useRef(onChart)
  onChartRef.current = onChart

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return undefined

    // See the module doc above: a caller that wants a legend opts in
    // explicitly and owns the sizing consequences; every current chart
    // gets the safe default instead.
    const withLegend: uPlot.Options =
      options.legend === undefined ? { ...options, legend: { show: false } } : options
    // Built at the container's own size when it has one. Every caller's
    // options carry a placeholder `width` of 600, and the observer below
    // reports the real size only a frame or more later: until then a chart
    // on a 360px phone made the document 624px wide, which
    // tests/chartFirstSize.spec.ts measures with the observer held back.
    // The container is still empty here, so its height is the one imposed
    // on it from outside, never a legend's.
    const { clientWidth, clientHeight } = container
    const builtOptions: uPlot.Options =
      clientWidth > 0 && clientHeight > 0 ? { ...withLegend, width: clientWidth, height: clientHeight } : withLegend
    const chart = new uPlot(builtOptions, data, container)
    chartRef.current = chart
    lastDataRef.current = data
    onChartRef.current?.(chart)

    return () => {
      onChartRef.current?.(null)
      chart.destroy()
      chartRef.current = null
    }
    // Recreation is keyed on `options` alone, by design: a `data`-only
    // change is handled by the effect below via `setData` instead, which is
    // the entire point of this file - including `data` here would rebuild
    // the chart on every data refresh and throw away uPlot's own cursor and
    // zoom state, the exact cost this component exists to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options])

  useEffect(() => {
    // Skip the redundant call right after the chart above was just
    // constructed with this same `data` reference.
    if (lastDataRef.current === data) return
    chartRef.current?.setData(data)
    lastDataRef.current = data
  }, [data])

  useEffect(() => {
    // A chart built this render already drew with the current state, so
    // only a key that differs from the last one seen repaints.
    if (Object.is(lastRedrawKeyRef.current, redrawKey)) return
    lastRedrawKeyRef.current = redrawKey
    // Paths and axes are unchanged: only the draw hooks' picture is.
    chartRef.current?.redraw(false, false)
  }, [redrawKey])

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return undefined
    if (typeof ResizeObserver === 'undefined') return undefined

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry === undefined) return
      const { width, height } = entry.contentRect
      if (width <= 0 || height <= 0) return
      chartRef.current?.setSize({ width, height })
    })
    observer.observe(container)
    return () => observer.disconnect()
    // Re-observe whenever the chart itself is rebuilt, since the effect
    // above may have swapped in a fresh instance under the same container.
  }, [options])

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
}
