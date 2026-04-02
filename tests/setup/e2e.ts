import { existsSync } from 'node:fs'
import { afterEach, vi } from 'vitest'

process.env.NUXT_SESSION_SECRET ??= 'test-session-secret-32-characters-min'
process.env.NUXT_PUBLIC_SITE_URL ??= 'http://localhost:3000'

// Supabase local development defaults (supabase start)
process.env.NUXT_SUPABASE_URL ??= 'http://127.0.0.1:54321'
process.env.NUXT_SUPABASE_ANON_KEY ??= 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
process.env.NUXT_SUPABASE_SERVICE_ROLE_KEY ??= 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

const browserCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/opt/homebrew/bin/chromium',
].filter((path): path is string => Boolean(path))

process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??= browserCandidates.find(path => existsSync(path))

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})
