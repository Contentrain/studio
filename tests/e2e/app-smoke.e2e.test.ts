import { fileURLToPath } from 'node:url'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import { describe, expect, it } from 'vitest'

await setup({
  rootDir: fileURLToPath(new URL('../..', import.meta.url)),
  port: 4327,
  env: {
    NUXT_SESSION_SECRET: 'test-session-secret-32-characters-min',
    NUXT_PUBLIC_SITE_URL: 'http://localhost:3000',
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
