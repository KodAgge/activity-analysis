import type { PlanVersion, Session } from '../components/plan/planMath'
import { NO_VALUE, heartRateRange, sessionKindLabel, speedRangeAsPace, stepAmount, stepRoleLabel } from '../format'

/**
 * The geometry of a session's workout profile, `SessionProfile`'s: the
 * steps laid end to end in time, each as tall as it is fast, so a hard rep
 * stands above an easy jog. Pure and kept apart from the component for the
 * reason `planShapeMath.ts` is.
 *
 * Everything here is a drawing, not a prediction: a step without a
 * duration is drawn for the time its distance takes at its target speed,
 * and a step without a speed at a speed its role implies. The figures
 * below are those assumptions, named so the chart and its tests share them.
 */

type Step = Session['steps'][number]
export type ProfileRole = Step['role']

/** The speed a step with no speed and no plan easy speed is drawn at, about 6:10/km. */
export const DEFAULT_EASY_MPS = 2.7
/** A recovery with no speed is drawn this much slower than easy. */
export const RECOVERY_FACTOR = 0.85
/** A work step with no speed in a quality, trial or race session is drawn this much faster than easy. */
export const WORK_FACTOR = 1.2
/** Strides are drawn this much faster than the session's fastest work... */
export const STRIDE_FACTOR = 1.15
/** ...and never slower than this, about 3:42/km: strides are near top speed whatever the session. */
export const DEFAULT_STRIDE_MPS = 4.5
/** The walk between two strides, which the plan does not write as a step. */
export const STRIDE_GAP_S = 45
/** A speed this much faster than easy, or more, is hard running: about 5:35/km over a 6:10 easy. */
export const HARD_FACTOR = 1.1
/** The floor of the height scale sits this far below the slowest piece. */
export const FLOOR_MARGIN_MPS = 0.3

/** Kinds whose work steps are the session's easy running, not its quality. */
const EASY_KINDS: ReadonlySet<Session['kind']> = new Set(['easy', 'long', 'strides'])
/** Kinds that are not running and so have no profile. */
const NOT_RUNNING: ReadonlySet<Session['kind']> = new Set(['rest', 'cross_training'])

/** One drawn stretch of a session, before it is laid out. */
export interface ProfilePiece {
  role: ProfileRole
  /** The step it draws, an index into `session.steps`; null for a session drawn from its planned extent. */
  stepIndex: number | null
  /** 1-based repeat of its step, and the step's repeats. */
  rep: number
  repeats: number
  /** The walk between two strides: a recovery the plan does not write. */
  gap: boolean
  /** The pieces drawn as one set: a step, or a work step with its interleaved recoveries. */
  group: number
  durationS: number
  speedMps: number
  /** The speed is the plan's own, the middle of the step's range, not a role's default. */
  speedSet: boolean
}

export interface ProfileScale {
  floorMps: number
  topMps: number
}

/** A piece laid out: `x` and `width` are fractions of the session's time, `height` of the scale. */
export interface ProfileSegment extends ProfilePiece {
  x: number
  width: number
  height: number
}

/** A work step's set, its recoveries included, for a label over it. */
export interface ProfileGroup {
  group: number
  role: ProfileRole
  stepIndex: number | null
  /** The recovery step interleaved with it, when there is one. */
  recoveryStepIndex: number | null
  x: number
  width: number
  /** The tallest segment's height in the set. */
  height: number
}

export interface SessionProfileData {
  segments: ProfileSegment[]
  groups: ProfileGroup[]
  totalS: number
  scale: ProfileScale
}

function midSpeed(step: Step): number | null {
  const speed = step.speed ?? null
  return speed === null ? null : (speed.low_mps + speed.high_mps) / 2
}

/**
 * Whether a work step and the recovery after it are drawn alternating,
 * rep, recovery, rep. Two shapes alternate: the recovery written with the
 * work's repeats, when there are two or more, the last recovery then
 * dropped as the next step follows; and the recovery written with one
 * repeat fewer, none dropped, so 2 reps and 1 recovery is rep, recovery,
 * rep. One rep and one recovery are two steps in order.
 */
function interleaves(work: Step, recovery: Step | undefined): boolean {
  if (work.role !== 'work' || recovery?.role !== 'recovery') return false
  return (recovery.repeat === work.repeat && work.repeat > 1) || recovery.repeat === work.repeat - 1
}

/**
 * The speed a session's steps without a speed of their own are drawn at,
 * by role: warm-up, cool-down and the work of an easy run at easy speed,
 * recovery slower, the work of a quality session faster, and strides
 * faster than the session's fastest work.
 */
function roleSpeeds(session: Session, easyMps: number) {
  const workMids = session.steps.flatMap((s) => {
    const mid = s.role === 'work' ? midSpeed(s) : null
    return mid === null ? [] : [mid]
  })
  const fastestWork = workMids.length > 0 ? Math.max(...workMids) : null
  return {
    warmup: easyMps,
    cooldown: easyMps,
    recovery: easyMps * RECOVERY_FACTOR,
    work: EASY_KINDS.has(session.kind) ? easyMps : easyMps * WORK_FACTOR,
    strides: Math.max(DEFAULT_STRIDE_MPS, (fastestWork ?? 0) * STRIDE_FACTOR),
  } satisfies Record<ProfileRole, number>
}

/**
 * The speed a step of a session is drawn at: the middle of its speed
 * range, else the speed `roleSpeeds` gives its role. `easyMps` is as
 * `profilePieces` takes it.
 */
export function stepSpeed(session: Session, step: Step, easyMps: number | null): number {
  return midSpeed(step) ?? roleSpeeds(session, easyMps ?? DEFAULT_EASY_MPS)[step.role]
}

/**
 * Whether a stretch is hard running, which the full profile draws in the
 * kind and the step list marks with the kind's swatch: strides always,
 * anything else when it is drawn at `HARD_FACTOR` times easy or faster.
 * An easy run's or a long run's whole distance is easy running whatever
 * role the plan gives it, and is drawn in the easy tone.
 */
export function isHard(role: ProfileRole, speedMps: number, easyMps: number | null): boolean {
  return role === 'strides' || speedMps >= (easyMps ?? DEFAULT_EASY_MPS) * HARD_FACTOR
}

/**
 * A session's steps expanded into the stretches it is run as, in order.
 *
 * A work step followed by a recovery that `interleaves` alternates with
 * it; strides alternate with a `STRIDE_GAP_S` walk, none after the last;
 * any other repeated step repeats in place. A step's duration is its own,
 * else its distance at the speed it is drawn at, `stepSpeed`'s. A running
 * session with no steps is one piece of its planned duration, else its
 * planned distance at easy speed; a rest day, a
 * cross-training session and a session with nothing to measure have none.
 *
 * `easyMps` is the plan's easy speed, `planEasySpeed`, else `DEFAULT_EASY_MPS`.
 */
export function profilePieces(session: Session, easyMps: number | null): ProfilePiece[] {
  if (NOT_RUNNING.has(session.kind)) return []
  const easy = easyMps ?? DEFAULT_EASY_MPS
  const byRole = roleSpeeds(session, easy)

  if (session.steps.length === 0) {
    const durationS = session.planned_duration_s ?? (session.planned_distance_m ?? 0) / easy
    if (!(durationS > 0)) return []
    return [
      { role: 'work', stepIndex: null, rep: 1, repeats: 1, gap: false, group: 0, durationS, speedMps: easy, speedSet: false },
    ]
  }

  const piece = (step: Step, stepIndex: number, rep: number, group: number): ProfilePiece => {
    const mid = midSpeed(step)
    const speedMps = mid ?? byRole[step.role]
    const durationS = step.duration_s ?? (step.distance_m ?? 0) / speedMps
    return { role: step.role, stepIndex, rep, repeats: step.repeat, gap: false, group, durationS, speedMps, speedSet: mid !== null }
  }

  const pieces: ProfilePiece[] = []
  let group = 0
  for (let i = 0; i < session.steps.length; i++) {
    const step = session.steps[i]
    if (step === undefined) continue
    const next = session.steps[i + 1]
    if (next !== undefined && interleaves(step, next)) {
      for (let rep = 1; rep <= step.repeat; rep++) {
        pieces.push(piece(step, i, rep, group))
        if (rep < step.repeat) pieces.push(piece(next, i + 1, rep, group))
      }
      i++
    } else if (step.role === 'strides') {
      for (let rep = 1; rep <= step.repeat; rep++) {
        pieces.push(piece(step, i, rep, group))
        if (rep < step.repeat) {
          pieces.push({
            role: 'recovery',
            stepIndex: i,
            rep,
            repeats: step.repeat,
            gap: true,
            group,
            durationS: STRIDE_GAP_S,
            speedMps: byRole.recovery,
            speedSet: false,
          })
        }
      }
    } else {
      for (let rep = 1; rep <= step.repeat; rep++) pieces.push(piece(step, i, rep, group))
    }
    group++
  }
  return pieces.filter((p) => p.durationS > 0)
}

/** The scale pieces span: from below the slowest of them and a recovery, to the fastest. */
function scaleOf(pieces: ProfilePiece[], easyMps: number): ProfileScale {
  const speeds = pieces.map((p) => p.speedMps)
  const bottom = Math.min(easyMps * RECOVERY_FACTOR, ...speeds)
  return { floorMps: bottom - FLOOR_MARGIN_MPS, topMps: Math.max(...speeds) }
}

/**
 * The plan's easy speed: the mean of the middle of every speed range on
 * an `easy` session's work steps, as `planShapeMath.easyBand` reads the
 * easy range. Null when no easy session gives a speed.
 */
export function planEasySpeed(version: PlanVersion): number | null {
  const mids = version.weeks
    .flatMap((w) => w.sessions)
    .filter((s) => s.kind === 'easy')
    .flatMap((s) => s.steps)
    .flatMap((step) => {
      const mid = step.role === 'work' ? midSpeed(step) : null
      return mid === null ? [] : [mid]
    })
  return mids.length === 0 ? null : mids.reduce((a, b) => a + b, 0) / mids.length
}

/**
 * One scale for every session of the plan, so an easy run draws low and
 * an interval session's reps tall wherever the two are seen side by side,
 * as the calendar shows a week. Null for a plan with nothing to draw.
 */
export function planProfileScale(version: PlanVersion): ProfileScale | null {
  const easy = planEasySpeed(version)
  const pieces = version.weeks.flatMap((w) => w.sessions).flatMap((s) => profilePieces(s, easy))
  return pieces.length === 0 ? null : scaleOf(pieces, easy ?? DEFAULT_EASY_MPS)
}

export interface SessionProfileOptions {
  /** The plan's easy speed, `planEasySpeed`; `DEFAULT_EASY_MPS` without one. */
  easyMps?: number | null
  /** A scale shared with other sessions, `planProfileScale`; the session's own without one. */
  scale?: ProfileScale | null
}

/** The smallest height a segment is drawn at, so a walk still shows. */
const MIN_HEIGHT = 0.04

/**
 * A session's profile laid out: segments end to end as fractions of the
 * session's time, each as tall as its speed on the scale, and the work
 * steps' sets for labels. Null when the session has nothing to draw.
 */
export function sessionProfile(session: Session, options: SessionProfileOptions): SessionProfileData | null {
  const easy = options.easyMps ?? null
  const pieces = profilePieces(session, easy)
  if (pieces.length === 0) return null
  const scale = options.scale ?? scaleOf(pieces, easy ?? DEFAULT_EASY_MPS)
  const totalS = pieces.reduce((sum, p) => sum + p.durationS, 0)
  const span = scale.topMps - scale.floorMps
  let elapsed = 0
  const segments = pieces.map((p) => {
    const height = span > 0 ? (p.speedMps - scale.floorMps) / span : 1
    const segment = { ...p, x: elapsed / totalS, width: p.durationS / totalS, height: Math.min(1, Math.max(MIN_HEIGHT, height)) }
    elapsed += p.durationS
    return segment
  })

  const groups: ProfileGroup[] = []
  for (const s of segments) {
    const last = groups[groups.length - 1]
    if (last !== undefined && last.group === s.group) {
      last.width = s.x + s.width - last.x
      last.height = Math.max(last.height, s.height)
      if (s.role === 'recovery' && !s.gap) last.recoveryStepIndex = s.stepIndex
      continue
    }
    groups.push({ group: s.group, role: s.role, stepIndex: s.stepIndex, recoveryStepIndex: null, x: s.x, width: s.width, height: s.height })
  }
  return { segments, groups, totalS, scale }
}

/** A step's repeats and length, `6 × 800 m`, through `format.stepAmount`. */
export function stepAmountOf(step: Step, repeat = step.repeat): string {
  return stepAmount(repeat, step.distance_m ?? null, step.duration_s ?? null)
}

/**
 * The profile in words, one phrase per set as it is drawn: `warm-up 15
 * min, 4 × 20 s strides, 6 × 800 m at 4:15-4:20/km with 400 m recoveries,
 * cool-down 9 min`. A session with no steps is `one run of 8 km`.
 */
export function profileDescription(session: Session, profile: SessionProfileData): string {
  return profile.groups
    .map((g) => {
      const step = g.stepIndex === null ? undefined : session.steps[g.stepIndex]
      if (step === undefined) {
        const extent = stepAmount(1, session.planned_distance_m ?? null, session.planned_duration_s ?? null)
        return `one run of ${extent}`
      }
      const amount = stepAmountOf(step)
      if (step.role === 'strides') return `${amount} strides`
      if (step.role !== 'work') return `${stepRoleLabel(step.role).toLowerCase()} ${amount}`
      const speed = step.speed ?? null
      const pace = speed === null ? '' : ` at ${speedRangeAsPace(speed.low_mps, speed.high_mps)}`
      const recovery = g.recoveryStepIndex === null ? undefined : session.steps[g.recoveryStepIndex]
      const between = recovery === undefined ? '' : ` with ${stepAmountOf(recovery, 1)} recoveries`
      return `${amount}${pace}${between}`
    })
    .join(', ')
}

/** What the readout says of a step with no target speed. */
export const NO_PACE = 'No pace set'

/**
 * What a segment's readout says: a heading, the role with the rep's place
 * in its set, `Work 3 of 6`, and rows for one rep's length, its pace range,
 * its heart rate range, with the zone of its top when `boundaries` are
 * given, and its note. A recovery has no counter, since an
 * interleaved set draws one fewer than written; the walk between strides
 * is a `Walk`, and a session with no steps reads as its kind.
 */
export function segmentReadout(
  session: Session,
  segment: ProfileSegment,
  boundaries: readonly number[] | null = null,
): { heading: string; rows: string[] } {
  const step = segment.stepIndex === null ? undefined : session.steps[segment.stepIndex]
  if (segment.gap) return { heading: 'Walk', rows: [stepAmount(1, null, segment.durationS), 'Between strides'] }
  if (step === undefined) {
    const extent = stepAmount(1, session.planned_distance_m ?? null, session.planned_duration_s ?? null)
    return { heading: sessionKindLabel(session.kind), rows: [extent, NO_PACE].filter((r) => r !== NO_VALUE) }
  }
  const counted = segment.role !== 'recovery' && segment.repeats > 1
  const heading = counted
    ? `${stepRoleLabel(step.role)} ${String(segment.rep)} of ${String(segment.repeats)}`
    : stepRoleLabel(step.role)
  const speed = step.speed ?? null
  const hr = step.heart_rate ?? null
  const rows = [
    stepAmountOf(step, 1),
    speed === null ? NO_PACE : speedRangeAsPace(speed.low_mps, speed.high_mps),
    ...(hr === null ? [] : [heartRateRange(hr.low_bpm, hr.high_bpm, boundaries)]),
    ...(step.note == null || step.note === '' ? [] : [step.note]),
  ]
  return { heading, rows }
}

/**
 * The index of the segment at `fraction` of the session's time, or null
 * outside `[0, 1)`, so a pointer past either end reads nothing out rather
 * than the nearest segment.
 */
export function segmentAt(segments: ProfileSegment[], fraction: number): number | null {
  if (!(fraction >= 0 && fraction < 1)) return null
  const index = segments.findIndex((s) => fraction >= s.x && fraction < s.x + s.width)
  return index === -1 ? null : index
}

/** The air between the readout and the pointer or segment it reads. */
export const READOUT_OFFSET_PX = 12

/**
 * The readout's left edge, beside its anchor rather than over it: right of
 * the anchor by `READOUT_OFFSET_PX` where it fits in the panel, else left
 * of it, else against the panel's right edge, or its left on a panel
 * narrower than the readout.
 */
export function readoutBeside(anchorPx: number, readoutWidthPx: number, panelWidthPx: number): number {
  const right = anchorPx + READOUT_OFFSET_PX
  if (right + readoutWidthPx <= panelWidthPx) return right
  const left = anchorPx - READOUT_OFFSET_PX - readoutWidthPx
  if (left >= 0) return left
  return Math.max(0, Math.min(right, panelWidthPx - readoutWidthPx))
}

/** Whole-minute tick steps, in minutes. */
const TICK_MINUTES = [1, 2, 5, 10, 20, 30, 60] as const
/** The least room between two time labels, `120 min` at `--text-small` with space to spare. */
export const MIN_TICK_GAP_PX = 64

/**
 * The time axis's ticks in seconds from the start: the smallest whole-minute
 * step that leaves `MIN_TICK_GAP_PX` between labels across `widthPx`.
 */
export function timeTicks(totalS: number, widthPx: number): number[] {
  if (!(totalS > 0) || !(widthPx > 0)) return []
  const pxPerS = widthPx / totalS
  const minutes = TICK_MINUTES.find((m) => m * 60 * pxPerS >= MIN_TICK_GAP_PX) ?? 60
  const stepS = minutes * 60
  const ticks: number[] = []
  for (let t = 0; t <= totalS + 1e-6; t += stepS) ticks.push(t)
  return ticks
}
