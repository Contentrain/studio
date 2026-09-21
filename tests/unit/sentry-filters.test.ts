import { describe, expect, it } from 'vitest'
import { isExpectedHttpError } from '../../server/utils/sentry-filters'

describe('isExpectedHttpError (#296)', () => {
  it('drops 401/403/404 h3 errors', () => {
    expect(isExpectedHttpError({ statusCode: 401 })).toBe(true)
    expect(isExpectedHttpError({ statusCode: 403 })).toBe(true)
    expect(isExpectedHttpError({ statusCode: 404 })).toBe(true)
  })

  it('drops any 4xx, not just 401/403/404', () => {
    expect(isExpectedHttpError({ statusCode: 429 })).toBe(true)
  })

  it('keeps 5xx errors', () => {
    expect(isExpectedHttpError({ statusCode: 500 })).toBe(false)
    expect(isExpectedHttpError({ statusCode: 503 })).toBe(false)
  })

  it('keeps errors and values with no numeric statusCode', () => {
    expect(isExpectedHttpError(new Error('boom'))).toBe(false)
    expect(isExpectedHttpError(null)).toBe(false)
    expect(isExpectedHttpError(undefined)).toBe(false)
    expect(isExpectedHttpError('a string')).toBe(false)
    expect(isExpectedHttpError({ statusCode: '404' })).toBe(false)
  })

  it('is exact at the 400/500 boundaries', () => {
    expect(isExpectedHttpError({ statusCode: 399 })).toBe(false)
    expect(isExpectedHttpError({ statusCode: 400 })).toBe(true)
    expect(isExpectedHttpError({ statusCode: 499 })).toBe(true)
    expect(isExpectedHttpError({ statusCode: 500 })).toBe(false)
  })
})
