import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'

async function loadWebhookHandler() {
  return (await import('../../server/api/webhooks/github.post')).default
}

function signGithubBody(secret: string, payload: unknown) {
  const raw = JSON.stringify(payload)
  return {
    raw,
    signature: `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
  }
}

describe('GitHub webhook integration', () => {
  it('rejects webhook requests with an invalid signature', async () => {
    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      github: { webhookSecret: 'webhook-secret' },
    }))

    await withTestServer({
      routes: [
        { path: '/api/webhooks/github', handler: await loadWebhookHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-hub-signature-256': 'sha256=invalid',
        },
        body: JSON.stringify({ ref: 'refs/heads/main' }),
      })

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toMatchObject({
        statusCode: 401,
      })
    })
  })

  it('clears linked workspaces when GitHub sends an installation.deleted event', async () => {
    const clearInstallation = vi.fn().mockResolvedValue({ error: null })
    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      github: { webhookSecret: 'webhook-secret' },
    }))
    vi.stubGlobal('useSupabaseAdmin', vi.fn().mockReturnValue({
      from: vi.fn(() => ({
        update: vi.fn(() => ({
          eq: clearInstallation,
        })),
      })),
    }))

    const { raw, signature } = signGithubBody('webhook-secret', {
      action: 'deleted',
      installation: { id: 77 },
    })

    await withTestServer({
      routes: [
        { path: '/api/webhooks/github', handler: await loadWebhookHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'installation',
          'x-hub-signature-256': signature,
        },
        body: raw,
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        ok: true,
        event: 'installation',
        action: 'deleted',
      })
      expect(clearInstallation).toHaveBeenCalledWith('github_installation_id', 77)
    })
  })

  it('ignores CDN builds when a push hits a different branch than the configured CDN branch', async () => {
    const executeCDNBuild = vi.fn()
    const createBuildRecord = vi.fn()

    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      github: { webhookSecret: 'webhook-secret' },
    }))
    vi.stubGlobal('useCDNProvider', vi.fn().mockReturnValue({}))
    vi.stubGlobal('executeCDNBuild', executeCDNBuild)
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
    vi.stubGlobal('getWorkspacePlan', vi.fn().mockReturnValue('pro'))
    vi.stubGlobal('normalizeContentRoot', vi.fn().mockImplementation((value: string | null) => value ?? ''))
    vi.stubGlobal('useSupabaseAdmin', vi.fn().mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'projects') {
          return {
            update: vi.fn(() => ({
              eq: vi.fn().mockResolvedValue({ error: null }),
            })),
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn().mockResolvedValue({
                  data: [{
                    id: 'project-1',
                    workspace_id: 'workspace-1',
                    content_root: '.',
                    cdn_enabled: true,
                    cdn_branch: 'preview',
                    default_branch: 'main',
                  }],
                }),
              })),
            })),
          }
        }

        if (table === 'workspaces') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({ data: { plan: 'pro' } }),
              })),
            })),
          }
        }

        if (table === 'cdn_builds') {
          return {
            insert: vi.fn(() => {
              createBuildRecord()
              return {
                select: vi.fn(() => ({
                  single: vi.fn().mockResolvedValue({ data: { id: 'build-1' } }),
                })),
              }
            }),
          }
        }

        throw new Error(`Unexpected table: ${table}`)
      }),
    }))

    const payload = {
      ref: 'refs/heads/main',
      after: 'commit-sha-1',
      repository: { full_name: 'acme/site' },
      commits: [{ modified: ['content/posts/en.json'] }],
    }
    const { raw, signature } = signGithubBody('webhook-secret', payload)

    await withTestServer({
      routes: [
        { path: '/api/webhooks/github', handler: await loadWebhookHandler() },
      ],
    }, async ({ request }) => {
      const response = await request('/api/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-hub-signature-256': signature,
        },
        body: raw,
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        ok: true,
        event: 'push',
        repo: 'acme/site',
      })
      expect(createBuildRecord).not.toHaveBeenCalled()
      expect(executeCDNBuild).not.toHaveBeenCalled()
    })
  })
})
