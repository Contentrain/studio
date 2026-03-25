import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requireAuth } from '../../server/utils/auth'

describe('requireAuth', () => {
  beforeEach(() => {
    vi.stubGlobal('createError', ({ statusCode, message }: { statusCode: number, message: string }) =>
      Object.assign(new Error(message), { statusCode, message }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the auth payload from event context', () => {
    const auth = requireAuth({
      context: {
        auth: {
          user: { id: 'user-1', email: 'user@example.com' },
          accessToken: 'token-1',
        },
      },
    } as never)

    expect(auth).toEqual({
      user: { id: 'user-1', email: 'user@example.com' },
      accessToken: 'token-1',
    })
  })

  it('throws 401 when auth is missing', () => {
    expect(() => requireAuth({ context: {} } as never)).toThrow('Unauthorized')
  })
})
