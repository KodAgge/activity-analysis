import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Where the end-to-end suite's two servers listen and which store the API
 * serves, shared by `playwright.config.ts` and `preconditions.setup.ts` so
 * the check and the thing it checks cannot name different ones.
 *
 * The ports are not the development defaults, 8000 and 5173, so the suite
 * runs beside a developer's own `serve` and `npm run dev` rather than
 * adopting them through `reuseExistingServer`: those serve whatever store
 * the developer pointed them at, and this suite asserts the committed
 * fixtures' values. `E2E_API_PORT` and `E2E_WEB_PORT` move them when these
 * two are taken.
 */
export const API_PORT = Number(process.env.E2E_API_PORT ?? 8100)
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5180)

export const API_ORIGIN = `http://127.0.0.1:${String(API_PORT)}`
export const WEB_ORIGIN = `http://localhost:${String(WEB_PORT)}`

/**
 * The Python project root, resolved from this file rather than from the
 * process's working directory.
 *
 * `execFileSync`'s `cwd` is resolved against `process.cwd()`, so a relative
 * path would depend on where Playwright was started: a `cwd: '..'` run from
 * the repository root as `npx playwright test -c web/playwright.config.ts`
 * pointed at the repository's parent, `uv run` found no project, and the
 * check died with a raw spawn error instead of the message that is its
 * whole reason to exist.
 */
export const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The store `scripts/e2e-api-server.mjs` ingests `data/examples` into and
 * serves: one directory per checkout under the OS temporary directory.
 *
 * Not under `web/test-results/`, which Playwright empties at the start of
 * every run - under a reused server that would delete the store it is
 * serving. Keyed by the checkout's path, so two checkouts never rebuild
 * each other's store, and so a server reused from another checkout fails
 * the precondition's root check rather than passing it.
 */
export const STORE_ROOT = join(
  tmpdir(),
  `activity-analysis-e2e-${createHash('sha256').update(PROJECT_ROOT).digest('hex').slice(0, 12)}`,
)
