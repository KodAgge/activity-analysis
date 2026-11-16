import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // MapLibre starts its worker with `type: 'module'`, so workers are built
  // as ES modules to match. The default `iife` also loads on Vite 8.2.2,
  // measured 2026-09-24, by inlining the worker's import of MapLibre's
  // shared chunk. See `ensureGlobals` in `src/charts/RouteMap.tsx`.
  worker: { format: 'es' },
  build: {
    // The lazy `RouteMap` chunk carries MapLibre, 1075 kB minified, and its
    // worker 509 kB (measured at maplibre-gl 6.11.1). Both load only when a
    // covered route is first shown, so their size is deliberate, and the
    // default 500 kB limit would warn about them on every build.
    chunkSizeWarningLimit: 1200,
  },
  server: {
    // The API is read-only and bound to loopback. Proxying keeps the browser
    // on one origin, so there is no CORS configuration on the Python side.
    // `ACTIVITY_ANALYSIS_API_URL` points it elsewhere: the end-to-end suite
    // sets it to its own API server (see `tests/e2eServers.ts`).
    proxy: { '/api': process.env.ACTIVITY_ANALYSIS_API_URL ?? 'http://127.0.0.1:8000' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // The first test in a file pays for that file's cold imports. Measured
    // 2026-10-16 on 16 workers: ActivityDetail's and AppShell's first tests
    // take about 0.4 s run alone and passed the 5 s default in two full runs
    // of 1374 tests, each time a different file's.
    testTimeout: 20_000,
    // Half the cores, not Vitest's default of one worker per core. Measured
    // 2026-11-16 on 16 cores and 7 GB of memory, 1940 tests: at the default
    // the jsdom workers starve each other, a Plan test that takes 1.2 s alone
    // took 24 s and failed the timeout above, and 3 tests failed in one of
    // two runs; at 8 workers the slowest test took 1.8 s and the suite took
    // 39 s rather than 87 s.
    maxWorkers: '50%',
    // Every unit and component test in this project is named `*.test.ts(x)`
    // under `src/`. Vitest's own default `include` also matches `*.spec.ts`,
    // which is exactly what `tests/smoke.spec.ts` (Playwright's end-to-end
    // suite, run by `npm run test:e2e`, never by Vitest) is named, and
    // Playwright's `test()` throws when a runner other than its own calls
    // it. Naming the pattern this project actually uses, rather than
    // carving out an exclusion for the one file that collides with the
    // default, is what keeps a future `tests/*.test.ts` from silently
    // falling into the same trap.
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
