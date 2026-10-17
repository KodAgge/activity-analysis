import { renderHook, act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createMomentStore, currentMoment } from './momentStore'
import { MomentProvider } from './MomentProvider'
import { useMomentState, useMomentStore } from './useMoment'

describe('the moment store', () => {
  it('starts empty', () => {
    expect(createMomentStore().getSnapshot()).toEqual({ pointer: null, replay: null })
  })

  it('prefers the pointer over the replay, and falls back when the pointer leaves', () => {
    const store = createMomentStore()
    store.setReplay(40)
    expect(currentMoment(store.getSnapshot())).toBe(40)
    store.setPointer(7)
    expect(currentMoment(store.getSnapshot())).toBe(7)
    store.setPointer(null)
    expect(currentMoment(store.getSnapshot())).toBe(40)
  })

  it('notifies subscribers on a change and not on a repeat', () => {
    const store = createMomentStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.setPointer(3)
    store.setPointer(3)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    store.setPointer(4)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('hands out a new snapshot object on every change, as useSyncExternalStore requires', () => {
    const store = createMomentStore()
    const before = store.getSnapshot()
    store.setReplay(1)
    expect(store.getSnapshot()).not.toBe(before)
  })
})

describe('the useMomentState hook', () => {
  it('returns the empty state outside a provider', () => {
    const { result } = renderHook(() => useMomentState())
    expect(result.current).toEqual({ pointer: null, replay: null })
  })

  it('re-renders when the moment state changes inside a provider', () => {
    const { result } = renderHook(() => ({ store: useMomentStore(), state: useMomentState() }), {
      wrapper: MomentProvider,
    })

    const store = result.current.store
    if (store === null) throw new Error('store is null inside provider')

    act(() => {
      store.setPointer(5)
    })

    expect(result.current.state.pointer).toBe(5)
  })
})
