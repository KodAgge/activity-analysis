import { cleanup, configure } from '@testing-library/react'
import { afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'

// How long a `findBy*` or `waitFor` waits before failing: 4 s rather than
// Testing Library's default 1 s. The first test in a view file pays that
// file's cold render - the real route tree, the query client, the lazy
// modules - and with Vitest running one jsdom worker per core that render
// crossed 1 s often enough to fail a different first test on most full runs
// (measured 2026-09-25: 1 to 3 failures in five of seven runs, always a
// file's first test, each `Unable to find` at the 1 s mark). A passing wait
// returns the moment its element appears, so this costs a green suite
// nothing; it stays under Vitest's 5 s test timeout so a real failure still
// reports as Testing Library's message rather than as a bare timeout.
configure({ asyncUtilTimeout: 4000 })

// Vite's test config does not set `test.globals: true`, so React Testing
// Library's automatic cleanup - which detects a global `afterEach` - never
// registers on its own. Without this, every test's rendered tree stays in
// the document after the test ends, so later tests silently query a `body`
// holding several stacked copies of the app and every `getByRole`/`getByText`
// throws on the ambiguity rather than testing what that test wrote.
afterEach(() => {
  cleanup()
})

// jsdom does not implement `matchMedia` at all - not even as a stub that
// warns - so any test that pulls in the real `uplot` package (rather than
// mocking it, as the chart tests do) fails at import time: uPlot's own
// module calls `matchMedia()` unconditionally the moment it loads, to pick
// up the device pixel ratio, before any chart is ever constructed. A route
// or view test that renders the real component tree - `router.test.tsx`
// exercising the real route tree is the case that first hit this - has no
// chart to mock and no reason to know one is reachable underneath it, so
// the polyfill belongs here rather than in each such test file.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
}

// jsdom implements `window.scrollTo` only as a "Not implemented" console
// error, and TanStack Router calls it on every navigation to reset the
// scroll position - 145 such lines in a run of the view and router tests,
// burying any real warning among them. Nothing here scrolls, so a no-op is
// the whole behaviour a test needs.
window.scrollTo = () => {}
