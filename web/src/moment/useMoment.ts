import { useContext, useSyncExternalStore } from 'react'
import { EMPTY_MOMENT, MomentContext, type MomentState, type MomentStore } from './momentStore'

const noSubscribe = () => () => {}
const empty = () => EMPTY_MOMENT

export function useMomentStore(): MomentStore | null {
  return useContext(MomentContext)
}

/** The current moment state, or the empty one where no activity view provides a store. */
export function useMomentState(): MomentState {
  const store = useMomentStore()
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getSnapshot ?? empty)
}
