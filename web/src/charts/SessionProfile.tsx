import { useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import type { Session } from '../components/plan/planMath'
import { KIND_MARK, kindSlotClass } from '../components/plan/sessionMarks'
import { NO_VALUE, elapsedMinutesLabel, speedRangeAsPace, stepAmount, stepRoleLabel } from '../format'
import { isHard, profileDescription, readoutBeside, segmentReadout, sessionProfile, timeTicks } from './sessionProfileMath'
import type { ProfileGroup, ProfileRole, ProfileSegment, SessionProfileOptions } from './sessionProfileMath'
import { usePanelWidth } from './usePanelWidth'
import styles from './SessionProfile.module.css'

export interface SessionProfileProps extends SessionProfileOptions {
  session: Session
  /**
   * `full` in the session's detail, with a time axis, labels on the work
   * sets, a key and a readout; `mini` in a calendar day, a bare sparkline.
   */
  size: 'full' | 'mini'
  /** The zone boundaries in bpm, so the readout labels a heart rate target with its zone, as the step list does. */
  zoneBoundaries?: readonly number[] | null
}

/** The mini's fills: a calendar day's sparkline, unchanged by the full one's key. */
const ROLE_CLASS: Readonly<Record<ProfileRole, string | undefined>> = {
  warmup: styles.soft,
  cooldown: styles.soft,
  work: styles.work,
  strides: styles.strides,
  recovery: styles.recovery,
}

/**
 * The full profile's fills: two tones, Runna's hard against easy, as its
 * key names them. Easy running, whatever its role, is a tint under a cap;
 * hard running, the strides and any stretch drawn well faster than easy
 * (`sessionProfileMath.isHard`), is solid. The hue is the effort's own
 * kind (`effortSlot`). An easy run's whole distance is a work step, and is
 * easy running all the same.
 */
type FullTone = 'easy' | 'fast'
function toneOf(s: ProfileSegment, easyMps: number | null): FullTone {
  return !s.gap && isHard(s.role, s.speedMps, easyMps) ? 'fast' : 'easy'
}
const TONE_CLASS: Readonly<Record<FullTone, string | undefined>> = {
  easy: styles.easy,
  fast: styles.work,
}
/**
 * The slot a full-profile segment is coloured in: the kind of effort it
 * is, as the calendar's key names kinds. The work is the session's own
 * kind, the strides are strides, and the easy running around them, the
 * warm-up, recoveries, cool-down and the walks between strides, is easy.
 * A colour on this chart then means what it means in the key above it:
 * an interval session's reps are the intervals colour rising out of the
 * easy colour, never a paler copy of their own.
 */
function effortSlot(s: ProfileSegment, kind: Session['kind']): string {
  if (s.gap) return kindSlotClass('easy')
  if (s.role === 'strides') return kindSlotClass('strides')
  if (s.role === 'work') return kindSlotClass(kind)
  return kindSlotClass('easy')
}

/** The easy tone's cap: the kind along a segment's top, so the pale tint reads on white. */
const CAP_PX = 2
/** The roles in the order the key names them in each tone. */
const KEY_ORDER: Readonly<Record<FullTone, readonly ProfileRole[]>> = {
  easy: ['warmup', 'work', 'recovery', 'cooldown', 'strides'],
  fast: ['work', 'strides', 'warmup', 'recovery', 'cooldown'],
}

const FALLBACK_WIDTH = { full: 600, mini: 120 } as const
/** The full profile's rows: labels over the sets, the plot, then the time axis. */
const PLOT_HEIGHT = { full: 120, mini: 18 } as const
/**
 * The full profile's plot ends at its tallest stretch, on the plan's
 * shared scale, so a long run is a low band and not a tall empty box;
 * never lower than this.
 */
const FULL_PLOT_MIN = 40
/** A set label's height over its baseline, `--text-small`, for the room it needs over its set. */
const LABEL_TEXT_PX = 14
/**
 * The full profile is a chart and not a strip: 120px of plot on a phone,
 * growing with its width past 700px at 17% of it, to 176px at 1035px and
 * wider, a desktop card's.
 */
const FULL_PLOT_GROWTH = 0.17
const FULL_PLOT_MAX = 176
/** The time axis under the plot, its labels at `--text-small`. */
const AXIS_BAND = 24
/**
 * A set label's width per character, `--text-small` bold: the label is the
 * chart's one headline, read at the size of the steps' notes. Measured on
 * `6 × 800 m @ 4:15-4:20` in Schibsted Grotesk, about 7.5px a character;
 * rounded up so a label that only just fits is dropped rather than clipped.
 */
const SET_LABEL_CHAR_PX = 8
/** The least room a set label leaves beside it within its set, so it never touches the strides before it. */
const SET_LABEL_AIR_PX = 24
/** The air between two segments, so reps read as reps; little in the mini, where it would eat a stride. */
const SEGMENT_GAP_PX = { full: 2, mini: 0.5 } as const
/** The narrowest a mini's segment is drawn, so a stride stays visible in a calendar day. */
const MINI_MIN_SEGMENT_PX = 1
/** The narrowest a full profile's stride is drawn, a spike rather than a hairline. */
const STRIDE_MIN_PX = 4
/** The least room a walk between two strides keeps, the air between their spikes. */
const WALK_MIN_PX = 2
const LABEL_GAP_PX = 4
const TICK_LENGTH = 4

/**
 * A session as a workout profile: its stretches end to end in time, each
 * as tall as it is fast (`sessionProfileMath`).
 *
 * The full size draws Runna's two tones, hard against easy, each stretch
 * in the colour of its own kind of effort (`effortSlot`): easy running as
 * a tint under a cap, hard running solid, the strides as spikes rising
 * from the easy ground, the walks between them drawn as that ground. Its plot ends at the session's
 * tallest stretch on the plan's shared scale, so a long run is a low band.
 * The mini keeps a calendar day's slate warm-up and cool-down, grey
 * recoveries and ink strides.
 *
 * The full size names itself with the session in words, labels each work
 * set with its pace per kilometre where the label fits, keys what it draws
 * and reads a segment
 * out under the pointer or the keyboard's cursor, through the readout the
 * app's charts share: out of flow, hidden from a screen reader, which has
 * the name instead. It stands beside the pointer, or the focused segment,
 * on the panel's foot, so it covers neither the key under the chart nor
 * the segment it reads. The mini is a sparkline for a calendar day, hidden
 * from a screen reader since the day's button names the session and opens
 * the full one.
 *
 * Plain SVG, its viewBox the measured width, as `PlanVolume`. Draws
 * nothing for a session with nothing to draw, a rest day among them.
 */
export function SessionProfile({ session, size, easyMps = null, scale = null, zoneBoundaries = null }: SessionProfileProps) {
  const [panelRef, measured] = usePanelWidth<HTMLElement>()
  const [active, setActive] = useState<number | null>(null)
  /** Where the pointer is across the panel, the readout's anchor; null for the keyboard's cursor. */
  const [pointerPx, setPointerPx] = useState<number | null>(null)
  const readoutRef = useRef<HTMLDivElement | null>(null)
  const [readoutWidthPx, setReadoutWidthPx] = useState(0)
  const profile = sessionProfile(session, { easyMps, scale })
  const segment = active === null ? undefined : profile?.segments[active]

  useLayoutEffect(() => {
    const element = readoutRef.current
    if (element === null) return
    const w = element.offsetWidth
    setReadoutWidthPx((previous) => (previous === w ? previous : w))
  }, [segment])

  if (profile === null) return null
  const full = size === 'full'
  const width = measured > 0 ? measured : FALLBACK_WIDTH[size]
  // The scale's height in px: a stretch at the top of the plan's scale
  // stands this tall. The full plot stops at the session's tallest stretch.
  const plotHeight = full
    ? Math.round(Math.min(FULL_PLOT_MAX, Math.max(PLOT_HEIGHT.full, width * FULL_PLOT_GROWTH)))
    : PLOT_HEIGHT.mini
  const tallest = Math.max(...profile.segments.map((s) => s.height))
  const drawnHeight = full ? Math.max(FULL_PLOT_MIN, Math.ceil(tallest * plotHeight)) : plotHeight
  const labels = full ? setLabels(session, profile.groups, width) : []
  // Room over the plot only where a set's label stands higher than it.
  const plotTop = Math.max(
    0,
    ...labels.map((l) => LABEL_TEXT_PX + LABEL_GAP_PX - (drawnHeight - l.height * plotHeight)),
  )
  const plotBottom = plotTop + drawnHeight
  const height = full ? plotBottom + AXIS_BAND : plotHeight
  const gap = SEGMENT_GAP_PX[size]
  const kind = kindSlotClass(session.kind)

  const slots = full ? fullSlots(profile.segments, width) : profile.segments.map((s) => ({ x: s.x * width, w: s.width * width }))
  const rects = profile.segments.map((s, i) => {
    const slot = slots[i] ?? { x: s.x * width, w: s.width * width }
    if (!full) {
      const h = s.height * plotHeight
      return { s, i, x: slot.x + gap / 2, y: plotBottom - h, w: Math.max(MINI_MIN_SEGMENT_PX, slot.w - gap), h }
    }
    if (s.gap) {
      // A walk between strides is the easy ground they rise from: as tall
      // as the stretch before the strides, reaching under the spikes' air.
      const h = baseHeight(profile.segments, i) * plotHeight
      return { s, i, x: slot.x - gap / 2, y: plotBottom - h, w: slot.w + gap, h }
    }
    const h = s.height * plotHeight
    return { s, i, x: slot.x + gap / 2, y: plotBottom - h, w: Math.max(1, slot.w - gap), h }
  })
  // The walks first, so the spikes they reach under paint over them.
  const drawn = full ? [...rects.filter((r) => r.s.gap), ...rects.filter((r) => !r.s.gap)] : rects

  const svg = (
    <svg
      className={styles.svg}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      // The mini fills its cell at a fixed height and stretches to it, so
      // a cell measured late never draws it at the wrong size; it has no
      // text to distort. The full one is drawn at its measured width.
      width={full ? undefined : '100%'}
      height={full ? undefined : height}
      preserveAspectRatio={full ? undefined : 'none'}
      aria-hidden={full ? undefined : 'true'}
      role={full ? 'img' : undefined}
      aria-label={full ? `Workout profile: ${profileDescription(session, profile)}.` : undefined}
    >
      {full && <line className={styles.baseline} x1={0} x2={width} y1={plotBottom + 0.5} y2={plotBottom + 0.5} />}
      {drawn.map(({ s, i, x, y, w, h }) => (
        <g key={i}>
          <rect
            className={[
              full ? TONE_CLASS[toneOf(s, easyMps)] : ROLE_CLASS[s.role],
              full ? effortSlot(s, session.kind) : null,
              i === active ? styles.active : null,
            ]
              .filter(Boolean)
              .join(' ')}
            data-mark="segment"
            data-role={s.role}
            x={x}
            y={y}
            width={w}
            height={h}
            rx={full ? 2 : 0.5}
          />
          {full && toneOf(s, easyMps) === 'easy' && h > CAP_PX && (
            <rect className={`${styles.cap} ${effortSlot(s, session.kind)}`} x={x} y={y} width={w} height={CAP_PX} rx={1} />
          )}
        </g>
      ))}
      {labels.map((l) => (
        <text
          key={l.group}
          className={styles.setLabel}
          data-label="set"
          x={l.centre}
          y={plotBottom - l.height * plotHeight - LABEL_GAP_PX}
          textAnchor="middle"
        >
          {l.text}
        </text>
      ))}
      {full &&
        timeTicks(profile.totalS, width).map((t) => {
          const x = (t / profile.totalS) * width
          const anchor = x < 1 ? 'start' : x > width - 1 ? 'end' : 'middle'
          return (
            <g key={t}>
              <line className={styles.tick} x1={x} x2={x} y1={plotBottom} y2={plotBottom + TICK_LENGTH} />
              <text className={styles.axisLabel} x={x} y={height - 3} textAnchor={anchor}>
                {elapsedMinutesLabel(t)}
              </text>
            </g>
          )
        })}
    </svg>
  )

  if (!full) {
    // A span, since the calendar draws it inside a session's button.
    return (
      <span className={`${styles.mini} ${kind}`} ref={panelRef}>
        {svg}
      </span>
    )
  }

  const count = profile.segments.length
  const move = (by: number) => setActive((i) => Math.min(count - 1, Math.max(0, (i ?? 0) + by)))
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    setPointerPx(null)
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      move(event.key === 'ArrowRight' ? 1 : -1)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setActive(event.key === 'Home' ? 0 : count - 1)
    }
  }
  function clear(): void {
    setActive(null)
    setPointerPx(null)
  }
  // Only a pointer over the bars' band and inside the session reads a
  // segment out; over the labels, the axis or past the end it reads none.
  function handleMouseMove(event: MouseEvent<HTMLDivElement>): void {
    const box = event.currentTarget.querySelector('svg')?.getBoundingClientRect()
    if (box === undefined || box.width <= 0 || box.height <= 0 || profile === null) return
    const x = ((event.clientX - box.left) / box.width) * width
    const y = ((event.clientY - box.top) / box.height) * height
    const index = y < plotTop || y > plotBottom ? null : slotAt(slots, x)
    if (index === null) {
      clear()
      return
    }
    setActive(index)
    setPointerPx(x)
  }

  const shown = segment === undefined ? null : segmentReadout(session, segment, zoneBoundaries)
  const activeSlot = active === null ? undefined : slots[active]
  const anchor = pointerPx ?? (activeSlot === undefined ? 0 : activeSlot.x + activeSlot.w / 2)
  const key = keyEntries(profile.segments, easyMps, session.kind)

  return (
    <div className={`${styles.profile} ${kind}`}>
      <div
        className={styles.panel}
        ref={panelRef}
        role="group"
        aria-label="Workout steps"
        // The arrow keys walk the segments for a sighted keyboard user;
        // a screen reader has the whole session in the chart's name.
        tabIndex={0}
        onFocus={() => setActive((i) => i ?? 0)}
        onBlur={clear}
        onKeyDown={handleKeyDown}
        onMouseMove={handleMouseMove}
        onMouseLeave={clear}
      >
        {svg}
        {shown !== null && (
          <div
            ref={readoutRef}
            className={styles.readout}
            style={{ left: `${String(readoutBeside(anchor, readoutWidthPx, width))}px` }}
            aria-hidden="true"
            data-testid="profile-readout"
          >
            <p className={styles.readoutWhen}>{shown.heading}</p>
            {shown.rows.map((row, i) => (
              <p key={i} className={styles.readoutRow}>
                {row}
              </p>
            ))}
          </div>
        )}
      </div>
      {key.length > 1 && (
        <ul className={styles.legend} aria-label="Key">
          {key.map((k) => (
            <li key={`${k.tone} ${k.slot}`}>
              <span
                aria-hidden="true"
                className={`${styles.swatch} ${k.slot} ${k.tone === 'easy' ? `${KIND_MARK.tint} ${styles.swatchEasy ?? ''}` : ''}`}
              />
              {k.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** A segment's room across the full profile, in px. */
interface Slot {
  x: number
  w: number
}

/**
 * The full profile's segments across `width` px, end to end in time, but
 * a stride at least `STRIDE_MIN_PX` and its own air wide and a walk between
 * two at least `WALK_MIN_PX`, so four 20 s strides read as four spikes and
 * not as hairlines on a phone. What they gain comes off the other segments
 * in proportion to their widths.
 */
function fullSlots(segments: readonly ProfileSegment[], width: number): Slot[] {
  const natural = segments.map((s) => s.width * width)
  const least = segments.map((s) => (s.role === 'strides' ? STRIDE_MIN_PX + SEGMENT_GAP_PX.full : s.gap ? WALK_MIN_PX : 0))
  const gained = natural.reduce((sum, n, i) => sum + Math.max(0, (least[i] ?? 0) - n), 0)
  const rest = natural.reduce((sum, n, i) => ((least[i] ?? 0) > 0 ? sum : sum + n), 0)
  const shrink = rest > gained ? (rest - gained) / rest : 1
  let x = 0
  return natural.map((n, i) => {
    const min = least[i] ?? 0
    const w = min > 0 ? Math.max(n, min) : n * shrink
    const slot = { x, w }
    x += w
    return slot
  })
}

/** The index of the slot under `px`, or null past either end. */
function slotAt(slots: readonly Slot[], px: number): number | null {
  const index = slots.findIndex((s) => px >= s.x && px < s.x + s.w)
  return index === -1 ? null : index
}

/** A walk's height: the stretch before its strides, else its own. */
function baseHeight(segments: readonly ProfileSegment[], index: number): number {
  for (let i = index - 1; i >= 0; i--) {
    const s = segments[i]
    if (s !== undefined && s.role !== 'strides' && !s.gap) return s.height
  }
  return segments[index]?.height ?? 0
}

/**
 * The full profile's key: one entry per tone and kind it draws, the hard
 * running first, named by the roles it draws so in the comma form: `Work`,
 * `Strides`, then `Warm-up, recovery, cool-down`, so on a phone the two
 * short ones share a line and the long one takes the next whole.
 * A work step drawn easy is `easy running`; the walks between strides
 * alone are `Walk`.
 */
function keyEntries(
  segments: readonly ProfileSegment[],
  easyMps: number | null,
  kind: Session['kind'],
): { tone: FullTone; slot: string; label: string }[] {
  const entries: { tone: FullTone; slot: string; label: string }[] = []
  for (const tone of ['fast', 'easy'] as const) {
    const drawn = segments.filter((s) => toneOf(s, easyMps) === tone)
    const roles = new Map<string, Set<ProfileRole>>()
    const add = (slot: string): Set<ProfileRole> => {
      const known = roles.get(slot) ?? new Set<ProfileRole>()
      roles.set(slot, known)
      return known
    }
    for (const role of KEY_ORDER[tone]) {
      for (const s of drawn) if (s.role === role && !s.gap) add(effortSlot(s, kind)).add(role)
    }
    for (const s of drawn) if (s.gap) add(effortSlot(s, kind))
    for (const [slot, named] of roles) {
      const names = KEY_ORDER[tone]
        .filter((r) => named.has(r))
        .map((r) => (r === 'work' && tone === 'easy' ? 'easy running' : stepRoleLabel(r).toLowerCase()))
      const label = names.length === 0 ? 'walk' : names.join(', ')
      entries.push({ tone, slot, label: label.charAt(0).toUpperCase() + label.slice(1) })
    }
  }
  return entries
}

/** A work set's label, where it stands and how tall its set is. */
interface SetLabel {
  group: number
  text: string
  centre: number
  /** The tallest segment's height in the set, a fraction of the scale. */
  height: number
}

/**
 * A label over each work set, `6 × 800 m @ 4:15-4:20/km`, centred on it
 * just above its tallest segment, where the set is wide enough for it
 * with `SET_LABEL_AIR_PX` to spare; its pace alone, `4:15-4:20/km`, where
 * only that fits. The steps under the chart carry the detail otherwise.
 */
function setLabels(session: Session, groups: readonly ProfileGroup[], width: number): SetLabel[] {
  return groups.flatMap((g) => {
    const step = g.stepIndex === null ? undefined : session.steps[g.stepIndex]
    if (g.role !== 'work' || step === undefined) return []
    const amount = stepAmount(step.repeat, step.distance_m ?? null, step.duration_s ?? null)
    const speed = step.speed ?? null
    const pace = speed === null ? NO_VALUE : speedRangeAsPace(speed.low_mps, speed.high_mps)
    const candidates = pace === NO_VALUE ? [amount] : [`${amount} @ ${pace}`, pace]
    const text = candidates.find((c) => c !== NO_VALUE && c.length * SET_LABEL_CHAR_PX + SET_LABEL_AIR_PX <= g.width * width)
    if (text === undefined) return []
    const textWidth = text.length * SET_LABEL_CHAR_PX
    const centre = Math.min(width - textWidth / 2, Math.max(textWidth / 2, (g.x + g.width / 2) * width))
    return [{ group: g.group, text, centre, height: g.height }]
  })
}
