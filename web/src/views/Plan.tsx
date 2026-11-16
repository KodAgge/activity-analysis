import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useRouter, useSearch } from '@tanstack/react-router'
import { useRef } from 'react'
import { describeApiError, isNotFoundError } from '../api/errors'
import type { components } from '../api/schema'
import type { PlanSearch } from '../api/planSearch'
import { queries } from '../api/queries'
import { Absent } from '../components/Absent'
import chartCard from '../charts/PlanChartCard.module.css'
import { PlanFitness } from '../charts/PlanFitness'
import { PlanIntensity } from '../charts/PlanIntensity'
import { PlanLeadIn } from '../charts/PlanLeadIn'
import { PlanLoad } from '../charts/PlanLoad'
import { PlanOutlook } from '../charts/PlanOutlook'
import { PlanPaces } from '../charts/PlanPaces'
import { PlanTrajectory } from '../charts/PlanTrajectory'
import { PlanVolume } from '../charts/PlanVolume'
import { PlanZoneMix } from '../charts/PlanZoneMix'
import {
  LEAD_IN_WEEKS,
  easyBand,
  goalPaceS,
  leadInSpan,
  leadInWeeks,
  paceMarks,
  planDays,
  weeklyMix,
} from '../charts/planShapeMath'
import { NextSession } from '../components/plan/NextSession'
import { PlanCard, PlanGrid, PlanSurface } from '../components/plan/PlanCard'
import { PlanAssessment } from '../components/plan/PlanAssessment'
import { PlanCalendar } from '../components/plan/PlanCalendar'
import { PlanHeader } from '../components/plan/PlanHeader'
import { PlanHistory } from '../components/plan/PlanHistory'
import { PlanRow } from '../components/plan/PlanRow'
import { ROW_LIST, rowClass } from '../components/plan/planRowClasses'
import { ProposalPanel } from '../components/plan/ProposalPanel'
import { SessionAppendix, SessionDialog, WeekAppendix } from '../components/plan/SessionDetail'
import {
  RUNS_LOADING,
  archivedByAccepting,
  changedSessionIds,
  checkpointSessions,
  currentAndPending,
  displayedGoal,
  isoDateOfDay,
  nextSession,
  nextWeek,
  outcomeBySession,
  planSpan,
  runsByLocalDay,
  sessionEntries,
  sessionEntry,
  shownVersion,
  trajectory,
  weeklyDistance,
} from '../components/plan/planMath'
import type { ActivitySummary, PlanSummary, PlanVersion } from '../components/plan/planMath'
import {
  fitnessFirstDay,
  fitnessSeries,
  outlookSeries,
  plannedLoadNote,
  weeklyLoad,
  weekLoad,
  weeklyZoneMix,
} from '../components/plan/planLoadMath'
import type { RunLoad } from '../components/plan/planLoadMath'
import {
  calendarDayOfDate,
  calendarDayOfLocalDate,
  dayMonthLabel,
  dayMonthNear,
  goalTitle,
  planStatusLabel,
  raceDistanceBadge,
  raceDistanceLabel,
} from '../format'
import styles from './Plan.module.css'

type LoadWeek = components['schemas']['LoadWeek']

export interface PlanProps {
  /**
   * The day the page treats as today: the countdown, the data's age and
   * the next session all hang off it. Defaults to the browser's own clock
   * at render; a test passes a fixed day so it does not depend on when it
   * runs.
   */
  today?: Date
}

/**
 * The training plan Claude wrote toward a race, as the athlete reads it.
 *
 * `/plan` opens on `displayedGoal` - a goal with a proposal awaiting a
 * decision first, then the active one, then the newest - and
 * `/plan/$goalId` on one goal. Of that goal it shows `shownVersion`: the
 * version `?version=N` names, else the pending one, else the accepted one.
 *
 * Read-only, like the server behind it: a plan is proposed, accepted and
 * revised through `activity-analysis plan` and the `/training-plan` skill,
 * and every place the page asks for a decision names the command.
 *
 * Top to bottom: the goal with the phase strip, the proposal when one is
 * shown, the calendar, every session's detail in the long PDF only, the
 * next week's sessions in the week PDF only, the next session, the
 * assessment, the eight weeks before the plan, weekly distance, the
 * weekly load, the heart-rate mix, fitness and fatigue, the VO2max
 * outlook, the intensity mix, the target paces, the trajectory, the
 * history and the other goals.
 * The calendar moved up and the overview charts came in at the
 * maintainer's ask on 2026-11-15.
 * Eight of the nine charts stand in pairs, side by side where the column
 * is wide enough for two (`CHART_PAIR_MIN`); fitness and fatigue takes the
 * full width.
 */
export function Plan({ today = new Date() }: PlanProps) {
  const { goalId } = useParams({ strict: false })
  const search: PlanSearch = useSearch({ strict: false })
  const plansQuery = useQuery(queries.plans())

  if (plansQuery.isPending) return <p>Loading the plan…</p>
  if (plansQuery.isError) {
    return <p role="alert">Could not load the plans: {describeApiError(plansQuery.error)}</p>
  }

  const plans = plansQuery.data.items
  const id = goalId ?? displayedGoal(plans)?.goal_id
  if (id === undefined) return <NoPlan />
  return (
    <GoalPlan goalId={id} plans={plans} requested={search.version} openSession={search.session} today={today} />
  )
}

interface GoalPlanProps {
  goalId: string
  plans: PlanSummary[]
  requested: number | undefined
  /** `?session=`: the session whose detail is open, if the shown version has it. */
  openSession: string | undefined
  today: Date
}

/**
 * The narrowest a chart card may be beside another: two to a row across a
 * desktop's content column, and one on a phone, whose column is narrower.
 * Eight of the overview charts stand in four pairs, each pair two views of
 * one question: the weeks before and the weeks of the plan, the load and
 * its heart-rate mix, fitness and intensity, the paces and the time they
 * aim at.
 */
const CHART_PAIR_MIN = '26rem'

/** Stands in for the runs while they load or when there is no span to ask for. */
const NO_RUNS: ActivitySummary[] = []

/**
 * The weekly distance chart's note when the runs failed to load: the
 * calendar above states the server's reason, so this says only what the
 * chart leaves out.
 */
const RUNS_FAILED = 'The runs could not be loaded, so only the plan is drawn.'

/** Stands in for the runs' load while it loads or when there is no span to ask for. */
const NO_LOADS: RunLoad[] = []
const NO_LOAD_WEEKS: LoadWeek[] = []

/** The fitness chart's note while its measured weeks are not drawn. */
function fitnessNote(load: { isPending: boolean; isError: boolean }, hasSpan: boolean): string | null {
  if (hasSpan && load.isPending) return 'Loading the measured fitness and fatigue.'
  if (load.isError) return 'The measured fitness and fatigue could not be loaded, so only the expected is drawn.'
  return null
}

/**
 * Why the load and heart-rate mix charts draw no run bars, or null when
 * they can: the runs' load is on its way or failed. A run's TRIMP and zone
 * time are stored with it, so the threshold request holds nothing back.
 */
function loadNote(load: { isPending: boolean; isError: boolean }, hasSpan: boolean): string | null {
  if (hasSpan && load.isPending) return 'Loading the heart rate of the runs done on these days.'
  if (load.isError) return "The runs' heart rate could not be loaded, so only the plan is drawn."
  return null
}

/**
 * The heart-rate mix's note: the load's, or, when the store answers that
 * it has no threshold estimate, that no run has zones. A run's TRIMP needs
 * no threshold, so the weekly load draws its runs regardless.
 */
function zoneMixNote(loadNoteText: string | null, threshold: { data?: { current: unknown } }): string | null {
  if (loadNoteText !== null) return loadNoteText
  if (threshold.data?.current === null) return 'No threshold estimate yet.'
  return null
}

function GoalPlan({ goalId, plans, requested, openSession, today }: GoalPlanProps) {
  const detailQuery = useQuery(queries.plan(goalId))
  const sessionUrl = useSessionUrl()
  const entry = detailQuery.data === undefined ? null : shownVersion(detailQuery.data, requested)
  const span = entry === null ? null : planSpan(entry.plan)
  // Every run in the plan's span, paged through, since a long plan can hold
  // more runs than the endpoint's one page. Asked for here rather than in
  // the calendar because the weekly distance chart reads the same runs.
  const runsQuery = useQuery({
    ...queries.everyActivity({ sport: 'running', from: span?.from, to: span?.to }),
    enabled: span !== null,
  })
  // The runs' load, zone time and heart rate over the same span, whose
  // `to` is inclusive where `/api/activities`' is not, reaching back to the
  // fitness chart's first day for its weeks before the plan. The charts
  // that file runs by plan week leave the earlier runs out.
  const loadQuery = useQuery({
    ...queries.trainingLoad({
      from: entry === null || span === null ? undefined : isoDateOfDay(fitnessFirstDay(entry.plan)),
      to: span === null ? undefined : isoDateOfDay(calendarDayOfDate(span.to) - 1),
    }),
    enabled: span !== null,
  })
  const thresholdQuery = useQuery(queries.threshold())
  const fitnessQuery = useQuery(queries.fitness())

  if (detailQuery.isPending) return <p>Loading the plan…</p>
  if (detailQuery.isError) {
    if (isNotFoundError(detailQuery.error)) return <UnknownGoal reason={describeApiError(detailQuery.error)} />
    return <p role="alert">Could not load this plan: {describeApiError(detailQuery.error)}</p>
  }

  const detail = detailQuery.data
  if (entry === null) return <NoPlan />
  const plan = entry.plan
  const others = plans.filter((p) => p.goal_id !== goalId)
  const { accepted } = currentAndPending(detail)
  // Only a shown proposal marks its changes: on an older version the marks
  // would describe a plan the page is not drawing.
  const changed = entry.status === 'proposed' ? changedSessionIds(accepted, plan) : new Set<string>()
  const runsByDay = runsByLocalDay(runsQuery.data ?? NO_RUNS)
  // A plan with no weeks asks for no runs, and its disabled query stays
  // pending for good, so pending alone is not loading.
  const runsLoading = span !== null && runsQuery.isPending
  const runsNote = runsLoading ? RUNS_LOADING : runsQuery.isError ? RUNS_FAILED : null
  const pendingNumber = detail.versions.find((v) => v.status === 'proposed')?.number
  const outcomes = outcomeBySession(plan)
  const next = nextSession(plan, today)
  const nextEntry = next === null ? null : sessionEntry(plan, next.id)
  // An id the shown version has no session for opens nothing.
  const opened = sessionEntry(plan, openSession)
  const days = planDays(plan)
  const week = nextWeek(plan, today)
  const runLoads = loadQuery.data?.runs ?? NO_LOADS
  const runLoadsNote = loadNote(loadQuery, span !== null)
  const runZonesNote = zoneMixNote(runLoadsNote, thresholdQuery)
  // The zones a heart rate target is labelled with: the version's own, as
  // it was written, else the current estimate's for a version without.
  const zoneBoundaries = plan.provenance.zone_boundaries_bpm ?? thresholdQuery.data?.current?.boundaries_bpm ?? null
  const hr = { zoneBoundaries, runLoads }
  const outlook = outlookSeries(detail, plan)
  const fitness = fitnessSeries(plan, loadQuery.data?.weeks ?? NO_LOAD_WEEKS)
  const deviceNote = fitnessQuery.isPending
    ? "Loading Garmin's own VO2max."
    : fitnessQuery.isError
      ? `Garmin's own VO2max could not be loaded: ${describeApiError(fitnessQuery.error)}.`
      : null

  return (
    <div className={styles.plan}>
      {pendingNumber !== undefined && pendingNumber !== entry.number && (
        <PlanSurface className={styles.pendingNotice}>
          <span className={styles.pendingTag}>Proposed</span>
          <Link to="/plan/$goalId" params={{ goalId }} className={styles.link}>
            Version {pendingNumber} is proposed and waiting for your decision.
          </Link>
        </PlanSurface>
      )}
      <PlanHeader
        entry={entry}
        goalStatus={detail.status}
        result={plan.result ?? accepted?.result ?? null}
        week={week}
        today={today}
        zoneBoundaries={zoneBoundaries}
      />
      {entry.status === 'proposed' && (
        <ProposalPanel entry={entry} goalId={goalId} archives={archivedByAccepting(plans, goalId)} />
      )}
      <PlanCalendar
        version={plan}
        runsByDay={runsByDay}
        changed={changed}
        today={today}
        runsError={runsQuery.isError ? describeApiError(runsQuery.error) : null}
        runsLoading={runsLoading}
        onOpenSession={sessionUrl.open}
      />
      <SessionAppendix
        entries={sessionEntries(plan)}
        outcomes={outcomes}
        runsByDay={runsByDay}
        today={today}
        {...hr}
      />
      {week !== null && (
        <WeekAppendix
          entry={week}
          outcomes={outcomes}
          runsByDay={runsByDay}
          today={today}
          load={{
            figures: weekLoad(plan, week.week),
            fitness,
            weekFromDay: calendarDayOfDate(week.week.start_date),
            weekToDay: Math.min(calendarDayOfDate(week.week.start_date) + 7, fitness.raceDay),
            planStartDay: span === null ? fitness.raceDay : calendarDayOfDate(span.from),
            measuredNote: fitnessNote(loadQuery, span !== null),
          }}
          {...hr}
        />
      )}
      <NextSession
        entry={nextEntry}
        outcome={next === null ? null : (outcomes.get(next.id) ?? null)}
        runsByDay={runsByDay}
        today={today}
        {...hr}
      />
      <PlanAssessment assessment={plan.assessment} />
      <PlanGrid min={CHART_PAIR_MIN}>
        <LeadIn plan={plan} today={today} />
        <PlanCard
          className={chartCard.card}
          title="Weekly distance"
          note="Planned against run, per week of the plan."
        >
          <PlanVolume weeks={weeklyDistance(plan, runsByDay, today)} runsNote={runsNote} />
        </PlanCard>
      </PlanGrid>
      <PlanGrid min={CHART_PAIR_MIN}>
        <PlanCard
          className={chartCard.card}
          title="Weekly load"
          note="Planned against run TRIMP. Planned TRIMP is the plan's minutes in each zone times your recent TRIMP per minute in that zone."
        >
          <PlanLoad
            weeks={weeklyLoad(plan, runLoads, today)}
            plannedNote={plannedLoadNote(plan)}
            runsNote={runLoadsNote}
          />
        </PlanCard>
        <PlanCard
          className={chartCard.card}
          title="Heart-rate mix"
          note="Minutes in zones 1-2, 3 and 4-5, planned against run."
        >
          <PlanZoneMix weeks={weeklyZoneMix(plan, runLoads, today)} runsNote={runZonesNote} />
        </PlanCard>
      </PlanGrid>
      {/* Full width: a timeline from six weeks before the plan to the race,
          whose weekly means need the room more than a pair would. */}
      <PlanCard
        className={chartCard.card}
        title="Fitness and fatigue"
        note="Weekly means of fitness (CTL), fatigue (ATL) and form, their difference, measured and as the plan's TRIMP is expected to move them."
      >
        <PlanFitness
          expected={fitness.expected}
          measured={fitness.measured}
          start={fitness.start}
          raceMorning={fitness.raceMorning}
          bridgedFrom={fitness.bridgedFrom}
          planStartDay={span === null ? fitness.raceDay : calendarDayOfDate(span.from)}
          firstDay={fitness.firstDay}
          raceDay={fitness.raceDay}
          measuredNote={fitnessNote(loadQuery, span !== null)}
        />
      </PlanCard>
      <PlanGrid min={CHART_PAIR_MIN}>
        <PlanCard
          className={chartCard.card}
          title="VO2max outlook"
          note="Expected by Claude per week, against what was measured. VDOT is the race-time equivalent; Garmin's is the watch's own."
        >
          <PlanOutlook
            expected={outlook.expected}
            measured={outlook.measured}
            targetVdot={outlook.targetVdot}
            garmin={fitnessQuery.data?.device.map((d) => ({ date: d.calendar_date, vo2max: d.vo2max })) ?? []}
            startDate={span?.from ?? plan.goal.race_date}
            raceDate={plan.goal.race_date}
            deviceNote={deviceNote}
          />
        </PlanCard>
        <PlanCard
          className={chartCard.card}
          title="Weekly intensity mix"
          note="Planned distance per week: easy running, the work of the quality sessions, and the work of the trials and the race."
        >
          <PlanIntensity weeks={weeklyMix(plan)} />
        </PlanCard>
      </PlanGrid>
      <PlanGrid min={CHART_PAIR_MIN}>
        <PlanCard
          className={chartCard.card}
          title="Target paces"
          aside={
            <span className={chartCard.span}>
              {dayMonthLabel(days[0])} - {dayMonthLabel(calendarDayOfDate(plan.goal.race_date))}
            </span>
          }
          note="The pace range of each quality, trial and race session's work, faster up, against the goal pace."
        >
          <PlanPaces
            marks={paceMarks(plan)}
            span={days}
            goalPaceS={goalPaceS(plan.goal)}
            easy={easyBand(plan)}
            raceDate={plan.goal.race_date}
          />
        </PlanCard>
        <PlanCard
          className={chartCard.card}
          title="Trajectory"
          note={`Predicted ${raceDistanceLabel(plan.goal.distance_m)} time from best efforts as each version was written, toward the target.`}
        >
          <PlanTrajectory
            points={trajectory(detail, plan.goal.distance_m)}
            targetS={plan.goal.target_time_s}
            raceDate={plan.goal.race_date}
            checkpoints={checkpointSessions(plan)}
          />
        </PlanCard>
      </PlanGrid>
      {/* Each full width: their rows fall into columns of their own on a
          desktop, so neither card stands short beside the other. */}
      <PlanHistory goalId={goalId} versions={detail.versions} shownNumber={entry.number} today={today} />
      {others.length > 0 && <OtherGoals goals={others} today={today} />}
      {opened !== null && (
        <SessionDialog
          entry={opened}
          outcome={outcomes.get(opened.session.id) ?? null}
          runsByDay={runsByDay}
          today={today}
          {...hr}
          onClose={sessionUrl.close}
        />
      )}
    </div>
  )
}

/**
 * Opening and closing a session's detail through `?session=`, the rest of
 * the search kept. Opening pushes an entry, so the browser's back button
 * closes the detail; closing one opened here goes back to the entry it
 * was opened from rather than pushing another, so back does not then
 * reopen it. One opened from a shared link has no entry of the page's to
 * go back to, so closing it replaces the URL with one without the param.
 */
function useSessionUrl(): { open: (id: string) => void; close: () => void } {
  const navigate = useNavigate()
  const router = useRouter()
  const openedHere = useRef(false)
  return {
    open: (id) => {
      openedHere.current = true
      void navigate({ to: '.', search: (prev: PlanSearch) => ({ ...prev, session: id }) })
    },
    close: () => {
      if (openedHere.current) {
        openedHere.current = false
        router.history.back()
        return
      }
      void navigate({
        to: '.',
        search: ({ session: _closed, ...rest }: PlanSearch) => rest,
        replace: true,
      })
    },
  }
}

/** The lead-in chart's line while its runs are on their way. */
const LEAD_IN_LOADING = 'Loading the runs of the weeks before the plan.'

/**
 * The eight weeks before the plan's first week, from `/api/activities`
 * over that span: each run's `effort_tags` and `pr_distance_keys` ride on
 * the list, so the chart draws as soon as the one list arrives.
 *
 * Titled for the athlete's last eight weeks while the plan has not begun,
 * and as the weeks before the plan once it has, since they are no longer
 * the last eight.
 */
function LeadIn({ plan, today }: { plan: PlanVersion; today: Date }) {
  const span = leadInSpan(plan)
  const runsQuery = useQuery({
    ...queries.everyActivity({ sport: 'running', from: span?.from, to: span?.to }),
    enabled: span !== null,
  })
  if (span === null) return null

  const note = runsQuery.isError
    ? `The runs before the plan could not be loaded: ${describeApiError(runsQuery.error)}.`
    : runsQuery.isPending
      ? LEAD_IN_LOADING
      : null
  const started = calendarDayOfLocalDate(today) >= span.startDay + LEAD_IN_WEEKS * 7
  return (
    <PlanCard
      className={chartCard.card}
      title={started ? `The ${String(LEAD_IN_WEEKS)} weeks before the plan` : `Your last ${String(LEAD_IN_WEEKS)} weeks`}
      note="Run distance per week before the plan's first week, by the effort the app tagged each run with."
    >
      <PlanLeadIn weeks={leadInWeeks(runsQuery.data ?? NO_RUNS, span.startDay)} note={note} />
    </PlanCard>
  )
}

/**
 * The goal's siblings, archived or awaiting acceptance, one link each, in
 * the history's row: the race's distance in the badge, the goal in bold
 * over its race date, and its status at the end.
 */
function OtherGoals({ goals, today }: { goals: PlanSummary[]; today: Date }) {
  const todayDay = calendarDayOfLocalDate(today)
  return (
    <PlanCard title="Other goals">
      <ul className={ROW_LIST}>
        {goals.map((g) => (
          <li key={g.goal_id}>
            <Link to="/plan/$goalId" params={{ goalId: g.goal_id }} className={rowClass()}>
              <PlanRow
                mark={raceDistanceBadge(g.distance_m)}
                title={goalTitle(g.distance_m, g.target_time_s)}
                detail={dayMonthNear(calendarDayOfDate(g.race_date), todayDay)}
                status={g.status}
                statusLabel={planStatusLabel(g.status)}
              />
            </Link>
          </li>
        ))}
      </ul>
    </PlanCard>
  )
}

/** No goal at all: how a plan comes to exist. */
function NoPlan() {
  return (
    <div className={styles.plan}>
      <h1>Plan</h1>
      <Absent
        label="No training plan yet."
        reason="Plans are written by Claude Code from a checkout of this repository: run /training-plan there."
      />
    </div>
  )
}

/**
 * A goal id no plan has, from a stale link. Stated with the server's own
 * words and a way back, as the route view states a retired route.
 */
function UnknownGoal({ reason }: { reason: string }) {
  return (
    <div className={styles.plan}>
      <h1>No such plan</h1>
      <p className={styles.dim}>The server answered: {reason}.</p>
      <p>
        <Link to="/plan" className={styles.link}>
          Back to the plan
        </Link>
      </p>
    </div>
  )
}
