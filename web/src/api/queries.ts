import { queryOptions } from '@tanstack/react-query'
import type { ActivitySearch } from './activitySearch'
import { validateActivitySearch } from './activitySearch'
import { api } from './client'
import { ApiError } from './errors'

/**
 * One TanStack Query options factory per endpoint.
 *
 * Two rules, both load-bearing:
 *
 * - The query key is the path plus the parameters object, so a different
 *   set of activity filters or a different activity id is a different cache
 *   entry rather than something a component has to invalidate by hand.
 * - Every `queryFn` throws on `openapi-fetch`'s `error` so TanStack Query
 *   sees a rejection and renders its error state. Returning
 *   `{ data: undefined }` on a failed request would instead render an empty
 *   chart or table, indistinguishable from a real empty result.
 *
 * `staleTime` and `retry` are not set per query here: every endpoint reads
 * an immutable, per-process view of the store, so the same reasoning
 * applies to all of them identically. See the `QueryClient` construction in
 * `main.tsx` for that argument stated once rather than repeated per query.
 */

export type { ActivitySearch as ActivitiesFilters } from './activitySearch'

export const queries = {
  health: () =>
    queryOptions({
      queryKey: ['/api/health'],
      queryFn: async () => {
        const { data, error } = await api.GET('/api/health')
        if (error) throw error
        return data
      },
    }),

  sports: () =>
    queryOptions({
      queryKey: ['/api/sports'],
      queryFn: async () => {
        const { data, error } = await api.GET('/api/sports')
        if (error) throw error
        return data
      },
    }),

  overview: () =>
    queryOptions({
      queryKey: ['/api/overview'],
      queryFn: async () => {
        const { data, error } = await api.GET('/api/overview')
        if (error) throw error
        return data
      },
    }),

  records: () =>
    queryOptions({
      queryKey: ['/api/records'],
      queryFn: async () => {
        const { data, error } = await api.GET('/api/records')
        if (error) throw error
        return data
      },
    }),

  basemap: () =>
    queryOptions({
      queryKey: ['/api/basemap'],
      queryFn: async () => {
        const { data, error } = await api.GET('/api/basemap')
        if (error) throw error
        return data
      },
    }),

  activities: (filters: ActivitySearch) => {
    // `filters` is typed as the already-validated shape, but it is commonly
    // a route's `useSearch()` value, and that value can still carry raw,
    // unvalidated URL keys at runtime: TanStack Router overlays a route's
    // validated search onto the *raw* parent search rather than replacing
    // it, so a key `validateActivitySearch` already dropped once can
    // resurface here unchanged regardless of what the type claims (see the
    // comment on that function). This is the actual network boundary, so it
    // narrows again right before the request is built rather than trusting
    // its own parameter type.
    const safe = validateActivitySearch(filters)
    return queryOptions({
      queryKey: ['/api/activities', safe],
      queryFn: async () => {
        const { data, error } = await api.GET('/api/activities', {
          params: { query: safe },
        })
        if (error) throw error
        return data
      },
    })
  },

  activity: (activityId: string) =>
    queryOptions({
      queryKey: ['/api/activities/{activity_id}', activityId],
      queryFn: async () => {
        const { data, error } = await api.GET('/api/activities/{activity_id}', {
          params: { path: { activity_id: activityId } },
        })
        if (error) throw error
        return data
      },
    }),

  streams: (activityId: string) =>
    queryOptions({
      queryKey: ['/api/activities/{activity_id}/streams', activityId],
      queryFn: async () => {
        const { data, error, response } = await api.GET('/api/activities/{activity_id}/streams', {
          params: { path: { activity_id: activityId } },
        })
        // Wrapped with the HTTP status, not thrown bare like every other
        // query above: `ActivityDetail` is the one caller that has to tell
        // a genuine 404 - a stated absence - apart from a real failure (a
        // 503, or a network error) that would otherwise render identically.
        // See `api/errors.ts`'s `ApiError` and `isNotFoundError`.
        if (error) throw new ApiError(error, response.status)
        return data
      },
    }),

  trends: () =>
    queryOptions({
      queryKey: ['/api/trends'],
      queryFn: async () => {
        const { data, error } = await api.GET('/api/trends')
        if (error) throw error
        return data
      },
    }),

  fitness: () =>
    queryOptions({
      queryKey: ['/api/fitness'],
      queryFn: async () => {
        const { data, error } = await api.GET('/api/fitness')
        if (error) throw error
        return data
      },
    }),

  predictions: () =>
    queryOptions({
      queryKey: ['/api/predictions'],
      queryFn: async () => {
        const { data, error } = await api.GET('/api/predictions')
        if (error) throw error
        return data
      },
    }),

  progression: (distanceKey: string) =>
    queryOptions({
      queryKey: ['/api/progression/{distance_key}', { distanceKey }],
      queryFn: async () => {
        const { data, error, response } = await api.GET('/api/progression/{distance_key}', {
          params: { path: { distance_key: distanceKey } },
        })
        // Wrapped with the status like `streams` above, for the same reason:
        // the endpoint 404s for a distance with no efforts (`marathon` on
        // the real store) and for a key the extractor does not know, and
        // `Progression` renders both as a stated absence rather than as the
        // failure a 503 or a network error is. See `api/errors.ts`.
        if (error) throw new ApiError(error, response.status)
        return data
      },
    }),

  distributions: () =>
    queryOptions({
      queryKey: ['/api/distributions'],
      queryFn: async () => {
        const { data, error } = await api.GET('/api/distributions')
        if (error) throw error
        return data
      },
    }),

  routes: () =>
    queryOptions({
      queryKey: ['/api/routes'],
      queryFn: async () => {
        const { data, error } = await api.GET('/api/routes')
        if (error) throw error
        return data
      },
    }),

  territory: () =>
    queryOptions({
      queryKey: ['/api/territory'],
      queryFn: async () => {
        const { data, error } = await api.GET('/api/territory')
        if (error) throw error
        return data
      },
    }),

  route: (routeId: string) =>
    queryOptions({
      queryKey: ['/api/routes/{route_id}', routeId],
      queryFn: async () => {
        const { data, error, response } = await api.GET('/api/routes/{route_id}', {
          params: { path: { route_id: routeId } },
        })
        // Wrapped with the status like `streams` and `progression` above: an
        // unknown route id is a 404, which the route view states as an
        // absence, while a 503 or a network error is a failure. A route's id
        // is its earliest run's activity id, so a recompute that regroups
        // the runs can retire an id a bookmark still holds - the 404 is
        // ordinary, not a fault.
        if (error) throw new ApiError(error, response.status)
        return data
      },
    }),
}
