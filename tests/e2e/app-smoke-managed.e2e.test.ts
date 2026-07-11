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
})
