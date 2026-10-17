import { useId } from 'react'
import styles from './RangeFilter.module.css'

export interface RangeFilterProps {
  /** Names the control and both its handles: `Distance`, `Moving time`. */
  label: string
  /** The bottom stop, in the reader's own unit. */
  min: number
  /** The top stop, in the reader's own unit. It means "and above" - see the module doc. */
  max: number
  /** How far one press of an arrow key, or one notch of a drag, moves a handle. */
  step: number
  /**
   * The bounds as they currently stand, in the reader's own unit.
   * `undefined` at the top is no upper bound at all, which is what the top
   * stop reports.
   */
  value: [number, number | undefined]
  onChange: (next: [number, number | undefined]) => void
  /** One bound as the readout shows it, unit included: `12 km`, `45 min`. */
  formatValue: (value: number) => string
  /** What the top stop reads as, rather than a number: `20 km+`, `2h+`. */
  topLabel: string
}

/** About this many tick marks, whatever the range: enough to locate a handle, few enough to see. */
const TARGET_TICKS = 6

/** Tick positions from `min` to `max` on the step grid, always including both stops. */
function tickValues(min: number, max: number, step: number): number[] {
  const steps = Math.max(1, Math.round((max - min) / step))
  const stride = Math.max(1, Math.round(steps / (TARGET_TICKS - 1)))
  const ticks: number[] = []
  for (let i = 0; i <= steps; i += stride) ticks.push(min + i * step)
  if (ticks.at(-1) !== max) ticks.push(max)
  return ticks
}

/**
 * A two-handled range for one numeric filter, replacing a pair of numeric
 * boxes.
 *
 * **The top stop means "and above", not `max`.** Six of the 307 real runs
 * are longer than 20 km and eight are longer than 2 hours, the longest 27%
 * past the distance stop and 45% past the duration one, so a slider that capped at its top stop would
 * hide real runs from a reader who had asked for none to be hidden. A
 * handle at the stop therefore reports `undefined` and removes the bound,
 * which is the same rule the boxes this replaces already followed, where an
 * empty box is `undefined` and not zero. The stop is labelled `20 km+` so
 * the behaviour is visible rather than inferred.
 *
 * The bottom stop is deliberately *not* symmetric with it. `0 km` is a true
 * statement about the bottom of the range, and a filter of "at least 0 km"
 * is a no-op rather than a misdescription; `20 km` at the top would be a
 * false ceiling. Whether a bottom bound of `min` is worth putting in the
 * URL at all is the caller's decision, since only the caller knows what the
 * key means when it is absent.
 *
 * **Two native inputs, not a package.** A two-handled range is two
 * `<input type="range">` elements over one track, and the ticks are what a
 * `<datalist>` already draws. Each handle carries its own `aria-label`, so
 * a screen reader hears which end it is on, and each is clamped against the
 * other so they cannot cross and invert the filter.
 *
 * This renders the reader's unit and reports the reader's unit. The SI
 * conversion stays where it already is, at `views/Activities.tsx`'s own
 * boundary, so a shared link and an API request still say the same thing.
 */
export function RangeFilter({
  label,
  min,
  max,
  step,
  value,
  onChange,
  formatValue,
  topLabel,
}: RangeFilterProps) {
  const ticksId = useId()
  const [low, high] = value
  // An absent upper bound sits the handle at the stop, which is where the
  // reader put it to remove the bound in the first place.
  //
  // A bound from outside the slider's own range is reachable - a
  // hand-edited URL, or a link shared before a stop moved - and the handle
  // is clamped to the track for it. The *readout* is not: it keeps saying
  // what the filter actually is, because a control that silently renamed a
  // 999 km floor as 20 km would leave a reader staring at an empty table
  // with no way to see why.
  const clamp = (v: number) => Math.min(Math.max(v, min), max)
  const highHandle = clamp(high ?? max)
  const lowHandle = clamp(low)

  function commitLow(next: number) {
    // Clamped against the other handle rather than pushing it: the handle
    // the reader is dragging is the one they are thinking about. The other
    // bound is passed through untouched, so an upper bound the reader
    // removed is not quietly reimposed by a drag on the lower handle.
    onChange([Math.min(next, highHandle), high])
  }

  function commitHigh(next: number) {
    // `low` rather than `lowHandle`, mirroring `commitLow`: the bound the
    // reader is not dragging passes through exactly as it stood. A lower
    // bound from outside the track - a hand-edited URL, or a link shared
    // before a stop moved - has a handle clamped to `max`, and handing that
    // clamped position back would rewrite a 999 km floor as 20 km on the
    // first drag of the other handle, silently replacing the filter with
    // one nobody asked for. The clamp still decides where *this* handle may
    // go, so the two cannot cross and invert the filter.
    const clamped = Math.max(next, lowHandle)
    onChange([low, clamped >= max ? undefined : clamped])
  }

  const lowPercent = ((lowHandle - min) / (max - min)) * 100
  const highPercent = ((highHandle - min) / (max - min)) * 100

  // Which thumb wins a press where the two coincide. The inputs are stacked
  // over one track, so without this the later one in DOM order - the
  // maximum - takes every press, and the minimum is unreachable by pointer
  // wherever they sit together.
  //
  // Coinciding is usually recoverable: the maximum is the one on top, and
  // dragging it away uncovers the minimum. At the top stop it is not. There
  // the upper bound is absent, so `highHandle` is `max`, `commitLow` lets
  // the minimum reach it, and the maximum has nowhere further right to go -
  // every press lands on an input whose own clamp re-reports the bound it
  // already has. The filter reads "20 km to 20 km+" and a pointer cannot
  // change it; only Tab and the arrow keys recover, which is the same
  // half-broken the `pointer-events` rule in the stylesheet exists to
  // prevent. So the minimum comes to the front exactly there, where it is
  // the only handle with room to move.
  const lowOnTop = lowHandle >= max

  return (
    <div className={styles.filter} role="group" aria-label={label}>
      <span className={styles.label}>{label}</span>
      <output className={styles.readout}>
        {formatValue(low)} to {high === undefined ? topLabel : formatValue(high)}
      </output>

      <div className={styles.track}>
        <span
          aria-hidden="true"
          className={styles.selected}
          style={{ left: `${String(lowPercent)}%`, right: `${String(100 - highPercent)}%` }}
        />
        <input
          type="range"
          className={styles.handle}
          aria-label={`${label}, minimum`}
          style={{ zIndex: lowOnTop ? 2 : 1 }}
          min={min}
          max={max}
          step={step}
          list={ticksId}
          value={lowHandle}
          onChange={(event) => {
            commitLow(Number(event.target.value))
          }}
        />
        <input
          type="range"
          className={styles.handle}
          aria-label={`${label}, maximum`}
          style={{ zIndex: lowOnTop ? 1 : 2 }}
          min={min}
          max={max}
          step={step}
          list={ticksId}
          value={highHandle}
          onChange={(event) => {
            commitHigh(Number(event.target.value))
          }}
        />
      </div>

      <datalist id={ticksId}>
        {tickValues(min, max, step).map((tick) => (
          <option key={tick} value={tick} />
        ))}
      </datalist>
    </div>
  )
}
