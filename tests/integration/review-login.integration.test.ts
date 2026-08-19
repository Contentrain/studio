import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

/**
 * Directory-review support surfaces: the env-gated password login (exists
 * ONLY with full env opt-in on the managed pair; timing-safe check; sets
 * the session cookie) and the OpenAI domain-verification token route.
 */

const state = vi.hoisted(() => ({
  rateCheck: { allowed: true, remaining: 4, retryAfterMs: 0 },
  createReviewSession: vi.fn(),
}))

vi.mock('~~/server/providers/managed-auth', () => ({
  createReviewSession: state.createReviewSession,
}))

vi.mock('~~/server/utils/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => state.rateCheck),
}))

vi.mock('~~/server/utils/content-strings', () => ({
  errorMessage: (key: string) => key,
}))

const REVIEW_EMAIL = 'reviewer@contentrain.io'
const REVIEW_PASSWORD = 'a-long-review-password'

function runtimeConfig(overrides: Record<string, unknown> = {}) {
  return {
    authProvider: 'managed',
    sessionSecret: 'test-session-secret-32-characters-min',
    public: { siteUrl: 'http://localhost:3000' },
    reviewAccount: { email: REVIEW_EMAIL, password: REVIEW_PASSWORD },
    openaiAppsChallenge: '',
    ...overrides,
  }
}

describe('POST /api/auth/review-login', () => {
  beforeEach(() => {
    state.rateCheck = { allowed: true, remaining: 4, retryAfterMs: 0 }
    state.createReviewSession.mockResolvedValue({
      user: { id: 'user-review', email: REVIEW_EMAIL, avatarUrl: null, provider: 'email', providerAccountId: null },
      tokens: { accessToken: 'jwt-review', refreshToken: 'crt_review', expiresAt: Math.floor(Date.now() / 1000) + 3600 },
    })
    vi.stubGlobal('useRuntimeConfig', () => runtimeConfig())
  })

  async function post(body: unknown) {
    const handler = (await import('../../server/api/auth/review-login.post')).default
    return withTestServer({ routes: [{ path: '/api/auth/review-login', handler }] }, async ({ request }) =>
      request('/api/auth/review-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }))
  }

  it('signs the reviewer in and sets the session cookie', async () => {
    const response = await post({ email: REVIEW_EMAIL, password: REVIEW_PASSWORD })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(response.headers.getSetCookie().join('; ')).toContain('contentrain-session=')
    expect(state.createReviewSession).toHaveBeenCalledWith(REVIEW_EMAIL)
  })

  it('accepts the configured address case-insensitively', async () => {
    const response = await post({ email: 'Reviewer@Contentrain.IO', password: REVIEW_PASSWORD })
    expect(response.status).toBe(200)
  })

  it('rejects a wrong password or a foreign email with 401', async () => {
    expect((await post({ email: REVIEW_EMAIL, password: 'wrong-password-here' })).status).toBe(401)
    expect((await post({ email: 'other@contentrain.io', password: REVIEW_PASSWORD })).status).toBe(401)
    expect(state.createReviewSession).not.toHaveBeenCalled()
  })

  it('does not exist without the env opt-in', async () => {
    vi.stubGlobal('useRuntimeConfig', () => runtimeConfig({ reviewAccount: { email: '', password: '' } }))
    expect((await post({ email: REVIEW_EMAIL, password: REVIEW_PASSWORD })).status).toBe(404)
  })

  it('does not exist with a partial opt-in or a short password', async () => {
    vi.stubGlobal('useRuntimeConfig', () => runtimeConfig({ reviewAccount: { email: REVIEW_EMAIL, password: '' } }))
    expect((await post({ email: REVIEW_EMAIL, password: REVIEW_PASSWORD })).status).toBe(404)

    vi.stubGlobal('useRuntimeConfig', () => runtimeConfig({ reviewAccount: { email: REVIEW_EMAIL, password: 'short' } }))
    expect((await post({ email: REVIEW_EMAIL, password: 'short' })).status).toBe(404)
  })

  it('does not exist on the Supabase pair', async () => {
    vi.stubGlobal('useRuntimeConfig', () => runtimeConfig({ authProvider: 'supabase' }))
    expect((await post({ email: REVIEW_EMAIL, password: REVIEW_PASSWORD })).status).toBe(404)
  })

  it('rate limits attempts per IP', async () => {
    state.rateCheck = { allowed: false, remaining: 0, retryAfterMs: 60_000 }
    expect((await post({ email: REVIEW_EMAIL, password: REVIEW_PASSWORD })).status).toBe(429)
  })
})

describe('GET /.well-known/openai-apps-challenge', () => {
  async function get(token: string) {
    vi.stubGlobal('useRuntimeConfig', () => runtimeConfig({ openaiAppsChallenge: token }))
    const handler = (await import('../../server/routes/.well-known/openai-apps-challenge.get')).default
    return withTestServer({ routes: [{ path: '/.well-known/openai-apps-challenge', handler }] }, async ({ request }) =>
      request('/.well-known/openai-apps-challenge'))
  }

  it('serves the verification token as plain text', async () => {
    const response = await get('openai-verify-abc123')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    await expect(response.text()).resolves.toBe('openai-verify-abc123')
  })

  it('404s when no token is configured', async () => {
    const response = await get('')
    expect(response.status).toBe(404)
  })
})
