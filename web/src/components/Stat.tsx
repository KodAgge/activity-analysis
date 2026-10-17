import { Children, createContext, isValidElement, useContext } from 'react'
import type { ReactNode } from 'react'
import type { Measure } from '../format'
import styles from './Stat.module.css'

/**
 * The label-over-value stat, and the grid it sits in.
 *
 * This is the application's smallest unit of "a number, named". Five
 * screens show one or more of them and every one of them should look the
 * same, so it lives here rather than in the view that happened to need it
 * first.
 *
 * **How the reference draws it, measured rather than assumed.** On
 * `.claude/design-bar/strava/you-tab-weekly-stats-streak-calendar.png`
 * (393 pt wide, 1.628 px/pt) a stat is a 11.4 pt label in dim grey over a
 * 17.5 pt value at weight 700, with 17 px - 10.4 pt - between the label's
 * baseline and the value's cap, and nothing else: no fill, no border, no
 * radius, no rule. The separation between one stat and the next is
 * whitespace. The same shape appears on
 * `activity-detail-stat-grid-and-actions.png` and on
 * `activity-detail-header-stats-and-map.jpg`, at the same two type sizes.
 *
 * **There is no card.** The version this replaced drew every stat on a
 * `--panel` fill inside a `--border` hairline, which at nine levels of
 * separation from the page was a box spending contrast on nothing while
 * making the five stats look like five buttons. Do not put one back.
 *
 * **The unit is the value's equal.** Measured on three stat values in the
 * reference screenshots, two in km and one in mi: the x-height of the unit against the cap height of the
 * digits beside it is 0.725 in all three, which is this face's own ratio,
 * so the unit is set at the value's size and weight after one ordinary
 * word space. It is a separate element anyway, because the number gets
 * `font-variant-numeric` and the unit must not, and because
 * `--stat-unit-size` and `--stat-unit-weight` are then one place to change
 * if a later screen genuinely needs a subordinate unit.
 */

export interface StatProps {
  /** The name of the quantity. Sentence case; the CSS does not shout it. */
  label: string
  /**
   * The value, already formatted by `src/format` - this component never
   * converts anything and never composes a unit onto a number.
   *
   * A `Measure` keeps the unit apart so the two can be set as two
   * elements; a bare string is for a value that has no unit to separate
   * ("48 of 52", a duration, a date).
   */
  value: Measure | string
  /**
   * A quiet second line under the value, for the qualifier a value cannot
   * carry itself: which window a count is out of, when a streak ended.
   *
   * Its height is reserved on every stat in a group where *any* stat has
   * one, so every `Stat` in that group is the same object and two cells in
   * a row cannot come out different heights - which is what a stat with a
   * caption beside one without used to do. A group where nothing carries a
   * caption reserves nothing: there is no ragged row to prevent, and
   * reserving anyway cost the activity detail screen 21px per row and
   * another 21 above the rule under it. `StatGroup` works out which case it
   * is (see below), so no caller has to say.
   *
   * Keep it to a single line at the width the group is drawn at: a caption
   * that wraps hangs below its row and reintroduces the fault the
   * reservation exists to remove.
   */
  detail?: ReactNode
  /**
   * How much of the group's width this stat takes: a third (the default),
   * two thirds, a half, or all of it.
   *
   * `StatGroup` is a six-track grid precisely so a row can be thirds,
   * halves or a two-thirds-and-a-third pair and still start and end on the
   * page gutter. **Give each row a share that fills it.** A fixed
   * three-wide grid would leave a trailing cell empty on a group of five,
   * which both round-1 critics read as an empty quadrant rather than as a
   * line of text ending early.
   *
   * **Prefer shares built out of thirds, and reach for `half` only in a
   * group whose every row is halves.** Thirds and halves do not share
   * their interior column edges, so a row of halves under a row of thirds
   * puts the same component on a column its neighbour above does not use:
   * measured on the round-2 capture, "Consistency" started 65 px from
   * "Last 4 weeks" and the block read as two grids stacked rather than one
   * (round-3 critic). Two thirds plus a third fills a row the same way a
   * pair of halves does, and every cell in the group still starts on one
   * of the three column edges.
   *
   * `two-thirds` is also what a stat carrying a long caption needs: a
   * third of 412 px is about 111 px, which is narrower than "through 10
   * November 2025" and wraps it mid-date.
   */
  share?: 'third' | 'two-thirds' | 'half' | 'full'
}

/**
 * One stat. Must be rendered inside a `StatGroup`.
 *
 * **Two `<dd>` elements for one `<dt>`, never a `<dd>` plus a `<p>`.**
 * Inside a `<dl>` a wrapping `<div>` may only contain `<dt>` and `<dd>`
 * children, so a `<p>` sibling here is invalid markup a parser is free to
 * reparent or drop. The `<dl>` model already has a shape for "more than
 * one description of this term", which is exactly what `value` and
 * `detail` are.
 */
const SHARE_CLASS = {
  third: 'third',
  'two-thirds': 'twoThirds',
  half: 'half',
  full: 'full',
} as const

/**
 * Whether the surrounding group contains a caption anywhere, and so
 * whether a stat without one has to hold that line open.
 *
 * Context rather than a prop because a caller that forgot the prop would
 * get silently ragged rows, which is the exact fault the reservation was
 * introduced to remove. The default is `false` so a `Stat` rendered
 * outside a `StatGroup` reserves nothing rather than reserving against a
 * group that does not exist.
 */
const GroupHasCaption = createContext(false)

export function Stat({ label, value, detail, share = 'third' }: StatProps) {
  const measure = typeof value === 'string' ? { value, unit: null } : value
  // The caption's height is reserved as padding on the wrapper rather than
  // by rendering an empty `<dd>`. An empty description is a real thing in
  // the accessibility tree - a term announced as having a blank
  // description - and reserving space is a layout concern, not a content
  // one.
  //
  // Only in a group that has a caption to line up with, though: see
  // `StatGroup`.
  const groupHasCaption = useContext(GroupHasCaption)
  const classes = [styles.stat, styles[SHARE_CLASS[share]] ?? '']
  if (groupHasCaption && detail === undefined) classes.push(styles.reserved)
  return (
    <div className={classes.join(' ')}>
      <dt className={styles.label}>{label}</dt>
      <dd className={styles.value}>
        <span className={styles.number}>{measure.value}</span>
        {measure.unit !== null && <span className={styles.unit}> {measure.unit}</span>}
      </dd>
      {detail !== undefined && <dd className={styles.detail}>{detail}</dd>}
    </div>
  )
}

export interface StatGroupProps {
  children: ReactNode
}

/**
 * The grid a set of stats sits in: a `<dl>`, because that is what a list
 * of named values is.
 *
 * Six tracks, not three. A row fills as three thirds, as two thirds and a
 * third, as two halves or as one full-width stat, so a group of five fills
 * two rows exactly while every row still starts and ends on the page
 * gutter. A fixed three-wide grid could only do it by leaving a sixth cell
 * empty, which both round-1 critics read as an empty quadrant.
 *
 * Thirds and halves do not share their interior edges - only a row's outer
 * edges can be common to both - so a group that mixes them lands the same
 * component on a different column in each row and reads as two grids
 * stacked. That is what `two-thirds` exists to avoid: it fills a row
 * alongside a third while keeping every cell in the group on one of the
 * three column edges the rest of the screen aligns to.
 *
 * **The group, not the stat, decides whether a caption line is reserved.**
 * It looks at its own children for a `detail` and tells them through
 * context, which sets both the reservation and the row gap that goes with
 * it: rows 21px taller need 8px between them, rows without need 16. A
 * `Stat` asked to decide alone can only see that *it* has no caption,
 * which is why the activity detail screen - where nothing has one - drew
 * every row 16px too tall and hung 21px of nothing under the last one.
 */
export function StatGroup({ children }: StatGroupProps) {
  const hasCaption = containsCaption(children)
  return (
    <GroupHasCaption.Provider value={hasCaption}>
      <dl className={hasCaption ? `${styles.group} ${styles.captioned}` : styles.group}>
        {children}
      </dl>
    </GroupHasCaption.Provider>
  )
}

/**
 * Does anything in this group carry a `detail`?
 *
 * The group has to answer this itself, from its own children, because the
 * alternative - a prop on `StatGroup` - is a flag every caller has to
 * remember, and the one who forgets gets the ragged rows the reservation
 * exists to prevent. Registering from the children during render would
 * mean a second pass and a frame of the wrong layout.
 *
 * The walk descends through fragments and arrays, which is what
 * `{items.map(...)}` and `<>...</>` inside a group produce, and reads
 * `detail` with exactly the test `Stat` itself uses, so a caption computed
 * as `undefined` counts as absent in both places. It does **not** see a
 * `Stat` that some other component renders, because a component's
 * `children` are what was passed to it and not what it returns - keep
 * stats as children of the group, which is also what the `<dl>` content
 * model wants.
 */
function containsCaption(children: ReactNode): boolean {
  return Children.toArray(children).some((child) => {
    if (!isValidElement(child)) return false
    if (child.type === Stat) return (child.props as StatProps).detail !== undefined
    return containsCaption((child.props as { children?: ReactNode }).children)
  })
}
