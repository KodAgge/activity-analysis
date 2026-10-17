import { Link, type LinkProps } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import styles from './RowList.module.css'

/**
 * The grouped list row: a plain label on the left, one bold value hard
 * right, and a chevron where the row leads somewhere.
 *
 * **What the reference does, measured.** On
 * `.claude/design-bar/strava/stats-totals-and-best-efforts.jpg` (1080 px
 * wide at 3x, so 360 dp, fixed by its 72 px content gutter) the best-effort
 * ladder is eleven rows on a 192 px pitch - a round 64 dp - with the
 * content vertically centred in each slot. Every label's ink starts at
 * x 72, the page gutter exactly. Every value's ink *ends* at x 921,
 * right-aligned as a column, with the chevron's arrow occupying x 974..993
 * and the right page gutter at x 1008. A row in a group with no chevron
 * puts its value's right edge on that gutter instead, so the chevron is a
 * reserved column rather than something hung outside the text.
 *
 * A luminance scan down the whole list finds **no rule between rows** -
 * rows are separated by whitespace alone. What separates one *group* from
 * the next is a tonal band: the rows sit on the page at rgb(18,18,18) and
 * the band behind the uppercase group heading is pure black, 96 px tall,
 * a round 32 dp, with its text on the same 24 dp gutter.
 *
 * Type, by cap height (the method and the 0.7031 cap ratio are piece 1's):
 * a label's digits measure 35 px of cap and a value's 40 px, which is
 * `--text-body` against `--text-stat` - **the value is a size larger than
 * its label, as well as bolder**. Both are set in full ink; the size and
 * the weight carry the hierarchy on their own. Digit advance measures 29.3
 * px against 32.7 px, a ratio of 1.12, which agrees. The group band's caps
 * measure 25 px, `--text-caption`, at effectively no tracking - 7.4 dp per
 * character against a 7.7 dp natural uppercase advance.
 *
 * **Where this deviates, and why.** The reference's rows carry one value
 * and nothing else, so they need one line. Ours carry the qualifiers a
 * record has to state - which run set it, how many efforts it beat - so a
 * row here is two lines: the reference's label-and-value line, and a quiet
 * second line holding `meta` under the label and `detail` under the value.
 * The second line is `--text-caption`, four px under the first, so the two
 * lines group as one object against the 24 px that separates one row from
 * the next.
 *
 * Above 60rem the same row flattens to a single line - label, meta, value,
 * detail, chevron - because the qualifiers that had to stack at 412 px fit
 * beside the value at 1088 px, and a phone row stretched across a desktop
 * is the layout this redesign exists to remove.
 */

export interface RowListProps {
  /**
   * The group's name, set in the uppercase band. Rendered as the `<h2>` a
   * titled block needs anyway - it is a heading, and the band is how the
   * reference draws one over a list.
   */
  title: string
  /** `Row` elements, in the order they are to be read. */
  children: ReactNode
}

/**
 * A titled group of rows: the full-bleed uppercase band, then an ordered
 * list of `Row`s.
 *
 * `<ol>` rather than `<ul>` because the order of the rows is part of the
 * data in every list this is for - a record ladder runs shortest distance
 * first and must never be re-sorted by the view.
 *
 * The band bleeds past the page gutter (`--bleed`) while its own text sits
 * on it, which is what makes it read as a band across the screen rather
 * than as the lid of a card. Light mode cannot take the reference's tonal
 * step literally - its band is *darker* than its page and ours is a light
 * palette - so the band is `--grid`, the one surface token that steps away
 * from `--page` in the same direction the reference's does.
 */
export function RowList({ title, children }: RowListProps) {
  return (
    <section className={styles.group}>
      <h2 className={styles.band}>{title}</h2>
      <ol className={styles.list}>{children}</ol>
    </section>
  )
}

export interface RowProps {
  /** The row's name, on the left. Plain, in full ink: the value carries the emphasis. */
  label: ReactNode
  /**
   * The row's number, hard right and the loudest thing in the row.
   * Already formatted by `src/format` - this component converts nothing.
   */
  value: ReactNode
  /**
   * The quiet line under the label: the qualifiers that say which thing
   * the value came from. Rendered as one run separated by middots, which
   * are `aria-hidden` so a reader hears the qualifiers and not the
   * punctuation between them.
   *
   * **A slot may be empty.** `meta` is positional - slot two is the date on
   * every row of a list, so that the desktop layout can turn the run into
   * aligned columns - and a row that has nothing to say in one slot passes
   * `null` there rather than dropping the entry and shifting every later
   * fragment left. An empty slot draws no fragment and no separator on
   * either side of itself, so the phone run reads as if it were never
   * there, while the desktop grid keeps the empty cell and the columns stay
   * aligned down the page.
   *
   * This is what a caller needs in order to state a fact only on the rows
   * where it is a fact - the exact metres are worth reading beside
   * "1 mile" and are the label again beside "5 km" - without either
   * repeating itself or breaking the alignment.
   */
  meta?: ReactNode[]
  /** The quiet line under the value, right-aligned. What the value means in other units. */
  detail?: ReactNode
  /**
   * Where the row leads. Given one, the whole row becomes a single link
   * and gains the chevron - which is exactly what the chevron means in the
   * reference: this row goes somewhere.
   *
   * The whole row rather than one word inside it, because a row with a
   * chevron on it is a target a thumb aims at, and a 64 dp slot whose only
   * hit area is a date string is a row that looks tappable and is not.
   */
  link?: LinkProps
}

const SEPARATOR = '·'

/**
 * Whether a `meta` slot has nothing in it - see `RowProps.meta`.
 *
 * The four values React itself renders as nothing. A slot holding one of
 * them gets its grid cell and no separator; anything else, `NO_VALUE`
 * included, is a fragment with something to say. A stated absence is not an
 * empty slot: "– bpm" says the heart rate is missing, which is a fact about
 * the effort, and it keeps its middots.
 */
function isEmptySlot(item: ReactNode): boolean {
  return item === null || item === undefined || item === false || item === ''
}

export function Row({ label, value, meta, detail, link }: RowProps) {
  const content = (
    <>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{value}</span>
      {meta !== undefined && (
        <span className={styles.meta}>
          {meta.map((item, index) => {
            // A separator belongs between two fragments, so it is drawn on
            // the second of the two: this slot has something in it and some
            // earlier slot did too. That is what makes an empty slot
            // invisible in the run rather than a dangling middot.
            const separated =
              !isEmptySlot(item) && meta.slice(0, index).some((earlier) => !isEmptySlot(earlier))
            return (
              // The index is the identity here on purpose: `meta` is a
              // positional run of already-formatted fragments, not a
              // collection of entities, and two rows can legitimately hold
              // the same fragment in the same slot.
              <span
                key={index}
                className={
                  isEmptySlot(item) ? `${styles.metaItem} ${styles.metaItemEmpty}` : styles.metaItem
                }
              >
                {separated && (
                  <span aria-hidden="true" className={styles.separator}>
                    {SEPARATOR}
                  </span>
                )}
                {item}
              </span>
            )
          })}
        </span>
      )}
      {detail !== undefined && <span className={styles.detail}>{detail}</span>}
      {link !== undefined && <Chevron />}
    </>
  )

  return (
    <li className={styles.row}>
      {link === undefined ? (
        <span className={styles.inner}>{content}</span>
      ) : (
        <Link {...link} className={styles.inner}>
          {content}
        </Link>
      )}
    </li>
  )
}

/**
 * The "leads somewhere" mark, hand-drawn because this project takes no icon
 * dependency.
 *
 * Sized and coloured from the reference's own - see `.chevron` in the
 * stylesheet for both measurements. `aria-hidden`, because the row is
 * already a link and a second name for the same destination is noise.
 *
 * The stroke is 1.25 of a 16-unit viewBox drawn at 16 px, so 1.25 CSS px,
 * and the 11-unit path makes the ink 12.25 CSS px tall. Both numbers are
 * ratios against the time beside them rather than absolute sizes - the
 * stylesheet has the measurement.
 */
function Chevron() {
  return (
    <svg
      className={styles.chevron}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5.5 2.5 11 8l-5.5 5.5" />
    </svg>
  )
}
