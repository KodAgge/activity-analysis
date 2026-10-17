/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { rampSteps, PACE_STEP_COUNT } from '../charts/paceColour'

/**
 * The pace ramp is a measured artefact, not a choice, exactly like the zone
 * ramp and the categorical palette beside it. This test is the measurement:
 * it reads the tokens file, which is the artefact under test rather than a
 * proxy for behaviour, and checks the two properties the ramp exists to have.
 *
 * The thresholds are the point of this file. A candidate colour that fails
 * one of them is changed; the threshold is not.
 *
 * Two ways of reaching the file do not work here and both fail quietly
 * enough to be worth naming. A `?raw` import resolves to the empty string,
 * because Vitest stubs every CSS import rather than processing one. And
 * `new URL('./tokens.css', import.meta.url)` is not a `file:` URL by the
 * time it runs: Vite rewrites that exact expression into an asset
 * reference, which is why the path is composed from `fileURLToPath`
 * instead.
 */
const TOKENS = readFileSync(join(fileURLToPath(import.meta.url), '..', 'tokens.css'), 'utf8')

function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(TOKENS)
  if (match === null || match[1] === undefined) throw new Error(`no --${name} in tokens.css`)
  return match[1]
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
}

function relativeLuminance(hex: string): number {
  const channel = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const [r, g, b] = rgb(hex)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  if (hi === undefined || lo === undefined) throw new Error('unreachable: two luminances')
  return (hi + 0.05) / (lo + 0.05)
}

/** Brettel-style deutan and protan simulation, enough to compare two swatches. */
function simulate(hex: string, kind: 'deutan' | 'protan'): [number, number, number] {
  const [r, g, b] = rgb(hex)
  if (kind === 'deutan') return [0.625 * r + 0.375 * g, 0.7 * r + 0.3 * g, 0.3 * g + 0.7 * b]
  return [0.567 * r + 0.433 * g, 0.558 * r + 0.442 * g, 0.242 * g + 0.758 * b]
}

function separation(a: string, b: string, kind: 'deutan' | 'protan'): number {
  const [ar, ag, ab] = simulate(a, kind)
  const [br, bg, bb] = simulate(b, kind)
  return Math.hypot(ar - br, ag - bg, ab - bb)
}

/**
 * Every surface this ramp can be stroked on, darkest first.
 *
 * `--page` is where a `TrendChart` actually sits: nothing between `body`
 * and `.chart` paints a background, so the panel token the bar was first
 * measured against was never under a line at all. `--panel` is kept beside
 * it because this is a general ordinal ramp rather than a chart-only one,
 * and the application has `--panel` surfaces a future chart could land on.
 *
 * Requiring both is what makes the bar independent of where the ramp is
 * next used, which is the property that failed. For a dark step the darker
 * surface is the binding one, so `--page` decides the ramp.
 */
const SURFACES = ['page', 'panel'] as const

describe('the reference-pace ramp', () => {
  const ramp = ['pace-1', 'pace-2', 'pace-3'].map(token)
  const surfaces = SURFACES.map((name) => [name, token(name)] as const)

  it('runs light to dark, so slow reads as slow and fast as fast', () => {
    const [a, b, c] = ramp.map(relativeLuminance)
    if (a === undefined || b === undefined || c === undefined) throw new Error('short ramp')
    expect(a).toBeGreaterThan(b)
    expect(b).toBeGreaterThan(c)
  })

  it('keeps every step visible on either surface it can be drawn on', () => {
    // 3:1 is the WCAG bar for a graphical object, which a chart line is.
    for (const step of ramp) {
      for (const [name, surface] of surfaces) {
        expect(contrast(step, surface), `${step} on --${name} (${surface})`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('keeps adjacent steps apart under deutan and protan simulation', () => {
    for (const kind of ['deutan', 'protan'] as const) {
      for (const [a, b] of [
        [ramp[0], ramp[1]],
        [ramp[1], ramp[2]],
      ]) {
        if (a === undefined || b === undefined) throw new Error('short ramp')
        expect(separation(a, b, kind), `${kind} separation`).toBeGreaterThan(40)
      }
    }
  })
})

describe('the route pace ramp', () => {
  const anchors = ['pace-map-1', 'pace-map-2', 'pace-map-3', 'pace-map-4', 'pace-map-5'].map(token)
  const casing = token('raised')

  it('keeps every anchor visible against the white casing under the line', () => {
    for (const step of anchors) {
      expect(contrast(step, casing), `${step} on --raised`).toBeGreaterThanOrEqual(3)
    }
  })

  it('keeps every interpolated step visible against the casing too', () => {
    // The map draws the 24 interpolated steps, not the five anchors, so an
    // OKLab midpoint that came out lighter than both neighbours would fail
    // here while every anchor passed.
    for (const step of rampSteps(anchors, PACE_STEP_COUNT)) {
      expect(contrast(step, casing), `${step} on --raised`).toBeGreaterThanOrEqual(3)
    }
  })

  it('keeps adjacent anchors apart under deutan and protan simulation', () => {
    for (const kind of ['deutan', 'protan'] as const) {
      for (let i = 0; i < anchors.length - 1; i++) {
        const a = anchors[i]
        const b = anchors[i + 1]
        if (a === undefined || b === undefined) throw new Error('short ramp')
        expect(separation(a, b, kind), `${a} and ${b}, ${kind}`).toBeGreaterThan(40)
      }
    }
  })

  it('draws a stopped second in a colour visible on the casing', () => {
    expect(contrast(token('pace-map-stopped'), casing)).toBeGreaterThanOrEqual(3)
  })
})
