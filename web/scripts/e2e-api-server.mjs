/**
 * The end-to-end suite's API server: a fresh store ingested from the
 * committed fixtures, then `activity-analysis serve` over it.
 *
 * Usage: node scripts/e2e-api-server.mjs <store root> <port>
 *
 * `playwright.config.ts` runs this as its API `webServer`, so the suite
 * asserts the five fixture runs of `data/examples` (see
 * `docs/reference/test-fixtures.md`) on any checkout, rather than whatever a
 * developer's own store holds. The store is deleted and rebuilt on every
 * start, which takes a couple of seconds: an `ingest` into a store left from
 * an earlier start would skip every file as already processed and so never
 * recompute it under a newer `ANALYSIS_VERSION`.
 *
 * The store also gets one basemap area, so the views draw their covered map
 * as they do on a store `activity-analysis tiles` has run on, without
 * fetching anything: the area's archive is `tests/fixtures/basemap-z0.pmtiles`
 * and its assets are stand-ins - an empty sprite index and a 1 x 1 sprite
 * sheet per flavour, and an empty glyph range for every range of the four
 * font stacks the style names, an empty protobuf being a valid message
 * holding no glyphs. Labels therefore draw as nothing.
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [root, port] = process.argv.slice(2)
if (root === undefined || port === undefined) {
  console.error('usage: node scripts/e2e-api-server.mjs <store root> <port>')
  process.exit(2)
}

/** `uv run` resolves the project and its `.venv` from the current directory. */
const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ARCHIVE = fileURLToPath(new URL('../tests/fixtures/basemap-z0.pmtiles', import.meta.url))

/** The archive's own header bounds, which hold every fixture run: west, south, east, north. */
const AREA_BOX = [14.05, 57.7, 14.3, 57.85]
const FONT_STACKS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic', 'Noto Sans Devanagari Regular v1']
const FLAVOURS = ['light', 'grayscale']
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

rmSync(root, { recursive: true, force: true })

const ingest = spawnSync(
  'uv',
  ['run', 'activity-analysis', 'ingest', 'data/examples', '--archive-kind', 'garmin', '--root', root],
  { cwd: PROJECT_ROOT, stdio: 'inherit' },
)
if (ingest.status !== 0) {
  console.error(`ingesting data/examples into ${root} failed`)
  process.exit(ingest.status ?? 1)
}

const basemap = join(root, 'data', 'basemap')
mkdirSync(join(basemap, 'areas'), { recursive: true })
copyFileSync(ARCHIVE, join(basemap, 'areas', 'fixture.pmtiles'))
const sprites = join(basemap, 'assets', 'sprites', 'v4')
mkdirSync(sprites, { recursive: true })
for (const flavour of FLAVOURS) {
  for (const scale of ['', '@2x']) {
    writeFileSync(join(sprites, `${flavour}${scale}.json`), '{}')
    writeFileSync(join(sprites, `${flavour}${scale}.png`), PNG_1X1)
  }
}
for (const stack of FONT_STACKS) {
  const dir = join(basemap, 'assets', 'fonts', stack)
  mkdirSync(dir, { recursive: true })
  for (let start = 0; start < 65536; start += 256) writeFileSync(join(dir, `${start}-${start + 255}.pbf`), '')
}
// The shape `basemap/manifest.py` reads, written last as `tiles` writes it.
writeFileSync(
  join(basemap, 'manifest.json'),
  `${JSON.stringify(
    {
      areas: [
        {
          id: 'fixture',
          box: AREA_BOX,
          build_key: '20261016.pmtiles',
          build_url: 'https://build.protomaps.com/20261016.pmtiles',
          schema_version: '4.15.2',
          size_bytes: statSync(ARCHIVE).size,
        },
      ],
      assets_commit: null,
    },
    null,
    2,
  )}\n`,
)

const server = spawn('uv', ['run', 'activity-analysis', 'serve', '--root', root, '--port', port], {
  cwd: PROJECT_ROOT,
  stdio: 'inherit',
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal))
server.on('exit', (code, signal) => process.exit(code ?? (signal === null ? 1 : 0)))
