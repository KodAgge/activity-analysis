import { useLayoutEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import { calendarDayOfDate, checkpointLabel, dayMonthLabel } from '../format'
import type { CheckpointSession } from '../components/plan/planMath'
import { ProgressDashes } from '../components/plan/ProgressDashes'
import type { DashState } from '../components/plan/ProgressDashes'
import type { PhaseBand } from './planShapeMath'
import { usePanelWidth } from './usePanelWidth'
import styles from './PlanPhases.module.css'

export interface PlanPhasesProps {
  /** From `planShapeMath.phaseBands`. */
  bands: PhaseBand[]
  /** From `planShapeMath.planDays`: the strip's `[start, end)` in day numbers. */
  span: [number, number]
  /** Today's day number when it is inside the plan, `planShapeMath.todayInPlan`, else null. */
  today: number | null
  checkpoints: CheckpointSession[]
  /** The race's local calendar date. */
  raceDate: string
  /**
   * Today's day number wherever it falls, which decides which weeks are
   * done: every week once the plan is over, none before it begins.
   * Defaults to `today`, and with neither every week is still to come.
   */
  progressDay?: number | null
}

const DAYS_PER_WEEK = 7

/**
 * Past this many weeks a phone draws each week as a dot rather than a
 * dash, and the wider gap between phases would break the row into
 * clusters; the phases then close up to the gap between weeks.
 */
const DENSE_WEEKS = 16

/** The clear space kept between two names, or two labels, on one line. */
const LABEL_PAD_PX = 8

/**
 * The plan at a glance, inside its header: Runna's row of week dashes,
 * one per week of the plan, in groups by phase, read as three lines.
 *
 * 1. **Names.** A phase is named once, over the first group of that
 *    name, and the phase today is in is named over its own group. A long
 *    plan's recovery weeks split one phase into many groups, and naming
 *    each would stutter `Base Base Base` along the row. A name may run on
 *    past its own group, and where two would collide the longer phase's
 *    keeps its place (`placeNames`); a name left out is still in the text
 *    alternative.
 * 2. **Dashes and marks.** A week is done once it has ended and current
 *    while today is in it, as `ProgressDashes` draws them. A checkpoint's
 *    session is a hollow diamond on its day's dash and today an ink tick
 *    through its week's; the race, filled, closes the row, so the row has
 *    one dark point to read to even before any week is done.
 * 3. **Labels.** Each mark's label sits under it, anchored at its mark:
 *    reading rightward from it, or leftward where that would collide or
 *    run off the row, or else on a line of its own (`placeLabels`). Every
 *    label is drawn; none is left to a key.
 *
 * A group grows with its phase's days, so a phase twice as long is twice
 * as wide, and a mark sits at its day's place along the row: its fraction
 * of the plan's days, of the row's width less the gaps between phases,
 * plus the gaps before it.
 */
export function PlanPhases({ bands, span, today, checkpoints, raceDate, progressDay }: PlanPhasesProps) {
  const [start, end] = span
  const total = Math.max(1, end - start)
  const raceDay = calendarDayOfDate(raceDate)
  const progress = progressDay ?? today
  // Measured only to render again when the panel's width changes, which
  // places the names and labels again.
  const [panelRef] = usePanelWidth<HTMLDivElement>()
  const stripRef = useRef<HTMLDivElement>(null)

  // Names and labels are placed after layout, from their measured widths,
  // and again whenever the panel's width changes or the web font arrives,
  // which sets them wider or narrower than the fallback. The outcome is
  // marked on the elements themselves (`data-cut`, `data-anchor`,
  // `--lane`), which React does not manage, so placing them renders
  // nothing again. jsdom lays nothing out and reports every width as 0, so
  // there every name shows and every label reads rightward on one line.
  useLayoutEffect(() => {
    const place = () => {
      const strip = stripRef.current
      if (strip === null) return
      placeNames(strip)
      placeLabels(strip)
    }
    place()
    let live = true
    void document.fonts?.ready.then(() => {
      if (live) place()
    })
    return () => {
      live = false
    }
  })

  // The row's pieces in order: each band, and a spacer for any days of the
  // span no band covers, such as race days after the last week.
  const pieces: ({ kind: 'band'; band: PhaseBand } | { kind: 'gap'; days: number; key: number })[] = []
  let cursor = start
  for (const band of bands) {
    if (band.startDay > cursor) pieces.push({ kind: 'gap', days: band.startDay - cursor, key: cursor })
    pieces.push({ kind: 'band', band })
    cursor = band.endDay
  }
  if (end > cursor) pieces.push({ kind: 'gap', days: end - cursor, key: cursor })
  const gaps = Math.max(0, pieces.length - 1)
  const daysOf = (p: (typeof pieces)[number]) => (p.kind === 'band' ? p.band.endDay - p.band.startDay : p.days)
  // The gaps between two weeks of one phase, summed over the row.
  const weekGaps = bands.reduce((n, b) => n + Math.max(0, (b.endDay - b.startDay) / DAYS_PER_WEEK - 1), 0)
  const unitWeeks = total / DAYS_PER_WEEK

  /**
   * Where a day's middle sits along the row, as a CSS length. Every week
   * is one width, `w`: the row less its gaps, over its weeks. A day is the
   * weeks before it and its fraction of its own week, each `w` wide, plus
   * every gap it has passed, between weeks and between phases.
   */
  const placeOf = (day: number): CSSProperties => {
    const clamped = Math.min(end - 0.5, Math.max(start, day + 0.5))
    let weeks = 0
    let inner = 0
    let phases = 0
    let edge = start
    for (const p of pieces) {
      const days = daysOf(p)
      if (clamped >= edge + days) {
        weeks += days / DAYS_PER_WEEK
        if (p.kind === 'band') inner += days / DAYS_PER_WEEK - 1
        phases += 1
        edge += days
        continue
      }
      const into = (clamped - edge) / DAYS_PER_WEEK
      const whole = p.kind === 'band' ? Math.floor(into) : 0
      weeks += into
      inner += whole
      break
    }
    phases = Math.min(phases, gaps)
    const w = `(100% - ${String(weekGaps)} * var(--week-gap) - ${String(gaps)} * var(--phase-gap)) / ${String(unitWeeks)}`
    return {
      left: `calc(${String(weeks)} * ${w} + ${String(inner)} * var(--week-gap) + ${String(phases)} * var(--phase-gap))`,
    }
  }

  /**
   * A piece's share of the row: its weeks, after the gaps between them,
   * so a phase of one week and a phase of five draw their weeks one width.
   */
  const sizeOf = (p: (typeof pieces)[number]): CSSProperties => {
    const weeks = daysOf(p) / DAYS_PER_WEEK
    const inner = p.kind === 'band' ? Math.max(0, weeks - 1) : 0
    return { flexGrow: weeks, flexBasis: `calc(${String(inner)} * var(--week-gap))` }
  }

  const weekState = (weekStart: number): DashState => {
    if (progress === null) return 'todo'
    if (weekStart + DAYS_PER_WEEK <= progress) return 'done'
    return weekStart <= progress ? 'current' : 'todo'
  }

  // Which group names its phase: the first of each name, and the current
  // one. Ranked for `placeNames`: the current phase first, then the longer
  // group, then the earlier. The race's own week is left unnamed, since
  // the race's label under it already says `Race`.
  const named = new Set<string>()
  const nameRank = new Map<PhaseBand, number>()
  const bandWeeks = bands.map((b) => {
    const weeks: DashState[] = []
    for (let d = b.startDay; d < b.endDay; d += DAYS_PER_WEEK) weeks.push(weekState(d))
    return weeks
  })
  // Before the plan begins, today stands at the row's start and the first
  // phase is the one coming, its name drawn as the current phase's is.
  const before = today === null && progress !== null && progress < start
  const isCurrent = (i: number) => (bandWeeks[i] ?? []).includes('current') || (before && i === 0)
  bands
    .map((b, i) => {
      const first = !named.has(b.phase)
      named.add(b.phase)
      return { b, i, first, current: (bandWeeks[i] ?? []).includes('current') }
    })
    .filter(({ b }) => !(b.phase.toLowerCase() === 'race' && raceDay >= b.startDay && raceDay < b.endDay))
    .filter(({ current, first }) => current || first)
    .sort((x, y) => Number(y.current) - Number(x.current) || y.b.endDay - y.b.startDay - (x.b.endDay - x.b.startDay) || x.i - y.i)
    .forEach(({ b }, rank) => nameRank.set(b, rank))

  const checkpointMarks = checkpoints.map((c) => {
    const day = calendarDayOfDate(c.date)
    return { key: c.sessionId, day, text: checkpointLabel(c.kind, c.targetDistanceM, c.targetS) }
  })

  const described = [
    ...bands.map((b) => {
      const weeks = b.firstWeek === b.lastWeek ? `week ${String(b.firstWeek)}` : `weeks ${String(b.firstWeek)} to ${String(b.lastWeek)}`
      return `${b.phase}, ${weeks}, ${dayMonthLabel(b.startDay)} to ${dayMonthLabel(b.endDay - 1)}`
    }),
    ...checkpoints.map(
      (c) => `checkpoint ${dayMonthLabel(calendarDayOfDate(c.date))}, ${checkpointLabel(c.kind, c.targetDistanceM, c.targetS)}`,
    ),
    `race ${dayMonthLabel(raceDay)}`,
    ...(today !== null ? [`today ${dayMonthLabel(today)}`] : []),
    ...(before && progress !== null ? [`today ${dayMonthLabel(progress)}, before the plan begins`] : []),
  ]
  const label = `Plan phases: ${described.join('; ')}.`
  const weekCount = bandWeeks.reduce((n, w) => n + w.length, 0)
  const panelClass = weekCount > DENSE_WEEKS ? `${styles.panel} ${styles.dense}` : styles.panel

  return (
    <div className={panelClass} ref={panelRef}>
      <div className={styles.strip} role="img" aria-label={label} ref={stripRef}>
        <div className={styles.row}>
          <div className={styles.track} data-track="">
            {pieces.map((p) => {
              if (p.kind === 'gap') return <div key={`gap-${String(p.key)}`} className={styles.spacer} style={sizeOf(p)} />
              const b = p.band
              const weeks = bandWeeks[bands.indexOf(b)] ?? []
              const rank = nameRank.get(b)
              return (
                <div
                  key={`${b.phase}-${String(b.startDay)}`}
                  className={isCurrent(bands.indexOf(b)) ? `${styles.phase} ${styles.currentPhase}` : styles.phase}
                  data-mark="phase"
                  style={sizeOf(p)}
                >
                  {rank !== undefined && (
                    <span className={styles.phaseName} data-phase-name={rank}>
                      {b.phase}
                    </span>
                  )}
                  <ProgressDashes items={weeks} label={b.phase} className={styles.dashes} />
                </div>
              )
            })}
            {checkpointMarks.map((m) => (
              <span key={m.key} className={styles.diamond} data-mark="checkpoint" style={placeOf(m.day)} />
            ))}
            {today !== null && <span className={styles.today} data-mark="today" style={placeOf(today)} />}
            {before && <span className={`${styles.today} ${styles.todayBefore}`} data-mark="today" />}
          </div>
          <span className={styles.finish} data-mark="race" />
        </div>

        {/* Each label's anchor is a zero-width point at its mark; the text
            hangs off it rightward or leftward (`data-anchor`). */}
        <div className={styles.labels} data-labels="">
          <span className={`${styles.anchor} ${styles.raceAnchor}`} data-label="race" data-anchor="end">
            <span className={`${styles.label} ${styles.raceLabel}`}>Race {dayMonthLabel(raceDay)}</span>
          </span>
          {today !== null && (
            <span className={`${styles.anchor} ${styles.tickAnchor}`} data-label="today" style={placeOf(today)}>
              <span className={styles.label}>
                <span>Today</span> <span className={styles.labelDate}>{dayMonthLabel(today)}</span>
              </span>
            </span>
          )}
          {before && progress !== null && (
            <span className={`${styles.anchor} ${styles.beforeAnchor}`} data-label="today">
              <span className={styles.label}>
                <span>Today</span> <span className={styles.labelDate}>{dayMonthLabel(progress)}</span>
              </span>
            </span>
          )}
          {[...checkpointMarks].reverse().map((m) => (
            <span key={m.key} className={styles.anchor} data-label="checkpoint" style={placeOf(m.day)}>
              <span className={styles.label}>
                <span>{m.text}</span> <span className={styles.labelDate}>{dayMonthLabel(m.day)}</span>
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

type Span = [number, number]

const clearOf = (span: Span, placed: Span[]) =>
  placed.every(([a, b]) => span[1] + LABEL_PAD_PX <= a || span[0] >= b + LABEL_PAD_PX)

/**
 * Shows each candidate phase name, in rank order, where it fits: reading
 * rightward from its group's start, else leftward from its group's end,
 * clear of every name already placed and inside the row. A name that fits
 * neither way is hidden (`data-cut`), keeping its box so it measures the
 * same next time; when none fits, the row of names is dropped
 * (`data-unnamed`) rather than left standing empty.
 *
 * The leftmost name, when one week alone stands before its group, such as
 * a long plan's opening recovery week whose own name did not fit, is drawn
 * from the row's start (`--snap`), so the names line up with the row's
 * left edge as the card's other text does.
 */
function placeNames(strip: HTMLElement) {
  const track = strip.querySelector<HTMLElement>('[data-track]')
  if (track === null) return
  const names = Array.from(track.querySelectorAll<HTMLElement>('[data-phase-name]')).sort(
    (a, b) => Number(a.dataset.phaseName) - Number(b.dataset.phaseName),
  )
  const right = track.clientWidth
  const placed: Span[] = []
  const week = track.querySelector<HTMLElement>('[data-state]')
  // One week's dash and the widest gap after it, with room to spare.
  const oneWeek = (week?.offsetWidth ?? 0) + 2 * LABEL_PAD_PX
  let leftmost: { name: HTMLElement; from: number } | null = null
  let shown = 0
  for (const name of names) {
    name.style.removeProperty('--snap')
    const group = name.parentElement
    if (group === null) continue
    const width = name.offsetWidth
    const from = group.offsetLeft
    const to = from + group.offsetWidth
    const options: [string, Span][] = [
      ['start', [from, from + width]],
      ['end', [to - width, to]],
    ]
    const fit = options.find(([, s]) => s[0] >= 0 && s[1] <= right + 0.5 && clearOf(s, placed))
    name.toggleAttribute('data-cut', fit === undefined)
    if (fit === undefined) continue
    name.dataset.anchor = fit[0]
    placed.push(fit[1])
    shown += 1
    if (leftmost === null || fit[1][0] < leftmost.from) leftmost = { name, from: fit[1][0] }
  }
  if (leftmost !== null && leftmost.name.dataset.anchor === 'start' && leftmost.from > 0 && leftmost.from <= oneWeek) {
    leftmost.name.style.setProperty('--snap', `${String(leftmost.from)}px`)
  }
  track.toggleAttribute('data-unnamed', shown === 0)
}

/**
 * Lays each mark's label under its mark, in the order the labels are
 * written: the race's, fixed at the row's end, then today's, then the
 * checkpoints from the race back, so the nearest the race keeps the first
 * line. Each tries the first line rightward, then leftward, then the next
 * line, until it is clear of every label placed on that line and inside
 * the row. The row of labels is as tall as its lines (`--lanes`).
 */
function placeLabels(strip: HTMLElement) {
  const row = strip.querySelector<HTMLElement>('[data-labels]')
  if (row === null) return
  const right = strip.clientWidth
  const lanes: Span[][] = []
  const spanOf = (anchor: HTMLElement): Span => {
    const text = anchor.firstElementChild as HTMLElement | null
    const from = anchor.offsetLeft + (text?.offsetLeft ?? 0)
    return [from, from + (text?.offsetWidth ?? 0)]
  }
  for (const anchor of Array.from(row.querySelectorAll<HTMLElement>('[data-label]'))) {
    const fixed = anchor.dataset.label === 'race'
    let lane = 0
    for (;; lane += 1) {
      const taken = lanes[lane] ?? []
      const sides = fixed ? ['end'] : ['start', 'end']
      const side = sides.find((s) => {
        anchor.dataset.anchor = s
        const span = spanOf(anchor)
        return (fixed || (span[0] >= -LABEL_PAD_PX && span[1] <= right + 0.5)) && clearOf(span, taken)
      })
      // A line no label is on yet takes it however it reads.
      if (side !== undefined || lane >= lanes.length) {
        if (side === undefined) anchor.dataset.anchor = sides[0] ?? 'start'
        break
      }
    }
    anchor.style.setProperty('--lane', String(lane))
    lanes[lane] = [...(lanes[lane] ?? []), spanOf(anchor)]
  }
  row.style.setProperty('--lanes', String(Math.max(1, lanes.length)))
}
