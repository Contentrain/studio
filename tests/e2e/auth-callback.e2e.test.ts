import { createPage, url } from '@nuxt/test-utils/e2e'
import { describe, expect, it } from 'vitest'
import { fulfillJson, setupBrowserE2E } from './helpers'

await setupBrowserE2E(4327)

describe('auth callback e2e', () => {
  it('verifies oauth code with stored state and redirects into the workspace', async () => {
    const verifyBodies: Array<Record<string, unknown>> = []
    let authMeCalls = 0
    const page = await createPage()

    await page.addInitScript(() => {
      sessionStorage.setItem('contentrain-auth-state', 'state-from-login')
    })

    await page.route('**/api/auth/verify', async (route) => {
      verifyBodies.push(JSON.parse(route.request().postData() ?? '{}'))
      await fulfillJson(route, { ok: true })
    })

    await page.route('**/api/auth/me', async (route) => {
      authMeCalls += 1

      if (authMeCalls === 1) {
        await fulfillJson(route, { message: 'Unauthorized' }, 401)
        return
      }

      await fulfillJson(route, {
        user: {
          id: 'user-1',
          email: 'owner@example.com',
          avatarUrl: null,
          provider: 'github',
        },
      })
    })

    await page.route('**/api/workspaces', async route => fulfillJson(route, [{
      id: 'ws-1',
      name: 'Personal',
      slug: 'personal',
      type: 'primary',
      owner_id: 'user-1',
      logo_url: null,
      github_installation_id: 42,
      plan: 'pro',
      created_at: '2026-03-25T00:00:00.000Z',
      workspace_members: [{ role: 'owner' }],
    }]))

    await page.route('**/api/workspaces/ws-1/projects', async route => fulfillJson(route, []))

    await page.goto(url('/auth/callback?code=oauth-code'))
    await page.waitForURL('**/w/personal')

    expect(verifyBodies).toEqual([
      { code: 'oauth-code', state: 'state-from-login' },
    ])
    expect(await page.evaluate(() => sessionStorage.getItem('contentrain-auth-state'))).toBeNull()
    expect(page.url()).toContain('/w/personal')

    await page.close()
  })

  it('rejects OAuth code flow without stored state (CSRF protection)', async () => {
    const page = await createPage()
    let verifyStatus = 200

    // No sessionStorage state set — simulates missing CSRF state
    await page.route('**/api/auth/verify', async (route) => {
      await fulfillJson(route, { message: 'Invalid state' }, 403)
      verifyStatus = 403
    })

    await page.route('**/api/auth/me', async (route) => {
      await fulfillJson(route, { message: 'Unauthorized' }, 401)
    })

    await page.goto(url('/auth/callback?code=oauth-code'))

    // Should stay on auth pages (login or callback with error) — not redirect into app
    await page.waitForTimeout(1000)
    const currentUrl = page.url()
    expect(currentUrl).toMatch(/\/auth\//)
    expect(verifyStatus).toBe(403)

    await page.close()
  })

  it('handles token callback flow and clears the stored state', async () => {
    const verifyBodies: Array<Record<string, unknown>> = []
    let authMeCalls = 0
    const page = await createPage()

    await page.addInitScript(() => {
      sessionStorage.setItem('contentrain-auth-state', 'token-state')
    })

    await page.route('**/api/auth/verify', async (route) => {
      verifyBodies.push(JSON.parse(route.request().postData() ?? '{}'))
      await fulfillJson(route, { ok: true })
    })

    await page.route('**/api/auth/me', async (route) => {
      authMeCalls += 1

      if (authMeCalls === 1) {
        await fulfillJson(route, { message: 'Unauthorized' }, 401)
        return
      }

      await fulfillJson(route, {
        user: {
          id: 'user-1',
          email: 'owner@example.com',
          avatarUrl: null,
          provider: 'google',
        },
      })
    })

    await page.route('**/api/workspaces', async route => fulfillJson(route, [{
      id: 'ws-1',
      name: 'Personal',
      slug: 'personal',
      type: 'primary',
      owner_id: 'user-1',
      logo_url: null,
      github_installation_id: null,
      plan: 'starter',
      created_at: '2026-03-25T00:00:00.000Z',
      workspace_members: [{ role: 'owner' }],
    }]))

    await page.route('**/api/workspaces/ws-1/projects', async route => fulfillJson(route, []))

    await page.goto(url('/auth/callback#access_token=access-123&refresh_token=refresh-456'))
    await page.waitForURL('**/w/personal')

    expect(verifyBodies).toEqual([
      {
        accessToken: 'access-123',
        refreshToken: 'refresh-456',
        state: 'token-state',
      },
    ])
    expect(await page.evaluate(() => sessionStorage.getItem('contentrain-auth-state'))).toBeNull()

    await page.close()
  })
})
