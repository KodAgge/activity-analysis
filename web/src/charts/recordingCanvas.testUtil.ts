import { vi } from 'vitest'

/**
 * A stand-in for a 2D canvas context, which jsdom does not implement: it
 * records each stroked path's colour and first point, and each clear, per
 * canvas element. Shared by the tests of `replayCanvas.ts` and of the two
 * pictures that use it. Not a test file itself, so Vitest does not collect it.
 */
export interface Recorded {
  strokes: { colour: string; first: [number, number]; points: number }[]
  clears: number
  transform: number[]
  lineWidth: number
}

export function recordCanvases(): Map<HTMLCanvasElement, Recorded> {
  const byCanvas = new Map<HTMLCanvasElement, Recorded>()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    let rec = byCanvas.get(this)
    if (rec === undefined) {
      rec = { strokes: [], clears: 0, transform: [], lineWidth: 0 }
      byCanvas.set(this, rec)
    }
    const r = rec
    let first: [number, number] = [0, 0]
    let points = 0
    const ctx = {
      strokeStyle: '',
      lineCap: 'butt',
      lineJoin: 'miter',
      set lineWidth(w: number) {
        r.lineWidth = w
      },
      setTransform: (...m: number[]) => {
        r.transform = m
      },
      beginPath: () => {
        points = 0
      },
      moveTo: (x: number, y: number) => {
        first = [x, y]
        points = 1
      },
      lineTo: () => {
        points++
      },
      stroke: () => {
        r.strokes.push({ colour: ctx.strokeStyle, first, points })
      },
      clearRect: () => {
        r.clears++
      },
    }
    return ctx as unknown as CanvasRenderingContext2D
  } as unknown as HTMLCanvasElement['getContext'])
  return byCanvas
}
