/**
 * An API failure that also carries the HTTP status, for the one place a
 * caller needs to tell a genuine "this does not exist" 404 apart from a
 * real failure (a 503, or a network error that never reaches an HTTP
 * response at all) that would otherwise render as an identical-looking
 * message. `ActivityDetail`'s stream panels used to frame both the same
 * way - a stopped server mid-page read `Failed to fetch` inside a dashed
 * "this is absent" note, the same as a genuine 404, while the page's own
 * detail-query failure one section up rendered as an alert for the exact
 * same underlying fact.
 *
 * `status` is always a real HTTP status, never a stand-in for its absence:
 * a network failure never reaches an HTTP response at all, and
 * `openapi-fetch` rethrows a rejected `fetch()` as a plain `Error` before
 * this class ever gets a chance to wrap it. That is why a plain `Error`
 * reaching `isNotFoundError` below is correctly never a 404.
 */
export class ApiError extends Error {
  readonly status: number

  constructor(body: unknown, status: number) {
    super(describeApiError(body))
    this.status = status
  }
}

/**
 * Whether `error` (as thrown by a `queries.ts` query function) is this
 * application's one status that means a stated absence rather than a
 * failure - see docs/reference/api.md, "Errors": 404 is the only status
 * meaning "no such thing", and every other status - 422, 503, or no status
 * at all for a network failure - means something went wrong instead.
 */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404
}

/**
 * A human-readable message from a failed request, whatever shape the
 * failure took.
 *
 * `openapi-fetch` resolves an HTTP error response (4xx/5xx) as `{ error:
 * <body> }`, and every error body this API actually returns is shaped
 * `{"detail": ...}` (see docs/reference/api.md, "Errors"): a plain string
 * for a 404 or 503 - `HTTPException`'s default shape, and the 503 body
 * specifically names the `ingest --force` or `recompute` that fixes it - or
 * an array of validation errors for a 422.
 *
 * A network failure (the backend not running at all) is a different shape
 * entirely: `openapi-fetch` does not catch a rejected `fetch()`, it rethrows
 * it, so that path never produces a `{"detail": ...}` body - it's a plain
 * `Error` (typically `TypeError: fetch failed`). That is the common failure
 * during development, not an edge case, so it is handled first.
 *
 * `String(error)` on any plain-object shape renders `[object Object]` and
 * throws away the one useful thing about the error, which is why this
 * exists instead.
 */
export function describeApiError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error !== null && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail: unknown }).detail
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail)) {
      return detail
        .map((item: unknown) => {
          if (
            item !== null &&
            typeof item === 'object' &&
            'msg' in item &&
            typeof item.msg === 'string'
          ) {
            return item.msg
          }
          // `JSON.stringify(undefined)` returns the value `undefined`, not
          // a string, and `Array.prototype.join` silently renders that as
          // an empty entry rather than surfacing anything - a validation
          // error that fails even this fallback must still say something.
          return item === undefined ? 'unrecognised validation error' : JSON.stringify(item)
        })
        .join('; ')
    }
  }
  return 'an unknown error'
}
