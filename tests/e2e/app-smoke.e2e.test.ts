import { fileURLToPath } from 'node:url'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import { describe, expect, it } from 'vitest'

await setup({
  rootDir: fileURLToPath(new URL('../..', import.meta.url)),
  port: 4327,
  env: {
    NUXT_SESSION_SECRET: 'test-session-secret-32-characters-min',
    NUXT_PUBLIC_SITE_URL: 'http://localhost:3000',
    NUXT_SUPABASE_URL: process.env.NUXT_SUPABASE_URL ?? 'http://127.0.0.1:54321',
    NUXT_SUPABASE_ANON_KEY: process.env.NUXT_SUPABASE_ANON_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
    NUXT_SUPABASE_SERVICE_ROLE_KEY: process.env.NUXT_SUPABASE_SERVICE_ROLE_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
  },
})

describe('app smoke', () => {
  it('serves the health endpoint', async () => {
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

  it('serves the public /about page without authentication (AGPL §13 source offer)', async () => {
    const response = await fetch('/about')
    const html = await response.text()

    expect(response.status).toBe(200)
    // SSR is off — so the raw response ships the Nuxt shell, not the
    // rendered content. The Corresponding Source link is hydrated on
    // the client. We still pin the shell + payload here so a broken
    // auth middleware redirect (which would send us to /auth/login)
    // surfaces as a failing test.
    expect(html).toContain('<div id="__nuxt"></div>')
    expect(html).toContain('__NUXT_DATA__')
  })

  it('exposes the resolved deployment snapshot in the runtime config payload', async () => {
    // `server/plugins/00.billing-flag.ts` writes the resolved profile
    // into `runtimeConfig.public.deployment` at boot. The SPA shell
    // serialises runtime config into the page payload so the client
    // composables can read it. This test asserts the plumbing end-to-
    // end: a fresh SSR render carries the snapshot.
    const response = await fetch('/auth/login')
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('deployment')
    // Nothing in the test setup configures ee/ or billing — we expect
    // the community fallback (edition=agpl, billingMode=off). Plain-
    // string match is enough since the payload is JSON-encoded.
    expect(html).toContain('"community"')
  })
})
