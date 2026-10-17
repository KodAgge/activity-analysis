import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDENTITY, ReplayCanvas, type ReplayPath } from './replayCanvas'
import { recordCanvases, type Recorded } from './recordingCanvas.testUtil'

// Pieces ending at samples 2, 4 and 6, each starting where the last ended.
const paths: ReplayPath[] = [
  { end: 2, colour: '#111111', points: [0, 0, 10, 0, 20, 0] },
  { end: 4, colour: '#222222', points: [20, 0, 30, 0] },
  { end: 6, colour: '#333333', points: [30, 0, 40, 0] },
]

let canvases: Map<HTMLCanvasElement, Recorded>
let canvas: HTMLCanvasElement
beforeEach(() => {
  canvases = recordCanvases()
  canvas = document.createElement('canvas')
})
afterEach(() => {
  vi.restoreAllMocks()
})

const rec = () => canvases.get(canvas) ?? { strokes: [], clears: 0, transform: [], lineWidth: 0 }
const colours = () => rec().strokes.map((s) => s.colour)

describe('ReplayCanvas', () => {
  it('sizes itself at the device pixel ratio', () => {
    new ReplayCanvas(canvas).layout(paths, 200, 100, 2, IDENTITY, 4.5)
    expect([canvas.width, canvas.height]).toEqual([400, 200])
  })

  it('draws nothing, and never asks for a context, without a head', () => {
    new ReplayCanvas(canvas).layout(paths, 200, 100, 1, IDENTITY, 4.5)
    expect(canvases.size).toBe(0)
  })

  it('strokes the pieces the head has passed, each in its colour and with every point', () => {
    const rc = new ReplayCanvas(canvas)
    rc.layout(paths, 200, 100, 1, IDENTITY, 4.5)
    rc.setHead(4)
    expect(colours()).toEqual(['#111111', '#222222'])
    expect(rec().strokes[0]).toEqual({ colour: '#111111', first: [0, 0], points: 3 })
    expect(rec().lineWidth).toBe(4.5)
  })

  it('strokes only the new pieces between two heads', () => {
    const rc = new ReplayCanvas(canvas)
    rc.layout(paths, 200, 100, 1, IDENTITY, 4.5)
    rc.setHead(2)
    rc.setHead(3)
    rc.setHead(6)
    expect(colours()).toEqual(['#111111', '#222222', '#333333'])
    expect(rec().clears).toBe(0)
  })

  it('clears and redraws up to a head that moved back', () => {
    const rc = new ReplayCanvas(canvas)
    rc.layout(paths, 200, 100, 1, IDENTITY, 4.5)
    rc.setHead(6)
    rec().strokes.length = 0
    rc.setHead(2)
    expect(rec().clears).toBe(1)
    expect(colours()).toEqual(['#111111'])
  })

  it('clears when the head goes', () => {
    const rc = new ReplayCanvas(canvas)
    rc.layout(paths, 200, 100, 1, IDENTITY, 4.5)
    rc.setHead(4)
    rc.setHead(null)
    expect(rec().clears).toBe(1)
  })

  it('keeps a head set before its first layout, and draws it there', () => {
    const rc = new ReplayCanvas(canvas)
    rc.setHead(4)
    expect(canvases.size).toBe(0)
    rc.layout(paths, 200, 100, 1, IDENTITY, 4.5)
    expect(colours()).toEqual(['#111111', '#222222'])
  })

  it('redraws up to the head on a new layout', () => {
    const rc = new ReplayCanvas(canvas)
    rc.layout(paths, 200, 100, 1, IDENTITY, 4.5)
    rc.setHead(4)
    rec().strokes.length = 0
    rc.layout(paths, 300, 150, 1, IDENTITY, 4.5)
    expect(colours()).toEqual(['#111111', '#222222'])
  })

  it('maps its units to device pixels through the transform', () => {
    const rc = new ReplayCanvas(canvas)
    rc.layout(paths, 200, 100, 2, { scale: 3, dx: 5, dy: 7 }, 0.1)
    rc.setHead(2)
    expect(rec().transform).toEqual([6, 0, 0, 6, 10, 14])
  })
})
