import { afterEach, describe, expect, it, vi } from 'vitest'
import { TestCookieJar, withTestServer } from '../helpers/http'

async function loadLoginHandler() {
  return (await import('../../server/api/auth/login.post')).default
}

async function loadVerifyHandler() {
  return (await import('../../server/api/auth/verify.post')).default
}

async function loadMeHandler() {
  return (await import('../../server/api/auth/me.get')).default
}

async function loadLogoutHandler() {
  return (await import('../../server/api/auth/logout.post')).default
}

async function loadAuthMiddleware() {
  return (await import('../../server/middleware/auth')).default
}

describe('auth route integration', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects invalid OAuth providers over HTTP', async () => {
    vi.stubGlobal('useAuthProvider', vi.fn().mockReturnValue({
      getOAuthRedirectUrl: vi.fn(),
    }))

    await withTestServer({
      routes: [
        { path: '/api/auth/login', handler: await loadLoginHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'discord' }),
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        statusCode: 400,
      })
    })
  })

  it('writes an auth-state cookie when OAuth login starts', async () => {
    const getOAuthRedirectUrl = vi.fn().mockResolvedValue({
      url: 'https://github.com/login/oauth/authorize',
      state: 'oauth-state-1',
    })

    vi.stubGlobal('useAuthProvider', vi.fn().mockReturnValue({
      getOAuthRedirectUrl,
    }))

    await withTestServer({
      routes: [
        { path: '/api/auth/login', handler: await loadLoginHandler() },
      ],
    }, async ({ request }) => {
      const jar = new TestCookieJar()
      const response = await request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'github', redirectTo: '/auth/callback' }),
      })

      jar.absorb(response)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        url: 'https://github.com/login/oauth/authorize',
        state: 'oauth-state-1',
      })
      expect(getOAuthRedirectUrl).toHaveBeenCalledWith('github', '/auth/callback')
      expect(jar.has('contentrain-auth-state')).toBe(true)
    })
  })

  it('stores an encrypted session cookie for token exchange flows', async () => {
    const exchangeTokens = vi.fn().mockResolvedValue({
      user: {
        id: 'user-1',
        email: 'user@example.com',
      },
      tokens: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    })

    vi.stubGlobal('useAuthProvider', vi.fn().mockReturnValue({
      exchangeTokens,
    }))

    await withTestServer({
      routes: [
        { path: '/api/auth/verify', handler: await loadVerifyHandler() },
      ],
    }, async ({ request }) => {
      const jar = new TestCookieJar()
      const response = await request('/api/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
        }),
      })

      jar.absorb(response)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        user: {
          id: 'user-1',
          email: 'user@example.com',
        },
      })
      expect(exchangeTokens).toHaveBeenCalledWith('access-token', 'refresh-token')
      expect(jar.has('contentrain-session')).toBe(true)
    })
  })

  it('refreshes expiring sessions and clears them on logout', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'))

    const authProvider = {
      exchangeTokens: vi.fn().mockResolvedValue({
        user: {
          id: 'user-1',
          email: 'user@example.com',
        },
        tokens: {
          accessToken: 'stale-access-token',
          refreshToken: 'refresh-token',
          expiresAt: Math.floor(Date.now() / 1000) - 10,
        },
      }),
      refreshSession: vi.fn().mockResolvedValue({
        accessToken: 'fresh-access-token',
        refreshToken: 'fresh-refresh-token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
      validateToken: vi.fn().mockImplementation(async (accessToken: string) => {
        if (!['stale-access-token', 'fresh-access-token'].includes(accessToken))
          return null

        return {
          id: 'user-1',
          email: 'user@example.com',
          provider: 'github',
        }
      }),
    }

    vi.stubGlobal('useAuthProvider', vi.fn().mockReturnValue(authProvider))

    await withTestServer({
      middleware: [await loadAuthMiddleware()],
      routes: [
        { path: '/api/auth/verify', handler: await loadVerifyHandler() },
        { path: '/api/auth/me', handler: await loadMeHandler() },
        { path: '/api/auth/logout', handler: await loadLogoutHandler() },
      ],
    }, async ({ request }) => {
      const jar = new TestCookieJar()

      const verifyResponse = await request('/api/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          accessToken: 'stale-access-token',
          refreshToken: 'refresh-token',
        }),
      })
      jar.absorb(verifyResponse)

      const meResponse = await request('/api/auth/me', {
        headers: { cookie: jar.header() },
      })
      jar.absorb(meResponse)

      expect(meResponse.status).toBe(200)
      await expect(meResponse.json()).resolves.toEqual({
        user: {
          id: 'user-1',
          email: 'user@example.com',
          provider: 'github',
        },
      })
      expect(authProvider.refreshSession).toHaveBeenCalledWith('refresh-token')
      expect(authProvider.validateToken).toHaveBeenCalledWith('fresh-access-token')
      expect(jar.has('contentrain-session')).toBe(true)

      const logoutResponse = await request('/api/auth/logout', {
        method: 'POST',
        headers: { cookie: jar.header() },
      })
      jar.absorb(logoutResponse)

      expect(logoutResponse.status).toBe(200)
      await expect(logoutResponse.json()).resolves.toEqual({ ok: true })
      expect(jar.has('contentrain-session')).toBe(false)

      const anonymousMe = await request('/api/auth/me', {
        headers: { cookie: jar.header() },
      })

      expect(anonymousMe.status).toBe(401)
    })
  })
})
