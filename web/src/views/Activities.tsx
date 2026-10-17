import { useQuery } from '@tanstack/react-query'
import { Link, getRouteApi } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { ALL_SPORTS, UNKNOWN_SPORT, isUnfilteredSearch } from '../api/activitySearch'
import type { ActivitySearch } from '../api/activitySearch'
import { describeApiError } from '../api/errors'
import { queries } from '../api/queries'
import type { components } from '../api/schema'
import { Badge } from '../components/Badge'
import { RangeFilter } from '../components/RangeFilter'
import { Stat, StatGroup } from '../components/Stat'
import type { Measure } from '../format'
import { distanceMeasure, duration, formatLocalShort, heartRateMeasure, pace, sportLabel } from '../format'
import styles from './Activities.module.css'

type ActivitySummary = components['schemas']['ActivitySummary']

/**
 * `getRouteApi` rather than importing the route object from `router.tsx`:
 * that file imports this component, so importing the route back would be a
 * cycle. This only needs the route's id string, which is stable regardless
 * of import order (see the TanStack Router docs on code-split route
 * components).
 */
const routeApi = getRouteApi('/activities')

type SortColumn = NonNullable<ActivitySearch['sort']>
type SourceValue = NonNullable<ActivitySearch['source']>

/**
 * How long the name filter waits after the last keystroke before it writes
 * to the URL. Typing "Treadmill" used to push nine history entries and
 * fire nine `/api/activities` requests, one per character, each a distinct
 * `queryKey` cached forever by `staleTime: Infinity`. Long enough to
 * collapse a typed word into one entry and one request, short enough that
 * the feed still feels like it is responding to the box.
 */
export const QUERY_DEBOUNCE_MS = 300

const DEFAULT_SORT: SortColumn = 'start_time_utc'
const DEFAULT_ORDER: NonNullable<ActivitySearch['order']> = 'desc'

const SOURCE_OPTIONS: { value: SourceValue; label: string }[] = [
  { value: 'garmin_fit', label: 'Garmin FIT' },
  { value: 'strava_fit', label: 'Strava FIT' },
  { value: 'gpx', label: 'GPX' },
]

function sportOptionValue(sport: string | null): string {
  return sport === null ? UNKNOWN_SPORT : sport
}

interface Field {
  /** React list key. Also what a test reaches for to prove the sort control and the card face it drives are the same object, not two parallel lists that happen to agree today. */
  key: string
  /** The field's name, shown on its sort chip and, for a field the card shows, above its value. One string, so the two cannot be worded differently. */
  label: string
  /**
   * The endpoint's `sort` query param. Every field here has one: a field
   * the endpoint cannot order by has no business being a sort chip, and
   * would be a card stat with no chip rather than a chip with no sort.
   *
   * This must always name the same quantity `stat` displays. An earlier
   * version of the "Moving time" column sorted by `elapsed_time_s` while
   * rendering `moving_time_s`, because `sort` used to be closed to
   * `start_time_utc`, `distance_m` and `elapsed_time_s` and moving time was
   * not among them - measured on the real store, 197 of 307 running rows
   * changed position under the two orderings, with 30 adjacent inversions.
   * `docs/reference/api.md` now documents `moving_time_s` as a fourth
   * sortable column for exactly this reason, and
   * `Activities.test.tsx`'s "no sort chip and card face drift apart" test
   * is what catches this pair diverging again.
   */
  sortKey: SortColumn
  /**
   * True when a descending sort on `sortKey` reads as *ascending* in the
   * field's own displayed unit, so the chip's arrow can say what the
   * reader sees rather than what the query asked for. Only pace, which is
   * the reciprocal of the column it sorts by.
   */
  indicatorInverted?: boolean
  /**
   * How the card shows this field, if it shows it as a stat at all.
   *
   * The date is the one field with no `stat`: it is the card's own
   * headline and its link, not one of the four numbers underneath. So the
   * five sortable fields are exactly the five things a card displays, and
   * a sixth added here without a face would be the drift this single list
   * exists to prevent.
   */
  stat?: (activity: ActivitySummary) => Measure | string
}

/**
 * Everything a card says, and everything the list can be sorted by, from a
 * single definition: the sort chips and every card's stat block are both
 * built by mapping this array.
 *
 * Date-led, never name-led: `activity.name` is not read anywhere below. The
 * 307 real runs hold exactly two distinct names, `Run` on 172 and
 * `Treadmill` on 51, so a name headline would read "Run" on 172 cards.
 * `Treadmill`
 * still appears, as a badge, but driven by `sub_sport` (what
 * `analysis/metrics.py`'s `is_indoor` is itself keyed on), not by the name
 * string, since a treadmill effort is real signal: no route, and distance
 * from an uncalibrated footpod rather than GPS.
 */
const FIELDS: Field[] = [
  { key: 'date', label: 'Date', sortKey: 'start_time_utc' },
  {
    key: 'distance',
    label: 'Distance',
    sortKey: 'distance_m',
    stat: (activity) => distanceMeasure(activity.distance_m),
  },
  {
    key: 'moving-time',
    label: 'Moving time',
    sortKey: 'moving_time_s',
    stat: (activity) => duration(activity.moving_time_s),
  },
  {
    key: 'pace',
    label: 'Pace',
    // Sorts by the speed pace is the reciprocal of, because no pace is
    // stored anywhere (CLAUDE.md, "Never store pace"). `toggleSort` asks
    // for `desc` on a field's first click, which in speed means the
    // fastest run first - the maintainer's choice on 2026-09-02, and the same
    // "biggest number first" behaviour every other field has.
    sortKey: 'avg_speed_mps',
    // The arrow has to be flipped for exactly that reason: descending speed
    // is *ascending* pace, so a ▼ beside "Pace" would tell the reader the
    // slowest run is on top while the fastest one is.
    indicatorInverted: true,
    stat: (activity) => pace(activity.avg_speed_mps),
  },
  {
    key: 'heart-rate',
    label: 'Heart rate',
    sortKey: 'avg_hr_bpm',
    stat: (activity) => heartRateMeasure(activity.avg_hr_bpm),
  },
]

/** A field the card shows as a stat: `FIELDS` minus the date, which is the headline instead. */
type StatField = Field & { stat: NonNullable<Field['stat']> }

const STAT_FIELDS: StatField[] = FIELDS.filter((field): field is StatField => field.stat !== undefined)

/*
 * Cadence and ascent are deliberately not on the card. The maintainer's reason,
 * 2026-09-02: both are visible on the activity itself, and a list entry is
 * for the handful of numbers you scan a list by.
 */

/**
 * The activity browser: a filterable, sortable, paged feed of every
 * activity in the store, defaulting to running.
 *
 * Every filter and the sort and the page live in the URL, via the route's
 * own typed search params, so this component never holds that state
 * itself. `queries.activities` re-validates whatever it is handed at the
 * network boundary regardless, so passing `search` straight through here is
 * safe even though TanStack Router's own merge can leave raw, unvalidated
 * keys on it (see the comment on `validateActivitySearch`).
 *
 * The exception is every filter the reader types into rather than picks:
 * the name box and the four numeric bounds keep a local draft while the
 * reader is still typing and commit it through `useTypedFilter`. The value
 * still ends up in the URL, so a filtered view stays shareable; it just
 * does not land there once per keystroke.
 *
 * The only state this component owns is whether the filter sheet is open,
 * which is a property of the reader's hands rather than of the result set:
 * it is not in the URL because a shared link should arrive showing the
 * activities it matched, not the panel that matched them.
 */
/**
 * The two range filters cross a unit boundary, and this is where they cross
 * it.
 *
 * The URL and the API carry SI - metres and seconds - like every other
 * quantity in this project. A reader thinks in kilometres and minutes. So
 * the slider renders the converted value and writes back the SI one, and
 * nothing downstream ever sees a kilometre. Keeping the URL in SI also
 * means a shared link and an API request say the same thing.
 *
 * **A bound at a stop is `undefined`, which removes the filter, not a
 * number - but only at the stop that bound can reach.** At the top that is
 * the whole point of the stop: it means "and above", because six of the 307
 * real runs are longer than 20 km and eight are longer than 2 hours, so a
 * slider that capped there would hide real runs. The *control* reports that
 * one, by handing back `undefined` rather than `max`. At the bottom it is
 * the same rule the numeric boxes this replaced already followed, where an
 * empty box was `undefined` and not 0: a floor of zero is a filter that
 * matches everything, which looks identical to no filter until the reader
 * shares the URL and wonders why it is in it.
 *
 * The two rules are therefore not one rule, and `upperAsSi` must not borrow
 * the lower one. A ceiling of zero is a real ceiling that matches nothing,
 * and it is reachable: dragging the upper handle to the bottom stop sends
 * the number 0, not `undefined`. Coercing that away would drop the filter
 * while the readout still said "0 km to 0 km", leaving the reader looking
 * at an unfiltered table that claims to be filtered to nothing.
 */
const DISTANCE_MAX_KM = 20
const DISTANCE_STEP_KM = 1
const TIME_MAX_MIN = 120
const TIME_STEP_MIN = 5

/** One bound as the slider wants it, from the SI value the URL carries. */
function siAsUnit(si: number | null | undefined, perUnit: number): number | undefined {
  // `null` as well as `undefined`: the generated query type mirrors the
  // endpoint's `float | None`, so an explicitly-null param is expressible.
  if (si === undefined || si === null) return undefined
  return si / perUnit
}

/** Both bounds as the slider wants them; an absent lower bound sits at the bottom stop. */
function rangeFromSearch(
  low: number | null | undefined,
  high: number | null | undefined,
  perUnit: number,
): [number, number | undefined] {
  return [siAsUnit(low, perUnit) ?? 0, siAsUnit(high, perUnit)]
}

/** The lower bound back to SI; at the bottom stop there is no floor to write. */
function lowerAsSi(value: number, perUnit: number): number | undefined {
  if (value <= 0) return undefined
  return value * perUnit
}

/**
 * The upper bound back to SI, absent only when the control says it is
 * absent. Zero is a ceiling like any other here - see the module note above.
 */
function upperAsSi(value: number | undefined, perUnit: number): number | undefined {
  if (value === undefined) return undefined
  return value * perUnit
}

type Patch = (next: Partial<ActivitySearch>, replace?: boolean) => void

/** What one filter's draft means for the URL; `undefined` removes the key. */
type DraftAsSearch<T> = (draft: T) => Partial<ActivitySearch>

type Range = [number, number | undefined]

const nameDraft: DraftAsSearch<string> = (draft) => ({ q: draft === '' ? undefined : draft })

const distanceDraft: DraftAsSearch<Range> = ([low, high]) => ({
  min_distance_m: lowerAsSi(low, 1000),
  max_distance_m: upperAsSi(high, 1000),
})

const timeDraft: DraftAsSearch<Range> = ([low, high]) => ({
  min_moving_time_s: lowerAsSi(low, 60),
  max_moving_time_s: upperAsSi(high, 60),
})

/**
 * Two drafts that would write the same thing to the URL. Compared through
 * `toSearch` rather than by value, because a draft does not round trip: a
 * distance range of `[0, undefined]` and one of `[0, 20]` are the same
 * filter, and comparing the drafts themselves would read a round-tripped
 * commit as the reader having navigated and overwrite what they are still
 * dragging.
 */
function sameFilter<T>(toSearch: DraftAsSearch<T>, a: T, b: T): boolean {
  return JSON.stringify(toSearch(a)) === JSON.stringify(toSearch(b))
}

/**
 * One filter the reader works continuously, wired the only way such a
 * filter is allowed to reach the URL here: a local draft, one commit after
 * `QUERY_DEBOUNCE_MS` of quiet, and that commit with `replace`.
 *
 * Every one of them goes through this rather than calling `patch` from its
 * own `onChange`, because the direct route navigates once per event: a
 * history entry and an `/api/activities` request per character typed, and
 * now per step of a drag, which buries the page the reader arrived from and
 * lands the detail view's back button on a half-made filter. The name box
 * was fixed that way first and the numeric bounds then shipped without it -
 * one mechanism for all of them is what stops the next one being forgotten
 * the same way, and a slider is exactly the next one.
 *
 * Generic in the draft's type, because the name box's draft is a string and
 * a range's is a pair of bounds. Nothing here reads the draft; only
 * `toSearch` does, and identity is compared through it rather than on the
 * draft itself - see `sameFilter`.
 *
 * `urlValue` is the filter as the URL currently has it, already in the
 * control's own unit. A change to it that this hook did not itself commit -
 * Back, Forward, a pasted link, the nav link's reset - overwrites the draft;
 * the hook's own commit round-tripping back does not.
 */
function useTypedFilter<T>(
  urlValue: T,
  toSearch: DraftAsSearch<T>,
  patch: Patch,
): { value: T; onChange: (next: T) => void } {
  const [draft, setDraft] = useState(urlValue)
  const committed = useRef(urlValue)

  useEffect(() => {
    if (sameFilter(toSearch, urlValue, committed.current)) return
    committed.current = urlValue
    setDraft(urlValue)
  }, [urlValue, toSearch])

  useEffect(() => {
    if (sameFilter(toSearch, draft, committed.current)) return
    const timer = setTimeout(() => {
      committed.current = draft
      patch(toSearch(draft), true)
    }, QUERY_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [draft, toSearch, patch])

  return { value: draft, onChange: setDraft }
}

/**
 * The arrow on the active sort chip, and the word a screen reader hears in
 * its place.
 *
 * `inverted` exists for the pace field alone: it sorts by `avg_speed_mps`,
 * and descending speed is ascending pace, so both the arrow and the spoken
 * word have to describe the field's own displayed unit rather than the
 * query's direction. Without it the chip reads ▼ while the fastest run is
 * on top. The two come from one boolean here so that what a sighted reader
 * sees and what a screen reader announces cannot disagree.
 */
function sortState(order: 'asc' | 'desc', inverted?: boolean): { direction: Direction } {
  const ascendingInDisplayedUnit = inverted === true ? order === 'desc' : order === 'asc'
  return { direction: ascendingInDisplayedUnit ? 'ascending' : 'descending' }
}

type Direction = 'ascending' | 'descending'

/**
 * The caret on the active sort chip.
 *
 * Drawn, not `▲`/`▼`. Those are text characters from a different system
 * than the chevron on the Filters control beside them - a filled triangle
 * against a stroked caret, and sitting low on the baseline because a
 * glyph's vertical placement is the font's decision rather than the
 * layout's. Two glyph systems on one row of controls is the kind of thing
 * a reader sees without being able to name. Nothing in the six reference
 * screenshots uses a text character as an icon; the reference's own filter
 * chips carry drawn marks.
 *
 * It is the *same path* as the Filters chevron, rotated: one caret drawn
 * once, pointing down for a descending sort and flipped for an ascending
 * one, which is also what makes the two controls read as one set.
 *
 * `data-direction` rather than a class, because the rotation is keyed off
 * it in the stylesheet: the mark a sighted reader sees and the word a
 * screen reader hears then come from one `sortState` call *and* one
 * attribute, so the two cannot be rotated apart. `aria-hidden`, because a
 * caret read aloud is either silence or the name of a shape - the hidden
 * word beside it is what carries the direction.
 */
function SortMark({ direction }: { direction: Direction }) {
  return (
    <svg
      className={styles.mark}
      data-direction={direction}
      viewBox="0 0 24 24"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
      focusable={false}
    >
      <path d="m5.6 9.2 6.4 6.2 6.4-6.2" />
    </svg>
  )
}

/**
 * How many filters are narrowing the list right now, for the count on the
 * Filters control.
 *
 * The sheet hides the filters, so something visible has to say that the
 * feed below is not the whole store - a reader who arrives on a shared
 * filtered link and sees a short feed must not have to open a panel to
 * find out why.
 *
 * The default sport is not counted, because it is the endpoint's own
 * default rather than something the reader chose, and neither is
 * `ALL_SPORTS`, which widens rather than narrows. Everything else present
 * and non-empty counts, including a key this function has never heard of -
 * the same construction as `isUnfilteredSearch`, and for the same reason:
 * the five filters added after that check was first written were not added
 * to it, and it went quietly wrong.
 */
const PRESENTATION_KEYS: ReadonlySet<string> = new Set(['sort', 'order', 'offset', 'limit'])
const DEFAULT_SPORT = 'running'

function activeFilterCount(search: ActivitySearch): number {
  return Object.entries(search).filter(([key, value]) => {
    if (PRESENTATION_KEYS.has(key)) return false
    if (key === 'sport') return value !== DEFAULT_SPORT && value !== ALL_SPORTS
    return value !== undefined && value !== ''
  }).length
}

/**
 * The sport's mark, inline at the head of the card's quiet line and
 * immediately before the sport's name.
 *
 * **That is where the reference puts a sport glyph**: on
 * `.claude/design-bar/strava/activity-detail-map-hero-and-sheet.jpg` the
 * shoe sits on the meta line, at the same x as the athlete's name above
 * it, and what occupies the column to its left is the *avatar*. We have no
 * avatar - every activity in this store is the same one person's - and the
 * first round of this card put the sport glyph in the avatar's slot
 * instead. That bought a third left edge inside the card (labels and values
 * at 41 px, the circle at 41, the headline at 93) to make room for a mark
 * that is the same on 307 of the 307 runs the browser defaults to. One
 * gutter is the thing the reference is most consistently praised for, and a
 * constant does not earn an indent.
 *
 * Drawn on `TabBar`'s own 24-unit grid so the icon sets read as one, at a
 * heavier stroke because it is drawn a third smaller than a tab icon.
 *
 * Two glyphs, not twelve. Running is the sport this application is about
 * and the one the browser defaults to; everything else - 1637 of the 1944
 * real activities, across eleven sports - gets the generic mark rather than
 * eleven hand-drawn ones that would each be guessed at rather than
 * recognised. The sport itself is named in text beside it either way, so
 * nothing is carried by the glyph alone.
 */
function SportIcon({ sport }: { sport: string | null }) {
  const shared = {
    viewBox: '0 0 24 24',
    width: 16,
    height: 16,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.1,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  }
  if (sport === 'running') {
    return (
      <svg {...shared}>
        <circle cx="14.6" cy="4.6" r="2.1" />
        <path d="m5.2 21 2.6-5.4 3.4-2.1-1.5-4.7-3.3 2-1.9 3" />
        <path d="m9.7 8.8 3.9-1.4 2.6 3.4 3.4 1.1" />
        <path d="m13.1 13.4 2.2 3.1.9 4.5" />
      </svg>
    )
  }
  return (
    <svg {...shared}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.2V12l3.1 1.9" />
    </svg>
  )
}

/**
 * One activity, as the reference's feed card is shaped.
 *
 * The reference's sheet header (see `BRIEF.md`: it is a feed card
 * expanded) runs avatar, identity, a quiet meta line, and then the stats.
 * Ours runs the same way with the identity replaced by the one thing that
 * actually differs between two of this athlete's runs - when it happened.
 * The name is not on the card at all, for the reason `FIELDS` records.
 *
 * **The whole card opens the activity, and that is a deliberate change.**
 * The list it replaces linked from the date cell alone, so that the other
 * cells' text stayed selectable. A card is not a row: the date is 40% of a
 * 130 px-tall tap target on a phone, and a reader who taps the card and
 * gets nothing has been told the wrong thing about what a card is. So the
 * link is stretched over the card with a `::after` overlay - still one
 * ordinary, keyboard-reachable `<a>` with a real `href`, which was the
 * other half of the original reason and is what the browser's own "open in
 * new tab" and a screen reader's link list both need. What it costs is
 * dragging to select a number out of the feed; the detail view, one tap
 * away, is where a run's numbers are read from anyway.
 */
function ActivityCard({ activity }: { activity: ActivitySummary }) {
  const prKeys = activity.pr_distance_keys
  return (
    <li className={styles.card}>
      <div className={styles.head}>
        <h2 className={styles.when}>
          <Link
            to="/activities/$activityId"
            params={{ activityId: activity.activity_id }}
            className={styles.link}
          >
            {formatLocalShort(activity.start_time_utc, activity.utc_offset_s)}
          </Link>
        </h2>
        <p className={styles.meta}>
          <span className={styles.sport}>
            <SportIcon sport={activity.sport} />
            {sportLabel(activity.sport)}
          </span>
          {activity.sub_sport === 'treadmill' && <Badge>Treadmill</Badge>}
          {prKeys.length > 0 && (
            // Which distances, not just "PR": one run in the real store
            // set a 1k, a 1mi and a 3k record at once, and "PR" alone
            // throws that away. The analysis layer orders the keys by
            // distance.
            <Badge tone="accent" title={`Personal record at ${prKeys.join(', ')}`}>
              PR {prKeys.join(' ')}
            </Badge>
          )}
        </p>
      </div>
      <StatGroup>
        {STAT_FIELDS.map((field) => (
          // Halves rather than thirds: four stats over two rows, each row
          // running gutter to gutter, which is the 2x2 block the
          // reference's own sheet header draws under its title.
          <Stat key={field.key} share="half" label={field.label} value={field.stat(activity)} />
        ))}
      </StatGroup>
    </li>
  )
}

export function Activities() {
  const search = routeApi.useSearch()
  const navigate = routeApi.useNavigate()
  const [filtersOpen, setFiltersOpen] = useState(false)

  /**
   * Applies a filter or sort change, always returning to the first page: a
   * page position from the old result set does not mean anything under a
   * new one.
   *
   * `replace` is for a filter that changes as fast as the reader types: a
   * push per intermediate value buries the page the reader arrived from
   * under one history entry per character, and the detail view's own back
   * button (`ActivityDetail`) then lands on a half-typed filter rather
   * than on the list it came from. `useTypedFilter` is the only caller
   * that passes it, and every typed box goes through that hook.
   */
  const patch = useCallback<Patch>(
    (next, replace = false) => {
      navigate({ search: (prev) => ({ ...prev, ...next, offset: 0 }), replace })
    },
    [navigate],
  )

  const nameFilter = useTypedFilter(search.q ?? '', nameDraft, patch)
  const distanceRange = useTypedFilter(
    rangeFromSearch(search.min_distance_m, search.max_distance_m, 1000),
    distanceDraft,
    patch,
  )
  const timeRange = useTypedFilter(
    rangeFromSearch(search.min_moving_time_s, search.max_moving_time_s, 60),
    timeDraft,
    patch,
  )

  const sportsQuery = useQuery(queries.sports())
  const activitiesQuery = useQuery(queries.activities(search))

  function goToOffset(offset: number) {
    navigate({ search: (prev) => ({ ...prev, offset }) })
  }

  function toggleSort(column: SortColumn) {
    const currentSort = search.sort ?? DEFAULT_SORT
    const currentOrder = search.order ?? DEFAULT_ORDER
    const nextOrder = currentSort === column && currentOrder === 'desc' ? 'asc' : 'desc'
    patch({ sort: column, order: nextOrder })
  }

  function onSportChange(event: ChangeEvent<HTMLSelectElement>) {
    patch({ sport: event.target.value })
  }

  function onSourceChange(event: ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value
    patch({ source: value === '' ? undefined : (value as SourceValue) })
  }

  function onHasHrChange(event: ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value
    patch({ has_hr: value === '' ? undefined : value === 'true' })
  }

  function onHasPrChange(event: ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value
    patch({ has_pr: value === '' ? undefined : value === 'true' })
  }

  function onFromChange(event: ChangeEvent<HTMLInputElement>) {
    patch({ from: event.target.value === '' ? undefined : event.target.value })
  }

  function onToChange(event: ChangeEvent<HTMLInputElement>) {
    patch({ to: event.target.value === '' ? undefined : event.target.value })
  }

  const sports = sportsQuery.data ?? []
  const totalActivityCount = sports.reduce((sum, sport) => sum + sport.count, 0)
  const filterCount = activeFilterCount(search)
  const effectiveSort = search.sort ?? DEFAULT_SORT
  const effectiveOrder = search.order ?? DEFAULT_ORDER

  /**
   * The screen's own opening, and the whole reason this view was rebuilt:
   * the title, one control that holds the filters, and one row of sort
   * chips. Nine stacked form controls used to fill the entire first phone
   * screen, so 307 runs began below the fold.
   */
  const header = (
    <div className={styles.header}>
      <h1>Activities</h1>
      <button
        type="button"
        className={styles.filterToggle}
        // `aria-expanded` and `aria-controls` rather than a bare button:
        // the sheet is a disclosure, and a control that opens something
        // has to say what and whether it is open.
        aria-expanded={filtersOpen}
        aria-controls="activity-filters"
        onClick={() => {
          setFiltersOpen((open) => !open)
        }}
      >
        Filters
        {/* The space is what makes this "Filters 2" rather than
            "Filters2" to a screen reader; see the sort chips below. */}
        {filterCount > 0 && (
          <>
            {' '}
            <span className={styles.filterCount}>{filterCount}</span>
          </>
        )}
        {/* The disclosure's own mark. `aria-expanded` already says this to
            a screen reader; a chevron is what says it to everyone else,
            and without one the only difference between open and closed is
            a fill the reader has to remember. */}
        <svg
          className={styles.chevron}
          viewBox="0 0 24 24"
          width={14}
          height={14}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden={true}
          focusable={false}
        >
          <path d="m5.6 9.2 6.4 6.2 6.4-6.2" />
        </svg>
      </button>
    </div>
  )

  const sortBar = (
    <div className={styles.sortBar} role="group" aria-label="Sort activities">
      {FIELDS.map((field) => {
        const active = effectiveSort === field.sortKey
        const sort = active ? sortState(effectiveOrder, field.indicatorInverted) : null
        return (
          <button
            key={field.key}
            type="button"
            className={active ? `${styles.chip} ${styles.chipActive}` : styles.chip}
            aria-pressed={active}
            onClick={() => {
              toggleSort(field.sortKey)
            }}
          >
            {field.label}
            {sort !== null && (
              <>
                <SortMark direction={sort.direction} />
                {/* An explicit space, because an accessible name is the
                    concatenation of its parts and JSX drops the newline
                    between two elements: without it the chip is announced
                    as "Paceascending". A whitespace-only text node in a
                    flex container is not rendered, so it costs the layout
                    nothing. */}
                {' '}
                <span className={styles.srOnly}>{sort.direction}</span>
              </>
            )}
          </button>
        )
      })}
    </div>
  )

  const filters = (
    <form
      id="activity-filters"
      className={styles.filters}
      // Kept mounted while closed rather than unmounted: `useTypedFilter`
      // holds an uncommitted draft, and a reader who closes the sheet
      // mid-word would otherwise lose it. `[hidden]` has to be restated in
      // the stylesheet because a `display` declaration on the class beats
      // the user agent's own `[hidden] { display: none }`.
      hidden={!filtersOpen}
      onSubmit={(event) => {
        event.preventDefault()
      }}
    >
      <label className={styles.field}>
        Sport
        <select value={search.sport} onChange={onSportChange}>
          <option value={ALL_SPORTS}>All sports ({totalActivityCount})</option>
          {sports.map((sport) => (
            <option key={sportOptionValue(sport.sport)} value={sportOptionValue(sport.sport)}>
              {sportLabel(sport.sport)} ({sport.count})
            </option>
          ))}
        </select>
      </label>

      <label className={styles.field}>
        Source
        <select value={search.source ?? ''} onChange={onSourceChange}>
          <option value="">Any source</option>
          {SOURCE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className={styles.field}>
        Heart rate
        <select value={search.has_hr === undefined ? '' : String(search.has_hr)} onChange={onHasHrChange}>
          <option value="">Any</option>
          <option value="true">With heart rate</option>
          <option value="false">Without heart rate</option>
        </select>
      </label>

      <label className={styles.field}>
        Records
        <select value={search.has_pr === undefined ? '' : String(search.has_pr)} onChange={onHasPrChange}>
          <option value="">Any</option>
          <option value="true">Set a record</option>
          <option value="false">Set no record</option>
        </select>
      </label>

      {/*
       * Kilometres and minutes in, metres and seconds out. The API is SI at
       * its boundary like every other quantity in this project, and a
       * reader does not think about a run in metres - so the conversion
       * happens here, in the one direction this application ever converts.
       *
       * The top stop is `20 km+` and `2h+` rather than 20 km and 2 hours:
       * six of the 307 real runs are longer than 20 km and eight are longer
       * than 2 hours, so a slider that capped there would hide real runs.
       * `RangeFilter` reports `undefined` at that stop and the conversion
       * above drops the key.
       */}
      <div className={styles.rangeField}>
        <RangeFilter
          label="Distance"
          min={0}
          max={DISTANCE_MAX_KM}
          step={DISTANCE_STEP_KM}
          value={distanceRange.value}
          onChange={distanceRange.onChange}
          formatValue={(km) => `${String(km)} km`}
          topLabel={`${String(DISTANCE_MAX_KM)} km+`}
        />
      </div>

      <div className={styles.rangeField}>
        <RangeFilter
          label="Moving time"
          min={0}
          max={TIME_MAX_MIN}
          step={TIME_STEP_MIN}
          value={timeRange.value}
          onChange={timeRange.onChange}
          formatValue={(minutes) => `${String(minutes)} min`}
          topLabel={`${String(TIME_MAX_MIN / 60)}h+`}
        />
      </div>

      <label className={styles.field}>
        From
        <input type="date" value={search.from ?? ''} onChange={onFromChange} />
      </label>

      <label className={styles.field}>
        To
        <input type="date" value={search.to ?? ''} onChange={onToChange} />
      </label>

      <label className={styles.field}>
        Name contains
        <input
          type="search"
          placeholder="Run, Treadmill…"
          value={nameFilter.value}
          onChange={(event) => {
            nameFilter.onChange(event.target.value)
          }}
        />
      </label>
    </form>
  )

  // A failed sport filter is a nicety lost, not the whole browser: every
  // other filter, the feed and paging all work regardless, and the sport
  // filter itself still functions - it just falls back to "All sports"
  // with no per-sport counts rather than refusing to render at all. An
  // earlier version returned early here and hid `activitiesQuery`'s own
  // result underneath a filter-only failure, which is the one error branch
  // in this component that did not keep the surrounding UI.
  const sportsError = sportsQuery.isError ? (
    <p className={styles.note} role="alert">
      Could not load the sport filter: {describeApiError(sportsQuery.error)}. The other filters still work.
    </p>
  ) : null

  if (activitiesQuery.isPending) {
    return (
      <div className={styles.activities}>
        {header}
        {sportsError}
        {sortBar}
        {filters}
        <p className={styles.note}>Loading activities…</p>
      </div>
    )
  }

  if (activitiesQuery.isError) {
    return (
      <div className={styles.activities}>
        {header}
        {sportsError}
        {sortBar}
        {filters}
        <p className={styles.note} role="alert">
          Could not load activities: {describeApiError(activitiesQuery.error)}
        </p>
      </div>
    )
  }

  const page = activitiesQuery.data
  const rangeStart = page.total === 0 ? 0 : page.offset + 1
  const rangeEnd = Math.min(page.offset + page.limit, page.total)

  // An `offset` at or past `total`: rows matched, but none of them are on
  // this page. Unreachable by clicking - Next disables at the boundary and
  // `patch` resets `offset` on every filter and sort change - so this is a
  // bookmarked or shared deep-page URL reloaded after the store shrank, or
  // after that URL's filters started matching fewer rows. Rendering the
  // feed anyway gave a pager reading "401-307 of 307", which is a range
  // that runs backwards and says nothing about why the page is blank. This
  // says what happened and offers the way out, rather than silently
  // clamping the arithmetic and leaving the reader looking at nothing.
  const emptyState =
    page.total === 0 ? (
      <p className={styles.empty}>
        {isUnfilteredSearch(search)
          ? 'This store has no activities in it. Ingest a Strava or Garmin Connect export to get started.'
          : 'No activities matched these filters. Try widening the sport, the date range or the distance and time bounds, or clearing the search.'}
      </p>
    ) : page.items.length === 0 ? (
      <div className={styles.empty}>
        <p>
          This page starts past the end of the results: {page.total}{' '}
          {page.total === 1 ? 'activity matches' : 'activities match'}, and this page begins at{' '}
          {rangeStart}.
        </p>
        <button type="button" className={styles.button} onClick={() => goToOffset(0)}>
          Back to the first page
        </button>
      </div>
    ) : null

  return (
    <div className={styles.activities}>
      {header}
      {sportsError}
      {sortBar}
      {filters}

      {emptyState ?? (
        <>
          {/* Named, because "a list" is what a screen reader would
              otherwise announce it as, and this page has a sport picker
              full of options and a sheet full of fields to tell it apart
              from. */}
          <ul className={styles.feed} aria-label="Activities">
            {page.items.map((activity) => (
              <ActivityCard key={activity.activity_id} activity={activity} />
            ))}
          </ul>

          <div className={styles.pager}>
            {/* Which slice of the results is on screen. It sits with the
                controls that change it rather than above the feed: it is
                information rather than navigation, and a line of it
                between the sort row and the first activity is chrome
                answering a question nobody has asked yet on arrival. */}
            <p className={styles.range}>
              {rangeStart}-{rangeEnd} of {page.total}
            </p>
            <button
              type="button"
              className={styles.button}
              disabled={page.offset === 0}
              onClick={() => goToOffset(Math.max(0, page.offset - page.limit))}
            >
              Previous
            </button>
            <button
              type="button"
              className={styles.button}
              disabled={page.offset + page.limit >= page.total}
              onClick={() => goToOffset(page.offset + page.limit)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export { FIELDS }
