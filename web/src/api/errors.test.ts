import { describe, expect, it } from 'vitest'
import { ApiError, describeApiError, isNotFoundError } from './errors'

describe('describeApiError', () => {
  it('reads a plain string detail, the shape of a 404 or 503 body', () => {
    // docs/reference/api.md: a 503 body names the ingest --force or
    // recompute that fixes it, so this is the case that matters most.
    expect(describeApiError({ detail: "DuckDB: file not found, run 'recompute'" })).toBe(
      "DuckDB: file not found, run 'recompute'",
    )
  })

  it('joins a 422 validation error array into one readable message', () => {
    const error = {
      detail: [
        {
          loc: ['query', 'limit'],
          msg: 'Input should be less than or equal to 200',
          type: 'less_than_equal',
        },
      ],
    }
    expect(describeApiError(error)).toBe('Input should be less than or equal to 200')
  })

  it('joins multiple validation errors', () => {
    const error = {
      detail: [
        { loc: ['query', 'limit'], msg: 'first problem', type: 'x' },
        { loc: ['query', 'sort'], msg: 'second problem', type: 'y' },
      ],
    }
    expect(describeApiError(error)).toBe('first problem; second problem')
  })

  it('does not render an empty entry for an undefined item in the detail array', () => {
    // JSON.stringify(undefined) returns the *value* undefined, not a
    // string, and Array.prototype.join silently renders that as "" - a
    // validation entry that fails even the object-with-msg check must
    // still produce visible text.
    const error: { detail: unknown[] } = { detail: [undefined, { msg: 'a real problem' }] }
    const result = describeApiError(error)
    expect(result).not.toBe('; a real problem')
    expect(result).toContain('a real problem')
    expect(result).toContain('unrecognised validation error')
  })

  it('falls back for an error with no detail field at all', () => {
    expect(describeApiError({})).toBe('an unknown error')
  })

  it('falls back for null and undefined rather than throwing', () => {
    expect(describeApiError(null)).toBe('an unknown error')
    expect(describeApiError(undefined)).toBe('an unknown error')
  })

  it('reads an Error instance\'s own message - the shape a network failure actually takes', () => {
    // openapi-fetch does not catch a rejected fetch(); it rethrows it. A
    // backend that isn't running surfaces as a plain Error, never as a
    // {"detail": ...} body, so this is the common failure during
    // development, not an edge case.
    expect(describeApiError(new TypeError('fetch failed'))).toBe('fetch failed')
  })

  it('reads a bare string error as itself', () => {
    expect(describeApiError('network error')).toBe('network error')
  })

  it('never renders the object literally, unlike String(error)', () => {
    const error = { detail: 'a real message' }
    // This is the bug being fixed: String(error) on a plain object always
    // reads "[object Object]", discarding the message entirely.
    expect(describeApiError(error)).not.toBe(String(error))
    expect(String(error)).toBe('[object Object]')
  })

  it('reads an ApiError the same way as a plain Error - the message it was built from', () => {
    const error = new ApiError({ detail: 'no such activity' }, 404)
    expect(describeApiError(error)).toBe('no such activity')
  })
})

describe('isNotFoundError (M9)', () => {
  it('is true for an ApiError carrying status 404, the one status this application ever treats as an absence', () => {
    expect(isNotFoundError(new ApiError({ detail: 'no such activity' }, 404))).toBe(true)
  })

  it('is false for an ApiError carrying any other status - a 503 is a failure, not an absence', () => {
    expect(isNotFoundError(new ApiError({ detail: 'store unavailable' }, 503))).toBe(false)
  })

  it('is false for a plain Error - the shape a network failure takes, which never reaches an HTTP status at all', () => {
    expect(isNotFoundError(new TypeError('fetch failed'))).toBe(false)
  })

  it('is false for null, undefined and a bare object, none of which are this application\'s own wrapped error', () => {
    expect(isNotFoundError(null)).toBe(false)
    expect(isNotFoundError(undefined)).toBe(false)
    expect(isNotFoundError({ detail: 'looks like a 404 body but was never wrapped' })).toBe(false)
  })
})
