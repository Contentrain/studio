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
      NUXT_SUPABASE_URL: process.env.NUXT_SUPABASE_URL ?? 'http://127.0.0.1:54321',
      NUXT_SUPABASE_ANON_KEY: process.env.NUXT_SUPABASE_ANON_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
      NUXT_SUPABASE_SERVICE_ROLE_KEY: process.env.NUXT_SUPABASE_SERVICE_ROLE_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
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
