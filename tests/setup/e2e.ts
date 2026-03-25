import { existsSync } from 'node:fs'
import { afterEach, vi } from 'vitest'

process.env.NUXT_SESSION_SECRET ??= 'test-session-secret-32-characters-min'
process.env.NUXT_PUBLIC_SITE_URL ??= 'http://localhost:3000'

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
