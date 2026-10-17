/**
 * The replay's clock: when, in real seconds after pressing Replay, each grid
 * sample is reached. See docs/reference/frontend.md, "Replay".
 *
 * A moving second takes 1 / (120 * speed) s. A paused or outage stretch
 * takes STOP_REPLAY_S in total whatever its length, so an hour-long stop
 * takes half a second instead of 30 s at 120x.
 */

export const BASE_SPEEDUP = 120
export const REPLAY_SPEEDS = [0.5, 1, 2] as const
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number]
export const STOP_REPLAY_S = 0.5

export interface Timeline {
  /** Moving grid seconds elapsed at each sample. */
  moving: number[]
  /** Stops passed at each sample, fractional inside a stop. */
  stops: number[]
}

export function isStopped(paused: (boolean | null)[], outage: (boolean | null)[], i: number): boolean {
  return paused[i] === true || outage[i] === true
}

/**
 * The interval arriving at sample i belongs to a stop when sample i is
 * stopped. A stretch of L stopped samples owns L such intervals and each
 * counts 1 / L of a stop, so the stretch is one stop in total. A stretch
 * starting at sample 0 has no interval into its first sample and counts a
 * little under one; harmless, and it keeps the clock at 0 at the start.
 */
export function buildTimeline(t: number[], paused: (boolean | null)[], outage: (boolean | null)[]): Timeline {
  const n = t.length
  const stretchLength = new Array<number>(n).fill(0)
  for (let i = 0; i < n; ) {
    if (!isStopped(paused, outage, i)) {
      i++
      continue
    }
    let j = i
    while (j < n && isStopped(paused, outage, j)) j++
    for (let k = i; k < j; k++) stretchLength[k] = j - i
    i = j
  }
  const moving = new Array<number>(n).fill(0)
  const stops = new Array<number>(n).fill(0)
  for (let i = 1; i < n; i++) {
    const length = stretchLength[i] ?? 0
    moving[i] = (moving[i - 1] ?? 0) + (length > 0 ? 0 : (t[i] ?? 0) - (t[i - 1] ?? 0))
    stops[i] = (stops[i - 1] ?? 0) + (length > 0 ? 1 / length : 0)
  }
  return { moving, stops }
}

export function replayTimes(timeline: Timeline, speed: ReplaySpeed): number[] {
  return timeline.moving.map((m, i) => m / (BASE_SPEEDUP * speed) + (timeline.stops[i] ?? 0) * STOP_REPLAY_S)
}

/** The last sample reached by replay time `tau`: binary search on a non-decreasing array. */
export function headAt(times: number[], tau: number): number {
  let lo = 0
  let hi = times.length - 1
  if (hi < 0) return 0
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if ((times[mid] ?? Infinity) <= tau) lo = mid
    else hi = mid - 1
  }
  return lo
}

export function speedupLabel(speed: ReplaySpeed): string {
  return `${String(BASE_SPEEDUP * speed)}x`
}
