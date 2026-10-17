#!/usr/bin/env node
// Fails when Vitest collected fewer tests than the floor below.
//
// `npm run check` is the frontend's only gate, and `vitest run` is given
// `--passWithNoTests` because there is a commit on this branch where the
// suite legitimately does not exist yet. That flag turns a total loss of
// coverage into a green run: `vite.config.ts` narrows `include` to
// `src/**/*.test.{ts,tsx}`, so a directory move, a change of naming
// convention, or an edit to `include` silently collects zero tests and
// the gate still exits 0. A floor keeps the flag's one real use
// while making "nothing ran" the failure it should be.
//
// The floor is deliberately well below the current count: it is a
// tripwire for the suite vanishing, not a ratchet that has to be bumped
// every time a test is added.
import { readFile } from 'node:fs/promises'

const MINIMUM_TESTS = 150

const [reportPath] = process.argv.slice(2)
if (reportPath === undefined) {
  console.error('usage: check-test-floor.mjs <vitest-json-report>')
  process.exit(2)
}

let report
try {
  report = JSON.parse(await readFile(reportPath, 'utf8'))
} catch (error) {
  console.error(`could not read Vitest's JSON report at ${reportPath}: ${error.message}`)
  process.exit(2)
}

const collected = report.numTotalTests ?? 0
if (collected < MINIMUM_TESTS) {
  console.error(
    `Vitest collected ${collected} tests, below the floor of ${MINIMUM_TESTS}. ` +
      "Either the suite stopped being collected (check `include` in vite.config.ts " +
      'and the `*.test.ts(x)` naming), or the floor in this script needs revisiting.',
  )
  process.exit(1)
}

console.log(`Vitest collected ${collected} tests (floor ${MINIMUM_TESTS}).`)
