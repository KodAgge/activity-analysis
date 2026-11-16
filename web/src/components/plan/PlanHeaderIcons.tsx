import type { ReactNode } from 'react'

/**
 * The header's line icons: one beside each of the goal's facts, as Runna
 * sets an icon before each fact of a plan, and one in each round action
 * button. Drawn on a 24-unit grid in the stroke style of the shell's own
 * navigation icons (`AppShell.tsx`): `currentColor`, 1.75 wide, round
 * ends. Decorative only, so hidden from a screen reader: the text beside
 * each says what it is.
 */
function Icon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export type HeaderIconName = 'flag' | 'surface' | 'pace' | 'page' | 'pages' | 'week' | 'copy'

const PATHS: Readonly<Record<HeaderIconName, ReactNode>> = {
  // The race's day: a finish flag.
  flag: (
    <>
      <path d="M5 21V4" />
      <path d="M5 4h12.5l-2.5 4 2.5 4H5" />
    </>
  ),
  // The surface: a running track's oval with its inner lane.
  surface: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="6" />
      <rect x="6.5" y="9.5" width="11" height="5" rx="2.5" />
    </>
  ),
  // The target pace: a stopwatch.
  pace: (
    <>
      <circle cx="12" cy="13.5" r="7" />
      <path d="M12 13.5V10M10 3h4M12 3v3.5M18.5 7l1.5-1.5" />
    </>
  ),
  // The page as shown: one sheet.
  page: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  // Every session: a stack of sheets.
  pages: (
    <>
      <path d="M15 6H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9Z" />
      <path d="M9 2.5h7l5 5V17" />
      <path d="M10 14h4M10 18h4" />
    </>
  ),
  // The next week: a calendar page.
  week: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4M7.5 14h2M11 14h2M14.5 14h2M7.5 17.25h2" />
    </>
  ),
  // The week as text: two overlapping sheets.
  copy: (
    <>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
      <path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" />
    </>
  ),
}

export function HeaderIcon({ name, className }: { name: HeaderIconName; className?: string }) {
  return <Icon className={className}>{PATHS[name]}</Icon>
}
