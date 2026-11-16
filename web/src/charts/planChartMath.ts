import { dayMonthLabel, yearLabel } from '../format'

/**
 * The scales behind the Plan view's two SVG charts, `PlanVolume` and
 * `PlanTrajectory`, kept apart from them for the reason
 * `progressionMath.ts` is: pure, testable without rendering, and a file
 * mixing components with plain functions cannot be Fast-Refreshed.
 *
 * Every length here is in CSS pixels. Both charts set their `viewBox` from
 * the panel's own measured width, so one coordinate unit is one CSS pixel
 * and a stated label size or bar width is what the reader sees; see
 * `ProgressionScatter.tsx` for what a fixed viewBox did to that.
 */

/** A y ladder whose bounds are its outermost ticks. */
export interface Ladder {
  min: number
  max: number
  /** Every rule, ascending, from `min` to `max`. */
  ticks: number[]
}

/** Both charts' drawn height. Wide enough a ladder at the phone's width, short enough to sit under the calendar. */
export const PLAN_CHART_HEIGHT_PX = 200

/** The width a chart lays out at before it has measured its panel, as in jsdom. */
export const PLAN_CHART_FALLBACK_WIDTH_PX = 600

/**
 * The ladder's gutter on the right, as `VolumeBars` and
 * `ProgressionScatter` carry theirs: wide enough for `40 km` or `24:00`
 * at `--text-caption`.
 */
const RIGHT_GUTTER_PX = 44
/** Room above the top rule for its label's upper half and a label over a point. */
const TOP_PX = 20
/** Room below the baseline for the week or date labels. */
const BOTTOM_PX = 24
const LEFT_PX = 8

/**
 * The lead-in's plot top: room over its tallest bar for a record's
 * pointer and label. Weekly distance, its partner on a desktop row,
 * starts its plot here too, so the two charts' rules line up across the
 * pair.
 */
export const LEAD_IN_TOP_PX = 34

/** The plotting area inside a chart of the given size. */
export interface Plot {
  left: number
  right: number
  top: number
  bottom: number
}

export function plotBox(widthPx: number, heightPx: number): Plot {
  return { left: LEFT_PX, right: widthPx - RIGHT_GUTTER_PX, top: TOP_PX, bottom: heightPx - BOTTOM_PX }
}

/** The trajectory's plot height, and the shorter one for three predictions or fewer. */
export const TRAJECTORY_PLOT_PX = 156
export const TRAJECTORY_COMPACT_PLOT_PX = 104
/**
 * The widest a chart draws compact: a phone's column. On a desktop the
 * trajectory stands beside the target paces, whose plot row it shares, so
 * a shorter plot there buys only white under it.
 */
const TRAJECTORY_COMPACT_MAX_WIDTH_PX = 440
/** The most predictions the compact plot is drawn for: one dot and a target line need little height. */
const TRAJECTORY_COMPACT_POINTS = 3
/** The date labels' baseline under the plot's bottom rule. */
const TRAJECTORY_DATE_DY = 17
/** From the date labels' baseline to the checkpoint row's rule, its name's baseline and its marks' middle. */
const STRIP_RULE_DY = 12
const STRIP_NAME_DY = 28
const STRIP_MARK_DY = 46
/** Under the checkpoint row's marks, room for a diamond's lower half and air. */
const STRIP_FOOT_PX = 12

/** The trajectory's geometry: its plot, its date labels and its checkpoint row. */
export interface TrajectoryLayout {
  plot: Plot
  /** The date labels' baseline. */
  dateY: number
  /** The checkpoint row under the date labels: its rule, its name's baseline and its marks' middle; null without checkpoints. */
  strip: { ruleY: number; nameY: number; markY: number } | null
  height: number
}

/**
 * The trajectory's plot, the date labels under it and, when it has
 * checkpoints, the checkpoint row under those.
 *
 * **A checkpoint never sits on the time ladder.** Its target is usually at
 * another distance - a 3 km time trial toward a 5 km goal - so any height
 * on the time axis would claim a time it does not have; drawn just under
 * the slowest rule, a diamond still read as a time slower than it. So the
 * checkpoints have a row of their own below the dates, under a rule and a
 * name, "Checkpoints", where nothing reads as a time on the ladder.
 *
 * Three predictions or fewer at a phone's width get the compact plot:
 * one dot and a target line spend no more height than they need.
 */
export function trajectoryLayout(widthPx: number, pointCount: number, withCheckpoints: boolean): TrajectoryLayout {
  const compact = pointCount <= TRAJECTORY_COMPACT_POINTS && widthPx <= TRAJECTORY_COMPACT_MAX_WIDTH_PX
  const plotHeight = compact ? TRAJECTORY_COMPACT_PLOT_PX : TRAJECTORY_PLOT_PX
  const top = plotBox(widthPx, 0).top
  const plot = { left: LEFT_PX, right: widthPx - RIGHT_GUTTER_PX, top, bottom: top + plotHeight }
  const dateY = plot.bottom + TRAJECTORY_DATE_DY
  if (!withCheckpoints) return { plot, dateY, strip: null, height: plot.bottom + BOTTOM_PX }
  const strip = { ruleY: dateY + STRIP_RULE_DY, nameY: dateY + STRIP_NAME_DY, markY: dateY + STRIP_MARK_DY }
  return { plot, dateY, strip, height: strip.markY + STRIP_FOOT_PX }
}

/** A linear map from `[d0, d1]` onto `[r0, r1]`; a degenerate domain maps to the middle. */
export function linearScale(d0: number, d1: number, r0: number, r1: number): (value: number) => number {
  if (d1 === d0) return () => (r0 + r1) / 2
  const k = (r1 - r0) / (d1 - d0)
  return (value) => r0 + (value - d0) * k
}

/** Whole numbers a half step may take, per decade: a step of 2.5 km is not whole kilometres. */
const WHOLE_MANTISSAS = [1, 2, 3, 4, 5, 6, 8, 10]

function wholeNiceCeil(value: number): number {
  if (value <= 1) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  const nice = WHOLE_MANTISSAS.find((m) => value / power <= m + 1e-9) ?? 10
  return nice * power
}

/**
 * Weekly distance's ladder: zero, a half step and its double, in whole
 * kilometres, the top at or above the largest week. Three rules, as
 * `VolumeBars` and `TerritoryGrowth` draw for the same kind of quantity.
 * A plan with no distance keeps a 1 km step rather than a ladder of
 * nothing.
 */
export function distanceLadder(maxM: number): Ladder {
  const half = wholeLadder(Math.max(0, maxM) / 1000).ticks[1] as number
  return { min: 0, max: 2 * half * 1000, ticks: [0, half * 1000, 2 * half * 1000] }
}

/**
 * The same three rules for a count with no unit of its own, the weekly
 * load and the heart-rate mix's minutes: zero, a whole half step and its
 * double, the top at or above `max`.
 */
export function wholeLadder(max: number): Ladder {
  const half = wholeNiceCeil(Math.max(0, max) / 2)
  return { min: 0, max: 2 * half, ticks: [0, half, 2 * half] }
}

/** Steps a time ladder may take: whole multiples of half a minute. */
const TIME_STEPS_S = [30, 60, 120, 300, 600, 900, 1800, 3600]
/** At most this many intervals, so the rules stay apart at `PLAN_CHART_HEIGHT_PX`. */
const MAX_TIME_INTERVALS = 4

/**
 * The trajectory's ladder, in seconds: rules on whole half minutes that
 * bracket every value strictly, so no point and no target line sits on the
 * plot's edge where its label would leave the chart. The step is the
 * smallest from `TIME_STEPS_S` that keeps to `MAX_TIME_INTERVALS`.
 *
 * Inverted when drawn, faster up: see `PlanTrajectory`.
 */
export function timeLadder(values: number[]): Ladder {
  return bracketLadder(values, TIME_STEPS_S, MAX_TIME_INTERVALS)
}

/** Steps the VO2max outlook's ladders may take, in ml/kg/min. */
const VO2MAX_STEPS = [0.5, 1, 2, 5, 10]
/** Fewer intervals than the time ladder, since each outlook panel is shorter than a chart. */
const MAX_VO2MAX_INTERVALS = 3

/** The VO2max outlook's ladder, `timeLadder`'s rule on steps of half a unit and up. */
export function vo2maxLadder(values: number[]): Ladder {
  return bracketLadder(values, VO2MAX_STEPS, MAX_VO2MAX_INTERVALS)
}

/**
 * Rules on whole multiples of a step that bracket every value strictly,
 * the step the smallest of `steps` that keeps to `maxIntervals`.
 */
function bracketLadder(values: number[], steps: readonly number[], maxIntervals: number): Ladder {
  const lowest = Math.min(...values)
  const highest = Math.max(...values)
  const bracket = (step: number) => {
    let min = Math.floor(lowest / step) * step
    if (min === lowest) min -= step
    let max = Math.ceil(highest / step) * step
    if (max === highest) max += step
    return { min, max }
  }
  const step =
    steps.find((s) => {
      const { min, max } = bracket(s)
      return (max - min) / s <= maxIntervals
    }) ?? (steps.at(-1) as number)
  const { min, max } = bracket(step)
  const ticks: number[] = []
  // Counted rather than accumulated, so a step of 0.5 lands on its multiples exactly.
  for (let i = 0; min + i * step <= max + 1e-9; i++) ticks.push(min + i * step)
  return { min, max, ticks }
}

/** The widest a bar may draw, so a short plan on a desktop column is not a row of slabs. */
const MAX_BAR_PX = 32
/** The gap between a week's planned and run bars. */
const PAIR_GAP_PX = 3

/** Where one week's two bars stand. */
export interface VolumeSlot {
  /** The middle of the week's slot, where its label goes. */
  centre: number
  plannedX: number
  runX: number
  barWidth: number
}

/**
 * One slot per week across `[left, right]`, the planned bar to the left
 * of the centre and the run bar to its right. Each bar takes at most a
 * third of its slot, which leaves a third of every slot as air between
 * weeks.
 */
export function volumeSlots(count: number, left: number, right: number): VolumeSlot[] {
  const slot = (right - left) / Math.max(count, 1)
  const barWidth = Math.min(MAX_BAR_PX, slot / 3)
  return Array.from({ length: count }, (_, i) => {
    const centre = left + slot * (i + 0.5)
    return { centre, plannedX: centre - PAIR_GAP_PX / 2 - barWidth, runX: centre + PAIR_GAP_PX / 2, barWidth }
  })
}

/** Days shown when nothing but the race is dated. */
const FALLBACK_SPAN_DAYS = 7

/**
 * The trajectory's x domain in day numbers: from the first point, or an
 * earlier checkpoint, to the race, which the chart draws nothing after. A
 * goal with nothing dated before its race shows the week before it.
 */
export function trajectoryDays(pointDays: number[], checkpointDays: number[], raceDay: number): [number, number] {
  const start = Math.min(raceDay, ...pointDays, ...checkpointDays)
  return [start < raceDay ? start : raceDay - FALLBACK_SPAN_DAYS, raceDay]
}

/**
 * A plan chart's two end dates, `5 Feb` and `13 Mar`, each with its year
 * when the span crosses one, `14 Nov 2026` and `5 Dec 2027`, since a
 * marathon block can run longer than a year.
 */
export function spanEndLabels(firstDay: number, lastDay: number): [string, string] {
  if (yearLabel(firstDay) === yearLabel(lastDay)) return [dayMonthLabel(firstDay), dayMonthLabel(lastDay)]
  return [`${dayMonthLabel(firstDay)} ${yearLabel(firstDay)}`, `${dayMonthLabel(lastDay)} ${yearLabel(lastDay)}`]
}

/**
 * Which labels to draw, given each label's x in drawing order: the last
 * always, then walking back, any label at least `minGapPx` left of the
 * last one kept, so no two print one over the other.
 */
export function thinLabels(xs: number[], minGapPx: number): boolean[] {
  const keep = xs.map(() => false)
  let lastKept = Number.POSITIVE_INFINITY
  for (let i = xs.length - 1; i >= 0; i--) {
    const x = xs[i] as number
    if (lastKept - x >= minGapPx) {
      keep[i] = true
      lastKept = x
    }
  }
  return keep
}

/**
 * Which way each checkpoint label reads from its diamond in the strip,
 * `start` (rightward) or `end` (leftward), or null where it fits neither
 * way and is left to the chart's text alternative.
 *
 * Every diamond is drawn, so every diamond is an obstacle: a label may
 * not cover another checkpoint's diamond, nor a label already placed, nor
 * run past `[left, right]`. Labels are placed from the last checkpoint
 * back, so the nearest to the race keeps its label when two compete, and
 * each tries rightward first, the way a reader's eye moves along the axis.
 * `width` is each label's estimated width; `dx` the gap from a diamond's
 * centre to its label, `r` a diamond's half width, `pad` the clear space
 * kept around both.
 */
export function placeStripLabels(
  items: { cx: number; width: number }[],
  left: number,
  right: number,
  dx: number,
  r: number,
  pad: number,
): ('start' | 'end' | null)[] {
  const diamonds = items.map((item): [number, number] => [item.cx - r, item.cx + r])
  const placed: [number, number][] = []
  const clear = ([from, to]: [number, number], own: number) =>
    from >= left &&
    to <= right &&
    diamonds.every(([a, b], j) => j === own || to + pad <= a || from >= b + pad) &&
    placed.every(([a, b]) => to + pad <= a || from >= b + pad)
  const sides: ('start' | 'end' | null)[] = items.map(() => null)
  for (let i = items.length - 1; i >= 0; i--) {
    const { cx, width } = items[i] as { cx: number; width: number }
    const rightward: [number, number] = [cx + dx, cx + dx + width]
    const leftward: [number, number] = [cx - dx - width, cx - dx]
    if (clear(rightward, i)) {
      sides[i] = 'start'
      placed.push(rightward)
    } else if (clear(leftward, i)) {
      sides[i] = 'end'
      placed.push(leftward)
    }
  }
  return sides
}

/** The corner radius of a bar's top, a quarter of its width up to this, as Runna rounds its weekly bars. */
const BAR_CORNER_MAX_PX = 4

/**
 * A bar standing on `bottom` with its top corners rounded, as an SVG path:
 * Runna's weekly bars end in a soft cap, not a square. The radius is a
 * quarter of the width, at most `BAR_CORNER_MAX_PX`, and never more than
 * the bar is tall, so a short bar stays a bar rather than a bump. A bar of
 * no height is a flat line on the baseline.
 */
export function roundedTopBar(x: number, top: number, width: number, bottom: number): string {
  const height = Math.max(0, bottom - top)
  const r = Math.min(width / 4, BAR_CORNER_MAX_PX, height)
  const right = x + width
  return [
    `M ${String(x)} ${String(bottom)}`,
    `V ${String(top + r)}`,
    `Q ${String(x)} ${String(top)} ${String(x + r)} ${String(top)}`,
    `H ${String(right - r)}`,
    `Q ${String(right)} ${String(top)} ${String(right)} ${String(top + r)}`,
    `V ${String(bottom)}`,
    'Z',
  ].join(' ')
}

/**
 * An estimate of one character's advance at `--text-label` (12 px) in the
 * sans, the size every plan chart's axis and annotation text is set at:
 * SVG text cannot be measured before it is drawn, and a generous estimate
 * only drops a label a little early.
 */
export const LABEL_CHAR_PX = 7
const WEEK_LABEL_PAD_PX = 10

/**
 * Which `W1`..`Wn` labels to draw under weeks centred at `centres`, evenly
 * spaced: `W1` and every `k`th week after it, `k` the smallest stride that
 * keeps the widest label, `Wn`, clear of the next. A plan of five weeks
 * labels all five; a 35-week plan on a phone every fourth or so, so the
 * axis reads as a scale rather than a row of numbers run together.
 */
export function weekStride(centres: number[]): boolean[] {
  const first = centres[0]
  const second = centres[1]
  if (first === undefined || second === undefined) return centres.map(() => true)
  const need = `W${String(centres.length)}`.length * LABEL_CHAR_PX + WEEK_LABEL_PAD_PX
  const stride = Math.max(1, Math.ceil(need / (second - first)))
  return centres.map((_, i) => i % stride === 0)
}

/** An axis-aligned box in CSS pixels, for label placement. */
export interface LabelBox {
  left: number
  right: number
  top: number
  bottom: number
}

/** A `--text-label` line split at its baseline: ascent above, descent below. */
const LABEL_ASCENT_PX = 10
const LABEL_DESCENT_PX = 3
/** Where a line of figures' visual middle sits above its baseline. */
const LABEL_MIDDLE_PX = 4
/** How far a label may slide off its mark's middle and still read as beside it. */
const BESIDE_REACH_PX = 14
/** The air between a mark's edge and the label beside it. */
const BESIDE_GAP_PX = 5

function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/** The box of a `--text-label` line `width` wide from `left`, on `baseline`. */
export function labelBox(left: number, width: number, baseline: number): LabelBox {
  return { left, right: left + width, top: baseline - LABEL_ASCENT_PX, bottom: baseline + LABEL_DESCENT_PX }
}

/** A mark that wants a label beside it: its middle, its half width and its vertical extent. */
export interface BesideItem {
  cx: number
  half: number
  top: number
  bottom: number
  text: string
  width: number
  /** The side tried first: `start` reads rightward from the mark, `end` leftward. */
  prefer: 'start' | 'end'
}

/** Where a label beside its mark is drawn. */
export interface BesidePlacement {
  x: number
  anchor: 'start' | 'end'
  baseline: number
}

/**
 * Labels set beside their marks, never above or below them, so a label
 * can cover no mark's end and no line across the chart.
 *
 * Each label sits level with its mark's middle on the side it prefers,
 * then the other; failing both it may slide up or down by up to
 * `BESIDE_REACH_PX`, about a line, still level with the mark's edge, so a range
 * that straddles the goal line can still be labelled clear of it. A
 * label may cover no `obstacles` - every mark, the lines across the plot,
 * their labels - nor a label already placed, nor leave `bounds`. A text
 * already printed is not printed again: a range repeated week after week
 * is labelled once, where it first appears. A label with nowhere to go is
 * null and left to the chart's text alternative.
 */
export function besideLabels(items: BesideItem[], obstacles: LabelBox[], bounds: LabelBox): (BesidePlacement | null)[] {
  const placed: LabelBox[] = []
  const printed = new Set<string>()
  return items.map((it) => {
    if (printed.has(it.text)) return null
    const middle = (it.top + it.bottom) / 2
    const reach = Math.max(BESIDE_REACH_PX, (it.bottom - it.top) / 2)
    const offsets = [0, -7, 7, -10, 10, -14, 14].filter((o) => Math.abs(o) <= reach)
    const sides = it.prefer === 'start' ? (['start', 'end'] as const) : (['end', 'start'] as const)
    for (const dy of offsets) {
      for (const anchor of sides) {
        const x = anchor === 'start' ? it.cx + it.half + BESIDE_GAP_PX : it.cx - it.half - BESIDE_GAP_PX
        const left = anchor === 'start' ? x : x - it.width
        const baseline = middle + dy + LABEL_MIDDLE_PX
        const box = labelBox(left, it.width, baseline)
        const inside =
          box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom
        if (inside && obstacles.every((o) => !boxesOverlap(box, o)) && placed.every((p) => !boxesOverlap(box, p))) {
          placed.push(box)
          printed.add(it.text)
          return { x, anchor, baseline }
        }
      }
    }
    return null
  })
}

/**
 * Form's ladder: zero and a whole step either side of it, the step at or
 * above the largest swing, so positive and negative form read at the same
 * scale and zero, the line form is judged against, sits in the middle.
 */
export function signedLadder(values: number[]): Ladder {
  const step = wholeNiceCeil(Math.max(0, ...values.map((v) => Math.abs(v))))
  return { min: -step, max: step, ticks: [-step, 0, step] }
}
