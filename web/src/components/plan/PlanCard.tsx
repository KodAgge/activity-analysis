import type { CSSProperties, ReactNode } from 'react'
import styles from './PlanCard.module.css'

export interface PlanCardProps {
  /** The card's own name, rendered as the `<h2>` the page's outline needs. */
  title: string
  /** A quiet line under the title: what the block covers. */
  note?: string
  /**
   * Something on the title's line at its far end, such as a key or a
   * badge; it wraps under the title when the line is too narrow for both.
   */
  aside?: ReactNode
  /** A block's own layout for its card, added to the card's class, never replacing it. */
  className?: string
  children: ReactNode
}

/**
 * A titled block of the plan page on its card: the white raised surface
 * every block of the page sits on, with an `<h2>`, an optional note and an
 * optional aside on the title's line. The plan page's `Section`: other
 * views keep `Section`, which owns no surface.
 *
 * `PlanCard.module.css` records the Runna measurements behind the padding,
 * radius, shadow and type.
 */
export function PlanCard({ title, note, aside, className, children }: PlanCardProps) {
  const heading = <h2 className={styles.title}>{title}</h2>
  return (
    <section className={className === undefined ? styles.card : `${styles.card} ${className}`}>
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

export interface PlanSurfaceProps {
  className?: string
  children: ReactNode
}

/**
 * The card's surface without its title, a `<div>`, for a block whose
 * heading is not an `<h2>` (the header, around the page's `<h1>`) or that
 * has none.
 */
export function PlanSurface({ className, children }: PlanSurfaceProps) {
  return <div className={className === undefined ? styles.card : `${styles.card} ${className}`}>{children}</div>
}

export interface PlanGridProps {
  /**
   * The narrowest a column may be, as a CSS length; 20rem by default,
   * which fits three cards across a desktop's content column and one on a
   * phone.
   */
  min?: string
  className?: string
  children: ReactNode
}

/**
 * Cards side by side: as many columns as fit at `min` wide, sharing the
 * rest, with the page's own gap between them. Every card is full width
 * unless a block puts it in one of these; on paper they stack.
 */
export function PlanGrid({ min, className, children }: PlanGridProps) {
  const style = min === undefined ? undefined : ({ '--plan-row-min': min } as CSSProperties)
  return (
    <div className={className === undefined ? styles.grid : `${styles.grid} ${className}`} style={style}>
      {children}
    </div>
  )
}
