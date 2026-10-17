import { afterEach, describe, expect, it } from 'vitest'
import { clampPopoverLeft, pageGutterPx } from './tagMath'

describe('clampPopoverLeft', () => {
  it('leaves a centred popover alone when it already fits inside both gutters', () => {
    // Item at 500..580 (width 80, centre 540), a 200px popover centred
    // under it spans 440..640, well inside a 1280px window with a 24px
    // gutter, so the offset is just the centring itself: 440 - 500 = -60.
    expect(clampPopoverLeft(500, 80, 200, 1280, 24)).toBe(-60)
  })

  it('pulls a popover on a badge near the left edge back to the gutter', () => {
    // The real 390px-wide case: item at x 24, width 55, popover 320 wide -
    // centred that would start at 24 + 27.5 - 160 = -108.5, off the left
    // edge entirely.
    const offset = clampPopoverLeft(24, 55, 320, 390, 24)
    const itemLeft = 24
    const resultingViewportLeft = itemLeft + offset
    expect(resultingViewportLeft).toBe(24) // pinned to the gutter, not negative
  })

  it('pulls a popover on a badge near the right edge back inside the right gutter', () => {
    const itemLeft = 340
    const itemWidth = 40
    const popoverWidth = 320
    const viewportWidth = 390
    const gutter = 24
    const offset = clampPopoverLeft(itemLeft, itemWidth, popoverWidth, viewportWidth, gutter)
    const resultingViewportRight = itemLeft + offset + popoverWidth
    expect(resultingViewportRight).toBe(viewportWidth - gutter)
  })

  it('falls back to the left gutter rather than an inverted range when the popover is wider than the window minus both gutters', () => {
    const itemLeft = 100
    const itemWidth = 40
    const popoverWidth = 500 // wider than 390 - 2*24 = 342
    const viewportWidth = 390
    const gutter = 24
    const offset = clampPopoverLeft(itemLeft, itemWidth, popoverWidth, viewportWidth, gutter)
    const resultingViewportLeft = itemLeft + offset
    expect(resultingViewportLeft).toBe(gutter)
  })
})

describe('pageGutterPx', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('reads the gutter through <main>\'s own computed padding, not the --gutter custom property\'s raw value', () => {
    // `--gutter` is declared in rem (`theme/tokens.css`) and
    // `getComputedStyle(root).getPropertyValue('--gutter')` hands back the
    // literal string `"1.5rem"` rather than a resolved length - this is
    // the actual bug this function replaces the reading of. `paddingLeft`
    // is an ordinary length property, so jsdom (like every browser)
    // resolves it to a used pixel value against the default 16px root
    // font size: 1.5rem -> 24px.
    const main = document.createElement('main')
    main.style.paddingLeft = '1.5rem'
    document.body.appendChild(main)

    expect(pageGutterPx(document)).toBe(24)
  })

  it('reads the wider desktop gutter the same way', () => {
    const main = document.createElement('main')
    main.style.paddingLeft = '2rem'
    document.body.appendChild(main)

    expect(pageGutterPx(document)).toBe(32)
  })

  it('falls back to 0 when there is no <main> to read from', () => {
    expect(pageGutterPx(document)).toBe(0)
  })
})
