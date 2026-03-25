import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setup } from '@nuxt/test-utils/e2e'
import type { Route } from 'playwright-core'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))

function resolveChromiumExecutablePath() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/opt/homebrew/bin/chromium',
  ].filter((path): path is string => Boolean(path))

  return candidates.find(path => existsSync(path))
}

export async function setupBrowserE2E(port: number) {
  await setup({
    rootDir,
    port,
    env: {
      NUXT_SESSION_SECRET: 'test-session-secret-32-characters-min',
      NUXT_PUBLIC_SITE_URL: 'http://localhost:3000',
    },
    browserOptions: {
      type: 'chromium',
      launch: {
        headless: true,
        executablePath: resolveChromiumExecutablePath(),
      },
    },
  })
}

export async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

export function ssePayload(events: unknown[]) {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
}
