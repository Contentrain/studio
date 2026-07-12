import { fileURLToPath } from 'node:url'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import { describe, expect, it } from 'vitest'

/**
 * Boot-path smoke for the managed + postgres provider pair.
 *
 * The sibling app-smoke suite boots the default supabase pair; this one
 * proves the alternate pair clears 00.validate-config and serves the
 * unauthenticated surface. NUXT_POSTGRES_URL points at a closed port on
 * purpose: the pg pool connects lazily and nothing below touches the
 * database, so a reachable Postgres is not required — which keeps this
 * suite runnable in every environment the supabase smoke runs in.
 */
await setup({
  rootDir: fileURLToPath(new URL('../..', import.meta.url)),
  port: 4327,
  env: {
    NUXT_SESSION_SECRET: 'test-session-secret-32-characters-min',
    // nuxt-auth-utils module session — the /api/_auth/session assertion
    // below regresses the "Empty password → 500 on every SSR load" gap.
    NUXT_SESSION_PASSWORD: 'test-module-session-password-32-chars',
    NUXT_PUBLIC_SITE_URL: 'http://localhost:3000',
    NUXT_AUTH_PROVIDER: 'managed',
    NUXT_DATABASE_PROVIDER: 'postgres',
    NUXT_POSTGRES_URL: 'postgres://postgres:postgres@127.0.0.1:59999/unreachable',
    NUXT_AUTH_JWT_SECRET: 'test-managed-jwt-secret-32-characters',
    NUXT_RESEND_API_KEY: 're_test_dummy_key',
    NUXT_OAUTH_GITHUB_CLIENT_ID: 'test-oauth-github-client-id',
    NUXT_OAUTH_GITHUB_CLIENT_SECRET: 'test-oauth-github-client-secret',
    NUXT_PUBLIC_DEPLOYMENT_PROFILE: 'community',
    NUXT_PUBLIC_DEPLOYMENT_EDITION: 'agpl',
    NUXT_PUBLIC_DEPLOYMENT_BILLING_MODE: 'off',
  },
})

describe('app smoke (managed + postgres pair)', () => {
  it('boots through validate-config and serves the health endpoint', async () => {
    const payload = await $fetch<{ status: string, timestamp: string }>('/api/health')

    expect(payload.status).toBe('ok')
    expect(Date.parse(payload.timestamp)).not.toBeNaN()
  })

  it('renders the public login page', async () => {
    const response = await fetch('/auth/login')
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('<div id="__nuxt"></div>')
    expect(html).toContain('__NUXT_DATA__')
  })

  it('rejects anonymous access to the auth session endpoint', async () => {
    const response = await fetch('/api/auth/me')

    expect(response.status).toBe(401)
  })

  it('serves the nuxt-auth-utils module session endpoint without 500', async () => {
    // Regression pin for two production gaps found on staging: the module
    // session route must be reachable without a Studio session (middleware
    // PUBLIC_PATHS), and sealing a fresh module session must not throw
    // "Empty password" (NUXT_SESSION_PASSWORD set in the env block above).
    const response = await fetch('/api/_auth/session')

    expect(response.status).toBe(200)
    // Anonymous module session: a bare session id, never a user.
    const body = await response.json() as Record<string, unknown>
    expect(body.user).toBeUndefined()
  })

  // ── OAuth AS surface (remote MCP) ──
  // These pin that Nitro actually registers the server/routes/ endpoints in
  // a real boot — including the `.well-known` DOT-directory, which no
  // handler-level integration test can prove.

  it('serves RFC 8414 authorization-server metadata from the well-known path', async () => {
    const response = await fetch('/.well-known/oauth-authorization-server')
    expect(response.status).toBe(200)

    const meta = await response.json() as Record<string, unknown>
    expect(meta.issuer).toBe('http://localhost:3000')
    expect(meta.authorization_endpoint).toBe('http://localhost:3000/oauth/authorize')
    expect(meta.code_challenge_methods_supported).toEqual(['S256'])
    // The CIMD selection pair Claude checks before choosing CIMD over DCR.
    expect(meta.client_id_metadata_document_supported).toBe(true)
    expect(meta.token_endpoint_auth_methods_supported).toEqual(['none'])
  })

  it('serves the OIDC discovery alias', async () => {
    const response = await fetch('/.well-known/openid-configuration')
    expect(response.status).toBe(200)
    const meta = await response.json() as Record<string, unknown>
    expect(meta.issuer).toBe('http://localhost:3000')
  })

  it('answers the token endpoint with RFC 6749 error JSON (no DB required)', async () => {
    const response = await fetch('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    })
    expect(response.status).toBe(400)
    const body = await response.json() as Record<string, unknown>
    expect(body.error).toBe('unsupported_grant_type')
  })

  it('rejects DCR registrations with invalid redirect URIs', async () => {
    const response = await fetch('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://example.com/cb'] }),
    })
    expect(response.status).toBe(400)
    const body = await response.json() as Record<string, unknown>
    expect(body.error).toBe('invalid_redirect_uri')
  })

  it('400s an authorize request without a client_id', async () => {
    const response = await fetch('/oauth/authorize')
    expect(response.status).toBe(400)
  })
})
