import { afterEach, vi } from 'vitest'

process.env.NUXT_SESSION_SECRET ??= 'test-session-secret-32-characters-min'
process.env.NUXT_PUBLIC_SITE_URL ??= 'http://localhost:3000'

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})
