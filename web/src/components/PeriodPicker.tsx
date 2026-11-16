import {
  customBoundChange,
  inclusiveLastDay,
  periodLabel,
  type CustomBounds,
  type Period,
} from '../api/period'
import styles from './PeriodPicker.module.css'

export interface PeriodPickerProps {
  /** Names the group and its select: `Period`, `Against`. */
  label: string
  period: Period
  bounds: CustomBounds
  /** Every year holding a run, ascending. */
  years: readonly number[]
  onPeriod: (period: Period) => void
  onBounds: (bounds: CustomBounds) => void
}

/**
 * A period select - the presets, one option per year holding a run, newest
 * first, and a custom range - with the custom range's two dates beside it.
 * `/distributions` renders it for `period` and `vs`, `/trends` for its own
 * `period`; `api/period.ts` owns what each option means.
 *
 * The URL's `to` is exclusive and the "To" input is not: it shows and
 * takes the last day the range includes, and `customBoundChange` stores the
 * day after it.
 */
export function PeriodPicker({ label, period, bounds, years, onPeriod, onBounds }: PeriodPickerProps) {
  const presets: Period[] = ['all', 'last_12_months', 'previous_12_months']
  const yearPeriods = [...years].reverse().map((year): Period => `year_${year}`)
  // A URL naming a year no run is in still gets its option, or the select
  // and the address bar would disagree about what is shown.
  const options = [...presets, ...yearPeriods]
  if (period !== 'custom' && !options.includes(period)) options.push(period)
  options.push('custom')

  return (
    <div className={styles.picker} role="group" aria-label={label}>
      <label className={styles.field}>
        {label}
        <select value={period} onChange={(event) => onPeriod(event.target.value as Period)}>
          {options.map((option) => (
            <option key={option} value={option}>
              {option === 'custom' ? 'Custom range' : periodLabel(option, undefined, undefined)}
            </option>
          ))}
        </select>
      </label>
      {period === 'custom' && (
        <>
          <label className={styles.field}>
            From
            <input
              type="date"
              value={bounds.from ?? ''}
              onChange={(event) => onBounds(customBoundChange(bounds, 'from', event.target.value))}
            />
          </label>
          <label className={styles.field}>
            To
            <input
              type="date"
              value={bounds.to === undefined ? '' : inclusiveLastDay(bounds.to)}
              onChange={(event) => onBounds(customBoundChange(bounds, 'lastDay', event.target.value))}
            />
          </label>
        </>
      )}
    </div>
  )
}
