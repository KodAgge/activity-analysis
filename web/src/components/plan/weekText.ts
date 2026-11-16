import type { components } from '../../api/schema'
import {
  NO_VALUE,
  calendarDayOfDate,
  calendarDayOfLocalDate,
  dayMonthLabel,
  formatLoadFigure as figure,
  heartRateRange,
  phaseLabel,
  sessionKindLabel,
  speedRangeAsKmh,
  speedRangeAsPace,
  stepAmount,
  stepRoleLabel,
  weekdayDayMonthNear,
} from '../../format'
import type { WeekLoadFigures } from './planLoadMath'
import type { SessionEntry, WeekEntry } from './planMath'

/**
 * The next week of the plan as plain text, for the header's `Copy as text`:
 * a note or a message holds it where a PDF is too much.
 *
 * It says what the week's PDF says, minus the workout profiles, through the
 * formatters `SessionDetail` uses, so the text and the page never state a
 * pace differently. Claude's descriptions are copied as written, since
 * their labelled-block format already reads as plain text.
 */

type Step = components['schemas']['Step']

/** The week's Monday as `31 Aug`, which the controls and the PDF's file name carry. */
export function weekStartLabel(entry: WeekEntry): string {
  return dayMonthLabel(calendarDayOfDate(entry.week.start_date))
}

/** The week's seven days as `31 Aug to 6 Sep`. */
export function weekRangeLabel(entry: WeekEntry): string {
  const start = calendarDayOfDate(entry.week.start_date)
  return `${dayMonthLabel(start)} to ${dayMonthLabel(start + 6)}`
}

/**
 * The week's phase, focus and planned distance as one line:
 * `Build. Add one quality session. 26 km planned.`
 */
export function weekSummary(entry: WeekEntry): string {
  const { phase, focus, planned_distance_m: planned } = entry.week
  const km = stepAmount(1, planned, null)
  const parts = [
    phaseLabel(phase),
    focus.trim().replace(/\.+$/, ''),
    km === NO_VALUE ? '' : `${km} planned`,
  ].filter((p) => p !== '')
  return `${parts.join('. ')}.`
}

/**
 * The week's load on one line, `Fitness (CTL) 56.0 -> 57.6, fatigue (ATL)
 * 68.8 -> 66.0, form -12.8 -> -8.4.`, or null without both points.
 */
export function weekLoadLine(load: WeekLoadFigures): string | null {
  const { start, end } = load
  if (start === null || end === null) return null
  return (
    `Fitness (CTL) ${figure(start.ctl)} -> ${figure(end.ctl)}, ` +
    `fatigue (ATL) ${figure(start.atl)} -> ${figure(end.atl)}, ` +
    `form ${figure(start.form, true)} -> ${figure(end.form, true)}.`
  )
}

/**
 * The week as text. With the zone boundaries in bpm, a heart rate target
 * carries the zone of its top, `up to 150 bpm (Z2)`, as the session dialog
 * prints it. With the week's load, its start and end and Claude's note
 * follow the summary, as they open the week's PDF.
 */
export function weekText(
  goal: string,
  entry: WeekEntry,
  today: Date,
  boundaries: readonly number[] | null = null,
  load: WeekLoadFigures | null = null,
): string {
  const todayDay = calendarDayOfLocalDate(today)
  const loadLines = load === null ? [] : [weekLoadLine(load), load.note].filter((l) => l !== null)
  const head = [`${goal}, week of ${weekRangeLabel(entry)}`, weekSummary(entry), ...loadLines].join('\n')
  return [head, ...entry.sessions.map((e) => sessionText(e, todayDay, boundaries))].join('\n\n')
}

function sessionText({ session }: SessionEntry, todayDay: number, boundaries: readonly number[] | null): string {
  const lines = [
    `${weekdayDayMonthNear(calendarDayOfDate(session.date), todayDay)} · ${sessionKindLabel(session.kind)} · ${session.title}`,
  ]
  const planned = [
    stepAmount(1, session.planned_distance_m ?? null, null),
    stepAmount(1, null, session.planned_duration_s ?? null),
  ].filter((p) => p !== NO_VALUE)
  if (planned.length > 0) lines.push(`Planned ${planned.join(' · ')}`)
  const description = session.description.trim()
  if (description !== '') lines.push(description)
  // A blank line before the steps, as between the description's own blocks.
  if (session.steps.length > 0) {
    if (description !== '') lines.push('')
    lines.push('Steps:', ...session.steps.flatMap((step) => stepLines(step, boundaries)))
  }
  return lines.join('\n')
}

/** A step as `- Work 6 × 800 m · 4:00-4:10/km · 14.4-15.0 km/h`, its note on the line below. */
function stepLines(step: Step, boundaries: readonly number[] | null): string[] {
  const speed = step.speed ?? null
  const hr = step.heart_rate ?? null
  const parts = [
    `${stepRoleLabel(step.role)} ${stepAmount(step.repeat, step.distance_m ?? null, step.duration_s ?? null)}`,
  ]
  if (speed !== null) parts.push(speedRangeAsPace(speed.low_mps, speed.high_mps), speedRangeAsKmh(speed))
  if (hr !== null) parts.push(heartRateRange(hr.low_bpm, hr.high_bpm, boundaries))
  const note = (step.note ?? '').trim()
  return note === '' ? [`- ${parts.join(' · ')}`] : [`- ${parts.join(' · ')}`, `  ${note}`]
}
