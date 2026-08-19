import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

/**
 * /oauth/register — DCR (RFC 7591). Public clients only; redirect URI
 * hygiene; RFC-shaped registration errors.
 */

const state = vi.hoisted(() => ({
  rateCheck: { allowed: true, remaining: 9, retryAfterMs: 0 },
  created: [] as Array<Record<string, unknown>>,
}))

vi.mock('~~/server/utils/oauth-server/store', () => ({
  createDcrClient: vi.fn(async (input: Record<string, unknown>) => {
    state.created.push(input)
    return {
      clientId: 'dcr_new123',
      kind: 'dcr',
      clientName: input.clientName ?? null,
      clientUri: input.clientUri ?? null,
      logoUri: input.logoUri ?? null,
      redirectUris: input.redirectUris,
      metadata: input.metadata,
      metadataFetchedAt: null,
    }
  }),
}))

vi.mock('~~/server/utils/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => state.rateCheck),
}))

const managedRuntimeConfig = {
  authProvider: 'managed',
  sessionSecret: 'test-session-secret-32-characters-min',
  public: { siteUrl: 'http://localhost:3000' },
}

describe('POST /oauth/register', () => {
  beforeEach(() => {
    state.rateCheck = { allowed: true, remaining: 9, retryAfterMs: 0 }
    state.created = []
    vi.stubGlobal('useRuntimeConfig', () => managedRuntimeConfig)
  })

  async function post(body: unknown) {
    const handler = (await import('../../server/routes/oauth/register.post')).default
    return withTestServer({ routes: [{ path: '/oauth/register', handler }] }, async ({ request }) =>
      request('/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }))
  }

  it('registers a public client and echoes the metadata (201)', async () => {
    const response = await post({
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    })

    expect(response.status).toBe(201)
    const json = await response.json()
    expect(json.client_id).toBe('dcr_new123')
    expect(json.token_endpoint_auth_method).toBe('none')
    expect(json.redirect_uris).toEqual(['https://claude.ai/api/mcp/auth_callback'])
    expect(json.grant_types).toEqual(['authorization_code', 'refresh_token'])
    expect(json.client_secret).toBeUndefined()
  })

  it('defaults grant/response types when omitted', async () => {
    const response = await post({ redirect_uris: ['http://localhost/callback'] })
    const json = await response.json()
    expect(json.grant_types).toEqual(['authorization_code'])
    expect(json.response_types).toEqual(['code'])
  })

  it('rejects http redirect URIs on non-loopback hosts', async () => {
    const response = await post({ redirect_uris: ['http://example.com/cb'] })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_redirect_uri' })
  })

  it('rejects missing redirect_uris', async () => {
    const response = await post({ client_name: 'No redirects' })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_redirect_uri' })
  })

  it('rejects confidential-client registrations', async () => {
    const response = await post({
      redirect_uris: ['https://claude.ai/cb'],
      token_endpoint_auth_method: 'client_secret_basic',
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_client_metadata' })
  })

  it('rejects unsupported grant types', async () => {
    const response = await post({
      redirect_uris: ['https://claude.ai/cb'],
      grant_types: ['client_credentials'],
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_client_metadata' })
  })

  it('404s on the Supabase pair', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ ...managedRuntimeConfig, authProvider: 'supabase' }))
    const response = await post({ redirect_uris: ['https://claude.ai/cb'] })
    expect(response.status).toBe(404)
  })

  it('429s when the per-IP rate limit trips (Claude DCR flooding guard)', async () => {
    state.rateCheck = { allowed: false, remaining: 0, retryAfterMs: 60_000 }
    const response = await post({ redirect_uris: ['https://claude.ai/cb'] })
    expect(response.status).toBe(429)
  })
})
