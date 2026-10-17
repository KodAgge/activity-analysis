import { Link, useRouter } from '@tanstack/react-router'
import styles from './BackControl.module.css'

/** What a history-back is called: it goes wherever the reader came from, so it names no place. */
export const HISTORY_BACK_LABEL = 'Back'

/**
 * The chevron the way back is drawn as.
 *
 * Same 24-unit grid, same 1.75 stroke and same "stroke, never fill" rule as
 * `components/TabBar.tsx`'s icons, so the application has one icon
 * vocabulary rather than one per component.
 */
function BackChevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
      focusable={false}
    >
      <path d="M14.5 4.8 7.3 12l7.2 7.2" />
    </svg>
  )
}

export interface BackControlProps {
  /** Over a `RouteHero`, on its inset, or at the top of the page when the screen has no hero. */
  floating: boolean
  /** Where the control goes when there is no history to go back through. */
  fallbackTo: '/activities' | '/records'
  /** The fallback link's accessible name, which names the place it goes. */
  fallbackLabel: string
}

/**
 * The way back from a deep view: a round control that floats over the
 * route hero, or the same control at the top of the page on a screen that
 * has no hero to float over. Shared by the activity view and the route view.
 *
 * A plain history-back rather than a link: a link to the list resets every
 * filter to the default set, and this is the one affordance in the page
 * that can restore a filtered list instead. A history-back goes wherever the reader came from, which is not
 * always the list - an activity is also opened from a route's chart, from
 * Records and from Progression - so it is called `Back` and names no place.
 *
 * That only holds when there is somewhere to go back to. A deep view is a
 * plain shareable URL, so a fresh tab, a bookmark, a pasted link or a
 * reload makes it the first entry in the session history, and `back()`
 * there either does nothing or leaves the application entirely - the only
 * visible way out, dead exactly where the reader has least context.
 * `canGoBack()` picks the fallback link instead in that case, which names
 * where it goes because it always goes there.
 *
 * Icon-only, so it can sit on the hero without covering the trace, but
 * never nameless: the accessible name is also the `title`, so a pointer
 * gets it as a tooltip.
 */
export function BackControl({ floating, fallbackTo, fallbackLabel }: BackControlProps) {
  const router = useRouter()
  const className = floating ? `${styles.back} ${styles.floating}` : styles.back

  if (router.history.canGoBack()) {
    return (
      <button
        type="button"
        className={className}
        aria-label={HISTORY_BACK_LABEL}
        title={HISTORY_BACK_LABEL}
        onClick={() => router.history.back()}
      >
        <BackChevron />
      </button>
    )
  }
  return (
    <Link to={fallbackTo} className={className} aria-label={fallbackLabel} title={fallbackLabel}>
      <BackChevron />
    </Link>
  )
}
