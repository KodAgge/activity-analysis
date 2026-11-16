/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KIND_MARK, kindSlotClass } from './sessionMarks'

/*
 * The kind treatments are colours the stylesheet derives from the
 * validated palette with `color-mix()`, which jsdom does not compute, so
 * the percentages are read out of `sessionMarks.module.css` and the
 * colours out of the tokens, and mixed here as the browser mixes them in
 * sRGB. A percentage changed so that text on a tint falls under 4.5:1
 * fails here; the threshold is not moved to fit a colour.
 */
const HERE = join(fileURLToPath(import.meta.url), '..')
const CSS = readFileSync(join(HERE, 'sessionMarks.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const TOKENS = readFileSync(join(HERE, '..', '..', 'theme', 'tokens.css'), 'utf8')

type Rgb = readonly [number, number, number]

function token(name: string): Rgb {
  const hex = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(TOKENS)?.[1]
  if (hex === undefined) throw new Error(`no --${name} in tokens.css`)
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb
}

/** The `--kind` of each slot class, as the token it names. */
function slotToken(slot: string): string {
  const name = new RegExp(`\\.${slot}\\s*\\{\\s*--kind:\\s*var\\(--([a-z0-9-]+)\\)`).exec(CSS)?.[1]
  if (name === undefined) throw new Error(`no --kind on .${slot}`)
  return name
}

/** A derived property's mix: `color-mix(in srgb, var(--a) N%, var(--b))`. */
function mixOf(property: string): { a: string; percent: number; b: string } {
  const match = new RegExp(
    `${property}:\\s*color-mix\\(in srgb, var\\(--([a-z0-9-]+)\\) (\\d+(?:\\.\\d+)?)%, var\\(--([a-z0-9-]+)\\)\\)`,
  ).exec(CSS)
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new Error(`no color-mix for ${property}`)
  }
  return { a: match[1], percent: Number(match[2]), b: match[3] }
}

function mix(a: Rgb, b: Rgb, percent: number): Rgb {
  const p = percent / 100
  return a.map((v, i) => v * p + (b[i] ?? 0) * (1 - p)) as unknown as Rgb
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(x: Rgb, y: Rgb): number {
  const [hi, lo] = [luminance(x), luminance(y)].sort((m, n) => n - m) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** Resolve a derived property for one slot: `--kind` is the slot's colour, anything else a token. */
function derived(property: string, kind: Rgb): Rgb {
  const { a, percent, b } = mixOf(property)
  const colour = (name: string) => (name === 'kind' ? kind : token(name))
  return mix(colour(a), colour(b), percent)
}

const SLOTS = ['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'neutral'] as const

describe('the kind treatments', () => {
  for (const slot of SLOTS) {
    const kind = token(slotToken(slot))
    const tint = derived('--kind-tint', kind)

    it(`keeps text on the ${slot} tint at 4.5:1 or more`, () => {
      expect(contrast(token('ink'), tint)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(derived('--kind-tint-dim', kind), tint)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(derived('--kind-ink', kind), tint)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(derived('--kind-ink', kind), token('raised'))).toBeGreaterThanOrEqual(4.5)
    })
  }

  it('needs its own dim text on a tint, since --ink-dim falls under 4.5:1 there', () => {
    const intervals = derived('--kind-tint', token(slotToken('slot1')))
    expect(contrast(token('ink-dim'), intervals)).toBeLessThan(4.5)
  })

  it('names a class for each treatment and a slot for each kind', () => {
    expect(KIND_MARK.bar).not.toBe('')
    expect(KIND_MARK.swatch).not.toBe('')
    expect(KIND_MARK.tint).not.toBe('')
    expect(kindSlotClass('intervals')).not.toBe(kindSlotClass('long'))
  })
})
