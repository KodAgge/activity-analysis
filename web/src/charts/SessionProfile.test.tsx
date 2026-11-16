import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { components } from '../api/schema'
import { SessionProfile } from './SessionProfile'
import styles from './SessionProfile.module.css'
import { kindSlotClass } from '../components/plan/sessionMarks'

type S = components['schemas']

/* A synthetic interval session; every figure made up. */
const INTERVALS: S['Session'] = {
  id: 'w1-intervals',
  date: '2026-03-04',
  kind: 'intervals',
  title: 'Intervals',
  description: '',
  steps: [
    { role: 'warmup', repeat: 1, duration_s: 900 },
    { role: 'strides', repeat: 4, duration_s: 20 },
    { role: 'work', repeat: 6, distance_m: 800, speed: { low_mps: 3.8462, high_mps: 3.9216 }, note: '8/10' },
    { role: 'recovery', repeat: 6, distance_m: 400 },
    { role: 'cooldown', repeat: 1, duration_s: 540 },
  ],
}

const REST: S['Session'] = { id: 'r', date: '2026-03-05', kind: 'rest', title: 'Rest', description: '', steps: [] }

function segments(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll('[data-mark="segment"]'))
}

describe('SessionProfile, full', () => {
  it('names the profile and lists its sets in words', () => {
    render(<SessionProfile session={INTERVALS} size="full" />)
    expect(
      screen.getByRole('img', {
        name: 'Workout profile: warm-up 15 min, 4 × 20 s strides, 6 × 800 m at 4:15-4:20/km with 400 m recoveries, cool-down 9 min.',
      }),
    ).toBeInTheDocument()
  })

  it('draws a segment per stretch, coloured by role, reps taller than the jogs between them', () => {
    const { container } = render(<SessionProfile session={INTERVALS} size="full" />)
    const drawn = segments(container)
    // 1 warm-up, 4 strides and 3 walks, 6 reps and 5 jogs, 1 cool-down.
    expect(drawn).toHaveLength(20)
    expect(drawn.map((r) => r.getAttribute('data-role'))).toContain('strides')
    const height = (role: string) => Number(drawn.find((r) => r.getAttribute('data-role') === role)?.getAttribute('height'))
    expect(height('work')).toBeGreaterThan(height('recovery'))
    expect(height('work')).toBeGreaterThan(height('warmup'))
    // Each stretch in the colour of its own kind of effort: the reps the
    // session's kind, the strides theirs, the easy running the easy kind's.
    const slotOf = (role: string) => drawn.find((r) => r.getAttribute('data-role') === role)?.getAttribute('class') ?? ''
    expect(slotOf('work')).toContain(kindSlotClass('intervals'))
    expect(slotOf('strides')).toContain(kindSlotClass('strides'))
    for (const easy of ['warmup', 'recovery', 'cooldown']) expect(slotOf(easy)).toContain(kindSlotClass('easy'))
  })

  it('labels the work set where it fits, keys the tones it draws and draws a time axis in minutes', () => {
    render(<SessionProfile session={INTERVALS} size="full" />)
    expect(screen.getByText('6 × 800 m @ 4:15-4:20/km')).toBeInTheDocument()
    const key = screen.getByRole('list', { name: 'Key' })
    // Warm-up, recovery and cool-down are one easy tone of the easy kind,
    // keyed once; the work is the session's kind and the strides theirs,
    // each keyed apart, so a colour here means what the calendar's key says.
    expect(Array.from(key.querySelectorAll('li')).map((li) => li.textContent)).toEqual([
      'Work',
      'Strides',
      'Warm-up, recovery, cool-down',
    ])
    // The set label carries its unit, so no note under the plot says it.
    expect(screen.queryByText('Paces per kilometre')).toBeNull()
    expect(screen.getByText('0')).toBeInTheDocument()
    expect(screen.getByText('10 min')).toBeInTheDocument()
  })

  it('reads a segment out on focus, and the arrow keys move along the session', () => {
    render(<SessionProfile session={INTERVALS} size="full" />)
    const plot = screen.getByRole('group', { name: 'Workout steps' })
    fireEvent.focus(plot)
    const readout = screen.getByTestId('profile-readout')
    expect(readout).toHaveTextContent('Warm-up')
    expect(readout).toHaveTextContent('15 min')
    // Past the four strides and three walks to the first rep.
    for (let i = 0; i < 8; i++) fireEvent.keyDown(plot, { key: 'ArrowRight' })
    expect(readout).toHaveTextContent('Work 1 of 6')
    expect(readout).toHaveTextContent('800 m')
    expect(readout).toHaveTextContent('4:15-4:20/km')
    expect(readout).toHaveTextContent('8/10')
    fireEvent.keyDown(plot, { key: 'ArrowLeft' })
    expect(readout).toHaveTextContent('Strides 4 of 4')
    fireEvent.keyDown(plot, { key: 'ArrowLeft' })
    expect(readout).toHaveTextContent('Walk')
    expect(readout).toHaveTextContent('45 s')
    fireEvent.blur(plot)
    expect(screen.queryByTestId('profile-readout')).toBeNull()
  })

  it('reads the segment under the pointer', () => {
    const { container } = render(<SessionProfile session={INTERVALS} size="full" />)
    const plot = screen.getByRole('group', { name: 'Workout steps' })
    const svg = container.querySelector('svg')
    if (svg === null) throw new Error('no svg')
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 90, width: 600, height: 90, x: 0, y: 0, toJSON: () => ({}) })
    // The last pixel is in the cool-down, at the bars' height.
    fireEvent.mouseMove(plot, { clientX: 598, clientY: 40 })
    expect(screen.getByTestId('profile-readout')).toHaveTextContent('Cool-down')
    fireEvent.mouseLeave(plot)
    expect(screen.queryByTestId('profile-readout')).toBeNull()
  })

  it('reads nothing out with the pointer over the axis, the label band or past the end', () => {
    // Without strides the reps are the tallest stretch, so their label stands in a band over the plot.
    const reps = { ...INTERVALS, steps: INTERVALS.steps.filter((s) => s.role !== 'strides') }
    const { container } = render(<SessionProfile session={reps} size="full" />)
    const plot = screen.getByRole('group', { name: 'Workout steps' })
    const svg = container.querySelector('svg')
    if (svg === null) throw new Error('no svg')
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 90, width: 600, height: 90, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.mouseMove(plot, { clientX: 300, clientY: 85 })
    expect(screen.queryByTestId('profile-readout')).toBeNull()
    fireEvent.mouseMove(plot, { clientX: 300, clientY: 4 })
    expect(screen.queryByTestId('profile-readout')).toBeNull()
    fireEvent.mouseMove(plot, { clientX: 300, clientY: 40 })
    expect(screen.getByTestId('profile-readout')).toBeInTheDocument()
    fireEvent.mouseMove(plot, { clientX: 640, clientY: 40 })
    expect(screen.queryByTestId('profile-readout')).toBeNull()
  })

  it('draws warm-up, recovery, cool-down and the walks between strides in one tone, and strides as spikes in their own colour', () => {
    const { container } = render(<SessionProfile session={INTERVALS} size="full" />)
    const drawn = segments(container)
    const classOf = (role: string) => new Set(drawn.filter((r) => r.getAttribute('data-role') === role).map((r) => r.getAttribute('class')))
    const easy = classOf('warmup')
    expect(easy.size).toBe(1)
    expect(classOf('recovery')).toEqual(easy)
    expect(classOf('cooldown')).toEqual(easy)
    expect(classOf('work')).not.toEqual(easy)
    expect(classOf('strides')).not.toEqual(easy)
    // Strides are fast running, solid as the work is, in the strides kind's
    // colour, the one the calendar's key gives them.
    for (const c of classOf('strides')) {
      expect(c).toContain(styles.work)
      expect(c).toContain(kindSlotClass('strides'))
    }
    // Each stride at least 4px wide, at the 600px the test draws.
    const strides = drawn.filter((r) => r.getAttribute('data-role') === 'strides')
    for (const r of strides) expect(Number(r.getAttribute('width'))).toBeGreaterThanOrEqual(4)
    // No walk drawn under a spike lower than the warm-up it continues.
    const warmTop = Number(drawn.find((r) => r.getAttribute('data-role') === 'warmup')?.getAttribute('y'))
    const walks = drawn.filter((r) => r.getAttribute('data-role') === 'recovery' && Number(r.getAttribute('y')) === warmTop)
    expect(walks).toHaveLength(3)
  })

  it('draws an easy run by effort: its whole distance in the easy tone, keyed as easy running, and a low plot', () => {
    const easyRun: S['Session'] = {
      ...INTERVALS,
      id: 'w1-easy',
      kind: 'easy',
      title: 'Easy run with strides',
      steps: [
        { role: 'work', repeat: 1, distance_m: 10000, heart_rate: { high_bpm: 167 } },
        { role: 'strides', repeat: 4, duration_s: 20 },
      ],
    }
    const { container } = render(<SessionProfile session={easyRun} size="full" />)
    const drawn = segments(container)
    const work = drawn.find((r) => r.getAttribute('data-role') === 'work')
    const stride = drawn.find((r) => r.getAttribute('data-role') === 'strides')
    expect(work?.getAttribute('class')).toContain(styles.easy)
    expect(stride?.getAttribute('class')).not.toContain(styles.easy)
    const key = screen.getByRole('list', { name: 'Key' })
    expect(Array.from(key.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['Strides', 'Easy running'])

    // A long run alone, on the interval session's scale: its plot ends at
    // its own height, lower than the interval session's.
    const scale = { floorMps: 2.0, topMps: 4.5 }
    const long = { ...easyRun, id: 'w1-long', kind: 'long' as const, steps: easyRun.steps.slice(0, 1) }
    const height = (session: S['Session']) => {
      const { container: c, unmount } = render(<SessionProfile session={session} size="full" scale={scale} />)
      const h = Number(c.querySelector('svg')?.getAttribute('viewBox')?.split(' ')[3])
      unmount()
      return h
    }
    expect(height(long)).toBeLessThan(height(INTERVALS) - 40)
  })

  it('keeps every stride apart from the next by air', () => {
    const { container } = render(<SessionProfile session={INTERVALS} size="full" />)
    const strides = segments(container)
      .filter((r) => r.getAttribute('data-role') === 'strides')
      .map((r) => ({ x: Number(r.getAttribute('x')), w: Number(r.getAttribute('width')) }))
      .sort((a, b) => a.x - b.x)
    for (let i = 1; i < strides.length; i++) {
      const prev = strides[i - 1]
      const next = strides[i]
      if (prev === undefined || next === undefined) continue
      expect(next.x - (prev.x + prev.w)).toBeGreaterThanOrEqual(2)
    }
  })

  it('draws nothing for a rest day', () => {
    const { container } = render(<SessionProfile session={REST} size="full" />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('SessionProfile, mini', () => {
  it('is a bare sparkline hidden from a screen reader: no axis, labels or key', () => {
    const { container } = render(<SessionProfile session={INTERVALS} size="mini" />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(Number(svg?.getAttribute('height'))).toBeLessThanOrEqual(20)
    expect(segments(container)).toHaveLength(20)
    expect(container.querySelectorAll('text')).toHaveLength(0)
    expect(screen.queryByRole('list')).toBeNull()
    expect(container.querySelector('[tabindex]')).toBeNull()
  })
})

/*
 * The colours are the stylesheet's, which jsdom does not apply, so the
 * rules are read from the files themselves, as `theme/rampContrast.test.ts`
 * reads the tokens.
 */
const HERE = join(fileURLToPath(import.meta.url), '..')
const CSS = readFileSync(join(HERE, 'SessionProfile.module.css'), 'utf8')
const TOKENS = readFileSync(join(HERE, '..', 'theme', 'tokens.css'), 'utf8')

type Declarations = Readonly<Record<string, string>>

/** The stylesheet as its rules, each selector's declarations by property, comments dropped. */
function parseRules(css: string): ReadonlyMap<string, Declarations> {
  const rules = new Map<string, Declarations>()
  for (const [, selector, body] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selector === undefined || body === undefined) continue
    const declarations: Record<string, string> = {}
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon >= 0) declarations[part.slice(0, colon).trim()] = part.slice(colon + 1).trim()
    }
    rules.set(selector.trim(), declarations)
  }
  return rules
}

const RULES = parseRules(CSS)

function rule(selector: string): Declarations {
  const declarations = RULES.get(selector)
  if (declarations === undefined) throw new Error(`no ${selector} rule`)
  return declarations
}

function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(TOKENS)
  if (match?.[1] === undefined) throw new Error(`no --${name}`)
  return match[1]
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

function fillToken(selector: string): string {
  const match = /^var\(--([a-z0-9-]+)\)$/.exec(rule(selector).fill ?? '')
  if (match?.[1] === undefined) throw new Error(`${selector} has no token fill`)
  return match[1]
}

/** A declaration's value with every `var(--token)` replaced by the token's colour; throws on any other variable, `--kind` among them. */
function resolved(value: string): string {
  return value.replace(/var\(--([a-z0-9-]+)\)/g, (_, name: string) => token(name))
}

/**
 * The declarations the stylesheet gives an element through its classes,
 * resolved through the tokens: every single-class rule whose module class
 * the element carries, merged.
 */
function styleOf(element: Element): Record<string, string> {
  const style: Record<string, string> = {}
  for (const [selector, declarations] of RULES) {
    const name = /^\.([A-Za-z][\w-]*)$/.exec(selector)?.[1]
    const moduleClass = name === undefined ? undefined : (styles as Record<string, string | undefined>)[name]
    if (moduleClass === undefined || !element.classList.contains(moduleClass)) continue
    for (const [property, value] of Object.entries(declarations)) style[property] = resolved(value)
  }
  return style
}

describe('SessionProfile colours', () => {
  it('draws warm-up and cool-down in one fixed token, not a tint of the kind, whatever the session', () => {
    const styleOfRole = (s: S['Session'], role: string) => {
      const { container, unmount } = render(<SessionProfile session={s} size="mini" />)
      const element = container.querySelector(`[data-role="${role}"]`)
      if (element === null) throw new Error(`no ${role} segment`)
      const style = styleOf(element)
      unmount()
      return style
    }
    const warm = { fill: token('ink-dim') }
    for (const kind of ['intervals', 'tempo', 'easy', 'long'] as const) {
      const session: S['Session'] = { ...INTERVALS, id: kind, kind }
      expect(styleOfRole(session, 'warmup')).toEqual(warm)
      expect(styleOfRole(session, 'cooldown')).toEqual(warm)
    }
  })

  it('gives warm-up at least 3:1 against the raised sheet and the page, and recovery a lighter grey', () => {
    const warm = token(fillToken('.soft'))
    for (const surface of ['raised', 'page']) expect(contrast(warm, token(surface))).toBeGreaterThanOrEqual(3)
    const recovery = token(fillToken('.recovery'))
    expect(luminance(recovery)).toBeGreaterThan(luminance(warm))
  })
})
