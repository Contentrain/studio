import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

const consumeMagicLinkToken = vi.fn()

vi.mock('../../server/providers/managed-auth', () => ({
  consumeMagicLinkToken: (...args: unknown[]) => consumeMagicLinkToken(...args),
}))

async function loadVerifyHandler() {
  return (await import('../../server/api/auth/magic/verify.get')).default
}

function stubManagedRuntime() {
  vi.stubGlobal('useRuntimeConfig', () => ({
    authProvider: 'managed',
    sessionSecret: 'test-session-secret-32-characters-min',
    public: { siteUrl: 'https://studio.example.com' },
  }))
}

describe('managed magic-link / invite landing', () => {
  async function landWith(redirect: string) {
    stubManagedRuntime()
    consumeMagicLinkToken.mockResolvedValue({
      user: { id: 'user-1' },
      tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAt: 4_000_000_000 },
    })

    let location: string | null = null
    await withTestServer({
      routes: [{ path: '/api/auth/magic/verify', handler: await loadVerifyHandler() }],
    }, async ({ request }) => {
      const response = await request(`/api/auth/magic/verify?token=inv_abc&redirect=${encodeURIComponent(redirect)}`, {
        redirect: 'manual',
      })
      expect(response.status).toBe(302)
      expect(response.headers.get('set-cookie')).toContain('contentrain-session=')
      location = response.headers.get('location')
    })
    return location
  }

  it('keeps the invited workspace from an absolute same-origin invite target', async () => {
    await expect(landWith('https://studio.example.com/auth/callback?workspace=lanista-software'))
      .resolves.toBe('/auth/callback?workspace=lanista-software')
  })

  it('passes internal paths through', async () => {
    await expect(landWith('/auth/callback?redirect=%2Fw%2Facme')).resolves.toBe('/auth/callback?redirect=%2Fw%2Facme')
  })

  it('never redirects off-site', async () => {
    await expect(landWith('https://evil.example.com/auth/callback')).resolves.toBe('/')
    await expect(landWith('//evil.example.com')).resolves.toBe('/')
    await expect(landWith('/\\evil.example.com')).resolves.toBe('/')
  })
})
