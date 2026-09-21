import { describe, expect, it } from 'vitest'
import { isExpectedHttpError } from '../../server/utils/sentry-filters'

/** Shape of a real `createError()` result — `unhandled` defaults to `false`. */
function h3Error(statusCode: number) {
  return { statusCode, unhandled: false }
}

describe('isExpectedHttpError (#296)', () => {
  it('drops 401/403/404 h3 errors', () => {
    expect(isExpectedHttpError(h3Error(401))).toBe(true)
    expect(isExpectedHttpError(h3Error(403))).toBe(true)
    expect(isExpectedHttpError(h3Error(404))).toBe(true)
  })

  it('drops any 4xx, not just 401/403/404', () => {
    expect(isExpectedHttpError(h3Error(429))).toBe(true)
  })

  it('keeps 5xx errors', () => {
    expect(isExpectedHttpError(h3Error(500))).toBe(false)
    expect(isExpectedHttpError(h3Error(503))).toBe(false)
  })

  it('keeps errors and values with no numeric statusCode', () => {
    expect(isExpectedHttpError(new Error('boom'))).toBe(false)
    expect(isExpectedHttpError(null)).toBe(false)
    expect(isExpectedHttpError(undefined)).toBe(false)
    expect(isExpectedHttpError('a string')).toBe(false)
    expect(isExpectedHttpError({ statusCode: '404', unhandled: false })).toBe(false)
  })

  it('is exact at the 400/500 boundaries', () => {
    expect(isExpectedHttpError(h3Error(399))).toBe(false)
    expect(isExpectedHttpError(h3Error(400))).toBe(true)
    expect(isExpectedHttpError(h3Error(499))).toBe(true)
    expect(isExpectedHttpError(h3Error(500))).toBe(false)
  })

  it('keeps a 4xx that is not a genuine h3 createError() result (regression for #299 review)', () => {
    // ofetch's FetchError can carry a `statusCode`-shaped field from an
    // outbound HTTP call — an unrelated failure this must not swallow.
    expect(isExpectedHttpError({ statusCode: 404 })).toBe(false)
    expect(isExpectedHttpError({ statusCode: 404, status: 404 })).toBe(false)
  })

  it('keeps a 4xx h3 error h3 had to wrap unexpectedly (unhandled: true)', () => {
    expect(isExpectedHttpError({ statusCode: 404, unhandled: true })).toBe(false)
  })
})
