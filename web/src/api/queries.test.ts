import { describe, expect, it, vi } from 'vitest'
import type { ActivitySearch } from './activitySearch'
import { api } from './client'
import { isNotFoundError } from './errors'
import { queries } from './queries'

vi.mock('./client', () => ({ api: { GET: vi.fn() } }))

/**
 * Invokes a `queryOptions()` result's own `queryFn` directly, the way
 * TanStack Query would, but with no real `QueryFunctionContext` - every
 * `queryFn` in `queries.ts` closes over its own arguments and ignores the
 * context entirely, so an empty one is enough here. `queryFn`'s real type
 * is a nest of TanStack Query generics this file has no reason to
 * reproduce; narrowed to "callable" with a real runtime check first, so
 * this project's own `no non-null assertions` rule stays satisfied by a
 * check rather than an assertion, and the one `as` below names a concrete
 * shape rather than silencing the compiler with `any`.
 */
async function invokeQueryFn(options: { queryFn?: unknown }): Promise<unknown> {
  const fn = options.queryFn
  if (typeof fn !== 'function') throw new Error('expected a queryFn')
  return (fn as (context: Record<string, never>) => Promise<unknown>)({})
}

/**
 * Simulates what a route's `useSearch()` can actually hand this function at
 * runtime: a value TypeScript believes is `ActivitySearch` (because that is
 * what `validateSearch` declares) but that can still carry whatever raw,
 * unvalidated keys TanStack Router's search merge left on it - see the
 * comment on `validateActivitySearch` for why the type lies here. Nothing in
 * `queries.activities`'s own parameter type stops this at compile time,
 * which is exactly why it has to re-validate at runtime regardless of it.
 */
function asLeakedSearch(raw: Record<string, unknown>): ActivitySearch {
  return raw as unknown as ActivitySearch
}

describe('queries.activities', () => {
  it('keys a well-formed filter set as-is', () => {
    const opts = queries.activities({ sport: 'cycling' })
    expect(opts.queryKey).toEqual(['/api/activities', { sport: 'cycling' }])
  })

  it('re-validates a leaked, unvalidated shape before building the query key and request', () => {
    // The exact shape the round-1 review found leaking through useSearch():
    // a non-numeric limit, an unrecognised sort and source, an invalid
    // date, and a key the endpoint does not declare at all. None of it may
    // reach the query key, because the query key is what api.GET is called
    // with too - see queries.ts's own queryFn.
    const leaked = asLeakedSearch({
      limit: 'abc',
      sort: 'nonsense',
      source: 'fitbit',
      from: 'hello',
      unknown: 'x',
    })
    const opts = queries.activities(leaked)
    expect(opts.queryKey).toEqual(['/api/activities', { sport: 'running' }])
  })

  it('clamps an out-of-range limit rather than forwarding it', () => {
    const opts = queries.activities(asLeakedSearch({ limit: 9999 }))
    expect(opts.queryKey).toEqual(['/api/activities', { sport: 'running', limit: 200 }])
  })

  it('clamps a negative offset to zero', () => {
    const opts = queries.activities(asLeakedSearch({ offset: -5 }))
    expect(opts.queryKey).toEqual(['/api/activities', { sport: 'running', offset: 0 }])
  })
})

describe('queries.streams (M9)', () => {
  async function caughtBy(options: { queryFn?: unknown }): Promise<unknown> {
    try {
      await invokeQueryFn(options)
      throw new Error('expected the queryFn to reject')
    } catch (error) {
      return error
    }
  }

  it('wraps a 404 so a caller can recognise it as this application\'s one stated absence', async () => {
    vi.mocked(api.GET).mockResolvedValue({
      data: undefined,
      error: { detail: 'no such activity' },
      response: new Response(null, { status: 404 }),
    } as Awaited<ReturnType<typeof api.GET>>)

    const caught = await caughtBy(queries.streams('abc123'))

    // The mutation this catches: reverting to the bare `if (error) throw
    // error` every other query in this file uses would still reject, and
    // still carry the same message - but the rejection would no longer be
    // an ApiError, so `isNotFoundError` would read it as a failure rather
    // than the absence a 404 actually is.
    expect(isNotFoundError(caught)).toBe(true)
  })

  it('wraps a 503 the same way structurally, but isNotFoundError still reads it as a failure, not an absence', async () => {
    vi.mocked(api.GET).mockResolvedValue({
      data: undefined,
      error: { detail: "DuckDB: file not found, run 'recompute'" },
      response: new Response(null, { status: 503 }),
    } as Awaited<ReturnType<typeof api.GET>>)

    const caught = await caughtBy(queries.streams('abc123'))

    expect(isNotFoundError(caught)).toBe(false)
  })
})

describe('the phase 4 queries', () => {
  it('gives each distance its own cache entry', () => {
    expect(queries.progression('5k').queryKey).not.toEqual(queries.progression('10k').queryKey)
  })

  it('keys the progression on the path plus the distance, so a component never invalidates by hand', () => {
    expect(queries.progression('5k').queryKey).toEqual(['/api/progression/{distance_key}', { distanceKey: '5k' }])
  })

  it('requests the progression for the distance it was given', async () => {
    vi.mocked(api.GET).mockResolvedValue({
      data: { distance_key: '10k', distance_m: 10000, effort_count: 0, eligible_count: 0, record_count: 0, items: [] },
      error: undefined,
      response: new Response(),
    } as Awaited<ReturnType<typeof api.GET>>)

    await invokeQueryFn(queries.progression('10k'))

    expect(api.GET).toHaveBeenCalledWith('/api/progression/{distance_key}', {
      params: { path: { distance_key: '10k' } },
    })
  })

  it('throws when the progression request fails, rather than rendering empty', async () => {
    vi.mocked(api.GET).mockResolvedValue({
      data: undefined,
      error: { detail: 'boom' },
      response: new Response(null, { status: 503 }),
    } as Awaited<ReturnType<typeof api.GET>>)
    await expect(invokeQueryFn(queries.progression('5k'))).rejects.toBeDefined()
  })

  it('wraps a progression 404 so the view can state the absence rather than a failure', async () => {
    // `/api/progression/marathon` is a 404 on the real store - the athlete
    // has no run of marathon length - and so is any key the extractor does not
    // know. The view renders both as a stated absence, which it can only do
    // if the rejection still carries the status; see `queries.streams` for
    // the same distinction and `api/errors.ts` for `isNotFoundError`.
    vi.mocked(api.GET).mockResolvedValue({
      data: undefined,
      error: { detail: 'no efforts at marathon' },
      response: new Response(null, { status: 404 }),
    } as Awaited<ReturnType<typeof api.GET>>)

    let caught: unknown
    try {
      await invokeQueryFn(queries.progression('marathon'))
    } catch (error) {
      caught = error
    }
    expect(isNotFoundError(caught)).toBe(true)
  })

  it.each([
    ['trends', () => queries.trends(), '/api/trends'],
    ['fitness', () => queries.fitness(), '/api/fitness'],
    ['predictions', () => queries.predictions(), '/api/predictions'],
    ['basemap', () => queries.basemap(), '/api/basemap'],
    ['distributions', () => queries.distributions(), '/api/distributions'],
  ] as const)('%s throws on a failed request rather than resolving to nothing', async (_name, build, path) => {
    vi.mocked(api.GET).mockResolvedValue({
      data: undefined,
      error: { detail: 'DuckDB: file not found' },
      response: new Response(null, { status: 503 }),
    } as Awaited<ReturnType<typeof api.GET>>)

    const options = build()
    expect(options.queryKey).toEqual([path])
    await expect(invokeQueryFn(options)).rejects.toBeDefined()
  })
})

describe('queries.distributions', () => {
  it('keys on the path alone, one cached query for the whole view - no filters, the endpoint takes none', () => {
    expect(queries.distributions().queryKey).toEqual(['/api/distributions'])
  })

  it('requests the endpoint with no query parameters', async () => {
    vi.mocked(api.GET).mockResolvedValue({
      data: { references: { median_mps: null }, runs: [] },
      error: undefined,
      response: new Response(),
    } as Awaited<ReturnType<typeof api.GET>>)

    await invokeQueryFn(queries.distributions())

    expect(api.GET).toHaveBeenCalledWith('/api/distributions')
  })
})

describe('the route queries', () => {
  it('keys the route list on its path alone', () => {
    expect(queries.routes().queryKey).toEqual(['/api/routes'])
  })

  it('keys one route on the path plus its id, so each route is its own cache entry', () => {
    expect(queries.route('a1b2').queryKey).toEqual(['/api/routes/{route_id}', 'a1b2'])
    expect(queries.route('a1b2').queryKey).not.toEqual(queries.route('c3d4').queryKey)
  })

  it('requests the route it was given', async () => {
    vi.mocked(api.GET).mockResolvedValue({
      data: { route: {}, reference_activity_id: 'x', runs: [] },
      error: undefined,
      response: new Response(),
    } as Awaited<ReturnType<typeof api.GET>>)

    await invokeQueryFn(queries.route('a1b2'))

    expect(api.GET).toHaveBeenCalledWith('/api/routes/{route_id}', {
      params: { path: { route_id: 'a1b2' } },
    })
  })

  it('throws when the route list fails, rather than resolving to no routes', async () => {
    vi.mocked(api.GET).mockResolvedValue({
      data: undefined,
      error: { detail: 'DuckDB: file not found' },
      response: new Response(null, { status: 503 }),
    } as Awaited<ReturnType<typeof api.GET>>)
    await expect(invokeQueryFn(queries.routes())).rejects.toBeDefined()
  })

  it('wraps an unknown route\'s 404 so the view can state the absence rather than a failure', async () => {
    vi.mocked(api.GET).mockResolvedValue({
      data: undefined,
      error: { detail: 'no such route' },
      response: new Response(null, { status: 404 }),
    } as Awaited<ReturnType<typeof api.GET>>)

    let caught: unknown
    try {
      await invokeQueryFn(queries.route('nope'))
    } catch (error) {
      caught = error
    }
    expect(isNotFoundError(caught)).toBe(true)
  })

  it('reads a failed route request as a failure, not an absence', async () => {
    vi.mocked(api.GET).mockResolvedValue({
      data: undefined,
      error: { detail: 'DuckDB: file not found' },
      response: new Response(null, { status: 503 }),
    } as Awaited<ReturnType<typeof api.GET>>)

    let caught: unknown
    try {
      await invokeQueryFn(queries.route('a1b2'))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(isNotFoundError(caught)).toBe(false)
  })
})
