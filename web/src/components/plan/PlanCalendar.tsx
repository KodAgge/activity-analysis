import { Link } from '@tanstack/react-router'
import {
  calendarDayOfDate,
  calendarDayOfLocalDate,
  dayMonthLabel,
  dayOfMonthLabel,
  distance,
  distanceKm,
  outcomeLabel,
  phaseLabel,
  sessionKindLabel,
  stepAmount,
  weekdayDayMonthNear,
} from '../../format'
import { SessionProfile } from '../../charts/SessionProfile'
import type { SessionProfileOptions } from '../../charts/sessionProfileMath'
import { DESKTOP_OR_PRINT_QUERY, useMediaQuery } from '../../views/useMediaQuery'
import { PlanCard } from './PlanCard'
import { ProgressDashes } from './ProgressDashes'
import type { DashState } from './ProgressDashes'
import {
  RUNS_LOADING,
  calendarWeeks,
  isoDateOfDay,
  outcomeBySession,
  paceRange,
  profileBasis,
  sessionTarget,
  weeklyDistance,
} from './planMath'
import type { ActivitySummary, CalendarDay, CalendarWeek, Outcome, PlanVersion, Session } from './planMath'
import { KIND_MARK, SLOT_KEY, VERDICT_GLYPH, kindSlotClass } from './sessionMarks'
import styles from './PlanCalendar.module.css'

export interface PlanCalendarProps {
  version: PlanVersion
  /** From `runsByLocalDay`: every run in the plan's span, under its local day. */
  runsByDay: Map<number, ActivitySummary[]>
  /** From `changedSessionIds`: the sessions the shown proposal changes. */
  changed: Set<string>
  today: Date
  /** Why the runs could not be loaded, stated above a calendar drawn without them. */
  runsError?: string | null
  /**
   * The runs have not arrived yet. Said above the calendar, because a plan
   * drawn without its runs otherwise reads as nothing done; the sessions
   * are drawn meanwhile, since they do not wait on the runs.
   */
  runsLoading?: boolean
  /** Opens a session's detail; every planned session is a button that calls it with its id. */
  onOpenSession: (id: string) => void
}

/** Monday first, as the plan's weeks run. */
const WEEKDAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const CHANGED = 'Changed in this proposal'

/**
 * The plan as a calendar, beside the runs done: weeks as rows, Monday to
 * Sunday, each day with its planned session, every run on it and Claude's
 * verdict on the session once it has passed.
 *
 * The runs are filed by the athlete's local calendar day and nothing here
 * matches a run to a session: a run on a rest day shows on the rest day,
 * and the matching that counts is Claude's, in the outcomes.
 *
 * Each week opens the way Runna's week card does: its dates, its number
 * and phase, a dash per session, filled once Claude has judged it run, and
 * the sessions and distance as counts. A session is a block tinted in its
 * kind with the kind's bar down its side.
 *
 * On a phone the seven columns do not fit, so the grid becomes a list of
 * the days that have a session or a run, grouped by week, each day a row
 * with its weekday and date in a narrow column. The two are two DOM trees
 * rather than one restyled, because a table's semantics are what make the
 * grid readable by row and column and are wrong for a list.
 */
export function PlanCalendar({
  version,
  runsByDay,
  changed,
  today,
  runsError = null,
  runsLoading = false,
  onOpenSession,
}: PlanCalendarProps) {
  const desktop = useMediaQuery(DESKTOP_OR_PRINT_QUERY)
  const weeks = calendarWeeks(version, runsByDay)
  const runsKnown = !runsLoading && runsError === null
  const runM = new Map(runsKnown ? weeklyDistance(version, runsByDay, today).map((w) => [w.startDate, w.runM]) : [])
  const outcomes = outcomeBySession(version)
  const todayDay = calendarDayOfLocalDate(today)
  const profile = profileBasis(version)
  const next = nextSessionId(weeks, outcomes, todayDay)
  const shared = { weeks, runM, outcomes, changed, todayDay, onOpenSession, profile, next }
  return (
    <PlanCard title="Calendar">
      {runsError !== null && (
        <p role="alert" className={styles.error}>
          Could not load the runs: {runsError}
        </p>
      )}
      {runsLoading && (
        <p className={styles.loading} role="status">
          {RUNS_LOADING}
        </p>
      )}
      {desktop ? <Grid {...shared} /> : <DayList {...shared} />}
      <Legend showChanged={changed.size > 0} />
    </PlanCard>
  )
}

interface LayoutProps {
  weeks: CalendarWeek[]
  /**
   * From `weeklyDistance`: the distance run in each week by its start date,
   * null for a week not begun. Empty while the runs are loading or failed,
   * since a week whose runs have not arrived would read as nothing run.
   */
  runM: Map<string, number | null>
  outcomes: Map<string, Outcome>
  changed: Set<string>
  todayDay: number
  onOpenSession: (id: string) => void
  /** The plan's basis for the sessions' mini profiles, so a week's sessions share one scale. */
  profile: SessionProfileOptions
  /** From `nextSessionId`: the session to run next, its week's current dash. */
  next: string | null
}

/**
 * The next session to run: the first one on or after today, rest days
 * aside, that Claude has not judged yet. Its dash is the week's current
 * one, so the dashes say where in the plan today stands.
 */
function nextSessionId(weeks: CalendarWeek[], outcomes: Map<string, Outcome>, todayDay: number): string | null {
  for (const w of weeks) {
    for (const d of w.days) {
      if (d.day < todayDay) continue
      const session = d.sessions.find((s) => counts(s) && !outcomes.has(s.id))
      if (session !== undefined) return session.id
    }
  }
  return null
}

/**
 * Which weekdays, Monday first, hold a session or a run in some written
 * week. The grid gives these the width and shrinks the rest to their
 * dates, once across the whole plan so every week's days stay in line.
 */
function busyWeekdays(weeks: CalendarWeek[]): boolean[] {
  return WEEKDAY_HEADERS.map((_, i) =>
    weeks.some((w) => {
      const d = w.days[i]
      return d !== undefined && (d.sessions.length > 0 || d.runs.length > 0)
    }),
  )
}

function Grid({ weeks, runM, outcomes, changed, todayDay, onOpenSession, profile, next }: LayoutProps) {
  const firstDay = weeks[0]?.days[0]?.day
  const busy = busyWeekdays(weeks)
  // A plan with nothing on any day yet keeps seven equal columns.
  const sized = busy.some((b) => b)
  return (
    <table className={styles.grid}>
      <caption className={styles.hidden}>The plan by week, Monday to Sunday, with the runs done each day</caption>
      <thead>
        <tr>
          <td className={styles.corner} />
          {WEEKDAY_HEADERS.map((d, i) => (
            <th
              key={d}
              scope="col"
              className={sized && busy[i] !== true ? `${styles.weekday} ${styles.restColumn}` : styles.weekday}
            >
              {d}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((w) => (
          <tr key={w.week.start_date} className={styles.gridWeek}>
            <th scope="row" className={styles.weekHead}>
              <WeekSummary week={w} runM={runM.get(w.week.start_date) ?? null} outcomes={outcomes} next={next} />
            </th>
            {w.days.length === 0 ? (
              <td colSpan={7} className={styles.outlineCell}>
                <OutlineWeek week={w} />
              </td>
            ) : (
              w.days.map((d, i) => (
                <td
                  key={d.day}
                  className={[
                    styles.day,
                    sized && busy[i] !== true ? styles.restDay : null,
                    d.day === todayDay ? styles.today : null,
                    d.sessions.length === 0 && d.runs.length === 0 ? styles.empty : null,
                  ]
                    .filter((c) => c !== null)
                    .join(' ')}
                  aria-current={d.day === todayDay ? 'date' : undefined}
                >
                  <time dateTime={isoDateOfDay(d.day)} className={styles.date}>
                    <DateNumber day={d.day} withMonth={d.day === firstDay} />
                    <span className={styles.hidden}>{weekdayDayMonthNear(d.day, todayDay)}</span>
                  </time>
                  <DayContents
                    day={d}
                    todayDay={todayDay}
                    outcomes={outcomes}
                    changed={changed}
                    onOpenSession={onOpenSession}
                    profile={profile}
                  />
                </td>
              ))
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function DayList({ weeks, runM, outcomes, changed, todayDay, onOpenSession, profile, next }: LayoutProps) {
  return (
    <ol className={styles.weeks}>
      {weeks.map((w) => {
        const days = w.days.filter((d) => d.sessions.length > 0 || d.runs.length > 0 || d.day === todayDay)
        return (
          <li key={w.week.start_date} className={styles.listWeek}>
            <WeekSummary
              week={w}
              runM={runM.get(w.week.start_date) ?? null}
              outcomes={outcomes}
              next={next}
              heading
            />
            {w.days.length === 0 ? (
              <div className={styles.listOutline}>
                <OutlineWeek week={w} />
              </div>
            ) : (
              <ol className={styles.days}>
                {days.map((d) => {
                  const isToday = d.day === todayDay
                  return (
                    <li
                      key={d.day}
                      className={isToday ? `${styles.listDay} ${styles.today}` : styles.listDay}
                      aria-current={isToday ? 'date' : undefined}
                    >
                      <p className={styles.dayColumn}>
                        {/* The disc alone would say today by shape only; the word says it outright. */}
                        {isToday && <strong className={styles.todayWord}>Today</strong>}
                        <span aria-hidden="true" className={styles.weekdayShort}>
                          {weekdayShort(d.day)}
                        </span>
                        <DateNumber day={d.day} withMonth={false} />
                        <time dateTime={isoDateOfDay(d.day)} className={styles.hidden}>
                          {weekdayDayMonthNear(d.day, todayDay)}
                        </time>
                      </p>
                      <div className={styles.dayBody}>
                        <DayContents
                          day={d}
                          todayDay={todayDay}
                          outcomes={outcomes}
                          changed={changed}
                          onOpenSession={onOpenSession}
                          profile={profile}
                          verbose
                        />
                        {d.sessions.length === 0 && d.runs.length === 0 && (
                          <p className={styles.nothing}>Nothing planned.</p>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ol>
            )}
          </li>
        )
      })}
    </ol>
  )
}

/** `Tue`, from a day number; day 0, 1 January 1970, was a Thursday. */
function weekdayShort(day: number): string {
  return WEEKDAY_HEADERS[(((day + 3) % 7) + 7) % 7] ?? ''
}

/**
 * A day's date as the calendar draws it, big, with its month set small
 * beside it where `dayOfMonthLabel` gives one: the 1st, and any day asked.
 * Hidden from a screen reader, which reads the full date beside it.
 */
function DateNumber({ day, withMonth }: { day: number; withMonth: boolean }) {
  const [number, month] = dayOfMonthLabel(day, withMonth).split(' ')
  return (
    <span aria-hidden="true" className={styles.dateNumber}>
      <span className={styles.dateDigits}>{number}</span>
      {month !== undefined && <span className={styles.dateMonth}>{month}</span>}
    </span>
  )
}

/** `16-22 Nov`, or `30 Nov - 6 Dec` across a month's end: a week's span, as Runna heads a week. */
function weekRange(startDate: string): string {
  const start = calendarDayOfDate(startDate)
  const [startDay = '', startMonth = ''] = dayMonthLabel(start).split(' ')
  const end = dayMonthLabel(start + 6)
  return end.endsWith(startMonth) ? `${startDay}-${end}` : `${dayMonthLabel(start)} - ${end}`
}

/** A session that counts toward a week's dashes: anything but a rest day. */
function counts(session: Session): boolean {
  return session.kind !== 'rest'
}

/** Judged as run in some form: done, partly, on another day or as another session. */
function ran(outcome: Outcome | undefined): boolean {
  return outcome !== undefined && outcome.verdict !== 'missed'
}

interface WeekSummaryProps {
  week: CalendarWeek
  runM: number | null
  outcomes: Map<string, Outcome>
  /** The session to run next, drawn as the current dash in its week. */
  next: string | null
  /** The phone list heads each week with an `h3`; the grid's row header has none. */
  heading?: boolean
}

/**
 * A week's head, Runna's week card: its dates, `Week 3` with its phase, a
 * dash per session filled once it is run, the next one to run in dim ink
 * so the plan always shows where today stands, and the sessions run and the
 * distance as counts. The distance is the plan's for a week not begun, or
 * while the runs are unknown, and run against planned once it has, as the
 * weekly distance chart has it.
 * An outline week has no sessions yet, so it has no dashes and no count.
 */
function WeekSummary({ week, runM, outcomes, next, heading = false }: WeekSummaryProps) {
  const sessions = week.days.flatMap((d) => d.sessions).filter(counts)
  const done = sessions.filter((s) => ran(outcomes.get(s.id))).length
  const dashes: DashState[] = sessions.map((s) => {
    if (ran(outcomes.get(s.id))) return 'done'
    return s.id === next ? 'current' : 'todo'
  })
  const upcoming = sessions.find((s) => s.id === next)
  const label = `Week ${String(week.number)}: ${String(done)} of ${String(sessions.length)} sessions run`
  const planned = distance(week.week.planned_distance_m, 0)
  const Title = heading ? 'h3' : 'p'
  return (
    <div className={styles.summary}>
      <p className={styles.range}>{weekRange(week.week.start_date)}</p>
      <Title className={styles.weekTitle}>
        <span className={styles.weekNumber}>Week {week.number}</span>{' '}
        <span className={styles.phase}>{phaseLabel(week.week.phase)}</span>
      </Title>
      {sessions.length > 0 && (
        <ProgressDashes
          items={dashes}
          label={upcoming === undefined ? label : `${label}, ${upcoming.title} next`}
          className={styles.dashes}
        />
      )}
      <p className={styles.counts}>
        {sessions.length > 0 && (
          <span className={styles.count}>
            <span className={styles.countLabel}>Sessions</span>{' '}
            <span className={styles.countValue}>
              {done}/{sessions.length}
            </span>
          </span>
        )}{' '}
        <span className={styles.count}>
          <span className={styles.countLabel}>Distance</span>{' '}
          <span className={styles.countValue}>{runM === null ? planned : `${distanceKm(runM, 1)}/${planned}`}</span>
        </span>
      </p>
    </div>
  )
}

/**
 * A week not yet written out: its focus, why it has no days, and any run
 * already done in it, which a plan left unrevised past the week's start
 * would otherwise hide.
 */
function OutlineWeek({ week }: { week: CalendarWeek }) {
  return (
    <div className={styles.outline}>
      <p className={styles.focus}>{week.week.focus}</p>
      <p className={styles.outlineNote}>Sessions are written out when the week comes within three weeks.</p>
      {week.outlineRuns.length > 0 && (
        <ul className={styles.outlineRuns}>
          {week.outlineRuns.map((r) => (
            <li key={r.activity_id}>
              <RunLink run={r} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface DayContentsProps {
  day: CalendarDay
  todayDay: number
  outcomes: Map<string, Outcome>
  changed: Set<string>
  onOpenSession: (id: string) => void
  profile: SessionProfileOptions
  /** The phone list's room: the verdict's word and Claude's note are shown, not only the glyph. */
  verbose?: boolean
}

function DayContents({ day, todayDay, outcomes, changed, onOpenSession, profile, verbose = false }: DayContentsProps) {
  return (
    <>
      {day.sessions.map((s) => (
        <SessionBlock
          key={s.id}
          session={s}
          dateLabel={weekdayDayMonthNear(day.day, todayDay)}
          outcome={outcomes.get(s.id)}
          changed={changed.has(s.id)}
          onOpen={onOpenSession}
          profile={profile}
          verbose={verbose}
        />
      ))}
      {day.runs.map((r) => (
        <RunLink key={r.activity_id} run={r} />
      ))}
    </>
  )
}

interface SessionBlockProps {
  session: Session
  /** The day for a screen reader, which reaches the button out of its cell: `Tuesday 17 November`. */
  dateLabel: string
  outcome: Outcome | undefined
  changed: boolean
  onOpen: (id: string) => void
  profile: SessionProfileOptions
  verbose: boolean
}

/**
 * A planned session as Runna's workout block: tinted in its kind, with the
 * kind's bar down its side, its title bold, and under it its distance and
 * pace with its workout profile as a sparkline, beside them on a phone and
 * under them in the grid; a verdict's glyph sits in the corner. A
 * session the proposal changes has a dashed outline, which reads without
 * colour, and says so to a screen reader.
 *
 * The whole block is a native button that opens the session's detail, so
 * Enter and Space open it as a click does and a screen reader's name for
 * it starts with the day and the title. `data-session-id` is how the
 * detail gives focus back to it on closing.
 */
function SessionBlock({ session, dateLabel, outcome, changed, onOpen, profile, verbose }: SessionBlockProps) {
  const target = blockTarget(session)
  const classes = [
    styles.session,
    kindSlotClass(session.kind),
    KIND_MARK.bar,
    KIND_MARK.tint,
    changed ? styles.changed : null,
    outcome !== undefined ? styles.judged : null,
  ]
  return (
    <button
      type="button"
      className={classes.filter((c) => c !== null && c !== '').join(' ')}
      data-session-id={session.id}
      onClick={() => onOpen(session.id)}
    >
      {/* The spaces between the parts are text nodes, which the flex
          layout ignores and a screen reader's name for the button keeps. */}
      <span className={styles.hidden}>
        {dateLabel}, {sessionKindLabel(session.kind)}:
      </span>{' '}
      <span className={styles.title}>{session.title}</span>{' '}
      <span className={styles.detail}>
        {target !== null && <span className={styles.target}>{target}</span>}
        <span className={styles.profile}>
          <SessionProfile session={session} size="mini" {...profile} />
        </span>
      </span>
      {outcome !== undefined && <> <Verdict outcome={outcome} verbose={verbose} /></>}
      {changed && <> <span className={verbose ? styles.changedNote : styles.hidden}>{CHANGED}</span></>}
    </button>
  )
}

/**
 * What a block says under its title, as Runna puts a distance on every
 * workout: the session's planned distance, then the pace of its first work
 * step that has one, `10 km · 4:15-4:20`. A session with no planned
 * distance says what `sessionTarget` picks.
 */
function blockTarget(session: Session): string | null {
  const plannedM = session.planned_distance_m ?? null
  if (plannedM === null) return sessionTarget(session)
  const planned = stepAmount(1, plannedM, null)
  const speed = session.steps.find((s) => s.role === 'work' && (s.speed ?? null) !== null)?.speed ?? null
  return speed === null ? planned : `${planned} · ${paceRange(speed)}`
}

/**
 * Claude's verdict: its glyph in a disc in the block's corner, as Runna
 * ticks a workout done, and on a phone its word and note under the
 * profile. The glyph is hidden from a screen reader, which reads the word.
 */
function Verdict({ outcome, verbose }: { outcome: Outcome; verbose: boolean }) {
  const label = outcomeLabel(outcome.verdict)
  return (
    <span className={styles.verdict} title={outcome.note === '' ? undefined : outcome.note}>
      <span aria-hidden="true" className={styles.glyph}>
        {VERDICT_GLYPH[outcome.verdict]}
      </span>
      <span className={verbose ? styles.verdictWord : styles.hidden}>{label}</span>
      {verbose && outcome.note !== '' && <span className={styles.note}>{outcome.note}</span>}
    </span>
  )
}

function RunLink({ run }: { run: ActivitySummary }) {
  return (
    <Link to="/activities/$activityId" params={{ activityId: run.activity_id }} className={styles.run}>
      <span className={styles.runWord}>Run</span> {distance(run.distance_m, 1)}
    </Link>
  )
}

/** What the colours, the glyphs and the dashed outline mean. */
function Legend({ showChanged }: { showChanged: boolean }) {
  return (
    <ul className={styles.legend} aria-label="Key">
      {SLOT_KEY.map(({ slot, label }) => (
        <li key={label} className={styles.legendKind}>
          <span aria-hidden="true" className={`${KIND_MARK.swatch} ${slot} ${styles.swatch}`} />
          {label}
        </li>
      ))}
      <li className={styles.legendVerdicts}>
        {(Object.keys(VERDICT_GLYPH) as Outcome['verdict'][]).map((v) => (
          <span key={v} className={styles.legendVerdict}>
            <span aria-hidden="true" className={styles.glyph}>
              {VERDICT_GLYPH[v]}
            </span>{' '}
            {outcomeLabel(v)}
          </span>
        ))}
      </li>
      {showChanged && (
        <li className={styles.legendKind}>
          <span aria-hidden="true" className={`${styles.swatch} ${styles.swatchChanged}`} />
          {CHANGED}
        </li>
      )}
      <li className={styles.legendNote}>Paces per kilometre</li>
    </ul>
  )
}
