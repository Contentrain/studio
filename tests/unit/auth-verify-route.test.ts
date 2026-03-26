import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function createErrorLike(input: { statusCode: number, message: string }) {
  return Object.assign(new Error(input.message), input)
}

async function loadHandler() {
  return (await import('../../server/api/auth/verify.post')).default
}

describe('auth verify route', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', createErrorLike)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects OAuth code exchange when the auth state is invalid', async () => {
    const exchangeCode = vi.fn()

    vi.stubGlobal('getHeader', vi.fn().mockReturnValue('127.0.0.1'))
    vi.stubGlobal('checkRateLimit', vi.fn().mockReturnValue({ allowed: true }))
    vi.stubGlobal('readBody', vi.fn().mockResolvedValue({
      code: 'oauth-code',
      state: 'bad-state',
    }))
    vi.stubGlobal('validateAuthState', vi.fn().mockResolvedValue(false))
    vi.stubGlobal('useAuthProvider', vi.fn().mockReturnValue({
      exchangeCode,
    }))
    vi.stubGlobal('setServerSession', vi.fn())

    const handler = await loadHandler()

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 403,
    })
    expect(exchangeCode).not.toHaveBeenCalled()
  })

  it('accepts token exchange flow without state and stores the server session', async () => {
    const exchangeTokens = vi.fn().mockResolvedValue({
      user: {
        id: 'user-1',
        email: 'user@example.com',
      },
      tokens: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: '2026-03-26T00:00:00.000Z',
      },
    })
    const setServerSession = vi.fn()

    vi.stubGlobal('getHeader', vi.fn().mockReturnValue('127.0.0.1'))
    vi.stubGlobal('checkRateLimit', vi.fn().mockReturnValue({ allowed: true }))
    vi.stubGlobal('readBody', vi.fn().mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    }))
    vi.stubGlobal('validateAuthState', vi.fn())
    vi.stubGlobal('useAuthProvider', vi.fn().mockReturnValue({
      exchangeTokens,
    }))
    vi.stubGlobal('setServerSession', setServerSession)

    const handler = await loadHandler()
    const result = await handler({} as never)

    expect(exchangeTokens).toHaveBeenCalledWith('access-token', 'refresh-token')
    expect(setServerSession).toHaveBeenCalledWith({} as never, {
      userId: 'user-1',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: '2026-03-26T00:00:00.000Z',
    })
    expect(result).toEqual({
      user: {
        id: 'user-1',
        email: 'user@example.com',
      },
    })
  })

  it('returns 429 when the verify endpoint exceeds the rate limit', async () => {
    vi.stubGlobal('getHeader', vi.fn().mockReturnValue('127.0.0.1'))
    vi.stubGlobal('checkRateLimit', vi.fn().mockReturnValue({ allowed: false }))
    vi.stubGlobal('readBody', vi.fn())
    vi.stubGlobal('useAuthProvider', vi.fn())
    vi.stubGlobal('setServerSession', vi.fn())

    const handler = await loadHandler()

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 429,
    })
  })
})
