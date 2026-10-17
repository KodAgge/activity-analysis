import { render, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NO_VALUE } from '../format'
import { ZoneBar, type ZoneBucket } from './ZoneBar'

/**
 * The shape an activity's own `derived.zones` actually arrives in, checked
 * live against `/api/activities/{id}` on 2026-09-12: all seven indices,
 * zone 6 included, each carrying its own edges and zone 6 reading
 * `207 bpm and above` with 0 seconds in it. An earlier version of this
 * fixture omitted zone 6 on the belief that the real store never sends one,
 * which is not true and left the padding in `ZoneBar` looking necessary.
 */
const REALISTIC_BUCKETS: ZoneBucket[] = [
  { zone_index: 0, seconds_s: 60, low_bpm: null, high_bpm: 104 },
  { zone_index: 1, seconds_s: 300, low_bpm: 104, high_bpm: 124 },
  { zone_index: 2, seconds_s: 600, low_bpm: 124, high_bpm: 145 },
  { zone_index: 3, seconds_s: 900, low_bpm: 145, high_bpm: 166 },
  { zone_index: 4, seconds_s: 700, low_bpm: 166, high_bpm: 186 },
  { zone_index: 5, seconds_s: 200, low_bpm: 186, high_bpm: 207 },
  { zone_index: 6, seconds_s: 0, low_bpm: 207, high_bpm: null },
]

/** The row for one zone index, whatever order the component chose to render in. */
function rowFor(container: HTMLElement, zoneIndex: number): HTMLElement {
  const row = container.querySelector(`tr[data-zone="${String(zoneIndex)}"]`)
  if (row === null) throw new Error(`no row rendered for zone ${String(zoneIndex)}`)
  return row as HTMLElement
}

/** The rendered bar width of one zone, as the percentage the component set. */
function barPercent(container: HTMLElement, zoneIndex: number): number {
  const fill = rowFor(container, zoneIndex).querySelector('td span span')
  if (fill === null) throw new Error(`no bar rendered for zone ${String(zoneIndex)}`)
  return Number.parseFloat((fill as HTMLElement).style.width)
}

describe('ZoneBar', () => {
  it('does not draw the empty band above the last configured boundary', () => {
    // The real profile: boundaries 104, 124, 145, 166, 186, 207 against a
    // configured maximum of 207, so the band above the last boundary means
    // "above your own maximum" and holds 0 seconds across all 223
    // activities with zone data. It is unreachable by construction rather
    // than merely empty.
    const { container } = render(<ZoneBar buckets={REALISTIC_BUCKETS} boundariesAreCurrentSettings={false} />)
    expect(container.querySelectorAll('tbody tr')).toHaveLength(6)
    expect(container.querySelector('tr[data-zone="6"]')).toBeNull()
    expect(within(container).queryByText('Z6')).toBeNull()
  })

  it('still draws an empty zone that is reachable, because that is a measurement', () => {
    // **Not the same rule as hiding an empty zone.** The real activity
    // `854fd775d479ca9f` records 0 s in zone 5 and 0 s in zone 6: the first
    // is an easy run that never reached 186 bpm, which the reader should
    // see, and the second is a band nothing can be in. Only the second goes.
    const emptyTopZones = REALISTIC_BUCKETS.map((bucket) =>
      bucket.zone_index === 5 ? { ...bucket, seconds_s: 0 } : bucket,
    )
    const { container } = render(<ZoneBar buckets={emptyTopZones} boundariesAreCurrentSettings={false} />)

    const zone5 = within(rowFor(container, 5))
    expect(zone5.getByText('0:00')).toBeInTheDocument()
    expect(zone5.getByText('0%')).toBeInTheDocument()
    expect(zone5.getByText('186-207')).toBeInTheDocument()
    expect(barPercent(container, 5)).toBe(0)
    expect(container.querySelector('tr[data-zone="6"]')).toBeNull()
  })

  it('draws the band above the last boundary anyway when something is measured in it', () => {
    // The rule is about the configuration, and time in that band is a fact
    // about the athlete. If a profile ever put its top boundary below the
    // configured maximum the band would be genuinely reachable, and hiding
    // measured seconds is the one failure this rule must not have.
    const reachedAboveTop = REALISTIC_BUCKETS.map((bucket) =>
      bucket.zone_index === 6 ? { ...bucket, seconds_s: 90 } : bucket,
    )
    const { container } = render(<ZoneBar buckets={reachedAboveTop} boundariesAreCurrentSettings={false} />)

    const zone6 = within(rowFor(container, 6))
    expect(zone6.getByText('1:30')).toBeInTheDocument()
    expect(zone6.getByText('207+')).toBeInTheDocument()
  })

  it('renders a zone the profile carries beyond the device default rather than dropping it', () => {
    // docs/reference/derived-layer.md is explicit that the six boundaries
    // this device supplies are a default rather than the law, and
    // `zoneEdgesFromBoundaries` emits n + 1 zones for n boundaries. With
    // seven boundaries, index 7 is the above-maximum band and index 6 is a
    // real measured zone. Hardcoding the indices to 0..6 drops that zone's
    // row while still counting its seconds in the denominator, so every
    // zone below it silently reads short.
    const sevenBoundaryBuckets: ZoneBucket[] = [
      // The six real zones, then a seventh real one, then the open-ended
      // band that has moved up to index 7 with the extra boundary.
      ...REALISTIC_BUCKETS.filter((bucket) => bucket.zone_index !== 6),
      { zone_index: 6, seconds_s: 240, low_bpm: 207, high_bpm: 215 },
      { zone_index: 7, seconds_s: 0, low_bpm: 215, high_bpm: null },
    ]
    const { container } = render(<ZoneBar buckets={sevenBoundaryBuckets} boundariesAreCurrentSettings={false} />)

    // Zone 6 is a real measured zone here: its own seconds, its own edges,
    // and it must not be dropped just because it is the seventh row.
    const zone6 = within(rowFor(container, 6))
    expect(zone6.getByText('4:00')).toBeInTheDocument()
    expect(zone6.getByText('207-215')).toBeInTheDocument()
    expect(barPercent(container, 6)).toBeGreaterThan(0)

    // The open-ended band has moved up to index 7, and that is the one that
    // goes: the rule follows the missing ceiling, never a fixed index.
    expect(container.querySelectorAll('tbody tr')).toHaveLength(7)
    expect(container.querySelector('tr[data-zone="7"]')).toBeNull()
  })

  it("carries each zone's bpm edges and its own duration in its own row", () => {
    const { container } = render(<ZoneBar buckets={REALISTIC_BUCKETS} boundariesAreCurrentSettings={false} />)

    // 900 s is 15:00, and zone 3's edges are its own, not a neighbour's.
    const zone3 = within(rowFor(container, 3))
    expect(zone3.getByText('145-166')).toBeInTheDocument()
    expect(zone3.getByText('15:00')).toBeInTheDocument()

    // An open-ended bottom zone says so rather than printing a null. It is
    // open-ended at the end the athlete can actually reach - real runs do
    // spend time below 104 bpm - which is why the drop rule keys on a
    // missing *ceiling* rather than on a missing edge.
    expect(within(rowFor(container, 0)).getByText('below 104')).toBeInTheDocument()
  })

  it('states a missing boundary in a label that fits the bpm column', () => {
    // Reachable whenever a bucket carries no edges at all, which
    // `/api/overview` produces when no profile is stored:
    // `zoneEdgesFromBoundaries([])` gives one zone with neither a floor nor
    // a ceiling. It renders inside a column `table-layout: fixed` holds at
    // 4.4rem - a 62.4px content box once the shared `--space-2` trailing
    // padding is taken off. jsdom lays nothing out, so the budget is
    // asserted in glyphs rather than in pixels: `.edges` is `mono` at
    // `--text-caption` (11px) and IBM Plex Mono advances 0.6em, so a glyph
    // is 6.6px and nine of them fit. Eight is kept as the budget for a
    // label with no boundary at all, which has no reason to run long. The
    // wording this replaced, "no recorded boundary", is 20 of them - 132px,
    // spilling across three cells under
    // `white-space: nowrap`.
    const MONO_GLYPHS_THAT_FIT = 8

    const noBoundaryBuckets: ZoneBucket[] = [
      { zone_index: 0, seconds_s: 120, low_bpm: null, high_bpm: null },
      { zone_index: 1, seconds_s: 300, low_bpm: null, high_bpm: null },
    ]
    const { container } = render(<ZoneBar buckets={noBoundaryBuckets} boundariesAreCurrentSettings={false} />)

    // One cell per bucket the input carried. A bucket with no edges at all
    // is never dropped: the rule needs to see a floor and no ceiling, and
    // nothing here says which end of the scale this band sits at.
    const edges = Array.from(container.querySelectorAll<HTMLElement>('tbody td:first-of-type'), (cell) =>
      (cell.textContent ?? '').trim(),
    )
    expect(edges).toHaveLength(2)
    for (const label of edges) {
      expect(label).toBe(NO_VALUE)
      expect(label.length).toBeLessThanOrEqual(MONO_GLYPHS_THAT_FIT)
    }

    // Still a stated absence rather than a blank cell: a reader has to be
    // able to tell "no boundary recorded" from a rendering fault.
    expect(edges.every((label) => label.length > 0)).toBe(true)
  })

  it('keeps every boundary label this store can produce inside the same column budget', () => {
    // The same budget applied to the shapes that actually occur: a range,
    // an open bottom and an open top. `below 104` is the longest of them
    // at 9 glyphs, 59.4px, which now sits inside the 62.4px content box
    // rather than leaning on the column's trailing padding the way it did
    // at the larger type this column used to carry. The budget stays
    // asserted per label, because what has to fit is a label and not an
    // average.
    const MONO_GLYPHS_THAT_FIT_WITH_PADDING = 9

    const { container } = render(<ZoneBar buckets={REALISTIC_BUCKETS} boundariesAreCurrentSettings={false} />)
    const edges = Array.from(container.querySelectorAll<HTMLElement>('tbody td:first-of-type'), (cell) =>
      (cell.textContent ?? '').trim(),
    )

    expect(edges).toContain('below 104')
    for (const label of edges) {
      expect(label.length).toBeLessThanOrEqual(MONO_GLYPHS_THAT_FIT_WITH_PADDING)
    }
  })

  it('scales the bars to the largest zone rather than to the total', () => {
    // The distinction that makes the rows readable. These buckets total
    // 2760 s with the largest at 900 s, so scaling to the total would put
    // every bar under a third of the track and the shape would be
    // unreadable - the same failure the splits bars had. Scaled to the
    // largest, zone 3 fills the track and every other zone is a legible
    // fraction of it.
    const { container } = render(<ZoneBar buckets={REALISTIC_BUCKETS} boundariesAreCurrentSettings={false} />)

    expect(barPercent(container, 3)).toBe(100)
    // 700/900 and 600/900, not 700/2760 and 600/2760.
    expect(barPercent(container, 4)).toBeCloseTo((700 / 900) * 100, 5)
    expect(barPercent(container, 2)).toBeCloseTo((600 / 900) * 100, 5)
  })

  it('reports each share against the total, which is a different number from the bar width', () => {
    // The bar is relative to the largest zone; the percentage is relative
    // to the whole activity. Conflating them would either mis-scale the
    // bars or misreport the shares, and one number cannot be both.
    const { container } = render(<ZoneBar buckets={REALISTIC_BUCKETS} boundariesAreCurrentSettings={false} />)
    const total = REALISTIC_BUCKETS.reduce((sum, bucket) => sum + bucket.seconds_s, 0)

    expect(within(rowFor(container, 3)).getByText(`${String(Math.round((900 / total) * 100))}%`)).toBeInTheDocument()
    expect(barPercent(container, 3)).toBe(100)
    expect(Math.round((900 / total) * 100)).not.toBe(100)
  })

  it('captions the boundaries as configured today when summed across a period', () => {
    const { getByText } = render(<ZoneBar buckets={REALISTIC_BUCKETS} boundariesAreCurrentSettings={true} />)
    expect(getByText(/as configured today/i)).toBeInTheDocument()
  })

  it("captions the boundaries as recorded for the activity when they are one activity's own", () => {
    const { getByText } = render(<ZoneBar buckets={REALISTIC_BUCKETS} boundariesAreCurrentSettings={false} />)
    expect(getByText(/as recorded for this activity/i)).toBeInTheDocument()
  })

  it('states the absence rather than drawing rows when there are no zone rows at all', () => {
    // The real shape of 84 of 307 runs: no heart rate, so no `zone_time`
    // rows, so `buckets` arrives empty.
    const { container, getByText, getByRole } = render(<ZoneBar buckets={[]} boundariesAreCurrentSettings={false} />)
    expect(container.querySelector('table')).toBeNull()
    expect(getByText(/no heart rate zone data/i)).toBeInTheDocument()
    // I6: through the shared `Absent` component - `role="note"` is its own
    // contract, which a component-local `.empty` div would not carry.
    expect(getByRole('note')).toBeInTheDocument()
  })

  it('also states the absence when every bucket sums to zero seconds, a different route to the same fact', () => {
    // Distinct from the per-zone `0:00` above: a single zero zone among
    // measured ones is a measurement, while a whole activity of them means
    // nothing was measured at all, and rendering seven `0:00` rows would
    // claim a distribution that was never recorded.
    const allZero: ZoneBucket[] = [
      { zone_index: 0, seconds_s: 0 },
      { zone_index: 1, seconds_s: 0 },
      { zone_index: 2, seconds_s: 0 },
    ]
    const { container, getByText } = render(<ZoneBar buckets={allZero} boundariesAreCurrentSettings={false} />)
    expect(container.querySelector('table')).toBeNull()
    expect(getByText(/no heart rate zone data/i)).toBeInTheDocument()
  })
})
