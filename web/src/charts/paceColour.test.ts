import { describe, expect, it } from 'vitest'
import { MAX_PIECE_SAMPLES, pacePieces, paceScaleEnds, pieceColour, piecesPassed, rampPosition, rampSteps } from './paceColour'

const none = (n: number) => Array.from({ length: n }, () => false)

describe('paceScaleEnds', () => {
  it('is the 5th and 95th percentile of the moving speeds, interpolated like numpy', () => {
    // 0..20 m/s: p05 = 1, p95 = 19 exactly.
    const speed = Array.from({ length: 21 }, (_, i) => i)
    expect(paceScaleEnds(speed, none(21), none(21))).toEqual({ slow: 1, fast: 19 })
  })

  it('leaves out paused, outage and missing seconds', () => {
    const speed = [100, 2, 2, 2, null, 50]
    const paused = [true, false, false, false, false, false]
    const outage = [false, false, false, false, false, true]
    expect(paceScaleEnds(speed, paused, outage)).toEqual({ slow: 2, fast: 2 })
  })

  it('is null when nothing moved', () => {
    expect(paceScaleEnds([null, null], none(2), none(2))).toBeNull()
    expect(paceScaleEnds([3, 3], [true, true], none(2))).toBeNull()
  })
})

describe('rampPosition', () => {
  const ends = { slow: 2, fast: 4 }
  it('is linear between the ends', () => {
    expect(rampPosition(2, ends)).toBe(0)
    expect(rampPosition(3, ends)).toBe(0.5)
    expect(rampPosition(4, ends)).toBe(1)
  })
  it('clamps outside them', () => {
    expect(rampPosition(1, ends)).toBe(0)
    expect(rampPosition(9, ends)).toBe(1)
  })
  it('puts everything at the middle of a degenerate range', () => {
    expect(rampPosition(3, { slow: 3, fast: 3 })).toBe(0.5)
  })
})

describe('rampSteps', () => {
  it('hits the anchors at the ends and interpolates between', () => {
    const steps = rampSteps(['#000000', '#ffffff'], 3)
    expect(steps).toHaveLength(3)
    // Step centres at 1/6, 1/2, 5/6 of the way; OKLab lightness is linear,
    // so the middle step is OKLab L = 0.5, which is sRGB #636363.
    const step0 = steps[0]
    const step1 = steps[1]
    if (step0 === undefined || step1 === undefined) throw new Error('short steps')
    expect(step1).toBe('#636363')
    expect(step0 < step1).toBe(true)
  })
  it('returns each anchor unchanged when there is one step per anchor at its centre', () => {
    expect(rampSteps(['#2563eb'], 4)).toEqual(['#2563eb', '#2563eb', '#2563eb', '#2563eb'])
  })
})

describe('pacePieces', () => {
  const line = (n: number) => ({
    lat: Array.from({ length: n }, (_, i) => 59 + i * 1e-4),
    lon: Array.from({ length: n }, () => 18),
  })

  it('merges consecutive seconds of one step and shares the joining point', () => {
    const input = { ...line(5), speed: [2, 2, 4, 4, 4], paused: none(5), outage: none(5) }
    const pieces = pacePieces(input, { slow: 2, fast: 4 }, 2)
    expect(pieces.map((p) => [p.step, p.start, p.end])).toEqual([
      [0, 0, 2],
      [1, 2, 4],
    ])
    const piece0 = pieces[0]
    const piece1 = pieces[1]
    if (piece0 === undefined || piece1 === undefined) throw new Error('short pieces')
    expect(piece0.coords).toHaveLength(3)
    expect(piece0.coords.at(-1)).toEqual(piece1.coords[0])
  })

  it('caps a piece at MAX_PIECE_SAMPLES segments, so a replay reveals the line in short steps', () => {
    const n = MAX_PIECE_SAMPLES * 2 + 1
    const input = { ...line(n), speed: Array(n).fill(3), paused: none(n), outage: none(n) }
    const pieces = pacePieces(input, { slow: 2, fast: 4 })
    expect(pieces.map((p) => p.end - p.start)).toEqual([MAX_PIECE_SAMPLES, MAX_PIECE_SAMPLES])
  })

  it('marks paused, outage and missing-speed segments as stopped', () => {
    // Segment 1 has no speed and segment 2 starts on a paused sample; they
    // merge into one stopped piece between two moving ones.
    const input = { ...line(5), speed: [3, null, 3, 3, 3], paused: [false, false, true, false, false], outage: none(5) }
    const steps = pacePieces(input, { slow: 2, fast: 4 }, 2).map((p) => p.step)
    expect(steps).toEqual([1, null, 1])
  })

  it('breaks at a missing position instead of drawing a chord across it', () => {
    const base = line(5)
    const input = { lat: [...base.lat.slice(0, 2), null, ...base.lat.slice(3)], lon: base.lon, speed: Array(5).fill(3), paused: none(5), outage: none(5) }
    const pieces = pacePieces(input, { slow: 2, fast: 4 }, 2)
    expect(pieces.map((p) => [p.start, p.end])).toEqual([
      [0, 1],
      [3, 4],
    ])
  })

  it('draws every segment as stopped when the run has no scale', () => {
    const input = { ...line(3), speed: [null, null, null], paused: none(3), outage: none(3) }
    expect(pacePieces(input, null).every((p) => p.step === null)).toBe(true)
  })
})

describe('piecesPassed', () => {
  const pieces = [
    { step: 0, start: 0, end: 2, coords: [] },
    { step: 1, start: 2, end: 4, coords: [] },
    { step: 0, start: 7, end: 9, coords: [] },
  ]

  it('counts the pieces whose end the head has reached', () => {
    expect(piecesPassed(pieces, 0)).toBe(0)
    expect(piecesPassed(pieces, 1)).toBe(0)
    expect(piecesPassed(pieces, 2)).toBe(1)
    expect(piecesPassed(pieces, 4)).toBe(2)
    // Across a GPS gap between two pieces.
    expect(piecesPassed(pieces, 6)).toBe(2)
    expect(piecesPassed(pieces, 9)).toBe(3)
    expect(piecesPassed(pieces, 99)).toBe(3)
  })

  it('is zero for a route with no pieces', () => {
    expect(piecesPassed([], 5)).toBe(0)
  })
})

describe('pieceColour', () => {
  const pace = { pieces: [], palette: ['#111111', '#222222'], stoppedColour: '#999999' }

  it('is the step colour for a moving piece and the stopped colour for a stopped one', () => {
    expect(pieceColour(pace, { step: 1, start: 0, end: 1, coords: [] })).toBe('#222222')
    expect(pieceColour(pace, { step: null, start: 0, end: 1, coords: [] })).toBe('#999999')
  })
})
