import { useState, type ReactNode } from 'react'
import { createMomentStore, MomentContext } from './momentStore'

/** One store per mounted activity view; a new activity is a new mount, so a new store. */
export function MomentProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createMomentStore)
  return <MomentContext.Provider value={store}>{children}</MomentContext.Provider>
}
