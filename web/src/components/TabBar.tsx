import { Link, useLocation } from '@tanstack/react-router'
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { DEFAULT_DISTANCE_KEY } from '../api/progressionSearch'
import { DEFAULT_VARIABLE } from '../charts/distributionVariables'
import styles from './TabBar.module.css'

/**
 * The application's one navigation control: a bottom tab bar on a phone, a
 * left rail on a desktop.
 *
 * Seven destinations in the router's own order, which is also the order
 * they are read in - what training has looked like lately, then the runs
 * behind it, then the bests those runs produced, then whether any of it is
 * improving, then how the runs spread over one variable at a time, then
 * the ground the loops among them have claimed.
 *
 * **A phone shows four and a More tab.** Six labels already needed the
 * bar's side padding cut to 8px and the label set at 10px to fit a 360px
 * phone, with the two longest columns widened past their share (see
 * `TabBar.module.css`); a seventh has no room left at any size a label can
 * still be read at. The platforms' own answer past five destinations is
 * an overflow - iOS's More tab - so the last three, the analysis views and
 * Territory, sit behind one, in the same order. The rail on a desktop has
 * room for all seven and shows them all, with no More.
 *
 * The three are one set of links either way, not a copy per layout: on a
 * phone their container is a sheet over the bar, shown while More is open
 * and `display: none` otherwise, and on a desktop it is `display:
 * contents`, so its links are the rail's own rows. The DOM order, and so
 * the reading order, is the same at both widths.
 *
 * Icons are hand-written 24px SVG rather than a package: `docs/reference/
 * frontend.md` and CLAUDE.md both make any dependency addition the user's
 * decision, and eight glyphs do not justify asking.
 */

/**
 * Every icon is drawn on the same 24-unit grid at the same stroke width, so
 * they read as one set rather than six borrowed marks. Stroke, never fill:
 * the active tab is marked by colour, and a filled glyph would change
 * weight as well as hue and read as two changes at once.
 */
function iconProps() {
  return {
    viewBox: '0 0 24 24',
    width: 24,
    height: 24,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  }
}

function OverviewIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M3.4 10.3 12 3.5l8.6 6.8v8.4a1.8 1.8 0 0 1-1.8 1.8h-3.5v-6.2H8.7v6.2H5.2a1.8 1.8 0 0 1-1.8-1.8Z" />
    </svg>
  )
}

function ActivitiesIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M9 5.8h11M9 12h11M9 18.2h11" />
      <path d="M4.3 5.8h.01M4.3 12h.01M4.3 18.2h.01" strokeWidth={2.6} />
    </svg>
  )
}

/** A stopwatch: Records is the table of fastest times over fixed distances. */
function RecordsIcon() {
  return (
    <svg {...iconProps()}>
      <circle cx="12" cy="13.8" r="7.4" />
      <path d="M9.6 2.8h4.8M12 2.8v3.6M12 13.8V9.9M18.7 7.1l1.3-1.3" />
    </svg>
  )
}

/** A line over axes: Trends is a continuous series against time. */
function TrendsIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M4 3.6v15.1a1.3 1.3 0 0 0 1.3 1.3H20.4" />
      <path d="m7.4 15.6 3.5-4.6 2.9 2.4 5.2-6.6" />
    </svg>
  )
}

/** Bars over the same axes: Progression is one value per race distance. */
function ProgressionIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M4 3.6v15.1a1.3 1.3 0 0 0 1.3 1.3H20.4" />
      <path d="M8.6 16.8v-3.4M13 16.8v-7M17.4 16.8v-10.4" strokeWidth={2.4} />
    </svg>
  )
}

/**
 * A histogram: bars of different heights on a shared baseline, no axes -
 * Distributions buckets one variable across every run rather than plotting
 * one value per distance or per date, which is what sets it apart from the
 * two bar-and-axis glyphs above.
 */
function DistributionsIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M4 19.2h16" />
      <path d="M6.2 19.2v-4.4M10.6 19.2v-9.4M15 19.2v-6.6M19.4 19.2v-2.6" strokeWidth={2.4} />
    </svg>
  )
}

/**
 * A closed loop with its ground marked: Territory is the area the loops
 * enclose, so the glyph is an irregular ring, not a pin or a flag, with a
 * dot for the ground inside it.
 */
function TerritoryIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M4.4 9.6 9.8 4.3l7.6 1.9 2.4 7.7-4.2 6-8.5-1.1Z" />
      <path d="M12 12.4h.01" strokeWidth={2.6} />
    </svg>
  )
}

/** Three dots: more destinations than the phone bar has room for. */
function MoreIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M5.2 12h.01M12 12h.01M18.8 12h.01" strokeWidth={2.8} />
    </svg>
  )
}

/** The paths the More tab holds on a phone, so it can be marked current on any of them. */
const OVERFLOW_PATHS = ['/progression', '/distributions', '/territory']

interface TabProps {
  icon: ReactNode
  label: string
}

function TabContent({ icon, label }: TabProps) {
  return (
    <>
      <span className={styles.icon}>{icon}</span>
      <span className={styles.label}>{label}</span>
    </>
  )
}

export function TabBar() {
  const pathname = useLocation({ select: (location) => location.pathname })
  // A route is reached from Records' Routes section, so its view belongs to
  // that tab even though `/routes/...` is not under `/records`.
  const onRouteView = pathname.startsWith('/routes/')
  const onOverflowView = OVERFLOW_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))
  // The path the sheet was opened on, or null: arriving anywhere else
  // closes it, whichever link took the reader there, with no effect to
  // reset it.
  const [openedOn, setOpenedOn] = useState<string | null>(null)
  const moreOpen = openedOn === pathname
  const setMoreOpen = (open: boolean) => setOpenedOn(open ? pathname : null)
  const sheetId = useId()
  const navRef = useRef<HTMLElement | null>(null)
  const moreRef = useRef<HTMLButtonElement | null>(null)

  // Open, the sheet closes on Escape, giving focus back to More, and on a
  // press anywhere outside the bar.
  useEffect(() => {
    if (!moreOpen) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpenedOn(null)
      moreRef.current?.focus()
    }
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && navRef.current?.contains(event.target)) return
      setOpenedOn(null)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [moreOpen])

  const moreClasses = [styles.tab, styles.more]
  if (onOverflowView) moreClasses.push(styles.tabActive)

  return (
    <nav ref={navRef} className={styles.bar} aria-label="Views">
      <span className={styles.brand} aria-hidden="true">
        activity-analysis
      </span>
      <Link to="/" className={styles.tab} activeProps={{ className: styles.tabActive }}>
        <TabContent icon={<OverviewIcon />} label="Overview" />
      </Link>
      <Link
        to="/activities"
        className={styles.tab}
        activeProps={{ className: styles.tabActive }}
      >
        <TabContent icon={<ActivitiesIcon />} label="Activities" />
      </Link>
      <Link
        to="/records"
        className={styles.tab}
        activeProps={{ className: styles.tabActive }}
        inactiveProps={onRouteView ? { className: styles.tabActive, 'aria-current': 'page' } : undefined}
      >
        <TabContent icon={<RecordsIcon />} label="Records" />
      </Link>
      <Link to="/trends" className={styles.tab} activeProps={{ className: styles.tabActive }}>
        <TabContent icon={<TrendsIcon />} label="Trends" />
      </Link>
      {/* A click on a link closes the sheet even when it names the view
          already shown, where the path does not change. */}
      <div
        id={sheetId}
        className={moreOpen ? `${styles.overflow} ${styles.overflowOpen}` : styles.overflow}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest('a') !== null) setMoreOpen(false)
        }}
      >
        <Link
          to="/progression"
          search={{ distance: DEFAULT_DISTANCE_KEY }}
          // The path alone names the view: the search is the reader's
          // distance choice, and the tab must stay marked current at 10 km as
          // well as at the default it happens to point at.
          activeOptions={{ includeSearch: false }}
          className={styles.tab}
          activeProps={{ className: styles.tabActive }}
        >
          <TabContent icon={<ProgressionIcon />} label="Progression" />
        </Link>
        <Link
          to="/distributions"
          search={{ variable: DEFAULT_VARIABLE }}
          // As with Progression above: the path names the view, and every
          // other search key (period, compare, the filters, the selected
          // bucket) is the reader's own choice, not part of what makes this
          // tab current.
          activeOptions={{ includeSearch: false }}
          className={styles.tab}
          activeProps={{ className: styles.tabActive }}
        >
          <TabContent icon={<DistributionsIcon />} label="Distributions" />
        </Link>
        <Link
          to="/territory"
          // The region is the reader's choice, as the distance is above.
          activeOptions={{ includeSearch: false }}
          className={styles.tab}
          activeProps={{ className: styles.tabActive }}
        >
          <TabContent icon={<TerritoryIcon />} label="Territory" />
        </Link>
      </div>
      <button
        ref={moreRef}
        type="button"
        className={moreClasses.join(' ')}
        aria-expanded={moreOpen}
        aria-controls={sheetId}
        onClick={() => setMoreOpen(!moreOpen)}
      >
        <TabContent icon={<MoreIcon />} label="More" />
      </button>
    </nav>
  )
}
