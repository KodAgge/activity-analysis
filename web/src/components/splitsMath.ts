import type { components } from '../api/schema'

type Lap = components['schemas']['Lap']

const KM_METRES = 1000

export interface KmSplit {
  /** 1-based ordinal among this run's splits, full and partial alike. */
  index: number
  elapsedS: number
  distanceM: number
  /** True for the leftover distance below a full kilometre. */
  partial: boolean
  avgHrBpm: number | null
  avgCadenceSpm: number | null
  /** End altitude minus start altitude - signed, unlike total ascent. */
  elevationChangeM: number | null
}

/** Carries the last known value across a null: the grid's own distance never regresses, so a run of nulls (there should not be any mid-stream - see docs/reference/api.md) reads as "no further progress yet" rather than breaking the crossing search below. */
function forwardFilledDistances(distanceM: (number | null)[]): number[] {
  const out: number[] = []
  let last = 0
  for (const d of distanceM) {
    if (d !== null && Number.isFinite(d)) last = d
    out.push(last)
  }
  return out
}

function atIndex<T>(values: T[], index: number, fallback: T): T {
  const value = values[index]
  return value === undefined ? fallback : value
}

/**
 * The elapsed time at which the forward-filled, non-decreasing `distances`
 * series first reaches `targetM`, linearly interpolated between the
 * bracketing samples. `null` if the run never covers that distance.
 */
function crossingTime(t: number[], distances: number[], targetM: number): number | null {
  for (let i = 0; i < distances.length; i++) {
    const d = atIndex(distances, i, 0)
    if (d < targetM) continue
    if (i === 0) return atIndex(t, 0, 0)
    const prevD = atIndex(distances, i - 1, 0)
    const prevT = atIndex(t, i - 1, 0)
    const curT = atIndex(t, i, prevT)
    if (d === prevD) return curT
    const fraction = (targetM - prevD) / (d - prevD)
    return prevT + fraction * (curT - prevT)
  }
  return null
}

/** First index whose elapsed time is at or after `time`, or `values.length` if none is. */
function indexAtOrAfter(t: number[], time: number): number {
  for (let i = 0; i < t.length; i++) {
    if (atIndex(t, i, Number.POSITIVE_INFINITY) >= time) return i
  }
  return t.length
}

function average(values: (number | null)[], startIndex: number, endIndex: number): number | null {
  let sum = 0
  let count = 0
  for (let i = startIndex; i < endIndex; i++) {
    const v = atIndex(values, i, null)
    if (v !== null && Number.isFinite(v)) {
      sum += v
      count += 1
    }
  }
  return count === 0 ? null : sum / count
}

/** The nearest non-null sample to `index`, searching outward in both directions. Altitude is not guaranteed at every index the way distance is, so a split boundary can land on a null sample. */
function nearestNonNull(values: (number | null)[], index: number): number | null {
  for (let offset = 0; offset < values.length; offset++) {
    const before = values[index - offset]
    if (before !== undefined && before !== null && Number.isFinite(before)) return before
    const after = values[index + offset]
    if (after !== undefined && after !== null && Number.isFinite(after)) return after
  }
  return null
}

function elevationDelta(altitudeM: (number | null)[], startIndex: number, endIndex: number): number | null {
  // A collapsed (zero-length) window is not a real span to measure a
  // change across - it arises when two consecutive kilometre crossings
  // land on the same grid sample, e.g. a data jump that covers several
  // kilometres in one recorded second. `nearestNonNull` would otherwise
  // search outward from the same index for both ends and report a
  // confident 0 m change for a window that never really existed.
  if (endIndex <= startIndex) return null
  const start = nearestNonNull(altitudeM, startIndex)
  const end = nearestNonNull(altitudeM, Math.max(startIndex, endIndex - 1))
  if (start === null || end === null) return null
  return end - start
}

/**
 * Per-kilometre splits computed from the 1 Hz grid, never from the
 * device's own laps: a split is the elapsed time
 * between two 1000 m crossings of the run's own odometer, found by
 * linear interpolation between the bracketing grid samples.
 *
 * The final leftover distance below a full kilometre is returned as one
 * more entry with `partial: true` rather than being dropped or padded out
 * to a full split it did not cover.
 */
export function perKilometreSplits(
  t: number[],
  distanceM: (number | null)[],
  hrBpm: (number | null)[],
  cadenceSpm: (number | null)[],
  altitudeM: (number | null)[],
): KmSplit[] {
  if (t.length === 0) return []

  const distances = forwardFilledDistances(distanceM)
  const totalDistance = atIndex(distances, distances.length - 1, 0)
  const fullSplitCount = Math.floor(totalDistance / KM_METRES)

  const boundaryTimes: number[] = [atIndex(t, 0, 0)]
  for (let km = 1; km <= fullSplitCount; km++) {
    const crossing = crossingTime(t, distances, km * KM_METRES)
    boundaryTimes.push(crossing ?? atIndex(boundaryTimes, boundaryTimes.length - 1, 0))
  }

  const splits: KmSplit[] = []
  for (let km = 1; km <= fullSplitCount; km++) {
    const startT = atIndex(boundaryTimes, km - 1, 0)
    const endT = atIndex(boundaryTimes, km, startT)
    const startIndex = indexAtOrAfter(t, startT)
    const endIndex = indexAtOrAfter(t, endT)
    splits.push({
      index: km,
      elapsedS: endT - startT,
      distanceM: KM_METRES,
      partial: false,
      avgHrBpm: average(hrBpm, startIndex, endIndex),
      avgCadenceSpm: average(cadenceSpm, startIndex, endIndex),
      elevationChangeM: elevationDelta(altitudeM, startIndex, endIndex),
    })
  }

  // A run ending exactly on a kilometre boundary has nothing left over;
  // the epsilon absorbs the odd fraction of a metre floating-point
  // interpolation can leave behind, so that case does not surface as a
  // one-millimetre "partial" split.
  const EPSILON_M = 0.5
  const remainder = totalDistance - fullSplitCount * KM_METRES
  if (remainder > EPSILON_M) {
    const startT = atIndex(boundaryTimes, boundaryTimes.length - 1, 0)
    const endT = atIndex(t, t.length - 1, startT)
    const startIndex = indexAtOrAfter(t, startT)
    splits.push({
      index: fullSplitCount + 1,
      elapsedS: endT - startT,
      distanceM: remainder,
      partial: true,
      avgHrBpm: average(hrBpm, startIndex, t.length),
      avgCadenceSpm: average(cadenceSpm, startIndex, t.length),
      elevationChangeM: elevationDelta(altitudeM, startIndex, t.length),
    })
  }

  return splits
}

export type LapRole = 'rep' | 'recovery' | 'plain'

export interface ClassifiedLap {
  lap: Lap
  role: LapRole
  /** 1-based, chronological among reps only; null for a non-rep lap. */
  repNumber: number | null
}

const REP_LABEL = 'R'
const RECOVERY_LABEL = 'W'

/**
 * `analysis/tags.py`'s `interval_reps` predicate, character for character:
 * an `R` is a counted rep only when the label immediately before or after
 * it is a `W`. `charAt` returns the empty string off either end, so the
 * first and last positions need no separate bounds check.
 */
function isCountedRep(pattern: string, index: number): boolean {
  if (pattern.charAt(index) !== REP_LABEL) return false
  return pattern.charAt(index - 1) === RECOVERY_LABEL || pattern.charAt(index + 1) === RECOVERY_LABEL
}

/**
 * Which recorded laps read as a rep or a recovery, read directly off the
 * analysis layer's own `rep_pattern` - the "R"/"W"/"-" string
 * `analysis/tags.py`'s `interval_reps` produced, one character per
 * recorded lap in recorded order (see docs/reference/math/tags.md and
 * ANALYSIS_VERSION 4's addition of the column).
 *
 * An earlier version of this function re-derived the classification in the
 * frontend from `avg_speed_mps` and `avg_cadence_spm`, taking the
 * `repCount` fastest laps as reps. That worked on the one activity it was
 * checked against but failed on the wider real store: five of the nine
 * real interval sessions record no `avg_speed_mps` at all on any lap (the
 * athlete stopped the watch through every recovery, so those laps are
 * zero-length stops rather than measured speeds), and even a speed
 * backfilled from `distance_m / elapsed_time_s` still mismatches the
 * analysis layer's own count on some sessions, because `rep_count` is not
 * simply "how many laps were fast" - `interval_reps` only counts an `R`
 * lap that sits beside a `W`, so a session can have more `R` labels than
 * its `rep_count` (`cb588d27` has nine `R` labels at `rep_count: 7`).
 * Reading the pattern directly is the only way to agree with that count.
 *
 * **The adjacency rule is mirrored here, not approximated.** Only an `R`
 * immediately beside a `W` is numbered, exactly as `interval_reps`
 * (`analysis/tags.py`) counts it, so the numbered rows are the same set
 * `rep_count` names and the last of them is always `Rep <rep_count>`.
 * Numbering every `R` instead put "Rep 1" through "Rep 9" under a tab
 * reading "Laps - 7 reps" on `cb588d27`. An `R` the analysis layer did not
 * count reads `plain`, which is what it is: a fast lap that is not one of
 * the reps this session was tagged for. The frontend does not get to
 * redefine a metric it does not own - that is why `rep_pattern` was
 * exposed as a column rather than left to be re-derived, and it is why the
 * tab label still reports the served `rep_count` unchanged.
 *
 * **Sorted by `lap_index` first**, rather than trusting the caller's array
 * order to already be recorded order. `docs/reference/api.md` documents
 * that `GET /api/activities/{id}` serves `laps` in `lap_index` order and
 * `tests/test_api_activities.py` enforces it, but nothing on this side of
 * the boundary depends on that structurally - a pattern is positional, so
 * indexing it against whatever order the array happens to arrive in would
 * silently misalign every role the moment that ordering ever changed, and
 * a walked recovery confidently labelled a rep is worse than no label at
 * all: it looks authoritative. Sorting a defensive copy here makes the
 * guarantee local instead of assumed.
 *
 * **Length guard**: if `pattern` is null, or its length does not match
 * the number of laps, every lap reads `plain`. A pattern is per-lap by
 * construction, so a length mismatch means the two came from different
 * activities or a stale response - assigning it anyway would confidently
 * label the wrong laps, which is worse than labelling none.
 */
export function rolesFromPattern(laps: Lap[], pattern: string | null): ClassifiedLap[] {
  const orderedLaps = [...laps].sort((a, b) => a.lap_index - b.lap_index)

  if (pattern === null || pattern.length !== orderedLaps.length) {
    return orderedLaps.map((lap) => ({ lap, role: 'plain', repNumber: null }))
  }

  let repNumber = 0
  return orderedLaps.map((lap, index) => {
    const role: LapRole = isCountedRep(pattern, index)
      ? 'rep'
      : pattern.charAt(index) === RECOVERY_LABEL
        ? 'recovery'
        : 'plain'
    if (role === 'rep') repNumber += 1
    return { lap, role, repNumber: role === 'rep' ? repNumber : null }
  })
}

/**
 * The width of a split's pace bar, as a percentage, scaled to the *range*
 * of paces in the table rather than to zero.
 *
 * Zero-anchoring was the original, and it made every bar look the same.
 * Measured on `854fd775d479ca9f`: eight laps from 6:16 to 6:57 per
 * kilometre, scaled as `speed / fastestSpeed`, span 90.1% to 100.0% of
 * their cell - a 9.9-point spread across the whole table, which the eye
 * cannot separate. Scaled to the observed range they span the floor to
 * 100%, an 88-point spread, 8.9 times more discriminating. This is the
 * same correction the pace *axis* already carries in
 * `charts/streamPanelMath.ts`, and for the same reason: a metric whose
 * real variation is a few percent of its absolute value needs an axis
 * around its own band, not one starting at zero.
 *
 * `MIN_PACE_BAR_PERCENT` is why the slowest split still draws something.
 * At a true zero the slowest row would have no bar at all, which reads as
 * missing data rather than as the slowest split, and a table where one row
 * is blank for a reason the reader has to infer is worse than one where
 * every row is comparable.
 *
 * A table whose splits all share one pace - a treadmill at a constant
 * speed, or a single-lap run - has no range to normalise against, and
 * every bar is drawn full. That is honest: they really are all the same
 * pace, and scaling them all to the floor instead would suggest they were
 * all slow.
 */
export function paceBarWidthPercent(
  speedMps: number | null,
  slowestSpeedMps: number,
  fastestSpeedMps: number,
): number {
  if (speedMps === null || !Number.isFinite(speedMps) || speedMps <= 0) return 0
  const span = fastestSpeedMps - slowestSpeedMps
  if (span <= 0) return 100
  const fraction = (speedMps - slowestSpeedMps) / span
  return MIN_PACE_BAR_PERCENT + fraction * (100 - MIN_PACE_BAR_PERCENT)
}

/** The width the slowest split's bar still gets, so it reads as slow rather than as absent. */
export const MIN_PACE_BAR_PERCENT = 12

/** The speed range a splits table's pace bars are normalised against. */
export interface PaceScale {
  slowestSpeedMps: number
  fastestSpeedMps: number
}

/** A row as far as the pace scale is concerned - only its speed matters, deliberately. */
export interface PaceScaleRow {
  avgSpeedMps: number | null
}

/**
 * The range `paceBarWidthPercent` normalises a table against: the slowest
 * and fastest pace **anywhere in it**, every row taking part on equal
 * terms.
 *
 * **The range is over every row, and the lap roles are deliberately not
 * consulted.** An interval session is bimodal, so a single range spends
 * most of its span separating the reps from the recoveries and compresses
 * each cluster internally - on `6116b2e90f551a6c`, whose `rep_pattern` is
 * `-WRWRWRWRWR---`, the five reps land at 89.4, 91.9, 92.5, 92.9 and
 * 100.0%, a 10.6-point spread about as tight as the 9.9 points that were
 * reported as unreadable in the first place. That compression is inherent
 * to a bimodal table rather than a fault in the scale, and every
 * alternative measured on that same fixture is worse:
 *
 * - Scaling to the **reps alone** (tried, and reverted) puts all nine
 *   non-rep laps below the range's floor, so every one of them draws at
 *   exactly `MIN_PACE_BAR_PERCENT`: one bar width across 1.477 to
 *   2.882 m/s, with the 11:17/km walked recovery and the 5:47/km
 *   cool-down pixel-identical. It buys rep separation by destroying nine
 *   rows of fourteen.
 * - Scaling **per role group** makes a bar comparable only with the bars
 *   of its own role, which removes the one thing a single visual column
 *   is for.
 * - A **logarithmic** scale over every row gives the reps about 7 of the
 *   88 points the floor leaves, no better than linear. No single linear
 *   or log scale can spread two clusters internally at once.
 *
 * What the all-rows range does give is the session's dominant structure,
 * legibly: on that fixture all fourteen laps get a distinct width - 35.7,
 * 12.0, 100.0, 24.1, 92.5, 19.9, 92.9, 23.8, 91.9, 23.0, 89.4, 40.3, 45.8
 * and 61.7 - so the reps read near 90-100%, the recoveries near 20-24%,
 * and the warm-up and cool-down in between. That is what the Laps tab of
 * an interval session is asked: were the reps consistent, and was there a
 * recovery. The finer rep-to-rep question, 4:12 against 4:33, is answered
 * exactly by the Pace column beside it - a bar is for relative comparison
 * across the table and is not a substitute for the number.
 *
 * Only rows with a known, positive pace take part. A lap whose
 * `avg_speed_mps` is null (every lap of five of the nine real interval
 * sessions, where the watch was stopped through each recovery) would
 * otherwise drag the slow end to zero and undo the normalisation for
 * every other row.
 */
export function paceBarScale(rows: readonly PaceScaleRow[]): PaceScale {
  const speeds = rows
    .map((row) => row.avgSpeedMps)
    .filter((speed): speed is number => speed !== null && Number.isFinite(speed) && speed > 0)
  if (speeds.length === 0) return { slowestSpeedMps: 0, fastestSpeedMps: 0 }
  return { slowestSpeedMps: Math.min(...speeds), fastestSpeedMps: Math.max(...speeds) }
}
