import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { router } from './router'
import './theme/tokens.css'
import './theme/global.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Every endpoint in this API reads the store the server built at
      // startup and holds for its entire process lifetime (see
      // docs/reference/api.md, "Connection model"): a `recompute` running
      // underneath it is invisible until the server itself restarts. None
      // of these responses can change while a tab is open, so there is no
      // duration at which "stale" would mean anything for them - Infinity
      // is the honest value here, not an arbitrarily long one. A restart is
      // picked up on the next full page load regardless, which discards
      // this whole cache, so a shorter staleTime would only buy wasted
      // refetches of data guaranteed identical - most visibly
      // `refetchOnWindowFocus` re-running `/api/health`'s 136 ms query (it
      // counts 1.46 million rows) every time the tab regains focus.
      staleTime: Infinity,
      // The default of 3 retries at 1s/2s/4s leaves the shell blank for
      // about 7s with the backend down, for an app whose only backend is a
      // process on the same machine (see docs/reference/api.md, "The
      // contract" - there is no authentication and no network in between).
      // One retry still tolerates a single dropped request without making a
      // stopped server look this slow to notice.
      retry: 1,
    },
  },
})

const rootElement = document.getElementById('root')
if (rootElement === null) {
  throw new Error("index.html is missing the '#root' element the app mounts into.")
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
