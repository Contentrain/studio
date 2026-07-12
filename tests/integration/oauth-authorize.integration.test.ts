import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

/**
 * /oauth/authorize gating — RFC 6749 error discipline (400 for unverifiable
 * client/redirect, error-redirects for everything after), PKCE enforcement,
 * resource validation, the login bounce and the consent hand-off.
 */

const state = vi.hoisted(() => ({
  session: null as { userId: string } | null,
  dcrClient: {
    clientId: 'dcr_test1234',
    kind: 'dcr' as const,
    clientName: 'Codex CLI',
    clientUri: null as string | null,
    logoUri: null as string | null,
    redirectUris: ['http://localhost/callback'],
    metadata: {},
    metadataFetchedAt: null as string | null,
  },
  rateCheck: { allowed: true, remaining: 29, retryAfterMs: 0 },
}))

vi.mock('~~/server/utils/oauth-server/store', () => ({
  getClient: vi.fn(async (id: string) => (id === state.dcrClient.clientId ? state.dcrClient : null)),
}))

vi.mock('~~/server/utils/oauth-server/cimd', () => ({
  isCimdClientId: (id: string) => id.startsWith('https://'),
  resolveCimdClient: vi.fn(async () => ({ ok: false, error: 'fetch disabled in tests' })),
}))

vi.mock('~~/server/utils/session', () => ({
  getServerSession: vi.fn(async () => state.session),
}))

vi.mock('~~/server/utils/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => state.rateCheck),
}))

const managedRuntimeConfig = {
  authProvider: 'managed',
  sessionSecret: 'test-session-secret-32-characters-min',
  public: { siteUrl: 'http://localhost:3000' },
}

async function loadHandler() {
  return (await import('../../server/routes/oauth/authorize.get')).default
}

function authorizeQuery(overrides: Record<string, string | null> = {}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: state.dcrClient.clientId,
    redirect_uri: 'http://localhost:54321/callback',
    scope: 'content:read content:write offline_access',
    state: 'client-state-1',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
  })
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) params.delete(key)
    else params.set(key, value)
  }
  return params.toString()
}

describe('GET /oauth/authorize', () => {
  beforeEach(() => {
    state.session = { userId: 'user-1' }
    state.rateCheck = { allowed: true, remaining: 29, retryAfterMs: 0 }
    vi.stubGlobal('useRuntimeConfig', () => managedRuntimeConfig)
  })

  async function request(query: string) {
    const handler = await loadHandler()
    return withTestServer({ routes: [{ path: '/oauth/authorize', handler }] }, async ({ request }) =>
      request(`/oauth/authorize?${query}`, { redirect: 'manual' }))
  }

  it('404s on the Supabase pair', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ ...managedRuntimeConfig, authProvider: 'supabase' }))
    const response = await request(authorizeQuery())
    expect(response.status).toBe(404)
  })

  it('400s without a client_id — never a redirect', async () => {
    const response = await request(authorizeQuery({ client_id: null }))
    expect(response.status).toBe(400)
  })

  it('400s for an unknown client', async () => {
    const response = await request(authorizeQuery({ client_id: 'dcr_unknown' }))
    expect(response.status).toBe(400)
  })

  it('400s for an unregistered redirect_uri — never a redirect', async () => {
    const response = await request(authorizeQuery({ redirect_uri: 'https://evil.example/cb' }))
    expect(response.status).toBe(400)
  })

  it('redirects back with unsupported_response_type', async () => {
    const response = await request(authorizeQuery({ response_type: 'token' }))
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location')!)
    expect(location.searchParams.get('error')).toBe('unsupported_response_type')
    expect(location.searchParams.get('state')).toBe('client-state-1')
  })

  it('requires PKCE: missing code_challenge → invalid_request', async () => {
    const response = await request(authorizeQuery({ code_challenge: null }))
    const location = new URL(response.headers.get('location')!)
    expect(location.searchParams.get('error')).toBe('invalid_request')
    expect(location.searchParams.get('error_description')).toMatch(/code_challenge/)
  })

  it('requires PKCE: plain method → invalid_request', async () => {
    const response = await request(authorizeQuery({ code_challenge_method: 'plain' }))
    const location = new URL(response.headers.get('location')!)
    expect(location.searchParams.get('error')).toBe('invalid_request')
    expect(location.searchParams.get('error_description')).toMatch(/S256/)
  })

  it('rejects unknown scopes with invalid_scope', async () => {
    const response = await request(authorizeQuery({ scope: 'content:read openid' }))
    const location = new URL(response.headers.get('location')!)
    expect(location.searchParams.get('error')).toBe('invalid_scope')
  })

  it('rejects a foreign resource with invalid_target (RFC 8707)', async () => {
    const response = await request(authorizeQuery({ resource: 'https://other.example/mcp' }))
    const location = new URL(response.headers.get('location')!)
    expect(location.searchParams.get('error')).toBe('invalid_target')
  })

  it('accepts our canonical resource (trailing slash normalized)', async () => {
    const response = await request(authorizeQuery({ resource: 'http://localhost:3000/api/mcp/remote/' }))
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/oauth/consent')
  })

  it('bounces to login preserving the full authorize request', async () => {
    state.session = null
    const response = await request(authorizeQuery())
    expect(response.status).toBe(302)
    const location = response.headers.get('location')!
    expect(location).toContain('/auth/login?redirect=')
    const redirect = decodeURIComponent(location.split('redirect=')[1]!)
    expect(redirect).toContain(`client_id=${state.dcrClient.clientId}`)
    expect(redirect).toContain('code_challenge=')
  })

  it('seals the flow cookie and redirects to consent on the happy path', async () => {
    const response = await request(authorizeQuery())
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/oauth/consent')
    const cookies = response.headers.getSetCookie().join('; ')
    expect(cookies).toContain('contentrain-oauth-authz=')
  })

  it('429s when the per-IP rate limit trips', async () => {
    state.rateCheck = { allowed: false, remaining: 0, retryAfterMs: 30_000 }
    const response = await request(authorizeQuery())
    expect(response.status).toBe(429)
  })
})
