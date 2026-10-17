import { defineConfig, devices } from '@playwright/test'
import { API_ORIGIN, API_PORT, STORE_ROOT, WEB_ORIGIN, WEB_PORT } from './tests/e2eServers'

/**
 * The end-to-end suite runs against the real thing: the real API server and
 * the real Vite dev server in front of it, over a store ingested from the
 * committed fixtures, `data/examples`. `webServer` below builds that store
 * and starts both servers, so `npm run test:e2e` from `web/` is the entire
 * command; nothing has to be running first, and every contributor's run
 * asserts the same five runs (see `docs/reference/test-fixtures.md`).
 *
 * The few things those five runs cannot show - a recurring route, which
 * takes several runs of one loop - are answered with `page.route` from
 * synthetic data in the test file that needs them; see `tests/syntheticRoute.ts`.
 *
 * `chromium` is the only browser project. Firefox and WebKit are not
 * installed in this environment and installing them is out of scope here -
 * see the note in `tests/smoke.spec.ts` on the one browser this suite has
 * ever been asked to run against. The `preconditions` project alongside it
 * runs no browser; it guards the `reuseExistingServer` setting below.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',

  use: {
    baseURL: WEB_ORIGIN,
    trace: 'on-first-retry',
  },

  projects: [
    // Checks that the servers `reuseExistingServer` may have adopted are
    // serving this checkout's code over the fixture store, and skips the
    // suite rather than letting it fail test by test over it. See
    // tests/preconditions.setup.ts.
    {
      name: 'preconditions',
      testMatch: /preconditions\.setup\.ts$/,
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['preconditions'],
    },
  ],

  webServer: [
    {
      // Deletes and re-ingests the fixture store, then serves it; see the
      // script's header. Run from `web/`, and the script steps up to the
      // pyproject itself, because `uv run` resolves the project and its
      // `.venv` from the current directory.
      command: `node scripts/e2e-api-server.mjs "${STORE_ROOT}" ${String(API_PORT)}`,
      url: `${API_ORIGIN}/api/health`,
      reuseExistingServer: !process.env.CI,
      // `uv run` does a `uv sync` first if the environment is not already
      // up to date, which can take a while on a cold `.venv` - a plain
      // request timeout here reads as a hung server rather than a slow
      // dependency install. See docs/reference/api.md's own startup cost
      // note for why `/api/health` (rather than `/`) is the readiness URL:
      // it is the one endpoint that touches every table, so a 200 from it
      // means the store's views are actually built, not just that the
      // process has bound the port.
      timeout: 180_000,
    },
    {
      // `vite.config.ts` proxies `/api` to the URL in this variable, here
      // the API server above rather than the development one on :8000.
      command: `npx vite --port ${String(WEB_PORT)} --strictPort`,
      url: WEB_ORIGIN,
      env: { ACTIVITY_ANALYSIS_API_URL: API_ORIGIN },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
})
