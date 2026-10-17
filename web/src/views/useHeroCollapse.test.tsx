import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { heroCollapse, useHeroCollapse } from './useHeroCollapse'

describe('heroCollapse', () => {
  // A 390px-wide phone at 844px tall with a square route: the hero is 390px
  // at rest and a third of the screen, 281.33px, collapsed, so it collapses
  // over the first 108.67px of scroll.
  const natural = 390
  const viewport = 844
  const distance = natural - viewport / 3

  it('is uncollapsed at the top of the page', () => {
    expect(heroCollapse(0, natural, viewport)).toEqual({ collapse: 0, collapsedScale: viewport / 3 / natural })
  })

  it('is linear in the scroll offset until the hero is a third of the screen', () => {
    expect(heroCollapse(distance / 4, natural, viewport).collapse).toBeCloseTo(0.25, 12)
    expect(heroCollapse(distance / 2, natural, viewport).collapse).toBeCloseTo(0.5, 12)
  })

  it('stays fully collapsed past that', () => {
    expect(heroCollapse(distance, natural, viewport).collapse).toBe(1)
    expect(heroCollapse(5000, natural, viewport).collapse).toBe(1)
  })

  it('reads an overscrolled page above the top as uncollapsed', () => {
    expect(heroCollapse(-40, natural, viewport).collapse).toBe(0)
  })

  it('shrinks the box and the picture by the same share', () => {
    const { collapse, collapsedScale } = heroCollapse(distance / 2, natural, viewport)
    const height = natural * (1 - collapse * (1 - collapsedScale))
    // Half way: the box has lost half the distance, one pixel per pixel scrolled.
    expect(height).toBeCloseTo(natural - distance / 2, 9)
  })

  it('never collapses a hero already no taller than a third of the screen', () => {
    // A wide route at the clamp's 1.8:1 is 217px tall on a 390px phone.
    expect(heroCollapse(200, 217, viewport)).toEqual({ collapse: 0, collapsedScale: 1 })
    expect(heroCollapse(200, viewport / 3, viewport)).toEqual({ collapse: 0, collapsedScale: 1 })
  })

  it('counts from where the hero sticks when something sits above it', () => {
    // The stale-store notice puts the hero 60px down the page: the hero
    // scrolls those 60px unchanged, and then collapses as it would from
    // the top.
    expect(heroCollapse(60, natural, viewport, 60).collapse).toBe(0)
    expect(heroCollapse(30, natural, viewport, 60).collapse).toBe(0)
    expect(heroCollapse(60 + distance / 2, natural, viewport, 60).collapse).toBeCloseTo(0.5, 12)
    expect(heroCollapse(60 + distance, natural, viewport, 60).collapse).toBe(1)
  })

  it('does nothing with no size to work from', () => {
    expect(heroCollapse(100, 0, viewport)).toEqual({ collapse: 0, collapsedScale: 1 })
    expect(heroCollapse(100, natural, 0)).toEqual({ collapse: 0, collapsedScale: 1 })
  })
})

describe('useHeroCollapse', () => {
  let phone: boolean
  let changeListeners: (() => void)[]
  let resize: ((entries: { target: Element; contentRect: { height: number } }[]) => void) | null
  let observed: Element[]

  beforeEach(() => {
    phone = true
    changeListeners = []
    resize = null
    observed = []
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() {
        return query === '(min-width: 60rem)' && !phone
      },
      media: query,
      addEventListener: (_: string, listener: () => void) => changeListeners.push(listener),
      removeEventListener: (_: string, listener: () => void) => {
        changeListeners = changeListeners.filter((l) => l !== listener)
      },
    }))
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: (entries: { target: Element; contentRect: { height: number } }[]) => void) {
          resize = callback
        }
        observe(target: Element) {
          observed.push(target)
        }
        disconnect() {
          resize = null
        }
      },
    )
    // One frame at a time, run on demand, so a test can see what a scroll
    // does before and after its frame.
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {
      frames.length = 0
    })
    vi.stubGlobal('innerHeight', 844)
    vi.stubGlobal('scrollY', 0)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    frames.length = 0
  })

  const frames: FrameRequestCallback[] = []
  const flushFrames = () =>
    act(() => {
      for (const frame of frames.splice(0)) frame(0)
    })

  function Hero() {
    const ref = useHeroCollapse()
    return (
      <section ref={ref} data-testid="hero">
        <div data-hero-picture="" />
      </section>
    )
  }

  const picture = () => document.querySelector('[data-hero-picture]')!

  function renderHero() {
    const view = render(<Hero />)
    const hero = view.getByTestId('hero')
    act(() => resize?.([{ target: picture(), contentRect: { height: 390 } }]))
    flushFrames()
    return { ...view, hero }
  }

  const scrollTo = (y: number) => {
    vi.stubGlobal('scrollY', y)
    window.dispatchEvent(new Event('scroll'))
  }

  it('writes the natural height and the collapsed share, uncollapsed at the top', () => {
    const { hero } = renderHero()
    expect(hero.style.getPropertyValue('--hero-natural-height')).toBe('390px')
    expect(hero.style.getPropertyValue('--hero-collapsed-scale')).toBe((844 / 3 / 390).toFixed(4))
    expect(hero.style.getPropertyValue('--hero-collapse')).toBe('0.0000')
  })

  it('follows the scroll in the next animation frame, once per frame', () => {
    const { hero } = renderHero()
    scrollTo(20)
    scrollTo(54)
    expect(frames).toHaveLength(1)
    expect(hero.style.getPropertyValue('--hero-collapse')).toBe('0.0000')
    flushFrames()
    expect(hero.style.getPropertyValue('--hero-collapse')).toBe((54 / (390 - 844 / 3)).toFixed(4))
    scrollTo(1000)
    flushFrames()
    expect(hero.style.getPropertyValue('--hero-collapse')).toBe('1.0000')
  })

  it('collapses from where the hero sticks, measured again when the document above it grows', () => {
    const { hero } = renderHero()
    expect(observed).toContain(document.documentElement)
    // A notice arrives above the hero: its parent now starts 60px down.
    const parent = hero.parentElement!
    vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 60, 390, 1000))
    act(() => resize?.([{ target: document.documentElement, contentRect: { height: 3000 } }]))
    flushFrames()
    // The natural height is the picture's, not the document's.
    expect(hero.style.getPropertyValue('--hero-natural-height')).toBe('390px')

    scrollTo(60)
    flushFrames()
    expect(hero.style.getPropertyValue('--hero-collapse')).toBe('0.0000')
    // The rectangle is the viewport's, so it moves up as the page scrolls:
    // the resting top it gives is the same from anywhere.
    vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 60 - 114, 390, 1000))
    scrollTo(114)
    act(() => resize?.([{ target: document.documentElement, contentRect: { height: 3000 } }]))
    flushFrames()
    expect(hero.style.getPropertyValue('--hero-collapse')).toBe((54 / (390 - 844 / 3)).toFixed(4))
  })

  it('writes nothing until the picture has a height', () => {
    render(<Hero />)
    flushFrames()
    const hero = document.querySelector<HTMLElement>('[data-testid="hero"]')
    expect(hero?.style.getPropertyValue('--hero-natural-height')).toBe('')
  })

  it('clears the properties at the desktop layout and writes them again on a phone', () => {
    const { hero } = renderHero()
    phone = false
    act(() => changeListeners.forEach((listener) => listener()))
    expect(hero.style.getPropertyValue('--hero-collapse')).toBe('')
    expect(hero.style.getPropertyValue('--hero-natural-height')).toBe('')
    scrollTo(54)
    flushFrames()
    expect(hero.style.getPropertyValue('--hero-collapse')).toBe('')
    phone = true
    act(() => changeListeners.forEach((listener) => listener()))
    flushFrames()
    expect(hero.style.getPropertyValue('--hero-collapse')).toBe((54 / (390 - 844 / 3)).toFixed(4))
  })

  it('stops listening and clears the properties on unmount', () => {
    const { hero, unmount } = renderHero()
    unmount()
    expect(hero.style.getPropertyValue('--hero-collapse')).toBe('')
    expect(changeListeners).toHaveLength(0)
    expect(resize).toBeNull()
    scrollTo(54)
    expect(frames).toHaveLength(0)
  })
})
