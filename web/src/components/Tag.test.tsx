import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../api/schema'
import { HOVER_CLOSE_GRACE_MS, Tag } from './Tag'
import styles from './Tag.module.css'

type ActivityTag = components['schemas']['ActivityTag']

/** A class the stylesheet defines, which Vitest's module proxy names after the key. */
function css(key: 'reason' | 'reasonVisible'): string {
  const name = styles[key]
  if (name === undefined) throw new Error(`Tag.module.css has no .${key}`)
  return name
}

function effortTag(overrides: Partial<ActivityTag> = {}): ActivityTag {
  return {
    kind: 'effort',
    tag: 'steady',
    distance_key: null,
    rep_count: null,
    rep_pattern: null,
    reason: 'median heart rate 161 bpm, 77.7% of max, no recorded reps',
    ...overrides,
  }
}

function longRunFlag(overrides: Partial<ActivityTag> = {}): ActivityTag {
  return {
    kind: 'flag',
    tag: 'long_run',
    distance_key: null,
    rep_count: null,
    rep_pattern: null,
    reason: '12.0 km, in the top decile of the last 90 days (threshold 11.5 km over 20 runs)',
    ...overrides,
  }
}

/**
 * The grace period past which a `pointerLeave` with no following
 * `pointerEnter` (on either the badge or the popover) actually hides the
 * popover - see `Tag.tsx`'s own `HOVER_CLOSE_GRACE_MS` doc. Fake timers
 * because the real one is long enough to slow the suite for no reason,
 * and because the "does not close" tests need to prove nothing fires
 * even after real time has clearly passed.
 */
function advancePastHoverGrace() {
  act(() => {
    vi.advanceTimersByTime(HOVER_CLOSE_GRACE_MS + 50)
  })
}

/**
 * Past the pointer-focus fallback's own same-task self-expiry
 * (`setTimeout(..., 0)` in `Tag.tsx`'s `handlePointerDown`) - jsdom
 * answers `false` to `CSS.supports('selector(:focus-visible)')`, so every
 * test in this file exercises that fallback rather than the real
 * `:focus-visible` branch, which only a live browser can.
 */
function advancePastPointerFocusExpiry() {
  act(() => {
    vi.advanceTimersByTime(1)
  })
}

describe('Tag', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders each tag as a button carrying its reason as an accessible description', () => {
    render(<Tag tags={[effortTag()]} />)

    const button = screen.getByRole('button', { name: 'Steady' })
    const reason = screen.getByText('median heart rate 161 bpm, 77.7% of max, no recorded reps')
    expect(button).toHaveAccessibleDescription('median heart rate 161 bpm, 77.7% of max, no recorded reps')
    expect(button.getAttribute('aria-describedby')).toBe(reason.id)
  })

  it('keeps the reason visually hidden until the badge is hovered, focused or tapped', () => {
    render(<Tag tags={[effortTag()]} />)

    const reason = screen.getByText('median heart rate 161 bpm, 77.7% of max, no recorded reps')
    expect(reason).toHaveClass(css('reason'))
    expect(reason).not.toHaveClass(css('reasonVisible'))
  })

  it('shows the reason while the badge is hovered, and hides it again once the hover-close grace period has passed', () => {
    render(<Tag tags={[effortTag()]} />)

    const button = screen.getByRole('button', { name: 'Steady' })
    const reason = screen.getByText('median heart rate 161 bpm, 77.7% of max, no recorded reps')

    fireEvent.pointerEnter(button, { pointerType: 'mouse' })
    expect(reason).toHaveClass(css('reasonVisible'))

    fireEvent.pointerLeave(button, { pointerType: 'mouse' })
    expect(reason).toHaveClass(css('reasonVisible')) // still open - within the grace period

    advancePastHoverGrace()
    expect(reason).not.toHaveClass(css('reasonVisible'))
  })

  it('shows the reason on keyboard focus (Tab, with no pointer interaction beforehand)', () => {
    render(<Tag tags={[effortTag()]} />)

    const button = screen.getByRole('button', { name: 'Steady' })
    const reason = screen.getByText('median heart rate 161 bpm, 77.7% of max, no recorded reps')

    fireEvent.focus(button)
    expect(reason).toHaveClass(css('reasonVisible'))

    fireEvent.blur(button)
    expect(reason).not.toHaveClass(css('reasonVisible'))
  })

  it('does not leave the reason open once the pointer leaves after a mouse click - a click-caused focus is not keyboard focus', () => {
    render(<Tag tags={[effortTag()]} />)

    const button = screen.getByRole('button', { name: 'Steady' })
    const reason = screen.getByText('median heart rate 161 bpm, 77.7% of max, no recorded reps')

    // A real click fires in this order: the pointer arrives (hover), then
    // `pointerdown`, then `focus`, then eventually the pointer leaves.
    fireEvent.pointerEnter(button, { pointerType: 'mouse' })
    expect(reason).toHaveClass(css('reasonVisible')) // shown for the hover so far, same as any other hover

    fireEvent.pointerDown(button, { pointerType: 'mouse' })
    fireEvent.focus(button)
    expect(reason).toHaveClass(css('reasonVisible')) // still just the hover holding it open

    fireEvent.pointerLeave(button, { pointerType: 'mouse' })
    advancePastHoverGrace()
    // If the click's `focus` had set `focused`, this would still be open.
    expect(reason).not.toHaveClass(css('reasonVisible'))
  })

  it('shows a later, genuinely separate keyboard focus after a lone pointerdown that no focus or blur ever followed', () => {
    render(<Tag tags={[effortTag()]} />)

    const button = screen.getByRole('button', { name: 'Steady' })
    const reason = screen.getByText('median heart rate 161 bpm, 77.7% of max, no recorded reps')

    // A pointerdown whose click never actually reaches this exact
    // button - no `focus`, no `blur` - so nothing here ever consumes
    // `pointerFocusRef`. Reported: an earlier version left the ref stuck
    // `true`, and the Tab below found it still set and swallowed itself.
    fireEvent.pointerDown(button, { pointerType: 'mouse' })
    advancePastPointerFocusExpiry()

    fireEvent.focus(button)
    expect(reason).toHaveClass(css('reasonVisible'))
  })

  it('shows a later keyboard focus after a press that drags off the badge and releases elsewhere', () => {
    render(
      <>
        <Tag tags={[effortTag()]} />
        <button type="button">Elsewhere</button>
      </>,
    )

    const button = screen.getByRole('button', { name: 'Steady' })
    const reason = screen.getByText('median heart rate 161 bpm, 77.7% of max, no recorded reps')
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' })

    fireEvent.pointerDown(button, { pointerType: 'mouse' })
    fireEvent.pointerUp(elsewhere, { pointerType: 'mouse' })
    advancePastPointerFocusExpiry()

    fireEvent.focus(button)
    expect(reason).toHaveClass(css('reasonVisible'))
  })

  it('toggles open on a touch tap, and closes on a second one', () => {
    render(<Tag tags={[effortTag()]} />)

    const button = screen.getByRole('button', { name: 'Steady' })
    const reason = screen.getByText('median heart rate 161 bpm, 77.7% of max, no recorded reps')

    fireEvent.pointerUp(button, { pointerType: 'touch' })
    expect(reason).toHaveClass(css('reasonVisible'))

    fireEvent.pointerUp(button, { pointerType: 'touch' })
    expect(reason).not.toHaveClass(css('reasonVisible'))
  })

  it("closes on a second touch tap despite the tap's compatibility mouse events, and on Escape", () => {
    render(<Tag tags={[effortTag()]} />)

    const button = screen.getByRole('button', { name: 'Steady' })
    const reason = screen.getByText('median heart rate 161 bpm, 77.7% of max, no recorded reps')

    // A real touch tap, as a touch browser dispatches it: the touch
    // pointer's own sequence, then the compatibility mouse events, whose
    // emulated mouse stays over the badge afterwards - no `mouseout`
    // follows until a tap lands elsewhere.
    function tap() {
      fireEvent.pointerEnter(button, { pointerType: 'touch' })
      fireEvent.pointerDown(button, { pointerType: 'touch' })
      fireEvent.pointerUp(button, { pointerType: 'touch' })
      fireEvent.pointerLeave(button, { pointerType: 'touch' })
      fireEvent.mouseEnter(button)
      fireEvent.mouseDown(button)
      fireEvent.mouseUp(button)
      fireEvent.click(button)
    }

    tap()
    expect(reason).toHaveClass(css('reasonVisible'))

    tap()
    expect(reason).not.toHaveClass(css('reasonVisible'))

    tap()
    expect(reason).toHaveClass(css('reasonVisible'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(reason).not.toHaveClass(css('reasonVisible'))
  })

  it('ignores a mouse pointerup - only a touch tap toggles the open state', () => {
    render(<Tag tags={[effortTag()]} />)

    const button = screen.getByRole('button', { name: 'Steady' })
    const reason = screen.getByText('median heart rate 161 bpm, 77.7% of max, no recorded reps')

    fireEvent.pointerUp(button, { pointerType: 'mouse' })
    expect(reason).not.toHaveClass(css('reasonVisible'))
  })

  it('closes a tapped-open reason on Escape', () => {
    render(<Tag tags={[effortTag()]} />)

    const button = screen.getByRole('button', { name: 'Steady' })
    const reason = screen.getByText('median heart rate 161 bpm, 77.7% of max, no recorded reps')

    fireEvent.pointerUp(button, { pointerType: 'touch' })
    expect(reason).toHaveClass(css('reasonVisible'))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(reason).not.toHaveClass(css('reasonVisible'))
  })

  it('closes a reason shown by keyboard focus on Escape, without moving focus off the button (WCAG 1.4.13 Dismissible)', () => {
    render(<Tag tags={[effortTag()]} />)

    const button = screen.getByRole('button', { name: 'Steady' })
    const reason = screen.getByText('median heart rate 161 bpm, 77.7% of max, no recorded reps')

    // `.focus()`/`.blur()` inside `act` rather than `fireEvent.focus`/
    // `fireEvent.blur`: `fireEvent` only dispatches the synthetic event
    // and never moves jsdom's own `document.activeElement`, which is
    // exactly what this test needs to observe to prove Escape didn't move
    // it either.
    act(() => button.focus())
    expect(reason).toHaveClass(css('reasonVisible'))
    expect(button).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(reason).not.toHaveClass(css('reasonVisible'))
    expect(button).toHaveFocus() // still focused - Escape hid the popover, not the button

    // Blurring and refocusing is a fresh interaction, so it shows again.
    act(() => button.blur())
    act(() => button.focus())
    expect(reason).toHaveClass(css('reasonVisible'))
  })

  it('closes a reason shown by hover on Escape, and shows it again on a later hover (WCAG 1.4.13 Dismissible)', () => {
    render(<Tag tags={[effortTag()]} />)

    const button = screen.getByRole('button', { name: 'Steady' })
    const reason = screen.getByText('median heart rate 161 bpm, 77.7% of max, no recorded reps')

    fireEvent.pointerEnter(button, { pointerType: 'mouse' })
    expect(reason).toHaveClass(css('reasonVisible'))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(reason).not.toHaveClass(css('reasonVisible'))

    // A genuinely fresh hover - the pointer actually leaves for longer
    // than the grace period, not a jitter within it - clears `dismissed`.
    fireEvent.pointerLeave(button, { pointerType: 'mouse' })
    advancePastHoverGrace()
    fireEvent.pointerEnter(button, { pointerType: 'mouse' })
    expect(reason).toHaveClass(css('reasonVisible'))
  })

  it('lets the pointer move from the badge onto the popover without it closing, so a long reason can be read (WCAG 1.4.13 Hoverable)', () => {
    render(<Tag tags={[longRunFlag()]} />)

    const button = screen.getByRole('button', { name: 'Long run' })
    const reason = screen.getByText('12.0 km, in the top decile of the last 90 days (threshold 11.5 km over 20 runs)')

    fireEvent.pointerEnter(button, { pointerType: 'mouse' })
    expect(reason).toHaveClass(css('reasonVisible'))

    // The pointer leaves the badge and arrives on the popover itself,
    // faster than the grace period - the realistic case this exists for.
    fireEvent.pointerLeave(button, { pointerType: 'mouse' })
    fireEvent.pointerEnter(reason, { pointerType: 'mouse' })
    advancePastHoverGrace() // the leave's own timeout, if not cancelled, would have fired by now
    expect(reason).toHaveClass(css('reasonVisible'))

    // Leaving the popover too, with the badge not re-entered, closes it
    // once the grace period passes.
    fireEvent.pointerLeave(reason, { pointerType: 'mouse' })
    expect(reason).toHaveClass(css('reasonVisible'))
    advancePastHoverGrace()
    expect(reason).not.toHaveClass(css('reasonVisible'))
  })

  it('closes a tapped-open reason on a tap elsewhere', () => {
    render(
      <>
        <Tag tags={[effortTag()]} />
        <button type="button">Elsewhere</button>
      </>,
    )

    const button = screen.getByRole('button', { name: 'Steady' })
    const reason = screen.getByText('median heart rate 161 bpm, 77.7% of max, no recorded reps')
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' })

    fireEvent.pointerUp(button, { pointerType: 'touch' })
    expect(reason).toHaveClass(css('reasonVisible'))

    fireEvent.pointerDown(elsewhere)
    expect(reason).not.toHaveClass(css('reasonVisible'))
  })

  it("keeps two badges' reasons independent", () => {
    render(<Tag tags={[effortTag(), longRunFlag()]} />)

    const effortButton = screen.getByRole('button', { name: 'Steady' })
    const effortReason = screen.getByText('median heart rate 161 bpm, 77.7% of max, no recorded reps')
    const flagReason = screen.getByText(
      '12.0 km, in the top decile of the last 90 days (threshold 11.5 km over 20 runs)',
    )

    fireEvent.pointerEnter(effortButton, { pointerType: 'mouse' })
    expect(effortReason).toHaveClass(css('reasonVisible'))
    expect(flagReason).not.toHaveClass(css('reasonVisible'))
  })

  it('renders the effort tag and every flag on one row', () => {
    render(<Tag tags={[effortTag(), longRunFlag()]} />)

    expect(screen.getByRole('button', { name: 'Steady' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Long run' })).toBeInTheDocument()
  })

  it('renders nothing when there is no effort tag and no flag', () => {
    const { container } = render(<Tag tags={[]} />)

    expect(container).toBeEmptyDOMElement()
  })
})
