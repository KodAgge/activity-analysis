import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMomentStore, type MomentStore } from './momentStore'
import { useReplay } from './useReplay'

/**
 * 121 moving seconds, `t = 0..120`: at 1x (120 grid seconds per real
 * second) the whole replay takes exactly 1 s, so a head read after `ms`
 * milliseconds is about `0.12 * ms`. Frames land every 16 ms under the fake
 * clock, so a head is compared within a couple of samples of that.
 */
const n = 121
const grid = {
  t: Array.from({ length: n }, (_, i) => i),
  paused: Array.from({ length: n }, () => false),
  outage: Array.from({ length: n }, () => false),
}

let store: MomentStore

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
  store = createMomentStore()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function renderReplay() {
  return renderHook(() => useReplay(grid, store))
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('useReplay', () => {
  it('starts idle, with no head and the default 120x', () => {
    const { result } = renderReplay()
    expect(result.current.status).toBe('idle')
    expect(result.current.head).toBeNull()
    expect(result.current.speed).toBe(1)
  })

  it('plays from the start and writes the head to the store', () => {
    const { result } = renderReplay()
    act(() => result.current.play())
    expect(result.current.status).toBe('playing')
    expect(result.current.head).toBe(0)
    advance(500)
    const head = result.current.head
    expect(head).not.toBeNull()
    expect(Math.abs((head ?? 0) - 60)).toBeLessThanOrEqual(2)
    expect(store.getSnapshot().replay).toBe(head)
  })

  it('finishes, restores the full line and clears the moment', () => {
    const { result } = renderReplay()
    act(() => result.current.play())
    advance(1100)
    expect(result.current.status).toBe('idle')
    expect(result.current.head).toBeNull()
    expect(store.getSnapshot().replay).toBeNull()
  })

  it('pauses and resumes from the head', () => {
    const { result } = renderReplay()
    act(() => result.current.play())
    advance(500)
    act(() => result.current.pause())
    expect(result.current.status).toBe('paused')
    const pausedAt = result.current.head
    advance(500)
    expect(result.current.head).toBe(pausedAt)
    expect(store.getSnapshot().replay).toBe(pausedAt)

    act(() => result.current.play())
    expect(result.current.status).toBe('playing')
    advance(250)
    expect(Math.abs((result.current.head ?? 0) - 90)).toBeLessThanOrEqual(3)
  })

  it('keeps the head when the speed changes mid-replay', () => {
    const { result } = renderReplay()
    act(() => result.current.play())
    advance(500)
    const before = result.current.head ?? 0
    act(() => result.current.setSpeed(2))
    expect(result.current.speed).toBe(2)
    expect(result.current.head).toBe(before)
    advance(16)
    expect(result.current.head ?? 0).toBeGreaterThanOrEqual(before)

    // The rest, about 60 samples, at 240 per second: about 250 ms.
    advance(200)
    expect(result.current.status).toBe('playing')
    advance(100)
    expect(result.current.status).toBe('idle')
  })

  it('pauses when the pointer picks a moment', () => {
    const { result } = renderReplay()
    act(() => result.current.play())
    advance(300)
    const head = result.current.head
    act(() => store.setPointer(10))
    expect(result.current.status).toBe('paused')
    expect(result.current.head).toBe(head)
    advance(300)
    expect(result.current.head).toBe(head)
    expect(store.getSnapshot().replay).toBe(head)
  })

  it('keeps playing when started with the pointer already resting on a chart', () => {
    // Replay pressed from the keyboard, the mouse left over a chart: every
    // frame's head notifies the store with the pointer set, which is not a
    // hover arriving.
    act(() => store.setPointer(10))
    const { result } = renderReplay()
    act(() => result.current.play())
    advance(300)
    expect(result.current.status).toBe('playing')
    expect(Math.abs((result.current.head ?? 0) - 36)).toBeLessThanOrEqual(2)

    // A move to another sample is still the same pointer resting there.
    act(() => store.setPointer(11))
    expect(result.current.status).toBe('playing')

    // It leaves and comes back: that is a hover, and it pauses.
    act(() => store.setPointer(null))
    act(() => store.setPointer(12))
    expect(result.current.status).toBe('paused')
  })

  it('schedules no further frame once a pause lands inside a frame', () => {
    // A store listener that sets the pointer in answer to a replay write
    // pauses the replay from inside the frame that wrote it, before that
    // frame has scheduled the next one.
    let pausedAt: number | null = null
    store.subscribe(() => {
      const { pointer, replay } = store.getSnapshot()
      if (pointer === null && replay !== null && replay >= 30) {
        pausedAt = replay
        store.setPointer(5)
      }
    })
    const { result } = renderReplay()
    act(() => result.current.play())
    advance(500)
    expect(pausedAt).not.toBeNull()
    expect(result.current.status).toBe('paused')
    expect(store.getSnapshot().replay).toBe(pausedAt)
    expect(result.current.head).toBe(pausedAt)
  })

  it('cancels its frame and clears the moment on unmount', () => {
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame')
    const { result, unmount } = renderReplay()
    act(() => result.current.play())
    advance(100)
    unmount()
    advance(500)
    expect(cancel).toHaveBeenCalled()
    expect(store.getSnapshot().replay).toBeNull()
  })

  it('restarts from the beginning after finishing', () => {
    const { result } = renderReplay()
    act(() => result.current.play())
    advance(1100)
    act(() => result.current.play())
    advance(100)
    expect(Math.abs((result.current.head ?? 0) - 12)).toBeLessThanOrEqual(2)
  })

  it('passes a stop in half a second, however long it lasted', () => {
    // Ten moving seconds, an hour paused, ten moving seconds: at 1x the
    // moving part takes 20 / 120 s and the stop half a second.
    const t = [...Array.from({ length: 11 }, (_, i) => i), 3610, ...Array.from({ length: 10 }, (_, i) => 3611 + i)]
    const paused = t.map((_, i) => i === 11)
    const outage = t.map(() => false)
    const stopped = { t, paused, outage }
    const { result } = renderHook(() => useReplay(stopped, store))
    act(() => result.current.play())
    advance(20 / 120 * 1000 + 500 - 50)
    expect(result.current.status).toBe('playing')
    advance(100)
    expect(result.current.status).toBe('idle')
  })

  it('does nothing without a grid', () => {
    const { result } = renderHook(() => useReplay(null, store))
    act(() => result.current.play())
    expect(result.current.status).toBe('idle')
    expect(store.getSnapshot().replay).toBeNull()
  })

  it('stops and clears the moment when handed a different grid', () => {
    const { result, rerender } = renderHook(({ g }) => useReplay(g, store), { initialProps: { g: grid } })
    act(() => result.current.play())
    advance(200)
    rerender({ g: { ...grid } })
    expect(result.current.status).toBe('idle')
    expect(result.current.head).toBeNull()
    expect(store.getSnapshot().replay).toBeNull()
    advance(200)
    expect(result.current.head).toBeNull()
  })
})
