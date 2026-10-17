import type { ReactNode } from 'react'
import styles from './Section.module.css'

/**
 * A titled block of a screen, and the rule that separates one from the
 * next.
 *
 * **What the reference does, measured.** On
 * `.claude/design-bar/strava/you-tab-weekly-stats-streak-calendar.png` a
 * section is a 17.5 pt title at weight 700 with its content directly under
 * it, and two sections are separated by one rule that runs the full width
 * of the screen - measured at x 5 and x 635 of a 640 px shot, so past both
 * gutters - with about 15 pt of air above it and 29 pt below. There is no
 * container, no panel and no card anywhere on that screen.
 *
 * A `note` is the second thing the reference puts under a title: "Past 12
 * weeks" over the chart is 11.4 pt dim text, the same size as a stat's
 * label rather than a heading of its own. Use it to say what a chart
 * covers; a heading would claim a level of the document outline that a
 * caption does not deserve.
 *
 * **How a later screen uses this.** Wrap each block of the view in one,
 * and set `divided` on every section after the first. The rule belongs to
 * the section below it, not the one above, so a section can be added or
 * removed without its neighbour needing to know.
 */
export interface SectionProps {
  /** The section's own name. Rendered as the `<h2>` the view needs anyway. */
  title: string
  /** A quiet line under the title, label-sized. What the block covers. */
  note?: string
  /**
   * Draw the full-bleed rule that separates this section from the one
   * above it. Set on every section but the first.
   */
  divided?: boolean
  /**
   * A key to what the block draws, right-aligned on the title's line, as
   * the activity view's Pace heading carries its average pace. It
   * wraps under the title when the line is too narrow for both.
   */
  aside?: ReactNode
  /**
   * An anchor another page links to, as the activity page's decoupling
   * section links to `/trends#decoupling`. Omitted on every section nothing
   * links into.
   */
  id?: string
  children: ReactNode
}

export function Section({ title, note, divided = false, aside, id, children }: SectionProps) {
  const heading = <h2 className={styles.title}>{title}</h2>
  return (
    <section id={id} className={divided ? `${styles.section} ${styles.divided}` : styles.section}>
      {aside === undefined ? (
        heading
      ) : (
        <div className={styles.head}>
          {heading}
          {aside}
        </div>
      )}
      {note !== undefined && <p className={styles.note}>{note}</p>}
      {children}
    </section>
  )
}
