import { createPage, url } from '@nuxt/test-utils/e2e'
import type { Page } from 'playwright-core'
import { describe, expect, it } from 'vitest'
import { fulfillJson, setupBrowserE2E, ssePayload } from './helpers'

await setupBrowserE2E(4327)

const workspaceBase = {
  id: 'ws-1',
  name: 'Acme',
  slug: 'acme',
  type: 'primary',
  owner_id: 'user-1',
  logo_url: null,
  github_installation_id: 42,
  created_at: '2026-03-25T00:00:00.000Z',
}

const project = {
  id: 'project-1',
  workspace_id: 'ws-1',
  repo_full_name: 'acme/site',
  default_branch: 'main',
  content_root: '.',
  detected_stack: 'nuxt',
  status: 'active',
  created_at: '2026-03-25T00:00:00.000Z',
}

async function mockProjectShell(page: Page, options: {
  role: 'owner' | 'admin' | 'member'
  plan: string
  cdnEnabled?: boolean
}) {
  await page.route('**/api/auth/me', async route => fulfillJson(route, {
    user: {
      id: 'user-1',
      email: 'owner@example.com',
      avatarUrl: null,
      provider: 'github',
    },
  }))

  await page.route('**/api/workspaces', async route => fulfillJson(route, [{
    ...workspaceBase,
    plan: options.plan,
    workspace_members: [{ role: options.role }],
  }]))

  await page.route('**/api/workspaces/ws-1/projects', async route => fulfillJson(route, [project]))
  await page.route('**/api/workspaces/ws-1/projects/project-1/conversations', async route => fulfillJson(route, []))
  await page.route('**/api/workspaces/ws-1/projects/project-1/branches', async route => fulfillJson(route, {
    branches: [],
  }))
  await page.route('**/api/workspaces/ws-1/projects/project-1/snapshot', async route => fulfillJson(route, {
    exists: true,
    config: { locales: { supported: ['en'], default: 'en' } },
    models: [],
    content: {},
  }))
  await page.route('**/api/workspaces/ws-1/projects/project-1/cdn/settings', async route => fulfillJson(route, {
    cdn_enabled: options.cdnEnabled ?? false,
    cdn_branch: null,
  }))
  await page.route('**/api/workspaces/ws-1/projects/project-1/cdn/builds', async route => fulfillJson(route, []))
}

describe('cdn panel e2e', () => {
  it('keeps CDN controls read-only for non-admin workspace members', async () => {
    const page = await createPage()

    await mockProjectShell(page, {
      role: 'member',
      plan: 'pro',
      cdnEnabled: true,
    })

    await page.goto(url('/w/acme/projects/project-1?cdn=true'))

    const toggle = page.locator('button[role="switch"]')
    await toggle.waitFor()
    expect(await toggle.isDisabled()).toBe(true)
    expect(await page.getByRole('button', { name: 'Create key' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Rebuild' }).count()).toBe(0)

    await page.close()
  })

  it('lets owners create keys and trigger rebuilds from the CDN panel', async () => {
    const page = await createPage()
    const patchBodies: Array<Record<string, unknown>> = []
    let buildsCalls = 0

    await mockProjectShell(page, {
      role: 'owner',
      plan: 'pro',
      cdnEnabled: false,
    })

    await page.unroute('**/api/workspaces/ws-1/projects/project-1/cdn/settings')
    await page.route('**/api/workspaces/ws-1/projects/project-1/cdn/settings', async (route) => {
      if (route.request().method() === 'PATCH') {
        patchBodies.push(JSON.parse(route.request().postData() ?? '{}'))
        await fulfillJson(route, { cdn_enabled: true, cdn_branch: null })
        return
      }

      await fulfillJson(route, { cdn_enabled: false, cdn_branch: null })
    })

    await page.route('**/api/workspaces/ws-1/projects/project-1/cdn/keys', async (route) => {
      if (route.request().method() === 'POST') {
        await fulfillJson(route, {
          id: 'key-1',
          name: 'Primary key',
          key_prefix: 'crn_live_abcd1234',
          environment: 'production',
          created_at: '2026-03-25T00:00:00.000Z',
          key: 'crn_live_full_secret',
        })
        return
      }

      await fulfillJson(route, [])
    })

    await page.unroute('**/api/workspaces/ws-1/projects/project-1/cdn/builds')
    await page.route('**/api/workspaces/ws-1/projects/project-1/cdn/builds', async route => fulfillJson(route, buildsCalls++ > 0
      ? [{
          id: 'build-1',
          status: 'success',
          trigger_type: 'manual',
          commit_sha: 'abc1234',
          file_count: 4,
          build_duration_ms: 123,
          error_message: null,
          started_at: '2026-03-25T00:00:00.000Z',
        }]
      : []))

    await page.route('**/api/workspaces/ws-1/projects/project-1/cdn/builds/trigger', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'cache-control': 'no-cache' },
        body: ssePayload([
          { phase: 'upload', message: 'Uploading files', current: 1, total: 2 },
          {
            phase: 'complete',
            message: 'Build complete — 4 files in 123ms',
            result: {
              buildId: 'build-1',
              filesUploaded: 4,
              totalSizeBytes: 2048,
              durationMs: 123,
              error: null,
            },
          },
        ]),
      })
    })

    await page.goto(url('/w/acme/projects/project-1?cdn=true'))

    const toggle = page.locator('button[role="switch"]')
    await toggle.waitFor()
    await toggle.click()

    const keyInput = page.locator('form input').first()
    await keyInput.waitFor()
    await keyInput.fill('Primary key')
    await page.locator('form button[type="submit"]').click()
    await page.getByText('crn_live_full_secret').waitFor()
    await page.getByRole('button', { name: 'Rebuild' }).click()
    await page.getByText('abc1234').waitFor()
    await page.getByText('4 files').waitFor()
    await page.getByText('123ms').waitFor()

    expect(patchBodies).toEqual([{ cdn_enabled: true }])

    await page.close()
  })
})
