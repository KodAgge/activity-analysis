import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, test as setup } from '@playwright/test'
import { API_ORIGIN, PROJECT_ROOT, STORE_ROOT, WEB_ORIGIN } from './e2eServers'

/**
 * Preconditions for the end-to-end suite: the API answering on
 * `API_ORIGIN` must be serving *this* checkout's code, and the dev server
 * answering on `WEB_ORIGIN` must be putting it in front of the fixture
 * store `scripts/e2e-api-server.mjs` built, not some other store.
 *
 * ## The failure this exists to stop
 *
 * `playwright.config.ts` starts both servers with `reuseExistingServer` on
 * outside CI, which is the right default - restarting a server whose
 * readiness check touches every table costs real seconds, and a human
 * working in `web/` often already has one running. But "reuse" is decided
 * purely by whether something answers on the port. A server left running
 * from an earlier branch answers just as readily as a current one, and then
 * every assertion about a feature that branch did not have fails for a
 * reason that has nothing to do with the code under test.
 *
 * That happened on 2026-09-04, and it is worth recording what it looked
 * like, because the output pointed everywhere except at the cause: 21 of
 * 27 tests failed, on selectors, on canvas pixels, on the URL - the whole
 * frontend appearing broken at once - because a server started hours
 * earlier from the previous branch had no `/api/records` and none of the
 * new query parameters. Six tests passed, which is what makes it
 * expensive: a wholly dead server would have been obvious in seconds.
 *
 * A server over the wrong store fails the same way, and since the suite
 * moved onto the fixture store that is the likelier of the two: a
 * developer's own `serve` over their real store, on the suite's port, would
 * pass the code check below and then fail every test that pins a fixture
 * value. So the second check asks the dev server, through its own `/api`
 * proxy, which store is behind it - which also catches a dev server whose
 * proxy points at some other API than the one checked here.
 *
 * ## Why a setup project rather than `globalSetup`
 *
 * `globalSetup`'s ordering against `webServer` is not something this
 * suite should depend on, and the check has to run *after* whichever
 * server is going to be used is up. A setup project runs like any other
 * test, so the server is guaranteed available; and because `chromium`
 * declares it in `dependencies`, a failure here reports one clear failure
 * and skips the rest, rather than 21 misleading ones.
 *
 * ## Why the whole document, and why `uv`
 *
 * The comparison is the API's entire OpenAPI document, live against the
 * one the current source produces. Measured 2026-09-04: the two are
 * byte-identical once keys are sorted (27430 bytes each), so this is an
 * exact check and not a heuristic - any drift at all, a new path or a
 * renamed field, means the process on the port is not this code.
 *
 * Shelling out to `uv` adds no requirement the suite did not already
 * have: `scripts/e2e-api-server.mjs` runs `uv run activity-analysis` to
 * build the store and to serve it. It costs about 0.6 s.
 */

/** How to clear the way for Playwright to start its own servers. */
const STOP_IT = [
  'It is almost certainly a server left running from another branch or over',
  "another store, which `reuseExistingServer` cannot tell apart from the suite's",
  'own. Stop it and let Playwright start its own, or move the suite to free',
  'ports with E2E_API_PORT and E2E_WEB_PORT. An API server an earlier run of',
  'this suite left behind stops with',
  '',
  '  pkill -f "[e]2e-api-server.mjs"',
  // The bracket keeps the pattern from matching the command line of a
  // shell invoked as `bash -c '...'`, which contains it verbatim - so the
  // suggestion is safe to paste anywhere, not only into an interactive
  // prompt where `pkill` only has itself to exclude.
]

/** JSON with every object's keys in sorted order, so two documents that differ only in key order compare equal. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  )
}

type OpenApiDocument = { paths?: Record<string, Record<string, { parameters?: { name?: string }[] }>> }

/**
 * One line per operation: `GET /api/activities [limit, offset, sport]`.
 *
 * The assertion below compares full documents, but a raw diff of two 27 KB
 * JSON strings tells a reader nothing. This reduction is only for the
 * failure message, and it is the level at which the real staleness shows
 * up - a missing endpoint, or an endpoint missing the parameters a test is
 * about to send it.
 */
function operationSurface(document: OpenApiDocument): string[] {
  const lines: string[] = []
  for (const [path, methods] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      const names = (operation.parameters ?? [])
        .map((parameter) => parameter.name)
        .filter((name): name is string => name !== undefined)
        .sort()
      lines.push(`${method.toUpperCase()} ${path} [${names.join(', ')}]`)
    }
  }
  return lines.sort()
}

setup("the API answering on the suite's port is serving this checkout", async ({ request }) => {
  const response = await request.get(`${API_ORIGIN}/openapi.json`)
  expect(response.ok(), `${API_ORIGIN}/openapi.json answered ${response.status()}`).toBe(true)
  const live = (await response.json()) as OpenApiDocument

  // `uv run` resolves the project and its venv from the current directory,
  // which is why `scripts/generate-api.sh` and `scripts/e2e-api-server.mjs`
  // both step up to the Python project - see `PROJECT_ROOT` for why the
  // step is taken from that file's location and not the process's.
  const source = JSON.parse(
    execFileSync('uv', ['run', 'activity-analysis', 'openapi'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    }),
  ) as OpenApiDocument

  if (JSON.stringify(canonical(live)) === JSON.stringify(canonical(source))) return

  const liveSurface = new Set(operationSurface(live))
  const sourceSurface = new Set(operationSurface(source))
  const missing = [...sourceSurface].filter((line) => !liveSurface.has(line))
  const extra = [...liveSurface].filter((line) => !sourceSurface.has(line))
  const differences = [
    ...missing.map((line) => `  this checkout has, the server does not: ${line}`),
    ...extra.map((line) => `  the server has, this checkout does not: ${line}`),
  ]

  throw new Error(
    [
      `The API answering on ${API_ORIGIN} is not serving this checkout.`,
      '',
      ...STOP_IT,
      '',
      differences.length > 0
        ? ['Where the two surfaces differ:', ...differences].join('\n')
        : 'The two agree on every path and parameter, so the difference is inside a schema - a renamed or retyped field.',
    ].join('\n'),
  )
})

setup('the dev server is serving the fixture store', async ({ request }) => {
  const response = await request.get(`${WEB_ORIGIN}/api/health`)
  expect(response.ok(), `${WEB_ORIGIN}/api/health answered ${response.status()}`).toBe(true)
  const health = (await response.json()) as { root: string; stale: boolean }
  if (resolve(health.root) !== resolve(STORE_ROOT)) {
    throw new Error(
      [
        `The API behind ${WEB_ORIGIN} is serving the store at ${health.root},`,
        `not the fixture store at ${STORE_ROOT}.`,
        '',
        ...STOP_IT,
      ].join('\n'),
    )
  }
  expect(health.stale, `the fixture store at ${STORE_ROOT} is stale: restart the API server`).toBe(false)
})
