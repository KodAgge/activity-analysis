import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { FocusEvent as ReactFocusEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { components } from '../api/schema'
import { effortTagLabel } from '../format'
import { Badge } from './Badge'
import styles from './Tag.module.css'
import { clampPopoverLeft, pageGutterPx } from './tagMath'

type ActivityTag = components['schemas']['ActivityTag']

export interface TagProps {
  /** `derived.tags`, verbatim - the analysis layer's own list, never recomputed here. */
  tags: ActivityTag[]
}

const FLAG_LABEL: Record<string, string> = {
  pr: 'PR',
  long_run: 'Long run',
}

function flagLabel(tag: string): string {
  return FLAG_LABEL[tag] ?? tag
}

// See `ReasonBadge`'s own "Hoverable" doc for why this has to be a grace
// period rather than an instant hide. Exported so `Tag.test.tsx` advances
// fake timers by the same value rather than a hardcoded, driftable copy of
// it - the same reason `views/Activities.tsx` exports `QUERY_DEBOUNCE_MS`.
export const HOVER_CLOSE_GRACE_MS = 200

/**
 * Whether this engine recognises `:focus-visible` as a selector at all -
 * not whether it currently matches. jsdom's own `.matches(':focus-visible')`
 * always answers `false`, on every element in every state, which is
 * silently indistinguishable from "this really is a click, not keyboard
 * focus" - confirmed directly: even a plain, programmatic `.focus()` call
 * in jsdom reports `false`. `CSS.supports('selector(...)')` is the
 * feature-detection built for exactly this, because it answers whether
 * the *syntax* is understood, independent of any element's current state
 * - confirmed the other way too: jsdom answers `false` to it, where
 * Chromium, Firefox and Safari all answer `true`. `ReasonBadge` trusts the
 * browser's own signal when this is `true` and falls back to
 * `pointerFocusRef` only when it is not.
 */
const supportsFocusVisible = (() => {
  try {
    return (
      typeof CSS !== 'undefined' &&
      typeof CSS.supports === 'function' &&
      CSS.supports('selector(:focus-visible)')
    )
  } catch {
    return false
  }
})()

interface ReasonBadgeProps {
  reason: string
  children: ReactNode
}

/**
 * One badge, wrapped in a button that owns its reason as a popover.
 *
 * The reason lives beside the button at all times - `aria-describedby`
 * points at it whether or not it is shown - and is only ever visually
 * hidden, never unmounted, the same `clip-path` trick
 * `RouteHero.module.css`'s `.srOnly` uses. `visible` follows this
 * codebase's own established pattern for a hover readout
 * (`charts/ProgressionScatter.tsx`'s `hoveredId`): plain hover and
 * `onFocus` state rather than a CSS `:hover` selector, because a CSS
 * pseudo-class cannot be asserted from a test run against mocked
 * stylesheets, and because a touch tap needs the same visibility this
 * state already drives.
 *
 * **Only a mouse or pen hovers.** `hovered` follows `pointerenter` /
 * `pointerleave` and ignores a touch pointer, rather than following
 * `mouseenter` / `mouseleave`: a touch browser fires compatibility mouse
 * events on a tap, and the emulated mouse stays over the badge after it, so
 * a second tap cleared `open` and left `hovered` holding the popover up. A
 * tap therefore goes through `open` alone.
 *
 * **Only keyboard focus shows it, not a mouse click.** Where the engine
 * itself understands `:focus-visible` (`supportsFocusVisible` - every
 * evergreen browser), `handleFocus` asks the browser's own signal via
 * `event.currentTarget.matches(':focus-visible')` rather than guessing:
 * the browser already knows whether this exact focus arrived by keyboard
 * or by pointer, and it is the one thing checked at that instant, not
 * carried as state.
 *
 * Where it does not (jsdom, and any engine `supportsFocusVisible` answers
 * `false` for), `pointerFocusRef` reconstructs the same distinction by
 * hand: `handlePointerDown` sets it for a `pointerdown` of any kind, and
 * `handleFocus`'s fallback branch consumes it - reads and clears it -
 * rather than setting `focused`, so a focus with no preceding
 * `pointerdown` (Tab) still shows it. **The ref cannot be left standing
 * on a consumer that never runs.** A press that drags off the badge and
 * releases elsewhere never focuses or blurs this exact button at all, so
 * neither `handleFocus` nor `handleBlur` would ever clear it, and a later,
 * wholly unrelated Tab-focus on this same badge would find it still
 * `true` and be wrongly swallowed - reported and reproduced against an
 * earlier version of this fallback, which cleared the ref only on this
 * button's own `focus` or `blur`. `handlePointerDown` therefore also
 * schedules a same-task self-expiry (`setTimeout(..., 0)`): a real click's
 * `focus` still runs synchronously before that timer ever fires, so the
 * ordinary suppression is unaffected, and a pointerdown with no focus to
 * consume it clears itself well before any later, genuinely separate
 * keyboard interaction can reach it.
 *
 * **Hoverable (WCAG 1.4.13).** The popover sits flush against its badge
 * (`Tag.module.css`'s `.reasonVisible` sets no gap) so there is no dead
 * pixel between them geometrically, and both the badge and the popover
 * itself feed the same `hovered` state, so a reader can move the pointer
 * from one onto the other - which a long reason needs room to be read.
 * That alone is not enough: `hovered` is state, and leaving the badge
 * re-renders the popover down to its 1x1 hidden box before a real pointer,
 * moving at a measured pace, can physically arrive at the larger one that
 * used to be there - confirmed live, not assumed: instrumenting the
 * actual events during a slow, deliberate move from the badge onto its
 * own popover showed the popover collapsing mid-transit and the pointer
 * arriving at nothing. `HOVER_CLOSE_GRACE_MS` is a grace period rather
 * than an instant hide, holding `hovered` true across exactly that gap;
 * `cancelHoverClose` clears it the moment either element is entered, so a
 * reader who really is leaving still sees it close within the grace
 * window rather than lingering.
 *
 * **Dismissible (WCAG 1.4.13).** `Escape` hides a popover shown by hover
 * or focus without moving focus off the button - `dismissed` suppresses
 * it while the same hover or focus continues, and clears again only once
 * both have cleared, so the *next* hover or focus shows it fresh. A
 * popover tapped open on a touch device is a different affordance
 * (`open`), and `Escape` there still fully closes and blurs it, the same
 * as a tap elsewhere.
 *
 * A tap is read from `pointerup` rather than `click`, because a touch
 * device fires both hover-shaped and click-shaped synthetic events on the
 * same tap and `pointerType` is the one signal that says which kind of
 * pointer this actually was. Closing also blurs the button so a lingering
 * focus state left by the tap itself does not keep the popover open after
 * `open` has gone false.
 */
function ReasonBadge({ reason, children }: ReasonBadgeProps) {
  const reasonId = useId()
  const containerRef = useRef<HTMLSpanElement>(null)
  const popoverRef = useRef<HTMLSpanElement>(null)
  const pointerFocusRef = useRef(false)
  const pointerFocusExpiryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [popoverLeftPx, setPopoverLeftPx] = useState<number | null>(null)

  const close = useCallback(() => {
    setOpen(false)
    const active = document.activeElement
    if (active instanceof HTMLElement && containerRef.current?.contains(active)) {
      active.blur()
    }
  }, [])

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== 'touch') return
    setOpen((wasOpen) => !wasOpen)
  }, [])

  const clearPointerFocusExpiry = useCallback(() => {
    if (pointerFocusExpiryRef.current === null) return
    clearTimeout(pointerFocusExpiryRef.current)
    pointerFocusExpiryRef.current = null
  }, [])

  const handlePointerDown = useCallback(() => {
    pointerFocusRef.current = true
    clearPointerFocusExpiry()
    pointerFocusExpiryRef.current = setTimeout(() => {
      pointerFocusExpiryRef.current = null
      pointerFocusRef.current = false
    }, 0)
  }, [clearPointerFocusExpiry])

  const handleFocus = useCallback(
    (event: ReactFocusEvent<HTMLButtonElement>) => {
      if (supportsFocusVisible) {
        if (event.currentTarget.matches(':focus-visible')) setFocused(true)
        return
      }
      if (pointerFocusRef.current) {
        pointerFocusRef.current = false
        clearPointerFocusExpiry()
        return
      }
      setFocused(true)
    },
    [clearPointerFocusExpiry],
  )

  const handleBlur = useCallback(() => {
    pointerFocusRef.current = false
    clearPointerFocusExpiry()
    setFocused(false)
  }, [clearPointerFocusExpiry])

  useEffect(() => clearPointerFocusExpiry, [clearPointerFocusExpiry])

  const cancelHoverClose = useCallback(() => {
    if (hoverCloseTimeoutRef.current === null) return
    clearTimeout(hoverCloseTimeoutRef.current)
    hoverCloseTimeoutRef.current = null
  }, [])

  const handleHoverEnter = useCallback(
    (event: ReactPointerEvent) => {
      if (event.pointerType === 'touch') return
      cancelHoverClose()
      setHovered(true)
    },
    [cancelHoverClose],
  )

  const handleHoverLeave = useCallback(
    (event: ReactPointerEvent) => {
      if (event.pointerType === 'touch') return
      cancelHoverClose()
      hoverCloseTimeoutRef.current = setTimeout(() => {
        hoverCloseTimeoutRef.current = null
        setHovered(false)
      }, HOVER_CLOSE_GRACE_MS)
    },
    [cancelHoverClose],
  )

  useEffect(() => cancelHoverClose, [cancelHoverClose])

  // The interaction currently engaging this badge, regardless of whether
  // `dismissed` is suppressing the popover it would otherwise show.
  const engaged = hovered || focused || open

  // Once every trigger has cleared, a later hover or focus shows the
  // popover again - so `dismissed` only outlives the interaction Escape
  // was pressed during, not every interaction after it.
  useEffect(() => {
    if (!hovered && !focused) setDismissed(false)
  }, [hovered, focused])

  useEffect(() => {
    if (!engaged) return undefined
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      if (open) {
        close()
      } else {
        setDismissed(true)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [engaged, open, close])

  useEffect(() => {
    if (!open) return undefined

    function handlePointerDownOutside(event: PointerEvent) {
      if (event.target instanceof Node && containerRef.current?.contains(event.target)) return
      close()
    }

    document.addEventListener('pointerdown', handlePointerDownOutside)
    return () => document.removeEventListener('pointerdown', handlePointerDownOutside)
  }, [open, close])

  const visible = open || (!dismissed && (hovered || focused))

  // Clamps the popover's own `left` inside the page gutter - see
  // `tagMath.clampPopoverLeft`. A plain function rather than a memoized
  // `useCallback`: it only ever reads the DOM through the refs above, so
  // recreating it every render costs nothing, and the two effects below
  // call it directly rather than listing it as a dependency, the same way
  // `charts/UPlot.tsx` and `charts/ProgressionScatter.tsx` silence
  // `exhaustive-deps` for a ref-only helper.
  function computePopoverLeft(): number | null {
    const item = containerRef.current
    const popover = popoverRef.current
    if (item === null || popover === null) return null
    const itemRect = item.getBoundingClientRect()
    const popoverWidth = popover.getBoundingClientRect().width
    if (itemRect.width === 0 || popoverWidth === 0) return null
    return clampPopoverLeft(itemRect.left, itemRect.width, popoverWidth, window.innerWidth, pageGutterPx())
  }

  // `useLayoutEffect` so the reader never sees the unclamped, centred
  // position for a frame: it measures and, if needed, corrects the
  // position before the browser paints. jsdom has no layout, so
  // `itemRect.width` and `popoverWidth` are always 0 there and this leaves
  // `popoverLeftPx` at its default `null`, which is the plain centred CSS
  // rule `Tag.module.css`'s `.reasonVisible` already carries.
  useLayoutEffect(() => {
    const next = visible ? computePopoverLeft() : null
    setPopoverLeftPx((previous) => (previous === next ? previous : next))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- computePopoverLeft only reads refs
  }, [visible])

  useEffect(() => {
    if (!visible) return undefined
    function recompute() {
      const next = computePopoverLeft()
      setPopoverLeftPx((previous) => (previous === next ? previous : next))
    }
    window.addEventListener('resize', recompute)
    return () => window.removeEventListener('resize', recompute)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- computePopoverLeft only reads refs
  }, [visible])

  return (
    <span className={styles.item} ref={containerRef}>
      <button
        type="button"
        className={styles.trigger}
        aria-describedby={reasonId}
        onPointerEnter={handleHoverEnter}
        onPointerLeave={handleHoverLeave}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
      >
        {children}
      </button>
      <span
        ref={popoverRef}
        id={reasonId}
        role="tooltip"
        className={`${styles.reason} ${visible ? styles.reasonVisible : ''}`}
        style={popoverLeftPx === null ? undefined : { left: `${String(popoverLeftPx)}px`, transform: 'none' }}
        onPointerEnter={handleHoverEnter}
        onPointerLeave={handleHoverLeave}
      >
        {reason}
      </span>
    </span>
  )
}

/**
 * The header's automatic tag: the one `kind: "effort"` row, if there is one,
 * plus every additive `kind: "flag"` row (a personal record, a long run).
 *
 * `derived.tags` carries no `effort` row on 86 of the 307 real runs (see
 * docs/reference/api.md) - 84 with no heart rate at all and two more with
 * heart rate but no maximum HR in the athlete profile interval covering
 * them - and this renders no effort badge at all for those rather than
 * guessing a tag: a classifier whose reasoning is hidden, or whose absence
 * is papered over, stops being trusted the first time it is wrong. Some of
 * those 86 still carry `flag` rows (a run with no effort tag can still be a
 * personal record), so the array itself is empty on a smaller 57 of the
 * 307, not on all 86. `reason` is prose meant for display and is explicitly
 * not a parsing surface (see `ActivityTag`'s own docstring), so it is shown
 * verbatim and never inspected.
 *
 * Every badge, effort first then the flags, sits on one wrapping row, and
 * each carries its reason in a popover rather than as text beside it - see
 * the comment above `<Tag>` in `views/ActivityDetail.tsx` for why.
 */
export function Tag({ tags }: TagProps) {
  const effort = tags.find((tag) => tag.kind === 'effort')
  const flags = tags.filter((tag) => tag.kind === 'flag')

  if (effort === undefined && flags.length === 0) return null

  return (
    <div className={styles.tags}>
      {effort !== undefined && (
        // A stable, real accessibility label rather than a test-only data
        // attribute: it names the region for a screen reader and gives
        // tests the same handle for free.
        <div className={styles.effort} aria-label="Automatic effort tag">
          <ReasonBadge reason={effort.reason}>
            <Badge tone="accent">{effortTagLabel(effort.tag)}</Badge>
          </ReasonBadge>
        </div>
      )}
      {flags.length > 0 && (
        <ul className={styles.flagList} aria-label="Automatic flags">
          {flags.map((flag, index) => (
            // A `pr` row's own identity is `tag` + `distance_key`, not the
            // index - but `distance_key` is null on any future flag kind
            // that is not about one distance, so the index breaks that tie
            // rather than assuming every flag has one.
            <li key={`${flag.tag}-${flag.distance_key ?? String(index)}`} className={styles.flag}>
              <ReasonBadge reason={flag.reason}>
                <Badge>{flagLabel(flag.tag)}</Badge>
              </ReasonBadge>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
