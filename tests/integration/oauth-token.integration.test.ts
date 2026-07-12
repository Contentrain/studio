import { createHash, randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

/**
 * /oauth/token — form-urlencoded handling, PKCE verification, RFC 6749
 * error codes (a dead refresh token MUST read invalid_grant or Claude never
 * re-runs the auth flow) and refresh rotation returning the new RT in the
 * same response.
 */

const VERIFIER = randomBytes(32).toString('base64url')
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')

const state = vi.hoisted(() => ({
  codeRow: null as Record<string, unknown> | null,
  rotated: null as Record<string, unknown> | null,
  grantId: 'grant-1',
  issued: { accessTokens: 0, refreshTokens: 0 },
  rateCheck: { allowed: true, remaining: 59, retryAfterMs: 0 },
}))

vi.mock('~~/server/utils/oauth-server/store', () => ({
  consumeAuthorizationCode: vi.fn(async () => state.codeRow),
  upsertGrant: vi.fn(async () => ({ grantId: state.grantId })),
  issueAccessToken: vi.fn(async () => {
    state.issued.accessTokens += 1
    return { token: `crn_oat_${'a'.repeat(64)}`, expiresIn: 3600 }
  }),
  issueRefreshToken: vi.fn(async () => {
    state.issued.refreshTokens += 1
    return `crn_ort_${'b'.repeat(64)}`
  }),
  rotateRefreshToken: vi.fn(async () => state.rotated),
  cleanupExpired: vi.fn(async () => {}),
  touchClient: vi.fn(async () => {}),
}))

vi.mock('~~/server/utils/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => state.rateCheck),
}))

const managedRuntimeConfig = {
  authProvider: 'managed',
  sessionSecret: 'test-session-secret-32-characters-min',
  public: { siteUrl: 'http://localhost:3000' },
}

function validCodeRow(overrides: Record<string, unknown> = {}) {
  return {
    clientId: 'dcr_test1234',
    userId: 'user-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    redirectUri: 'http://localhost:54321/callback',
    scope: 'content:read content:write offline_access',
    codeChallenge: CHALLENGE,
    codeChallengeMethod: 'S256',
    resource: null,
    ...overrides,
  }
}

function tokenBody(overrides: Record<string, string | null> = {}): URLSearchParams {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: `oac_${'c'.repeat(64)}`,
    redirect_uri: 'http://localhost:54321/callback',
    client_id: 'dcr_test1234',
    code_verifier: VERIFIER,
  })
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) params.delete(key)
    else params.set(key, value)
  }
  return params
}

describe('POST /oauth/token', () => {
  beforeEach(() => {
    state.codeRow = validCodeRow()
    state.rotated = null
    state.issued = { accessTokens: 0, refreshTokens: 0 }
    state.rateCheck = { allowed: true, remaining: 59, retryAfterMs: 0 }
    vi.stubGlobal('useRuntimeConfig', () => managedRuntimeConfig)
  })

  async function post(body: URLSearchParams) {
    const handler = (await import('../../server/routes/oauth/token.post')).default
    return withTestServer({ routes: [{ path: '/oauth/token', handler }] }, async ({ request }) =>
      request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }))
  }

  it('exchanges a code for tokens over form-urlencoded', async () => {
    const response = await post(tokenBody())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')

    const json = await response.json()
    expect(json).toMatchObject({
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'content:read content:write offline_access',
    })
    expect(json.access_token).toMatch(/^crn_oat_/)
    expect(json.refresh_token).toMatch(/^crn_ort_/)
  })

  it('omits the refresh token when offline_access was not granted', async () => {
    state.codeRow = validCodeRow({ scope: 'content:read' })
    const response = await post(tokenBody())
    const json = await response.json()
    expect(json.refresh_token).toBeUndefined()
    expect(state.issued.refreshTokens).toBe(0)
  })

  it('replayed/expired codes → invalid_grant', async () => {
    state.codeRow = null
    const response = await post(tokenBody())
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_grant' })
  })

  it('client_id mismatch → invalid_grant', async () => {
    const response = await post(tokenBody({ client_id: 'dcr_other' }))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_grant' })
  })

  it('redirect_uri mismatch → invalid_grant', async () => {
    const response = await post(tokenBody({ redirect_uri: 'http://localhost:54321/other' }))
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_grant' })
  })

  it('PKCE verifier mismatch → invalid_grant', async () => {
    const response = await post(tokenBody({ code_verifier: randomBytes(32).toString('base64url') }))
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_grant' })
  })

  it('foreign resource → invalid_target', async () => {
    const response = await post(tokenBody({ resource: 'https://other.example/mcp' }))
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_target' })
  })

  it('missing parameters → invalid_request', async () => {
    const response = await post(tokenBody({ code_verifier: null }))
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' })
  })

  it('rotates refresh tokens and returns the new RT in the same response', async () => {
    state.rotated = {
      grant: { grantId: 'grant-1', userId: 'user-1', clientId: 'dcr_test1234', workspaceId: 'ws-1', projectId: 'proj-1', scope: 'content:read offline_access' },
      accessToken: `crn_oat_${'d'.repeat(64)}`,
      accessTokenExpiresIn: 3600,
      refreshToken: `crn_ort_${'e'.repeat(64)}`,
    }
    const response = await post(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: `crn_ort_${'b'.repeat(64)}`,
    }))
    const json = await response.json()
    expect(json.refresh_token).toBe(`crn_ort_${'e'.repeat(64)}`)
    expect(json.scope).toBe('content:read offline_access')
  })

  it('refresh with a foreign client_id → invalid_grant', async () => {
    state.rotated = {
      grant: { grantId: 'grant-1', userId: 'user-1', clientId: 'dcr_test1234', workspaceId: 'ws-1', projectId: 'proj-1', scope: 'content:read offline_access' },
      accessToken: `crn_oat_${'d'.repeat(64)}`,
      accessTokenExpiresIn: 3600,
      refreshToken: `crn_ort_${'e'.repeat(64)}`,
    }
    const response = await post(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: `crn_ort_${'b'.repeat(64)}`,
      client_id: 'dcr_other',
    }))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_grant' })
  })

  it('dead refresh tokens → invalid_grant (Claude re-auth signal)', async () => {
    state.rotated = null
    const response = await post(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'crn_ort_dead',
    }))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_grant' })
  })

  it('unknown grant types → unsupported_grant_type', async () => {
    const response = await post(new URLSearchParams({ grant_type: 'client_credentials' }))
    await expect(response.json()).resolves.toMatchObject({ error: 'unsupported_grant_type' })
  })

  it('404s on the Supabase pair', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ ...managedRuntimeConfig, authProvider: 'supabase' }))
    const response = await post(tokenBody())
    expect(response.status).toBe(404)
  })

  it('429s with Retry-After when rate limited', async () => {
    state.rateCheck = { allowed: false, remaining: 0, retryAfterMs: 42_000 }
    const response = await post(tokenBody())
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('42')
  })
})
