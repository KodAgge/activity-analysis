import type { PaceEnds } from '../charts/paceColour'
import { pace } from '../format'
import styles from './PaceLegend.module.css'

export interface PaceLegendProps {
  ends: PaceEnds
  palette: string[]
}

/**
 * The route hero's own legend: the ramp and the run's two ends, slow on
 * the left - see docs/reference/frontend.md, "The route is coloured by
 * pace".
 *
 * A `<figure>` rather than something `aria-hidden`: unlike the moment
 * readouts, which change on every pointer move and so are deliberately
 * unannounced (see `VolumeBars`), this is static information that does not
 * change while the reader looks at it, so it is exposed like any other
 * content.
 *
 * Positioned by its caller, `RouteHero`, which is where the decision of
 * whether a map style switch sits above it lives.
 */
export function PaceLegend({ ends, palette }: PaceLegendProps) {
  return (
    <figure className={styles.legend} data-testid="pace-legend">
      <figcaption className={styles.caption}>Pace</figcaption>
      <div className={styles.bar} style={{ background: `linear-gradient(in oklab to right, ${palette.join(', ')})` }} />
      <div className={styles.ends}>
        <span>{pace(ends.slow)}</span>
        <span>{pace(ends.fast)}</span>
      </div>
    </figure>
  )
}
