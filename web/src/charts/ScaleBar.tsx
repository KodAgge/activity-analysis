import { distance, metresLabel } from '../format'
import styles from './ScaleBar.module.css'

export interface ScaleBarProps {
  /** The round distance the rule stands for. */
  metres: number
  /** The rule's length as a fraction of the panel's width. */
  fraction: number
}

/**
 * `niceRoundNumber` only ever returns 1, 2 or 5 times a power of ten, so
 * every value at or above 1000 m is already a whole number of kilometres -
 * `distance(metres, 0)` never has a fraction to round away here.
 */
function formatScaleLabel(metres: number): string {
  return metres >= 1000 ? distance(metres, 0) : metresLabel(metres)
}

/**
 * The scale bar, as an overlay in the *panel's* coordinates: a label and a
 * rule whose width is `fraction` of the panel. The panel has to be the
 * nearest positioned ancestor and set `--route-inset`, which both `Route`
 * and `RouteMap` do.
 *
 * Shared because the two panels state their scale from different geometry
 * - `Route` from its own viewBox, `RouteMap` from the map's metres per
 * pixel - and must still draw it identically.
 */
export function ScaleBar({ metres, fraction }: ScaleBarProps) {
  return (
    <div className={styles.scale} data-testid="scale-bar">
      <span className={styles.scaleLabel}>{formatScaleLabel(metres)}</span>
      <span
        className={styles.scaleBar}
        data-testid="scale-bar-rule"
        style={{ width: `${String(100 * fraction)}%` }}
      />
    </div>
  )
}
