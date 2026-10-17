import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { describeApiError } from '../api/errors'
import { queries } from '../api/queries'
import { NO_VALUE } from '../format'
import { TabBar } from './TabBar'
import styles from './AppShell.module.css'

interface AppShellProps {
  children: ReactNode
}

/**
 * A warning triangle, on the same 24-unit grid as `TabBar`'s icon set.
 *
 * 16px, not the bar's 24: the notice is a system strip set in caption type,
 * and a 24px glyph beside 11px text turns the strip into the loudest thing
 * on a screen whose own title is 26px.
 */
function AlertIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable={false}
    >
      <path d="M12 4.2 21 19.4a1 1 0 0 1-.9 1.5H3.9a1 1 0 0 1-.9-1.5Z" />
      <path d="M12 10v4.4M12 17.6h.01" />
    </svg>
  )
}

/**
 * The frame every route renders inside: the tab bar, the content column and
 * the two things the store itself has to be able to say.
 *
 * The screen's own title is the first thing in the scroll and belongs to the
 * view, not to this component - there is no chrome above it. That leaves the
 * store diagnostics without their old home at the top of the page, and they
 * get two different ones, because they are two different kinds of statement.
 *
 * The activity count is ambient: it answers "is this the store I think it
 * is", which is a question asked once on arrival and never again. It sits at
 * the end of the scroll, in caption type, the way a footer does.
 *
 * The staleness warning is not ambient. The server holds the store as it was
 * at the moment it started (see docs/reference/api.md, "Connection model"),
 * so a `recompute` run while the server keeps going is invisible to it. The
 * symptom is a number that stops moving, which reads exactly like a bug in
 * whatever metric was just changed rather than what it is: a stale process.
 * Naming the fix turns that into a five-second read instead of a debugging
 * session.
 *
 * It opens the scroll rather than floating over it. An earlier version was a
 * card pinned above the tab bar, so that it would be on screen wherever the
 * suspect number was; what it did instead was cover the Overview's bar chart
 * from the zero line down, which took the baseline away from the one plot on
 * the screen. A warning that destroys the thing it is warning about is not a
 * trade worth making, so it is in the flow, one line tall, with the fix one
 * disclosure away. The shell cannot place it between a view's own `<h1>` and
 * the view's body without reaching into `views/`, so it takes the position
 * immediately above the title: a system strip, at one line, over the screen
 * it applies to.
 */
export function AppShell({ children }: AppShellProps) {
  const health = useQuery(queries.health())

  return (
    <div className={styles.shell}>
      <main className={styles.main}>
        {health.isError && (
          <div className={styles.notice} role="alert">
            <span className={styles.noticeIcon}>
              <AlertIcon />
            </span>
            <p className={styles.noticeBody}>
              Could not reach the store: {describeApiError(health.error)}
            </p>
          </div>
        )}
        {health.data?.stale && (
          <div className={styles.notice} role="alert">
            <span className={styles.noticeIcon}>
              <AlertIcon />
            </span>
            {/*
             * Every word of the message survives, split across the summary
             * and the disclosure rather than shortened: the first sentence
             * says there is a problem, the rest names the exact two-command
             * fix. A `recompute` alone leaves the running server serving
             * what it was already serving, so the second command is not a
             * detail that can be dropped - only one that can be folded.
             *
             * Folded for the eye only. A closed `<details>` keeps its body
             * out of the accessibility tree, so the alert would announce the
             * problem without the fix; the visually hidden line after it
             * puts both commands in what the live region says.
             */}
            <details className={styles.noticeBody}>
              <summary className={styles.summary}>
                The store is stale
                <span className={styles.more}>Details</span>
              </summary>
              <p className={styles.noticeText}>
                The server is still serving what it read at startup, so a number that
                looks wrong may just be out of date. Run{' '}
                <code className="mono">activity-analysis recompute</code>, then restart{' '}
                <code className="mono">activity-analysis serve</code> to pick it up.
              </p>
            </details>
            <p className={styles.srOnly}>
              Run activity-analysis recompute, then restart activity-analysis serve.
            </p>
          </div>
        )}
        <div className={styles.content}>{children}</div>
        {health.data && (
          <footer className={styles.store}>
            {/*
             * `counts` is a plain `dict[str, int]` from the backend, so
             * `noUncheckedIndexedAccess` types this key as possibly
             * `undefined` even though the server always populates it. A
             * missing number is never a zero (see CLAUDE.md and
             * `format/index.ts`'s own `NO_VALUE`) - an earlier version fell
             * back to `?? 0`, which would have shown a genuinely empty
             * store the same way as a type artefact of a key that is, in
             * practice, always there.
             */}
            <span className="mono" role="status">
              {health.data.counts.activities ?? NO_VALUE} activities
            </span>{' '}
            in this store
          </footer>
        )}
      </main>
      <TabBar />
    </div>
  )
}
