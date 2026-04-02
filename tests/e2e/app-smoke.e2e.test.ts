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
})
