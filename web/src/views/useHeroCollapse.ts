import { useCallback, useEffect, useState } from 'react'
import { DESKTOP_LAYOUT_QUERY } from './useMediaQuery'

/**
 * Finds the element inside the hero whose layout height is the hero's
 * natural height: `components/RouteHero.tsx`'s picture wrapper, which
 * carries the attribute and which the collapse scales but never resizes.
 */
const HERO_PICTURE_SELECTOR = '[data-hero-picture]'

/** The collapsed hero's share of the viewport height; see ActivityDetail in docs/reference/frontend.md. */
const COLLAPSED_VIEWPORT_SHARE = 1 / 3

export interface HeroCollapse {
  /** 0 with the hero at its natural height, 1 once it has collapsed fully. */
  collapse: number
  /** The collapsed height over the natural height: the picture's scale at `collapse` 1. */
  collapsedScale: number
}

/**
 * How far the phone hero has collapsed at a scroll position.
 *
 * `0` until the page has scrolled the hero to the top of the window, where
 * it sticks, and `1` once it has scrolled on by the hero's natural height
 * less a third of the viewport, linear between, so the hero's bottom edge
 * and the content under it move together: the box loses one pixel of
 * height for each pixel scrolled until it is a third of the screen tall. A
 * hero already no taller than that never collapses.
 *
 * `restingTop` is the hero's top in the document, where it sits unstuck:
 * `0` when the hero is first on the page, and further down when a notice
 * sits above it. The
 * collapse counts from there because a box that shrank before it stuck
 * would open a gap under itself of every pixel scrolled so far: 60 px, with
 * the stale-store notice above the hero at 390x844.
 */
export function heroCollapse(
  scrollY: number,
  naturalHeight: number,
  viewportHeight: number,
  restingTop = 0,
): HeroCollapse {
  const collapsedHeight = viewportHeight * COLLAPSED_VIEWPORT_SHARE
  if (!(naturalHeight > collapsedHeight) || !(collapsedHeight > 0)) return { collapse: 0, collapsedScale: 1 }
  const distance = naturalHeight - collapsedHeight
  return {
    collapse: Math.min(Math.max((scrollY - restingTop) / distance, 0), 1),
    collapsedScale: collapsedHeight / naturalHeight,
  }
}

/**
 * The hero's top in the document while it is not stuck, measured from its
 * parent rather than from itself: a sticky box's own rectangle, and its
 * `offsetTop`, report where it is stuck, not where it would sit. The hero
 * is the first child of `ActivityDetail`'s `.detail`, a flex column with
 * no border, so it sits at the parent's padding offset by its own top
 * margin, with no margin collapsing through the parent.
 */
function restingTopOf(hero: HTMLElement): number {
  const parent = hero.parentElement
  if (parent === null) return 0
  const parentStyle = getComputedStyle(parent)
  return (
    parent.getBoundingClientRect().top +
    window.scrollY +
    (parseFloat(parentStyle.paddingTop) || 0) +
    (parseFloat(getComputedStyle(hero).marginTop) || 0)
  )
}

/** The custom properties the collapse writes on the hero, read by the phone block of `ActivityDetail.module.css`. */
const PROPERTIES = ['--hero-collapse', '--hero-collapsed-scale', '--hero-natural-height'] as const

/**
 * Collapses the activity view's pinned phone hero as the page scrolls - see
 * docs/reference/frontend.md's ActivityDetail and `ActivityDetail.module.css`'s phone
 * block, which turns the three properties written here into the hero's
 * height and its picture's scale.
 *
 * Returns the ref to put on the hero. A callback ref rather than an object
 * one, because the hero remounts under the same view: a new activity keys
 * the `MomentProvider` around it afresh, and an effect keyed on an object
 * ref would go on writing to the old element.
 *
 * The work per scroll frame is one read of `scrollY` and at most one write
 * of `--hero-collapse`, in an animation frame: the natural height is read
 * from a `ResizeObserver` on the picture, the viewport height on `resize`,
 * and the hero's resting top whenever either of those or the document's
 * own size changes (a notice appearing above the hero is one), never
 * measured from the scroll handler, so a frame forces no layout of its own.
 * The collapse gives the height it takes back as margin, so the document's
 * size holds still while the hero collapses and the observer stays quiet. Nothing runs at the desktop layout, where the hero is
 * pinned beside the charts instead, and the properties are removed there so
 * nothing of the collapse survives a window widened past the breakpoint.
 */
export function useHeroCollapse(): (hero: HTMLElement | null) => void {
  const [hero, setHero] = useState<HTMLElement | null>(null)
  const ref = useCallback((element: HTMLElement | null) => setHero(element), [])

  useEffect(() => {
    if (hero === null) return undefined
    const picture = hero.querySelector<HTMLElement>(HERO_PICTURE_SELECTOR)
    if (picture === null) return undefined
    // The collapse is the phone layout's, everything below the desktop one.
    const desktop = window.matchMedia(DESKTOP_LAYOUT_QUERY)

    let naturalHeight = picture.offsetHeight
    let viewportHeight = window.innerHeight
    let restingTop = restingTopOf(hero)
    let frame = 0
    const written = new Map<string, string>()
    const set = (name: string, value: string) => {
      if (written.get(name) === value) return
      written.set(name, value)
      hero.style.setProperty(name, value)
    }
    const clear = () => {
      for (const name of PROPERTIES) hero.style.removeProperty(name)
      written.clear()
    }

    const write = () => {
      frame = 0
      if (desktop.matches) return
      // Not laid out yet: a zero natural height would collapse the hero to
      // nothing, so it keeps its own height until the observer reports one.
      if (!(naturalHeight > 0)) {
        clear()
        return
      }
      const { collapse, collapsedScale } = heroCollapse(window.scrollY, naturalHeight, viewportHeight, restingTop)
      set('--hero-natural-height', `${naturalHeight}px`)
      set('--hero-collapsed-scale', collapsedScale.toFixed(4))
      set('--hero-collapse', collapse.toFixed(4))
    }
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(write)
    }
    const onResize = () => {
      viewportHeight = window.innerHeight
      restingTop = restingTopOf(hero)
      schedule()
    }
    const onLayoutChange = () => {
      if (desktop.matches) clear()
      else schedule()
    }

    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            for (const entry of entries) {
              if (entry.target === picture) naturalHeight = entry.contentRect.height
            }
            restingTop = restingTopOf(hero)
            schedule()
          })
    observer?.observe(picture)
    observer?.observe(document.documentElement)
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', onResize)
    desktop.addEventListener('change', onLayoutChange)
    onLayoutChange()

    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', onResize)
      desktop.removeEventListener('change', onLayoutChange)
      if (frame !== 0) cancelAnimationFrame(frame)
      clear()
    }
  }, [hero])

  return ref
}
