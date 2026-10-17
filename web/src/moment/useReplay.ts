import { useEffect, useMemo, useRef, useState } from 'react'
import { buildTimeline, headAt, REPLAY_SPEEDS, replayTimes, type ReplaySpeed } from '../charts/replayTimeline'
import type { MomentStore } from './momentStore'

export type ReplayStatus = 'idle' | 'playing' | 'paused'

export interface Replay {
  status: ReplayStatus
  /** The grid sample the replay has reached, or null while idle. */
  head: number | null
  speed: ReplaySpeed
  /** Start from the beginning when idle, continue from the head when paused. */
  play(): void
  pause(): void
  setSpeed(speed: ReplaySpeed): void
}

function cancelFrame(frameRef: { current: number | null }) {
  if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
  frameRef.current = null
}

export interface ReplayGrid {
  t: number[]
  paused: (boolean | null)[]
  outage: (boolean | null)[]
}

/**
 * The replay's clock and controls. See docs/reference/frontend.md, "Replay".
 *
 * A frame reads the wall clock, turns it into replay time since the start
 * and finds the head on `replayTimes` by binary search, so a dropped frame
 * skips samples rather than slowing the replay down. The head is written to
 * the moment store as `replay`, which is what moves the stream panels'
 * cursors and the dot; hovering a chart sets `pointer`, which wins over it
 * and pauses the replay at the head.
 *
 * `grid` must keep its identity across renders: a new one is a new run,
 * and stops the replay.
 */
export function useReplay(grid: ReplayGrid | null, store: MomentStore | null): Replay {
  const timeline = useMemo(() => grid && buildTimeline(grid.t, grid.paused, grid.outage), [grid])
  // Every speed's clock at once, so a speed change can re-base on the new
  // clock's time at the head without building it twice.
  const timesBySpeed = useMemo(
    () => timeline && new Map(REPLAY_SPEEDS.map((s) => [s, replayTimes(timeline, s)] as const)),
    [timeline],
  )
  const [speed, setSpeedState] = useState<ReplaySpeed>(1)
  const times = timesBySpeed?.get(speed) ?? null
  const [status, setStatus] = useState<ReplayStatus>('idle')
  const [head, setHead] = useState<number | null>(null)
  // The `performance.now()` at which replay time 0 would have been.
  const startRef = useRef(0)
  const frameRef = useRef<number | null>(null)
  // Set by the pointer listener below when it pauses the replay, which it
  // can do from inside a frame: the frame's own `setReplay` notifies every
  // store listener synchronously, so a pause can land before the frame has
  // scheduled its successor, and cancelling `frameRef` then cancels
  // nothing. The frame reads this before it schedules another.
  const haltedRef = useRef(false)

  // A different run: adjusted during render, React's pattern for state that
  // follows a prop, so the old run's head never reaches the new run's map.
  const [shownGrid, setShownGrid] = useState(grid)
  if (shownGrid !== grid) {
    setShownGrid(grid)
    setStatus('idle')
    setHead(null)
  }

  // The frame loop, for as long as the replay plays. A speed change hands
  // it a new clock, and it restarts on it from the re-based start.
  useEffect(() => {
    if (status !== 'playing' || times === null) return undefined
    const end = times.at(-1) ?? 0
    haltedRef.current = false
    const tick = () => {
      const tau = (performance.now() - startRef.current) / 1000
      if (tau >= end) {
        frameRef.current = null
        setStatus('idle')
        setHead(null)
        store?.setReplay(null)
        return
      }
      const next = headAt(times, tau)
      setHead(next)
      store?.setReplay(next)
      if (haltedRef.current) {
        frameRef.current = null
        return
      }
      frameRef.current = requestAnimationFrame(tick)
    }
    frameRef.current = requestAnimationFrame(tick)
    return () => cancelFrame(frameRef)
  }, [status, times, store])

  // Hovering a chart pauses the replay at its head: a pointer arriving, not
  // one already there. A replay started from the keyboard with the mouse
  // resting on a chart would otherwise pause on its first frame, since
  // every frame's `setReplay` notifies this listener with the pointer set.
  useEffect(() => {
    if (store === null || status !== 'playing') return undefined
    let previous = store.getSnapshot().pointer
    return store.subscribe(() => {
      const pointer = store.getSnapshot().pointer
      const arrived = previous === null && pointer !== null
      previous = pointer
      if (!arrived) return
      haltedRef.current = true
      cancelFrame(frameRef)
      setStatus('paused')
    })
  }, [store, status])

  // The moment belongs to this run's replay: gone with the run or the view.
  useEffect(() => () => store?.setReplay(null), [grid, store])

  const play = () => {
    if (times === null || status === 'playing') return
    const from = status === 'paused' && head !== null ? head : 0
    startRef.current = performance.now() - (times[from] ?? 0) * 1000
    setHead(from)
    store?.setReplay(from)
    setStatus('playing')
  }

  const pause = () => {
    if (status !== 'playing') return
    // Cancelled here, not only by the loop's cleanup, which runs after the
    // next paint and would let one more frame move the head.
    cancelFrame(frameRef)
    setStatus('paused')
  }

  const setSpeed = (next: ReplaySpeed) => {
    if (next === speed) return
    const nextTimes = timesBySpeed?.get(next)
    if (status === 'playing' && head !== null && nextTimes !== undefined) {
      // The old clock's pending frame must not read the new start.
      cancelFrame(frameRef)
      startRef.current = performance.now() - (nextTimes[head] ?? 0) * 1000
    }
    setSpeedState(next)
  }

  return { status, head, speed, play, pause, setSpeed }
}
