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
  snapshot: Record<string, unknown>
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
  await page.route('**/api/workspaces/ws-1/projects/project-1/snapshot', async route => fulfillJson(route, options.snapshot))
}

describe('project content and review e2e', () => {
  it('keeps publish controls hidden for non-admin workspace members', async () => {
    const page = await createPage()

    await mockProjectShell(page, {
      role: 'member',
      plan: 'business',
      snapshot: {
        exists: true,
        config: { locales: { supported: ['en'], default: 'en' } },
        models: [{
          id: 'posts',
          name: 'Posts',
          kind: 'collection',
          type: 'collection',
          fields: {
            title: { type: 'string', required: true },
            slug: { type: 'slug' },
          },
          domain: 'marketing',
          i18n: true,
        }],
        content: {
          posts: { count: 1, locales: ['en'] },
        },
      },
    })

    await page.route('**/api/workspaces/ws-1/projects/project-1/content/posts?locale=en', async route => fulfillJson(route, {
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
    }))

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
      snapshot: {
        exists: true,
        config: { locales: { supported: ['en'], default: 'en' } },
        models: [{
          id: 'site-settings',
          name: 'Site Settings',
          kind: 'singleton',
          type: 'singleton',
          fields: {
            headline: { type: 'string', required: true },
          },
          domain: 'system',
          i18n: false,
        }],
        content: {
          'site-settings': { count: 1, locales: ['en'] },
        },
      },
    })

    await page.route('**/api/workspaces/ws-1/projects/project-1/content/site-settings?locale=en', async route => fulfillJson(route, {
      data: {
        headline: 'Welcome to Acme',
      },
      kind: 'singleton',
      meta: null,
    }))

    await page.route('**/api/workspaces/ws-1/projects/project-1/content/site-settings', async (route) => {
      if (route.request().method() === 'POST') {
        saveBodies.push(JSON.parse(route.request().postData() ?? '{}'))
        await fulfillJson(route, {
          branch: 'contentrain/update-site-settings',
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

    await page.getByText('Saved to branch: contentrain/update-site-settings', { exact: true }).waitFor()
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
        name: 'contentrain/review-copy',
        sha: 'abc123',
        protected: false,
      }],
      snapshot: {
        exists: true,
        config: { locales: { supported: ['en'], default: 'en' } },
        models: [{
          id: 'posts',
          name: 'Posts',
          kind: 'collection',
          type: 'collection',
          fields: {
            title: { type: 'string', required: true },
          },
          domain: 'marketing',
          i18n: true,
        }],
        content: {
          posts: { count: 1, locales: ['en'] },
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
              name: 'contentrain/review-copy',
              sha: 'abc123',
              protected: false,
            }],
      })
    })

    await page.route('**/api/workspaces/ws-1/projects/project-1/branches/contentrain%2Freview-copy/diff', async route => fulfillJson(route, {
      branch: 'contentrain/review-copy',
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

    await page.route('**/api/workspaces/ws-1/projects/project-1/branches/contentrain%2Freview-copy/merge', async (route) => {
      mergeRequests.push(route.request().url())
      await fulfillJson(route, { merged: true })
    })

    await page.goto(url('/w/acme/projects/project-1?branch=contentrain%2Freview-copy'))

    await page.getByRole('button', { name: 'Approve & Merge' }).waitFor()
    await page.getByRole('button', { name: 'Approve & Merge' }).click()

    await page.waitForURL('**/w/acme/projects/project-1')
    expect(page.url()).not.toContain('branch=')
    expect(mergeRequests).toHaveLength(1)

    await page.close()
  })
})
