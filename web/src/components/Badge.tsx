import type { ReactNode } from 'react'
import styles from './Badge.module.css'

/**
 * The small pill that labels a fact about an activity: a personal record,
 * an effort tag, a treadmill caveat.
 *
 * **What the reference draws.** The "Se mer" pill in
 * `.claude/design-bar/strava/activity-detail-map-hero-and-sheet.jpg` is a
 * fully rounded, filled, bold chip at the label size, and the challenge
 * badge beside it sits on the panel rather than on a fill. There is no
 * uppercasing anywhere on those screens, so this does not uppercase either
 * - it was doing so in two places, which rendered the analysis layer's own
 * `400m` distance key as `400M` until a local `text-transform: none`
 * fought it back.
 *
 * **Two tones, and the split is about meaning rather than variety.**
 * `accent` is for a fact the reader is meant to notice (a record, the
 * classifier's effort tag); `quiet` is for a caveat about the data (a
 * treadmill run has no GPS and an uncalibrated distance). The old list
 * marked the record in `--series-5`, which is a *chart* colour from a
 * fixed-order, CVD-validated categorical palette - spending one of those
 * five on interface chrome is how that order stops meaning anything.
 */
export type BadgeTone = 'accent' | 'quiet'

export interface BadgeProps {
  children: ReactNode
  tone?: BadgeTone
  /**
   * The native tooltip. `Tag` has prose beside its badge and needs none;
   * the list's record badge carries the distances it was set at here as
   * well as in its text, because one real run set a 1k, a 1mi and a 3k at
   * once.
   */
  title?: string
}

export function Badge({ children, tone = 'quiet', title }: BadgeProps) {
  return (
    <span className={`${styles.badge} ${tone === 'accent' ? styles.accent : styles.quiet}`} title={title}>
      {children}
    </span>
  )
}
