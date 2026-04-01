import { createPage, url } from '@nuxt/test-utils/e2e'
import type { Page } from 'playwright-core'
import { describe, expect, it } from 'vitest'
import { fulfillJson, setupBrowserE2E, ssePayload } from './helpers'

await setupBrowserE2E(4327)

async function mockChatShell(page: Page) {
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
    github_installation_id: 42,
    plan: 'pro',
    created_at: '2026-03-25T00:00:00.000Z',
    workspace_members: [{ role: 'owner' }],
  }]))

  await page.route('**/api/workspaces/ws-1/projects', async route => fulfillJson(route, [{
    id: 'project-1',
    workspace_id: 'ws-1',
    repo_full_name: 'acme/site',
    default_branch: 'main',
    content_root: '.',
    detected_stack: 'nuxt',
    status: 'active',
    created_at: '2026-03-25T00:00:00.000Z',
  }]))

  await page.route('**/api/workspaces/ws-1/projects/project-1/branches', async route => fulfillJson(route, {
    branches: [],
  }))

  await page.route('**/api/workspaces/ws-1/projects/project-1/snapshot', async route => fulfillJson(route, {
    exists: true,
    config: { locales: { supported: ['en'], default: 'en' } },
    models: [],
    content: {},
  }))
}

describe('chat stream e2e', () => {
  it('renders streamed assistant text and tool activity', async () => {
    let conversationsCalls = 0
    const chatBodies: Array<Record<string, unknown>> = []
    const page = await createPage()

    await mockChatShell(page)

    await page.route('**/api/workspaces/ws-1/projects/project-1/conversations', async (route) => {
      conversationsCalls += 1
      await fulfillJson(route, conversationsCalls > 1
        ? [{
            id: 'conv-1',
            title: 'Review homepage copy',
            created_at: '2026-03-25T00:00:00.000Z',
            updated_at: '2026-03-25T00:00:00.000Z',
          }]
        : [])
    })

    await page.route('**/api/workspaces/ws-1/projects/project-1/chat', async (route) => {
      chatBodies.push(JSON.parse(route.request().postData() ?? '{}'))
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'cache-control': 'no-cache' },
        body: ssePayload([
          { type: 'conversation', id: 'conv-1' },
          { type: 'text', content: 'I reviewed the homepage copy.' },
          { type: 'tool_use', id: 'tool-1', name: 'read_content' },
          { type: 'tool_result', id: 'tool-1', result: { entries: 1, locale: 'en' } },
          {
            type: 'done',
            affected: {
              models: [],
              locales: ['en'],
              snapshotChanged: false,
              branchesChanged: false,
            },
          },
        ]),
      })
    })

    await page.goto(url('/w/acme/projects/project-1'))

    await page.getByPlaceholder('Ask about your content...').fill('Review the homepage copy')
    await page.getByRole('button', { name: 'Send' }).click()

    await page.getByText('Review the homepage copy').waitFor()
    await page.getByText('I reviewed the homepage copy.').waitFor()
    await page.getByRole('button', { name: /read_content/i }).click()
    await page.getByText('"entries": 1').waitFor()

    expect(chatBodies).toEqual([
      {
        message: 'Review the homepage copy',
        conversationId: null,
        model: 'claude-sonnet-4-20250514',
        context: {
          activeModelId: null,
          activeLocale: 'en',
          activeEntryId: null,
          panelState: 'overview',
          activeBranch: null,
          contextItems: [],
        },
      },
    ])

    await page.close()
  })

  it('surfaces denial errors from the chat endpoint to the user', async () => {
    const page = await createPage()

    await mockChatShell(page)
    await page.route('**/api/workspaces/ws-1/projects/project-1/conversations', async route => fulfillJson(route, []))
    await page.route('**/api/workspaces/ws-1/projects/project-1/chat', async route => fulfillJson(route, {
      message: 'Viewer cannot send messages on this project',
    }, 403))

    await page.goto(url('/w/acme/projects/project-1'))

    await page.getByPlaceholder('Ask about your content...').fill('Try to write content')
    await page.getByRole('button', { name: 'Send' }).click()

    await page.getByText('Viewer cannot send messages on this project', { exact: true }).waitFor()
    await page.getByText('Try to write content').waitFor()

    await page.close()
  })
})
