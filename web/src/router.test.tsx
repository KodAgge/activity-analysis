import { createMemoryHistory, createRouter } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { router } from './router'

/**
 * Builds a fresh router instance from the app's own route tree, on a memory
 * history seeded with the given path, and loads it - exercising the real
 * `validateSearch` + `beforeLoad` pair on `/activities`, not a
 * reimplementation of either.
 */
function loadAt(initialPath: string) {
  const testRouter = createRouter({
    routeTree: router.routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  return testRouter.load().then(() => testRouter)
}

function activitiesMatchSearch(testRouter: Awaited<ReturnType<typeof loadAt>>) {
  const match = testRouter.state.matches.find((m) => m.routeId.includes('activities'))
  return match?.search
}

describe('the /activities route cleans its own search state, not just the request', () => {
  it('redirects an unknown key and an invalid value away, updating both the URL and useSearch()', async () => {
    const testRouter = await loadAt('/activities?limit=abc&unknown=x')
    // The URL itself moved, not just the internal match state - this is
    // the part a merge-only fix (or comparing the wrong field) cannot do.
    expect(testRouter.state.location.pathname).toBe('/activities')
    expect(testRouter.state.location.search).toEqual({ sport: 'running' })
    expect(activitiesMatchSearch(testRouter)).toEqual({ sport: 'running' })
  })

  it('redirects a value that is merely out of bounds, even though the key set does not change', async () => {
    // The key set is identical on both sides here (`sport`, `limit`) - only
    // the value of `limit` differs once clamped. A comparison that checked
    // key sets rather than values would wrongly see no difference and never
    // fire the redirect, leaving 9999 in the address bar - misleading to
    // bookmark or share - even though the app is really using 200.
    const testRouter = await loadAt('/activities?sport=running&limit=9999')
    expect(testRouter.state.location.search).toEqual({ sport: 'running', limit: 200 })
    expect(activitiesMatchSearch(testRouter)).toEqual({ sport: 'running', limit: 200 })
  })

  it('does not redirect a URL that is already exactly the clean shape (the loop guard)', async () => {
    const testRouter = await loadAt('/activities?sport=running')
    const hrefAfterFirstLoad = testRouter.state.location.href
    // A second load at the same, already-clean location must not move the
    // URL again - if it did, that is the shape a redirect loop takes.
    await testRouter.load()
    expect(testRouter.state.location.href).toBe(hrefAfterFirstLoad)
    expect(testRouter.state.location.search).toEqual({ sport: 'running' })
  })

  it('converges in exactly one redirect: loading the cleaned destination directly does not redirect again', async () => {
    const dirty = await loadAt('/activities?limit=9999&unknown=x')
    const cleanedHref = dirty.state.location.href

    const loadedDirectly = await loadAt(cleanedHref)
    expect(loadedDirectly.state.location.href).toBe(cleanedHref)
    expect(loadedDirectly.state.location.search).toEqual(dirty.state.location.search)
  })
})

describe('the phase 4 routes', () => {
  it('routes /trends to the trends view', async () => {
    const testRouter = await loadAt('/trends')
    expect(testRouter.state.location.pathname).toBe('/trends')
    expect(testRouter.state.matches.map((m) => m.routeId)).toContain('/trends')
    // A literal path, not an activity id: the detail route must not match.
    expect(testRouter.state.matches.map((m) => m.routeId)).not.toContain('/activities/$activityId')
  })

  it('routes /progression to the progression view', async () => {
    const testRouter = await loadAt('/progression?distance=10k')
    expect(testRouter.state.matches.map((m) => m.routeId)).toContain('/progression')
    expect(testRouter.state.matches.map((m) => m.routeId)).not.toContain('/activities/$activityId')
  })

  it('keeps the chosen distance in the URL', async () => {
    const testRouter = await loadAt('/progression?distance=10k')
    expect(testRouter.state.location.search).toEqual({ distance: '10k' })
    const match = testRouter.state.matches.find((m) => m.routeId === '/progression')
    expect(match?.search).toEqual({ distance: '10k' })
  })

  it('redirects a bare /progression to the default distance, so the address bar says what the chart shows', async () => {
    const testRouter = await loadAt('/progression')
    expect(testRouter.state.location.search).toEqual({ distance: '5k' })
    // And converges in one redirect: the destination does not move again.
    const href = testRouter.state.location.href
    await testRouter.load()
    expect(testRouter.state.location.href).toBe(href)
  })

  it('drops an unknown key from /progression while keeping the distance', async () => {
    const testRouter = await loadAt('/progression?distance=1mi&unknown=x')
    expect(testRouter.state.location.search).toEqual({ distance: '1mi' })
  })
})

describe('the /distributions route', () => {
  it('routes /distributions to the distributions view', async () => {
    const testRouter = await loadAt('/distributions?variable=avg_hr')
    expect(testRouter.state.matches.map((m) => m.routeId)).toContain('/distributions')
    expect(testRouter.state.matches.map((m) => m.routeId)).not.toContain('/activities/$activityId')
  })

  it('keeps the chosen variable in the URL', async () => {
    const testRouter = await loadAt('/distributions?variable=avg_hr')
    expect(testRouter.state.location.search).toEqual({ variable: 'avg_hr' })
    const match = testRouter.state.matches.find((m) => m.routeId === '/distributions')
    expect(match?.search).toEqual({ variable: 'avg_hr' })
  })

  it('redirects a bare /distributions to the default variable, so the address bar says what the chart shows', async () => {
    const testRouter = await loadAt('/distributions')
    expect(testRouter.state.location.search).toEqual({ variable: 'distance' })
    // And converges in one redirect: the destination does not move again.
    const href = testRouter.state.location.href
    await testRouter.load()
    expect(testRouter.state.location.href).toBe(href)
  })

  it('drops an unknown key and an invalid period from /distributions while keeping the variable', async () => {
    const testRouter = await loadAt('/distributions?variable=avg_hr&period=year_20x5&unknown=x')
    expect(testRouter.state.location.search).toEqual({ variable: 'avg_hr' })
  })

  it('keeps a hand-typed numeric ?bucket=5000 as the bucket selection rather than losing it to a redirect', async () => {
    // The router's own default parseSearch JSON.parses each raw value, so
    // this URL - unquoted, the shape a reader would actually type or paste
    // - hands the route the *number* 5000 for `bucket`, not the string
    // '5000' that `histogramMath.bucketsFor` actually builds bucket keys
    // as. The one redirect this fires normalises the URL to a quoted
    // `bucket=%225000%22` so it round-trips as a string from here on, and
    // the selection survives rather than being dropped.
    const testRouter = await loadAt('/distributions?variable=distance&bucket=5000')
    expect(testRouter.state.location.search).toEqual({ variable: 'distance', bucket: '5000' })
    const match = testRouter.state.matches.find((m) => m.routeId === '/distributions')
    expect(match?.search).toEqual({ variable: 'distance', bucket: '5000' })

    // And converges: loading the now-quoted destination directly does not
    // redirect again.
    const href = testRouter.state.location.href
    const loadedDirectly = await loadAt(href)
    expect(loadedDirectly.state.location.search).toEqual({ variable: 'distance', bucket: '5000' })
    expect(loadedDirectly.state.location.href).toBe(href)
  })
})

describe('the redirects fire on an in-app navigation, not only on a first load', () => {
  // Every test above loads the dirty URL as the router's first location.
  // These navigate to it from another view, the way a link or a typed
  // search does. The navigation adds one history entry and the redirect
  // replaces it, so Back returns to the view the navigation left rather
  // than to the dirty URL, which would redirect forward again. TanStack
  // Router 1.171 follows every redirect with `replace: true` whatever the
  // thrown redirect asks for, so this pins the behaviour, not the
  // `replace: true` in `router.tsx`. The search is read off the history,
  // which is the address bar, rather than off the router's parsed copy.
  async function navigateFromTrends(href: string) {
    const testRouter = await loadAt('/trends')
    expect(testRouter.history.length).toBe(1)
    await testRouter.navigate({ href })
    expect(testRouter.history.length).toBe(2)
    return testRouter
  }

  function addressBarSearch(testRouter: Awaited<ReturnType<typeof loadAt>>) {
    return Object.fromEntries(new URLSearchParams(testRouter.history.location.search))
  }

  function pathAfterBack(testRouter: Awaited<ReturnType<typeof loadAt>>) {
    testRouter.history.back()
    return testRouter.history.location.pathname
  }

  it('rewrites a dirty /activities navigation in place', async () => {
    const testRouter = await navigateFromTrends('/activities?limit=9999&unknown=x')
    expect(testRouter.state.location.pathname).toBe('/activities')
    expect(addressBarSearch(testRouter)).toEqual({ sport: 'running', limit: '200' })
    expect(pathAfterBack(testRouter)).toBe('/trends')
  })

  it('rewrites a dirty /progression navigation in place', async () => {
    // An unknown key, not a bare path: building the navigation's location
    // already writes the default distance into a bare `/progression`, so
    // only a key the validator drops needs the redirect to leave the URL.
    const testRouter = await navigateFromTrends('/progression?distance=1mi&unknown=x')
    expect(addressBarSearch(testRouter)).toEqual({ distance: '1mi' })
    expect(pathAfterBack(testRouter)).toBe('/trends')
  })

  it('rewrites a dirty /distributions navigation in place', async () => {
    const testRouter = await navigateFromTrends('/distributions?variable=avg_hr&unknown=x')
    expect(addressBarSearch(testRouter)).toEqual({ variable: 'avg_hr' })
    expect(pathAfterBack(testRouter)).toBe('/trends')
  })
})

describe('the /territory route', () => {
  it('keeps a bare /territory, whose default region only the payload knows', async () => {
    const testRouter = await loadAt('/territory')
    expect(testRouter.state.location.pathname).toBe('/territory')
    expect(testRouter.state.location.search).toEqual({})
  })

  it('redirects an unknown key and an empty region away, keeping a real one', async () => {
    const stripped = await loadAt('/territory?region=&zoom=4')
    expect(stripped.state.location.search).toEqual({})
    const kept = await loadAt('/territory?region=abc&zoom=4')
    expect(kept.state.location.search).toEqual({ region: 'abc' })
  })
})
