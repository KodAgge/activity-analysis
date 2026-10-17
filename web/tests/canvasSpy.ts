import type { ElementHandle, Page } from '@playwright/test'

/**
 * uPlot draws every chart on a `<canvas>`, axis tick labels included - there
 * is no DOM fallback text anywhere in a chart, only pixels. The two most
 * hard-won facts this suite exists to check - that the weekly history marks
 * an empty week, and that the pace panel's top tick reads a fast time rather
 * than a slow one - are both facts about what got drawn, not about anything
 * in the accessibility tree. Reading a canvas for real, rather than skipping
 * the assertion or trusting the source code that produced the pixels, means
 * intercepting the drawing calls themselves.
 *
 * `installCanvasSpy` patches `CanvasRenderingContext2D.prototype.fillRect`,
 * `.arc`, `.fillText` and `.clearRect` once, via `page.addInitScript` so the
 * patch is in place before the application's own first script runs, and
 * records every call against the `<canvas>` element it was drawn on.
 * `fillRectCalls`, `arcCalls` and `fillTextCalls` below read those
 * recordings back for one specific canvas.
 *
 * `.arc` is patched because the empty-week mark stopped being a rectangle:
 * `VolumeBars.tsx` draws a week with no run as an open ring resting on the
 * baseline (`ctx.arc` then `ctx.stroke`), so that a zero reads as deliberate
 * rather than as a bar too short to see. Its bars are `arcTo` corners on a
 * filled path and its zero rule is the one remaining `fillRect`, so a
 * recording of `.arc` on a `VolumeBars` canvas is exactly the empty marks
 * and nothing else.
 *
 * React's `StrictMode` (see `src/main.tsx`) double-invokes the mount effect
 * in development, so `UPlot.tsx` briefly constructs a first uPlot instance,
 * destroys it, and constructs a second - two distinct `<canvas>` elements,
 * the first now detached from the document. Filtering by `call.canvas ===
 * el`, comparing the live element handle against the actual `HTMLCanvasElement`
 * reference captured at draw time, discards the detached first canvas's
 * calls for free: object identity, not a heuristic.
 *
 * A genuine second redraw of the *same* final canvas is the other case to
 * handle: `UPlot.tsx` constructs every chart at a fixed `options.width: 600`
 * / `height: 240`, then its `ResizeObserver` corrects to the container's
 * real size and calls `setSize`, which redraws every mark at a genuinely
 * different position, not a repeat of the same layout. Deduplicating on
 * rounded position (and, for text, the drawn string too) only collapses a
 * repaint of an *unchanged* layout - it cannot collapse this, because every
 * mark lands at a different x or y between the two draws, so a bare count
 * would silently double. uPlot's own `_commit` (see
 * `node_modules/uplot/dist/uPlot.esm.js`) calls `ctx.clearRect(0, 0,
 * can.width, can.height)` immediately before every redraw's actual drawing
 * calls, for every commit including the first, so `clearRect` is patched
 * too, purely to delimit one redraw from the next: each canvas gets its own
 * generation counter, incremented on every `clearRect` seen on it, and each
 * recorded `fillRect`/`fillText` call is tagged with the canvas's current
 * generation at the moment it was drawn. `fillRectCalls` and `fillTextCalls`
 * then keep only the calls from that canvas's *highest* recorded generation
 * - the most recent complete draw - before deduplicating by position within
 * it.
 */

export interface CanvasRectCall {
  x: number
  y: number
}

/** One `ctx.arc`, in canvas pixels: its centre and the radius of its path. */
export interface CanvasArcCall {
  x: number
  y: number
  radius: number
}

export interface CanvasTextCall {
  text: string
  x: number
  y: number
}

interface CanvasSpyState {
  fillRect: { canvas: HTMLCanvasElement; x: number; y: number; generation: number }[]
  arc: { canvas: HTMLCanvasElement; x: number; y: number; radius: number; generation: number }[]
  fillText: { canvas: HTMLCanvasElement; text: string; x: number; y: number; generation: number }[]
}

declare global {
  interface Window {
    __canvasSpy?: CanvasSpyState
  }
}

export async function installCanvasSpy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state: CanvasSpyState = { fillRect: [], arc: [], fillText: [] }
    window.__canvasSpy = state

    // One counter per canvas: bumped on every `clearRect` seen on that
    // canvas, so every `fillRect`/`fillText` call between one `clearRect`
    // and the next carries the same generation number - the marker of "one
    // uPlot redraw" that lets the readers below isolate the final one.
    const generations = new Map<HTMLCanvasElement, number>()
    const currentGeneration = (canvas: HTMLCanvasElement): number => generations.get(canvas) ?? 0

    const originalClearRect = CanvasRenderingContext2D.prototype.clearRect
    CanvasRenderingContext2D.prototype.clearRect = function (
      this: CanvasRenderingContext2D,
      x: number,
      y: number,
      w: number,
      h: number,
    ): void {
      generations.set(this.canvas, currentGeneration(this.canvas) + 1)
      originalClearRect.call(this, x, y, w, h)
    }

    const originalFillRect = CanvasRenderingContext2D.prototype.fillRect
    CanvasRenderingContext2D.prototype.fillRect = function (
      this: CanvasRenderingContext2D,
      x: number,
      y: number,
      w: number,
      h: number,
    ): void {
      state.fillRect.push({ canvas: this.canvas, x, y, generation: currentGeneration(this.canvas) })
      originalFillRect.call(this, x, y, w, h)
    }

    const originalArc = CanvasRenderingContext2D.prototype.arc
    CanvasRenderingContext2D.prototype.arc = function (
      this: CanvasRenderingContext2D,
      x: number,
      y: number,
      radius: number,
      startAngle: number,
      endAngle: number,
      counterclockwise?: boolean,
    ): void {
      state.arc.push({ canvas: this.canvas, x, y, radius, generation: currentGeneration(this.canvas) })
      originalArc.call(this, x, y, radius, startAngle, endAngle, counterclockwise)
    }

    const originalFillText = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (
      this: CanvasRenderingContext2D,
      text: string,
      x: number,
      y: number,
      maxWidth?: number,
    ): void {
      state.fillText.push({ canvas: this.canvas, text, x, y, generation: currentGeneration(this.canvas) })
      if (maxWidth === undefined) {
        originalFillText.call(this, text, x, y)
      } else {
        originalFillText.call(this, text, x, y, maxWidth)
      }
    }
  })
}

function dedupeRects(calls: CanvasRectCall[]): CanvasRectCall[] {
  const seen = new Set<string>()
  const out: CanvasRectCall[] = []
  for (const call of calls) {
    const key = `${String(Math.round(call.x))}|${String(Math.round(call.y))}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(call)
  }
  return out
}

function dedupeArcs(calls: CanvasArcCall[]): CanvasArcCall[] {
  const seen = new Set<string>()
  const out: CanvasArcCall[] = []
  for (const call of calls) {
    const key = `${String(Math.round(call.x))}|${String(Math.round(call.y))}|${String(Math.round(call.radius))}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(call)
  }
  return out
}

function dedupeText(calls: CanvasTextCall[]): CanvasTextCall[] {
  const seen = new Set<string>()
  const out: CanvasTextCall[] = []
  for (const call of calls) {
    const key = `${call.text}|${String(Math.round(call.x))}|${String(Math.round(call.y))}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(call)
  }
  return out
}

/**
 * Every distinct `fillRect` this page has recorded against exactly this
 * canvas element, from its most recent complete draw only - see the file
 * header on why a later redraw at a different size cannot be collapsed by
 * position dedupe alone.
 */
export async function fillRectCalls(canvas: ElementHandle<HTMLCanvasElement>): Promise<CanvasRectCall[]> {
  const raw = await canvas.evaluate((el) => {
    const state = window.__canvasSpy
    if (state === undefined) return []
    const onThisCanvas = state.fillRect.filter((call) => call.canvas === el)
    const latestGeneration = onThisCanvas.reduce((max, call) => Math.max(max, call.generation), 0)
    return onThisCanvas
      .filter((call) => call.generation === latestGeneration)
      .map((call) => ({ x: call.x, y: call.y }))
  })
  return dedupeRects(raw)
}

/**
 * Every distinct `arc` this page has recorded against exactly this canvas
 * element, from its most recent complete draw only - the same generation
 * and dedupe rules `fillRectCalls` uses, and for the same two reasons.
 */
export async function arcCalls(canvas: ElementHandle<HTMLCanvasElement>): Promise<CanvasArcCall[]> {
  const raw = await canvas.evaluate((el) => {
    const state = window.__canvasSpy
    if (state === undefined) return []
    const onThisCanvas = state.arc.filter((call) => call.canvas === el)
    const latestGeneration = onThisCanvas.reduce((max, call) => Math.max(max, call.generation), 0)
    return onThisCanvas
      .filter((call) => call.generation === latestGeneration)
      .map((call) => ({ x: call.x, y: call.y, radius: call.radius }))
  })
  return dedupeArcs(raw)
}

/**
 * Every distinct `fillText` this page has recorded against exactly this
 * canvas element, from its most recent complete draw only - see the file
 * header on why a later redraw at a different size cannot be collapsed by
 * position dedupe alone.
 */
export async function fillTextCalls(canvas: ElementHandle<HTMLCanvasElement>): Promise<CanvasTextCall[]> {
  const raw = await canvas.evaluate((el) => {
    const state = window.__canvasSpy
    if (state === undefined) return []
    const onThisCanvas = state.fillText.filter((call) => call.canvas === el)
    const latestGeneration = onThisCanvas.reduce((max, call) => Math.max(max, call.generation), 0)
    return onThisCanvas
      .filter((call) => call.generation === latestGeneration)
      .map((call) => ({ text: call.text, x: call.x, y: call.y }))
  })
  return dedupeText(raw)
}
