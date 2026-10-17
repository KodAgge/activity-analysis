import { createContext } from 'react'

/**
 * The moment in a run the activity view is showing: an index into the run's
 * 1 Hz grid, from the pointer over a chart or from a replay, or none. See
 * docs/reference/frontend.md, "The moment".
 *
 * An external store rather than React state on the view, so a pointer move
 * re-renders only the components that read it - the four stream panels and
 * the route hero - and not the splits table and zone bar beside them.
 */
export interface MomentState {
  pointer: number | null
  replay: number | null
}

export interface MomentStore {
  getSnapshot(): MomentState
  subscribe(listener: () => void): () => void
  setPointer(index: number | null): void
  setReplay(index: number | null): void
}

const EMPTY: MomentState = { pointer: null, replay: null }

export function createMomentStore(): MomentStore {
  let state = EMPTY
  const listeners = new Set<() => void>()
  const update = (next: MomentState) => {
    if (next.pointer === state.pointer && next.replay === state.replay) return
    state = next
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setPointer: (index) => update({ ...state, pointer: index }),
    setReplay: (index) => update({ ...state, replay: index }),
  }
}

/** The pointer wins: hovering a chart during a paused replay shows the hovered second. */
export function currentMoment(state: MomentState): number | null {
  return state.pointer ?? state.replay
}

export const MomentContext = createContext<MomentStore | null>(null)

export const EMPTY_MOMENT = EMPTY
