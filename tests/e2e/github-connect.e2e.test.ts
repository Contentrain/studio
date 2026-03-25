import { createPage, url } from '@nuxt/test-utils/e2e'
import { describe, expect, it } from 'vitest'
import { fulfillJson, setupBrowserE2E } from './helpers'

await setupBrowserE2E(4327)

describe('github connect flow e2e', () => {
  it('scans a repository and connects it into the workspace', async () => {
    const createProjectBodies: Array<Record<string, unknown>> = []
    let projectsGetCalls = 0
    const page = await createPage()

    await page.route('**/api/auth/me', async route => fulfillJson(route, {
      user: {
        id: 'user-1',
        email: 'owner@example.com',
        avatarUrl: null,
        provider: 'github',
      },
    }))

    await page.route('**/api/workspaces', async route => fulfillJson(route, [{
      id: 'ws-1',
      name: 'Acme',
      slug: 'acme',
      type: 'primary',
      owner_id: 'user-1',
      logo_url: null,
      github_installation_id: 77,
      plan: 'business',
      created_at: '2026-03-25T00:00:00.000Z',
      workspace_members: [{ role: 'owner' }],
    }]))

    await page.route('**/api/workspaces/ws-1/projects', async (route) => {
      if (route.request().method() === 'POST') {
        createProjectBodies.push(JSON.parse(route.request().postData() ?? '{}'))
        await fulfillJson(route, {
          id: 'project-1',
          workspace_id: 'ws-1',
          repo_full_name: 'acme/site',
          default_branch: 'main',
          content_root: '.',
          detected_stack: 'nuxt',
          status: 'setup',
          created_at: '2026-03-25T00:00:00.000Z',
        })
        return
      }

      projectsGetCalls += 1

      await fulfillJson(route, projectsGetCalls > 1
        ? [{
            id: 'project-1',
            workspace_id: 'ws-1',
            repo_full_name: 'acme/site',
            default_branch: 'main',
            content_root: '.',
            detected_stack: 'nuxt',
            status: 'setup',
            created_at: '2026-03-25T00:00:00.000Z',
          }]
        : [])
    })

    await page.route('**/api/github/repos**', async route => fulfillJson(route, [
      {
        id: 101,
        fullName: 'acme/site',
        name: 'site',
        owner: 'acme',
        private: true,
        defaultBranch: 'main',
        description: 'Marketing site',
        language: 'TypeScript',
        updatedAt: '2026-03-25T00:00:00.000Z',
      },
    ]))

    await page.route('**/api/github/scan**', async route => fulfillJson(route, {
      defaultBranch: 'main',
      stack: 'nuxt',
      hasContentDir: true,
      hasI18n: true,
    }))

    await page.goto(url('/w/acme'))
    await page.getByRole('button', { name: 'Connect repository' }).first().click()

    await page.getByText('acme/site').waitFor()
    await page.getByRole('button', { name: 'acme/site' }).click()

    await page.getByText('.contentrain/ found — ready to browse').waitFor()
    await page.getByText('Nuxt detected').waitFor()

    await page.getByRole('button', { name: 'Connect' }).click()

    await page.locator('[role="dialog"]').waitFor({ state: 'hidden' })
    expect(projectsGetCalls).toBeGreaterThan(1)
    expect(createProjectBodies).toEqual([
      {
        repoFullName: 'acme/site',
        defaultBranch: 'main',
        detectedStack: 'nuxt',
        hasContentrain: true,
      },
    ])

    await page.close()
  })
})
