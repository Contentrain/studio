import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EnterpriseBridge } from '../../server/utils/enterprise'
import { setEnterpriseBridgeForTesting } from '../../server/utils/enterprise'
import { withTestServer } from '../helpers/http'

async function loadMagicLinkHandler() {
  return (await import('../../server/api/auth/magic-link.post')).default
}

async function loadAIKeysIndexHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/ai-keys/index.get')).default
}

async function loadAIKeysCreateHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/ai-keys/index.post')).default
}

async function loadAIKeysDeleteHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/ai-keys/[keyId].delete')).default
}

describe('magic link and AI key route integration', () => {
  afterEach(() => {
    setEnterpriseBridgeForTesting(undefined)
  })

  it('rate limits magic link requests per IP', async () => {
    vi.stubGlobal('checkRateLimit', vi.fn().mockReturnValue({
      allowed: false,
      retryAfterMs: 60000,
    }))
    const handler = await loadMagicLinkHandler()

    await expect(handler({
      node: {
        req: {
          headers: {
            'x-forwarded-for': '127.0.0.1',
          },
        },
      },
    } as never)).rejects.toMatchObject({
      statusCode: 429,
    })
  })

  it('sends magic links through the auth provider with the default callback path', async () => {
    const sendMagicLink = vi.fn().mockResolvedValue(undefined)

    vi.stubGlobal('useAuthProvider', vi.fn().mockReturnValue({ sendMagicLink }))

    await withTestServer({
      routes: [
        { path: '/api/auth/magic-link', handler: await loadMagicLinkHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/auth/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com' }),
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ sent: true })
      expect(sendMagicLink).toHaveBeenCalledWith('test@example.com', '/auth/callback')
    })
  })

  it('lists only the current user AI keys for the workspace', async () => {
    setEnterpriseBridgeForTesting({
      listWorkspaceAiKeys: vi.fn().mockResolvedValue([
        { id: 'key-1', provider: 'anthropic', key_hint: 'sk-...1234', created_at: '2026-03-26T00:00:00.000Z' },
      ]),
    } as EnterpriseBridge)

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/ai-keys', handler: await loadAIKeysIndexHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/ai-keys')

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual([
        { id: 'key-1', provider: 'anthropic', key_hint: 'sk-...1234', created_at: '2026-03-26T00:00:00.000Z' },
      ])
    })
  })

  it('blocks BYOA API key storage on plans without the ai.byoa feature', async () => {
    vi.stubGlobal('getRouterParam', vi.fn(() => 'workspace-1'))
    vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
      user: { id: 'user-1' },
      accessToken: 'token-1',
    }))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('starter'))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(false))
    vi.stubGlobal('useSupabaseUserClient', vi.fn().mockReturnValue({
      from: vi.fn((table: string) => {
        if (table !== 'workspaces')
          throw new Error(`Unexpected table: ${table}`)

        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: { plan: 'starter' } }),
            })),
          })),
        }
      }),
    }))

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/ai-keys', handler: await loadAIKeysCreateHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/ai-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'anthropic', apiKey: 'sk-ant-test-1234' }),
      })

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({
        statusCode: 403,
      })
    })
  })

  it('stores encrypted AI keys and returns only safe hints', async () => {
    setEnterpriseBridgeForTesting({
      createWorkspaceAiKey: vi.fn().mockResolvedValue({
        id: 'key-1',
        provider: 'anthropic',
        key_hint: 'sk-...1234',
        created_at: '2026-03-26T00:00:00.000Z',
      }),
    } as EnterpriseBridge)

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/ai-keys', handler: await loadAIKeysCreateHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/ai-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'anthropic', apiKey: 'sk-ant-test-1234' }),
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        id: 'key-1',
        provider: 'anthropic',
        key_hint: 'sk-...1234',
        created_at: '2026-03-26T00:00:00.000Z',
      })
    })
  })

  it('deletes AI keys within the authenticated user scope', async () => {
    setEnterpriseBridgeForTesting({
      deleteWorkspaceAiKey: vi.fn().mockResolvedValue({ deleted: true }),
    } as EnterpriseBridge)

    await withTestServer({
      routes: [
        { path: '/api/workspaces/workspace-1/ai-keys/key-1', handler: await loadAIKeysDeleteHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/workspaces/workspace-1/ai-keys/key-1', { method: 'DELETE' })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ deleted: true })
    })
  })
})
