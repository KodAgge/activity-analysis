#!/usr/bin/env node
// Measures the activity moment's performance budgets (recorded with the
// figures in docs/reference/frontend.md, "Replay"), against a
// production build, with the API on :8000 serving a store that holds the run
// - the end-to-end suite's fixture store, with its stand-in basemap area,
// unless MEASURE_RUN names a run of some other store:
//
//   cd web
//   node scripts/e2e-api-server.mjs "$(mktemp -d)" 8000 &
//   npx vite build && npx vite preview --port 4173
//   MEASURE_LAUNCH_ARGS='--use-gl=angle --use-angle=swiftshader' node scripts/measure-moment.mjs
//
// `vite preview` proxies `/api` the same way the dev server does
// (`server.proxy` is honoured by `preview` too in this project's Vite
// 8.2.2; there is no separate `preview.proxy` in vite.config.ts). Point it
// elsewhere with MEASURE_BASE_URL, e.g. to compare against a different
// commit's build served on a different port.
//
// The SwiftShader launch args are required in an environment with no real
// GPU: under the default headless args, every drawing strategy compared
// when the replay's growing line was chosen read 7.5-12 fps median, the
// cheapest among them included.
//
// The run defaults to 0af80b91f3c92e34, the longest fixture run, which the
// fixture store's stand-in area covers, so the hero is a MapLibre map and
// not only the bare trace. The recorded figures were measured on a longer
// run of the maintainer's own store, on a covered route, with no heart rate
// at all, which is why cadence is the stream panel this script watches;
// see (a)/(b) below:
//
//  - replay, p5 fps >= 50, over the loaded map and over the bare trace
//    (`/api/basemap` failed, as when no area covers the run)
//  - (a) work per move, p90 <= 16 ms: the synchronous cost of handling one
//    pointer move - the actual claim "a pointer move updates the four stream
//    panels and the hero within one frame" makes.
//  - (b) sweep smoothness, p5 fps >= 50: whether a real pointer sweep across
//    the pace chart keeps the page's own frame rate up.
//  - phone scroll, p5 fps >= 50: wheel steps down to the splits at 390x844,
//    while the pinned hero collapses.
//
// The replay is pressed once the map has loaded, the network is idle and
// the page's frames have settled. Pressed while the map is still loading,
// the map's own first style, tile and paint work lands in the replay's
// window: 633 to 1683 ms frames, before and after the press. The bare trace
// has one long frame of its own about 1.0 s after navigation, with no
// replay pressed at all: Chrome's compositor teardown waiting on a
// SwiftShader GPU flush, which predates the activity moment. A
// production-build A/B of eight loads each measured it at 450 to 2100 ms
// with the moment and 317 to 1167 ms on b4369e2 before it, about 200 ms
// longer with it. A replay on a settled page shows no frame over 40 ms.
//
// (a) and (b) replaced an earlier, single "pointer latency" measurement
// (CDP `page.mouse.move` -> `MutationObserver` -> next frame), which
// measures Chrome's own input-to-paint pipeline rather than the app's
// per-move work: Chrome aligns real input to `requestAnimationFrame` and
// paints on the frame after, so that method reads about two frames (~33 ms
// at 60 Hz) on any page, real work or none. It is kept here as
// `measureInputLatencyInformational` - printed for context, never graded
// against a budget.
//
// Checked for a regression against e154de7, the commit before the compact
// desktop layout, the tag popovers and the pinned hero: this same script,
// against a build of that commit served on its own port, gave (a) p90
// 5.8-11.0 ms and (b) p5 59.5-59.7 fps over three runs, both at least as
// good at the commit that added them.

import { chromium } from '@playwright/test'

const BASE_URL = process.env.MEASURE_BASE_URL ?? 'http://localhost:4173'
const RUN = process.env.MEASURE_RUN ?? '0af80b91f3c92e34'

/** How long to record the replay's own frame arrivals. */
const REPLAY_WINDOW_MS = 10_000
/** A page counts as settled after this many frames in a row, each within `SETTLED_FRAME_MS`. */
const SETTLED_FRAMES = 60
const SETTLED_FRAME_MS = 34
/** The pointer sweep across the pace chart's plot, for every measurement below that sweeps one. */
const POINTER_STEPS = 200
/** How many times to repeat (a), (b) and the phone scroll. */
const REPEATS = 3
/** Wheel steps from the top of the phone layout to the splits. */
const PHONE_SCROLL_STEPS = 60
/** (`measureInputLatencyInformational` only) how long each step gives the mutation-plus-frame pipeline to produce a sample before moving on, and how long to drain after the sweep. */
const INFORMATIONAL_STEP_BUDGET_MS = 30
const INFORMATIONAL_DRAIN_MS = 300

const REPLAY_FPS_BUDGET = 50
const WORK_PER_MOVE_P90_BUDGET_MS = 16
const SWEEP_FPS_BUDGET = 50
const PHONE_SCROLL_FPS_BUDGET = 50

function percentile(sorted, p) {
  const idx = (sorted.length - 1) * (p / 100)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function frameStats(frameTimes) {
  const intervals = []
  for (let i = 1; i < frameTimes.length; i++) intervals.push(frameTimes[i] - frameTimes[i - 1])
  const fps = intervals.map((ms) => 1000 / ms)
  const sortedFps = [...fps].sort((a, b) => a - b)
  return {
    frames: frameTimes.length,
    medianFps: percentile(sortedFps, 50),
    p5Fps: percentile(sortedFps, 5),
    longestFrameMs: Math.max(...intervals),
  }
}

function latencyStats(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b)
  return {
    samples: sorted.length,
    medianMs: percentile(sorted, 50),
    p90Ms: percentile(sorted, 90),
    maxMs: sorted.at(-1) ?? NaN,
  }
}

/**
 * A WebGL renderer string independent of anything the page itself draws -
 * a bare canvas rather than the map's own, so this reads the same whether
 * or not this run has a covered route to show a MapLibre map for.
 */
async function rendererInfo(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    if (!gl) return 'no WebGL context'
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER))
  })
}

/**
 * Opens the activity, waits for the hero and the pace chart, and scrolls
 * the pace section into view - the title block above the compact stream
 * stack (place, route line, stats, tags) can be taller than the viewport,
 * so the pace panel's box can sit partly below the fold at the
 * initial scroll position (see activityMoment.spec.ts's own hover test for
 * the same fix). Returns the plot's and the cadence section's element
 * handles and the plot's own box, for a caller to sweep a pointer across.
 *
 * **Cadence, not heart rate.** The run the recorded budgets were measured
 * on carries no heart rate at all (`hr_bpm` null on every sample), so its
 * heart rate panel renders `Absent` and never mutates on hover. Cadence is
 * a stream panel driven through the same moment store and the same repaint
 * path, and was recorded on 99% of that run's samples and on every fixture
 * run, so it is what every measurement below actually observes.
 */
async function openPaceAndCadence(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`${BASE_URL}/activities/${RUN}`)
  await page.getByRole('region', { name: 'Route', exact: true }).waitFor()

  const paceSection = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Pace', exact: true, level: 2 }) })
  const cadenceSection = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Cadence', exact: true, level: 2 }) })
  const plot = paceSection.locator('.u-over')
  await plot.waitFor()
  await paceSection.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  const box = await plot.boundingBox()
  if (box === null) throw new Error('the pace chart has no box to sweep a pointer across')

  const overHandle = await plot.elementHandle()
  const cadenceHandle = await cadenceSection.elementHandle()
  if (overHandle === null || cadenceHandle === null) {
    throw new Error('could not find the pace plot or the cadence section')
  }
  return { page, overHandle, cadenceHandle, box }
}

/**
 * Resolves once the page has drawn `SETTLED_FRAMES` frames in a row, each
 * within `SETTLED_FRAME_MS` of the last - the page's own load work done.
 */
async function waitForSettledFrames(page) {
  await page.evaluate(
    ([count, limitMs]) =>
      new Promise((resolve) => {
        let previous = null
        let run = 0
        const frame = (now) => {
          run = previous !== null && now - previous <= limitMs ? run + 1 : 0
          previous = now
          if (run >= count) resolve()
          else requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      }),
    [SETTLED_FRAMES, SETTLED_FRAME_MS],
  )
}

/**
 * Presses Replay and records the frame rate for `REPLAY_WINDOW_MS`, through
 * `requestAnimationFrame` in the page - independent of the replay's own
 * clock, so a dropped frame shows up as a gap rather than being smoothed
 * away by only sampling the replay's own reported head.
 */
async function measureReplayFps(browser, { bare }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  if (bare) await page.route('**/api/basemap', (route) => route.fulfill({ status: 500, body: 'measuring the bare trace' }))
  await page.goto(`${BASE_URL}/activities/${RUN}`)
  const replayButton = page.getByRole('button', { name: 'Replay' })
  // Absent rather than a real failure against a commit predating the
  // Replay feature - the e154de7 regression check runs this same script
  // against that build, and this measurement is not one of the two
  // budgets under review there.
  const hasReplay = await replayButton
    .waitFor({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false)
  if (!hasReplay) {
    await page.close()
    return null
  }
  // The map's style switch appears once the map has loaded; see the header
  // on why the replay waits for it, and for the page's frames to settle.
  const mapStyle = page.getByRole('radiogroup', { name: 'Map style' })
  if (!bare) await mapStyle.waitFor({ timeout: 60_000 })
  await page.waitForLoadState('networkidle')
  await waitForSettledFrames(page)
  if (bare && (await mapStyle.count()) > 0) throw new Error('the map loaded although /api/basemap failed')
  const renderer = await rendererInfo(page)

  await page.evaluate((durationMs) => {
    window.__frameTimes = []
    window.__framesDone = false
    const start = performance.now()
    function frame(now) {
      window.__frameTimes.push(now)
      if (now - start < durationMs) {
        requestAnimationFrame(frame)
      } else {
        window.__framesDone = true
      }
    }
    requestAnimationFrame(frame)
  }, REPLAY_WINDOW_MS)

  await replayButton.click()
  await page.waitForFunction(() => window.__framesDone === true, null, { timeout: REPLAY_WINDOW_MS + 30_000 })
  const frameTimes = await page.evaluate(() => window.__frameTimes)
  await page.close()
  return { renderer, ...frameStats(frameTimes) }
}

/**
 * Scrolls the phone layout down to the splits in `PHONE_SCROLL_STEPS` wheel
 * steps, one per rendered frame, while a continuous rAF loop records every
 * frame's arrival, the same way `measureSweepFps` does for a pointer sweep.
 * The pinned hero collapses over the first part of it.
 */
async function measurePhoneScrollFps(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.goto(`${BASE_URL}/activities/${RUN}`)
  await page.getByRole('region', { name: 'Route', exact: true }).waitFor()
  await page.getByRole('radiogroup', { name: 'Map style' }).waitFor({ timeout: 60_000 })
  const splits = page.getByRole('heading', { name: 'Splits', exact: true })
  await splits.waitFor()
  const distance = (await splits.boundingBox()).y
  const step = distance / PHONE_SCROLL_STEPS

  await page.evaluate(() => {
    window.__scrollFrameTimes = []
    window.__scrollRecording = true
    function frame(now) {
      window.__scrollFrameTimes.push(now)
      if (window.__scrollRecording) requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
  await page.mouse.move(195, 600)
  for (let i = 0; i < PHONE_SCROLL_STEPS; i++) {
    await page.mouse.wheel(0, step)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
  }
  await page.waitForTimeout(200)

  const frameTimes = await page.evaluate(() => {
    window.__scrollRecording = false
    return window.__scrollFrameTimes
  })
  await page.close()
  return frameStats(frameTimes)
}

/**
 * (a) Work per move: the synchronous cost of handling one pointer move,
 * timed from dispatch to whichever comes later of the cadence heading's own
 * `MutationObserver` callback and the end of the same task - a
 * `MessageChannel` round trip, which always resolves, so every one of the
 * `POINTER_STEPS` gets a sample even when a step's own grid index rounds to
 * the same cadence as the step before it and never mutates the DOM at all
 * (real work - a re-render that confirms nothing changed - still happened,
 * and the task-end signal still times it).
 *
 * Dispatched as a synthetic `PointerEvent` from a `requestAnimationFrame`
 * callback, not a real `page.mouse.move`: a real move measures Chrome's own
 * input-to-paint pipeline (see `measureInputLatencyInformational`), which
 * is ~2 frames on any page regardless of how much or little work the app
 * itself does. `dispatchEvent` calls every listener on `.u-over`
 * synchronously, exactly as a real event would, without that pipeline's own
 * fixed overhead on top - which is what isolates the app's own per-move
 * work, the actual thing a 16 ms-per-move budget is a claim about.
 */
async function measureWorkPerMove(browser) {
  const { page, overHandle, cadenceHandle, box } = await openPaceAndCadence(browser)

  const latencies = await page.evaluate(
    async ([overEl, cadenceEl, box, steps]) => {
      function nextFrame() {
        return new Promise((resolve) => requestAnimationFrame(resolve))
      }
      function taskEnd() {
        return new Promise((resolve) => {
          const channel = new MessageChannel()
          channel.port1.onmessage = () => resolve(performance.now())
          channel.port2.postMessage(null)
        })
      }

      let mutationAt = null
      const observer = new MutationObserver(() => {
        mutationAt = performance.now()
      })
      observer.observe(cadenceEl, { subtree: true, childList: true, characterData: true })

      const results = []
      for (let i = 0; i < steps; i++) {
        await nextFrame()
        mutationAt = null
        const x = box.x + (box.width * i) / (steps - 1)
        const y = box.y + box.height / 2
        const dispatchAt = performance.now()
        overEl.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: x, clientY: y, bubbles: true }))
        const taskEndAt = await taskEnd()
        const finalAt = mutationAt !== null && mutationAt > taskEndAt ? mutationAt : taskEndAt
        results.push(finalAt - dispatchAt)
      }
      observer.disconnect()
      return results
    },
    [overHandle, cadenceHandle, box, POINTER_STEPS],
  )

  await page.close()
  return latencyStats(latencies)
}

/**
 * (b) Smoothness during a real sweep: a real `page.mouse.move` across the
 * plot in `POINTER_STEPS` steps, paced by the page's own
 * `requestAnimationFrame` ("at display rate") rather than a fixed wait,
 * while a continuous rAF loop in the page records every frame's own
 * arrival - independent of the sweep's own steps, so a frame the sweep
 * never causes still counts towards the rate, and a dropped one still
 * shows up as a gap.
 */
async function measureSweepFps(browser) {
  const { page, box } = await openPaceAndCadence(browser)

  await page.evaluate(() => {
    window.__sweepFrameTimes = []
    window.__sweepRecording = true
    function frame(now) {
      window.__sweepFrameTimes.push(now)
      if (window.__sweepRecording) requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })

  const y = box.y + box.height / 2
  for (let i = 0; i < POINTER_STEPS; i++) {
    const x = box.x + (box.width * i) / (POINTER_STEPS - 1)
    await page.mouse.move(x, y)
    // Paces the sweep to the page's own display rate rather than a fixed
    // wait, so this drives roughly one move per rendered frame.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
  }
  await page.waitForTimeout(200)

  const frameTimes = await page.evaluate(() => {
    window.__sweepRecording = false
    return window.__sweepFrameTimes
  })
  await page.close()
  return frameStats(frameTimes)
}

/**
 * The earlier "pointer latency" measurement: a real `page.mouse.move` over
 * `POINTER_STEPS` steps, timing from each move the app's own `.u-over`
 * listener receives to the next animation frame after the cadence heading's
 * text changes. Kept for context - Chrome aligns real input to
 * `requestAnimationFrame` and paints on the frame after, so this reads
 * about two frames (~33 ms at 60 Hz) on any page, independent of how much
 * or little work the app does per move, which is why it no longer stands
 * for a budget: see (a) `measureWorkPerMove`, which isolates the work
 * itself, and (b) `measureSweepFps`, which checks whether a real sweep
 * still hits the display's own frame rate.
 */
async function measureInputLatencyInformational(browser) {
  const { page, overHandle, cadenceHandle, box } = await openPaceAndCadence(browser)

  await page.evaluate(
    ([overEl, cadenceEl]) => {
      window.__latencies = []
      let lastMoveAt = null
      let frameScheduled = false
      overEl.addEventListener('pointermove', () => {
        lastMoveAt = performance.now()
      })
      const observer = new MutationObserver(() => {
        if (lastMoveAt === null || frameScheduled) return
        frameScheduled = true
        const dispatchAt = lastMoveAt
        requestAnimationFrame(() => {
          window.__latencies.push(performance.now() - dispatchAt)
          lastMoveAt = null
          frameScheduled = false
        })
      })
      observer.observe(cadenceEl, { subtree: true, childList: true, characterData: true })
    },
    [overHandle, cadenceHandle],
  )

  const y = box.y + box.height / 2
  for (let i = 0; i < POINTER_STEPS; i++) {
    const x = box.x + (box.width * i) / (POINTER_STEPS - 1)
    await page.mouse.move(x, y)
    await page.waitForTimeout(INFORMATIONAL_STEP_BUDGET_MS)
  }
  await page.waitForTimeout(INFORMATIONAL_DRAIN_MS)

  const latencies = await page.evaluate(() => window.__latencies)
  await page.close()
  return latencyStats(latencies)
}

async function main() {
  const launchArgs = (process.env.MEASURE_LAUNCH_ARGS ?? '').split(' ').filter(Boolean)
  const browser = await chromium.launch({ headless: true, args: launchArgs })

  console.log(`target: ${BASE_URL}`)
  console.log(`launch args: ${launchArgs.join(' ') || '(default)'}`)

  const replays = []
  for (const [name, bare] of [
    ['over the map', false],
    ['over the bare trace', true],
  ]) {
    const replay = await measureReplayFps(browser, { bare })
    replays.push(replay)
    if (replay === null) {
      console.log(`Replay ${name}: no Replay button on this build (commit predates the feature) - skipped.`)
      console.log()
      continue
    }
    if (!bare) console.log(`renderer: ${replay.renderer}`)
    console.log()
    console.log(`Replay ${name}, ${(REPLAY_WINDOW_MS / 1000).toFixed(0)} s window, ${String(replay.frames)} frames:`)
    console.log(`  median fps: ${replay.medianFps.toFixed(1)}`)
    console.log(`  p5 fps:     ${replay.p5Fps.toFixed(1)}  (budget >= ${String(REPLAY_FPS_BUDGET)})`)
    console.log(`  longest frame: ${replay.longestFrameMs.toFixed(1)} ms`)
    console.log()
  }

  const informational = await measureInputLatencyInformational(browser)
  console.log(
    `Input latency, CDP mouse move -> repaint (informational, not a budget), ${String(informational.samples)} of ${String(POINTER_STEPS)} steps sampled:`,
  )
  console.log(`  median: ${informational.medianMs.toFixed(1)} ms`)
  console.log()

  const workRuns = []
  const sweepRuns = []
  const scrollRuns = []
  for (let run = 1; run <= REPEATS; run++) {
    const work = await measureWorkPerMove(browser)
    const sweep = await measureSweepFps(browser)
    const scroll = await measurePhoneScrollFps(browser)
    workRuns.push(work)
    sweepRuns.push(sweep)
    scrollRuns.push(scroll)
    console.log(`Run ${String(run)}/${String(REPEATS)}:`)
    console.log(
      `  (a) work per move, ${String(work.samples)} of ${String(POINTER_STEPS)} steps: median ${work.medianMs.toFixed(1)} ms, p90 ${work.p90Ms.toFixed(1)} ms (budget <= ${String(WORK_PER_MOVE_P90_BUDGET_MS)}), max ${work.maxMs.toFixed(1)} ms`,
    )
    console.log(
      `  (b) sweep smoothness: median ${sweep.medianFps.toFixed(1)} fps, p5 ${sweep.p5Fps.toFixed(1)} fps (budget >= ${String(SWEEP_FPS_BUDGET)})`,
    )
    console.log(
      `  phone scroll: median ${scroll.medianFps.toFixed(1)} fps, p5 ${scroll.p5Fps.toFixed(1)} fps (budget >= ${String(PHONE_SCROLL_FPS_BUDGET)}), longest frame ${scroll.longestFrameMs.toFixed(1)} ms`,
    )
  }
  console.log()

  await browser.close()

  const replayOk = replays.includes(null) ? null : replays.every((r) => r.p5Fps >= REPLAY_FPS_BUDGET)
  const workOk = workRuns.every((w) => w.p90Ms <= WORK_PER_MOVE_P90_BUDGET_MS)
  const sweepOk = sweepRuns.every((s) => s.p5Fps >= SWEEP_FPS_BUDGET)
  const scrollOk = scrollRuns.every((s) => s.p5Fps >= PHONE_SCROLL_FPS_BUDGET)
  console.log(`replay p5 fps budget, map and bare trace: ${replayOk === null ? 'n/a (no Replay button on this build)' : replayOk ? 'PASS' : 'FAIL'}`)
  console.log(`(a) work-per-move p90 budget, all ${String(REPEATS)} runs: ${workOk ? 'PASS' : 'FAIL'}`)
  console.log(`(b) sweep p5 fps budget, all ${String(REPEATS)} runs: ${sweepOk ? 'PASS' : 'FAIL'}`)
  console.log(`phone scroll p5 fps budget, all ${String(REPEATS)} runs: ${scrollOk ? 'PASS' : 'FAIL'}`)
  if (replayOk === false || !workOk || !sweepOk || !scrollOk) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
