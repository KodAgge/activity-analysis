import { Link } from '@tanstack/react-router'
import { calendarDayOfLocalDate, dayMonthNear, planStatusLabel } from '../../format'
import { PlanCard } from './PlanCard'
import { PlanRow } from './PlanRow'
import { ROW_LIST, rowClass } from './planRowClasses'
import type { PlanVersionEntry } from './planMath'

export interface PlanHistoryProps {
  goalId: string
  versions: PlanVersionEntry[]
  /** The version the page shows, marked current in the list. */
  shownNumber: number
  today: Date
}

/**
 * Every version of the goal, newest first, each a link to the page as of
 * that version. Rejected and withdrawn versions stay listed: the history is
 * of what Claude proposed, not only of what the athlete took.
 *
 * Each row names its first change, which is the goal change when there is
 * one - the change summary puts it first - and the plan's first version,
 * which revises nothing, says so. The version and its date lead the row in
 * bold, one short line as Runna leads a row with its time, the change is
 * the quiet line under it, and the status is the pill at its end; the
 * version on screen has its number filled in ink.
 */
export function PlanHistory({ goalId, versions, shownNumber, today }: PlanHistoryProps) {
  const todayDay = calendarDayOfLocalDate(today)
  const newestFirst = [...versions].sort((a, b) => b.number - a.number)
  return (
    <PlanCard title="History">
      <ol className={ROW_LIST}>
        {newestFirst.map((entry) => {
          const { changes, provenance } = entry.plan
          const first = changes.find((c) => c.goal_change) ?? changes[0]
          const summary = first?.title ?? (provenance.revises === null ? 'The first plan' : 'No changes listed')
          const current = entry.number === shownNumber
          const created = dayMonthNear(calendarDayOfLocalDate(new Date(provenance.created_at)), todayDay)
          return (
            <li key={entry.number}>
              <Link
                to="/plan/$goalId"
                params={{ goalId }}
                search={{ version: entry.number }}
                className={rowClass(current)}
                aria-current={current ? 'page' : undefined}
              >
                <PlanRow
                  mark={String(entry.number)}
                  title={`Version ${String(entry.number)} · ${created}`}
                  detail={summary}
                  status={entry.status}
                  statusLabel={planStatusLabel(entry.status)}
                  current={current}
                />
              </Link>
            </li>
          )
        })}
      </ol>
    </PlanCard>
  )
}
