import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Gate logic for the public media API. `resolveMediaApiContext` is the
 * single choke point every `/api/media/v1/...` route runs through, so its
 * decisions (project match, scope, rate limit, plan, provider) are what
 * matter most.
 */
describe('resolveMediaApiContext', () => {
  const setResponseHeader = vi.fn()

  beforeEach(() => {
    setResponseHeader.mockReset()
    vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => {
      const err = new Error(input.message) as Error & { statusCode: number }
      err.statusCode = input.statusCode
      return err
    })
    vi.stubGlobal('errorMessage', (key: string) => key)
    vi.stubGlobal('getHeader', () => 'Bearer crn_live_test')
    vi.stubGlobal('getRouterParam', () => 'proj-1')
    vi.stubGlobal('setResponseHeader', setResponseHeader)
    vi.stubGlobal('validateCDNKey', vi.fn().mockResolvedValue({
      projectId: 'proj-1',
      keyId: 'key-1',
      rateLimitPerHour: 100,
      allowedOrigins: [],
      scopes: ['media:read', 'media:write'],
    }))
    vi.stubGlobal('requireScope', (scopes: string[], needed: string) => {
      if (!scopes.includes(needed)) {
        const err = new Error('cdn.scope_insufficient') as Error & { statusCode: number }
        err.statusCode = 403
        throw err
      }
    })
    vi.stubGlobal('checkRateLimit', vi.fn().mockResolvedValue({ allowed: true, retryAfterMs: 0 }))
    vi.stubGlobal('useDatabaseProvider', () => ({
      getProjectById: vi.fn().mockResolvedValue({ id: 'proj-1', workspace_id: 'ws-1' }),
      getWorkspaceById: vi.fn().mockResolvedValue({ id: 'ws-1', plan: 'pro', overage_settings: {} }),
    }))
    vi.stubGlobal('getWorkspacePlan', () => 'pro')
    vi.stubGlobal('hasFeature', () => true)
    vi.stubGlobal('getUpgradeParams', () => ({}))
    vi.stubGlobal('useMediaProvider', () => ({ listAssets: vi.fn() }))
  })

  const opts = { scope: 'media:write' as const, feature: 'media.upload' as never, upgradeKey: 'media.upload_upgrade' }

  it('resolves the context on the happy path', async () => {
    const { resolveMediaApiContext } = await import('../../server/utils/media-api')
    const ctx = await resolveMediaApiContext({} as never, opts)
    expect(ctx).toMatchObject({ projectId: 'proj-1', workspaceId: 'ws-1', plan: 'pro', keyId: 'key-1' })
    expect(ctx.media).toBeTruthy()
  })

  it('403s when the route project does not match the key', async () => {
    vi.stubGlobal('getRouterParam', () => 'other-project')
    const { resolveMediaApiContext } = await import('../../server/utils/media-api')
    await expect(resolveMediaApiContext({} as never, opts)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('403s when the key lacks the required scope', async () => {
    vi.stubGlobal('validateCDNKey', vi.fn().mockResolvedValue({
      projectId: 'proj-1', keyId: 'key-1', rateLimitPerHour: 100, allowedOrigins: [], scopes: ['media:read'],
    }))
    const { resolveMediaApiContext } = await import('../../server/utils/media-api')
    await expect(resolveMediaApiContext({} as never, opts)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('429s + sets Retry-After when rate limited', async () => {
    vi.stubGlobal('checkRateLimit', vi.fn().mockResolvedValue({ allowed: false, retryAfterMs: 12_000 }))
    const { resolveMediaApiContext } = await import('../../server/utils/media-api')
    await expect(resolveMediaApiContext({} as never, opts)).rejects.toMatchObject({ statusCode: 429 })
    expect(setResponseHeader).toHaveBeenCalledWith(expect.anything(), 'Retry-After', 12)
  })

  it('503s when the media provider is absent (Community Edition)', async () => {
    vi.stubGlobal('useMediaProvider', () => null)
    const { resolveMediaApiContext } = await import('../../server/utils/media-api')
    await expect(resolveMediaApiContext({} as never, opts)).rejects.toMatchObject({ statusCode: 503 })
  })
})
