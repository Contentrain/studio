import { createPage, url } from '@nuxt/test-utils/e2e'
import type { Page } from 'playwright-core'
import { describe, expect, it } from 'vitest'
import { fulfillJson, setupBrowserE2E } from './helpers'

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
  brainSync: Record<string, unknown>
  branches?: Array<{ name: string, sha: string, protected: boolean }>
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
    branches: options.branches ?? [],
  }))
  await page.route('**/api/workspaces/ws-1/projects/project-1/brain/sync**', async route => fulfillJson(route, options.brainSync))
}

describe('project content and review e2e', () => {
  it('keeps publish controls hidden for non-admin workspace members', async () => {
    const page = await createPage()

    await mockProjectShell(page, {
      role: 'member',
      plan: 'business',
      brainSync: {
        treeSha: 'tree-1',
        delta: false,
        config: { locales: { supported: ['en'], default: 'en' } },
        models: {
          posts: {
            id: 'posts',
            name: 'Posts',
            kind: 'collection',
            fields: {
              title: { type: 'string', required: true },
              slug: { type: 'slug' },
            },
            domain: 'marketing',
            i18n: true,
          },
        },
        content: {
          'posts:en': {
            data: {
              'post-1': {
                title: 'Launch Post',
                slug: 'launch-post',
              },
            },
            kind: 'collection',
            meta: {
              'post-1': { status: 'published' },
            },
          },
        },
        vocabulary: null,
        contentContext: null,
        contentSummary: {
          posts: { count: 1, locales: ['en'], kind: 'collection' },
        },
      },
    })

    await page.goto(url('/w/acme/projects/project-1?model=posts'))

    await page.getByText('Launch Post').first().waitFor()
    await page.getByText('published').waitFor()
    expect(await page.locator('button[title="Unpublish"]').count()).toBe(0)
    expect(await page.locator('button[title="Publish"]').count()).toBe(0)

    await page.close()
  })

  it('saves singleton content through the modal editor', async () => {
    const saveBodies: Array<Record<string, unknown>> = []
    const page = await createPage()

    await mockProjectShell(page, {
      role: 'owner',
      plan: 'business',
      brainSync: {
        treeSha: 'tree-2',
        delta: false,
        config: { locales: { supported: ['en'], default: 'en' } },
        models: {
          'site-settings': {
            id: 'site-settings',
            name: 'Site Settings',
            kind: 'singleton',
            fields: {
              headline: { type: 'string', required: true },
            },
            domain: 'system',
            i18n: false,
          },
        },
        content: {
          'site-settings:en': {
            data: {
              headline: 'Welcome to Acme',
            },
            kind: 'singleton',
            meta: null,
          },
        },
        vocabulary: null,
        contentContext: null,
        contentSummary: {
          'site-settings': { count: 1, locales: ['en'], kind: 'singleton' },
        },
      },
    })

    await page.route('**/api/workspaces/ws-1/projects/project-1/content/site-settings', async (route) => {
      if (route.request().method() === 'POST') {
        saveBodies.push(JSON.parse(route.request().postData() ?? '{}'))
        await fulfillJson(route, {
          branch: 'cr/content/site-settings/en/1234567890-abcd',
          validation: { valid: true, errors: [] },
        })
        return
      }

      await route.fallback()
    })

    await page.goto(url('/w/acme/projects/project-1?model=site-settings'))

    await page.getByText('Welcome to Acme').waitFor()
    await page.getByRole('button', { name: 'Edit content' }).click()

    const dialog = page.locator('[role="dialog"]')
    await dialog.waitFor()
    await dialog.locator('input').first().fill('Updated Acme headline')
    await dialog.getByRole('button', { name: 'Save changes' }).click()

    await page.getByText('Saved to branch: cr/content/site-settings/en/1234567890-abcd', { exact: true }).waitFor()
    expect(saveBodies).toEqual([
      {
        locale: 'en',
        data: {
          headline: 'Updated Acme headline',
        },
      },
    ])

    await page.close()
  })

  it('merges a review branch and clears the branch query from the URL', async () => {
    const mergeRequests: string[] = []
    let branchesCalls = 0
    const page = await createPage()

    await mockProjectShell(page, {
      role: 'owner',
      plan: 'business',
      branches: [{
        name: 'cr/content/posts/en/1234567890-review',
        sha: 'abc123',
        protected: false,
      }],
      brainSync: {
        treeSha: 'tree-3',
        delta: false,
        config: { locales: { supported: ['en'], default: 'en' } },
        models: {
          posts: {
            id: 'posts',
            name: 'Posts',
            kind: 'collection',
            fields: {
              title: { type: 'string', required: true },
            },
            domain: 'marketing',
            i18n: true,
          },
        },
        content: {
          'posts:en': {
            data: {
              'post-1': { title: 'Old title' },
            },
            kind: 'collection',
            meta: {
              'post-1': { status: 'draft' },
            },
          },
        },
        vocabulary: null,
        contentContext: null,
        contentSummary: {
          posts: { count: 1, locales: ['en'], kind: 'collection' },
        },
      },
    })

    await page.unroute('**/api/workspaces/ws-1/projects/project-1/branches')
    await page.route('**/api/workspaces/ws-1/projects/project-1/branches', async (route) => {
      branchesCalls += 1
      await fulfillJson(route, {
        branches: branchesCalls > 1
          ? []
          : [{
              name: 'cr/content/posts/en/1234567890-review',
              sha: 'abc123',
              protected: false,
            }],
      })
    })

    await page.route(`**/api/workspaces/ws-1/projects/project-1/branches/${encodeURIComponent('cr/content/posts/en/1234567890-review')}/diff`, async route => fulfillJson(route, {
      branch: 'cr/content/posts/en/1234567890-review',
      files: [{
        path: '.contentrain/content/marketing/posts/en.json',
        status: 'modified',
      }],
      contents: {
        '.contentrain/content/marketing/posts/en.json': {
          before: { title: 'Old title' },
          after: { title: 'New title' },
        },
      },
    }))

    await page.route(`**/api/workspaces/ws-1/projects/project-1/branches/${encodeURIComponent('cr/content/posts/en/1234567890-review')}/merge`, async (route) => {
      mergeRequests.push(route.request().url())
      await fulfillJson(route, { merged: true })
    })

    await page.goto(url(`/w/acme/projects/project-1?branch=${encodeURIComponent('cr/content/posts/en/1234567890-review')}`))

    await page.getByRole('button', { name: 'Approve & Merge' }).waitFor()
    await page.getByRole('button', { name: 'Approve & Merge' }).click()

    await page.waitForURL('**/w/acme/projects/project-1')
    expect(page.url()).not.toContain('branch=')
    expect(mergeRequests).toHaveLength(1)

    await page.close()
  })
})
