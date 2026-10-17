import { REPLAY_SPEEDS, speedupLabel } from '../charts/replayTimeline'
import type { Replay } from '../moment/useReplay'
import styles from './ReplayControls.module.css'

/**
 * The replay's button and its speed switch, over one of the route hero's
 * bottom corners - `side`, the one away from the route's start (see
 * `routeMath.ts`'s `replayControlsSide`). The switch shows only while a replay is playing or paused, to keep the
 * map quiet otherwise. The button keeps the corner and the switch opens
 * beside it, towards the middle, in reading order either way.
 */
export function ReplayControls({ replay, side = 'right' }: { replay: Replay; side?: 'left' | 'right' }) {
  const playing = replay.status === 'playing'
  const label = playing ? 'Pause' : replay.status === 'paused' ? 'Resume' : 'Replay'
  const speedSwitch = replay.status !== 'idle' && (
    <div className={styles.switch} role="radiogroup" aria-label="Replay speed">
      {REPLAY_SPEEDS.map((s) => (
        <label key={s} className={styles.segment}>
          <input
            type="radio"
            name="replay-speed"
            value={s}
            checked={replay.speed === s}
            onChange={() => replay.setSpeed(s)}
          />
          <span>{speedupLabel(s)}</span>
        </label>
      ))}
    </div>
  )
  const button = (
    <button type="button" className={styles.button} onClick={playing ? replay.pause : replay.play}>
      <svg className={styles.icon} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        {playing ? <path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" /> : <path d="M3 1.2 10.5 6 3 10.8z" />}
      </svg>
      <span>{label}</span>
    </button>
  )
  // Each child keeps its own slot as the switch comes and goes, so the
  // button is the same element throughout and keeps focus across a press.
  return (
    <div className={`${styles.controls} ${side === 'left' ? styles.left : styles.right}`} data-side={side}>
      {side === 'left' ? button : speedSwitch}
      {side === 'left' ? speedSwitch : button}
    </div>
  )
}
