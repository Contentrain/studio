import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Remote MCP route gating (/api/mcp/remote) — the OAuth twin of
 * mcp-cloud-proxy.integration.test.ts. Pins: the bare-401 discovery
 * challenge (before any loopback dependency), scope→tool enforcement with
 * 403 insufficient_scope step-up, grant-keyed quota/metering through the
 * shared pipeline, and header strip/inject parity with the key surface.
 */

const state = vi.hoisted(() => ({
  grant: {
    grantId: 'grant-1',
    userId: 'user-1',
    clientId: 'dcr_client',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    scope: 'content:read content:write project:metadata offline_access',
  } as Record<string, string> | null,
  mcpUrl: 'http://127.0.0.1:9999/mcp' as string | null,
  rateCheck: { allowed: true, remaining: 59, retryAfterMs: 0 },
  quota: { allowed: true, used: 1 },
  planOk: true,
  mediaProvider: null as unknown,
  db: {
    getProjectById: vi.fn(),
    getWorkspaceById: vi.fn(),
    incrementMcpCloudUsageIfAllowed: vi.fn(),
  },
  incrementOauthUsage: vi.fn(),
  proxyRequest: vi.fn(),
  setResponseHeader: vi.fn(),
  invalidateBrainCache: vi.fn(),
  reconcile: vi.fn(),
  recordMCPCallUsage: vi.fn(),
}))

vi.mock('h3', async () => {
  const actual = await vi.importActual<typeof import('h3')>('h3')
  return {
    ...actual,
    getHeader: (event: { __headers?: Record<string, string> }, name: string) => event.__headers?.[name.toLowerCase()],
    getRouterParam: (event: { __params?: Record<string, string> }, key: string) => event.__params?.[key],
    readRawBody: async (event: { __body?: string }) => event.__body,
    proxyRequest: state.proxyRequest,
    setResponseHeader: state.setResponseHeader,
  }
})

// Real tokens.ts runs (Bearer parsing + prefix check); only the store is mocked.
vi.mock('~~/server/utils/oauth-server/store', () => ({
  getGrantContextByAccessToken: vi.fn(async () => state.grant),
  incrementOauthUsageIfAllowed: vi.fn(async (input: unknown) => {
    state.incrementOauthUsage(input)
    return state.quota
  }),
}))

vi.mock('~~/server/utils/mcp-cloud-runtime', () => ({
  getInternalMcpUrl: vi.fn(() => state.mcpUrl),
}))

vi.mock('~~/server/utils/providers', () => ({
  useDatabaseProvider: vi.fn(() => state.db),
  useMediaProvider: vi.fn(() => state.mediaProvider),
}))

vi.mock('~~/server/utils/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => state.rateCheck),
}))

vi.mock('~~/server/utils/license', () => ({
  getWorkspacePlan: vi.fn(() => 'pro'),
  hasFeature: vi.fn(() => state.planOk),
  getPlanLimit: vi.fn(() => 1000),
}))

vi.mock('~~/server/utils/overage', () => ({
  getEffectiveLimit: vi.fn((limit: number) => limit),
}))

vi.mock('~~/server/utils/brain-cache', () => ({
  invalidateBrainCache: state.invalidateBrainCache,
}))

vi.mock('~~/server/utils/mcp-cloud-automerge', () => ({
  reconcileMcpCloudAutoMerge: state.reconcile,
}))

vi.mock('~~/server/utils/content-strings', () => ({
  errorMessage: (key: string) => key,
}))

interface FakeEvent {
  method: string
  node: { req: { headers: Record<string, string | undefined> } }
  __headers?: Record<string, string>
  __params?: Record<string, string>
  __body?: string
}

function makeEvent(overrides: Partial<FakeEvent> = {}): FakeEvent {
  return {
    method: 'POST',
    node: { req: { headers: {} } },
    __headers: { authorization: `Bearer crn_oat_${'a'.repeat(64)}` },
    __params: { slug: '' },
    __body: undefined,
    ...overrides,
  }
}

function toolCallBody(name: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } })
}

async function loadHandler() {
  return (await import('../../server/api/mcp/remote/[...slug]')).default
}

/** The WWW-Authenticate value set on the response, if any. */
function wwwAuthenticate(): string | undefined {
  const call = state.setResponseHeader.mock.calls.find(args => args[1] === 'WWW-Authenticate')
  return call?.[2] as string | undefined
}

describe('remote MCP proxy gating (OAuth surface)', () => {
  beforeEach(() => {
    state.grant = {
      grantId: 'grant-1',
      userId: 'user-1',
      clientId: 'dcr_client',
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      scope: 'content:read content:write project:metadata offline_access',
    }
    state.mcpUrl = 'http://127.0.0.1:9999/mcp'
    state.rateCheck = { allowed: true, remaining: 59, retryAfterMs: 0 }
    state.quota = { allowed: true, used: 1 }
    state.planOk = true
    state.mediaProvider = null

    state.db.getProjectById.mockResolvedValue({
      id: 'proj-1',
      repo_full_name: 'acme/site',
      content_root: '',
      workspace_id: 'ws-1',
      cdn_enabled: true,
    })
    state.db.getWorkspaceById.mockResolvedValue({
      id: 'ws-1',
      github_installation_id: 42,
      plan: 'pro',
      overage_settings: {},
      owner_id: 'owner-1',
    })
    state.proxyRequest.mockResolvedValue('proxied')
    state.reconcile.mockResolvedValue(undefined)

    vi.stubGlobal('recordMCPCallUsage', state.recordMCPCallUsage.mockResolvedValue(undefined))
    vi.stubGlobal('useRuntimeConfig', () => ({
      authProvider: 'managed',
      public: { siteUrl: 'http://localhost:3000' },
    }))
  })

  it('404s on the Supabase pair', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ authProvider: 'supabase', public: { siteUrl: 'http://localhost:3000' } }))
    const handler = await loadHandler()

    await expect(handler(makeEvent() as never)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('401s a bare request with the discovery challenge — before any loopback dependency', async () => {
    state.mcpUrl = null // loopback still booting: the challenge must not care
    const handler = await loadHandler()
    const event = makeEvent({ __headers: {} })

    await expect(handler(event as never)).rejects.toMatchObject({ statusCode: 401 })
    const challenge = wwwAuthenticate()!
    expect(challenge).toContain('Bearer error="invalid_token"')
    expect(challenge).toContain('resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/api/mcp/remote"')
    expect(challenge).toContain('scope="content:read content:write project:metadata"')
  })

  it('401s tokens with a foreign prefix without touching the store', async () => {
    const handler = await loadHandler()
    const event = makeEvent({ __headers: { authorization: 'Bearer crn_mcp_not_an_oauth_token' } })

    await expect(handler(event as never)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('401s expired/revoked tokens (store returns null)', async () => {
    state.grant = null
    const handler = await loadHandler()

    await expect(handler(makeEvent() as never)).rejects.toMatchObject({ statusCode: 401 })
    expect(wwwAuthenticate()).toContain('error="invalid_token"')
  })

  it('404s when the grant project no longer matches its workspace', async () => {
    state.db.getProjectById.mockResolvedValue({ id: 'proj-1', repo_full_name: 'acme/site', content_root: '', workspace_id: 'ws-other' })
    const handler = await loadHandler()

    await expect(handler(makeEvent() as never)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('403s with the plan message when api.mcp_cloud_oauth is not granted', async () => {
    state.planOk = false
    const handler = await loadHandler()

    await expect(handler(makeEvent() as never)).rejects.toMatchObject({
      statusCode: 403,
      message: 'oauth.plan_required',
    })
  })

  it('503s only after auth when the loopback is unavailable', async () => {
    state.mcpUrl = null
    const handler = await loadHandler()

    await expect(handler(makeEvent() as never)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('proxies protocol traffic without consuming quota', async () => {
    const handler = await loadHandler()
    const event = makeEvent({
      __body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
    })

    await expect(handler(event as never)).resolves.toBe('proxied')
    expect(state.incrementOauthUsage).not.toHaveBeenCalled()
    expect(state.recordMCPCallUsage).not.toHaveBeenCalled()
  })

  it('consumes the grant-keyed quota and meters with source=grant on tools/call', async () => {
    const handler = await loadHandler()
    const event = makeEvent({ __body: toolCallBody('contentrain_content_list') })

    await handler(event as never)

    expect(state.incrementOauthUsage).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', grantId: 'grant-1', limit: 1000 }),
    )
    expect(state.db.incrementMcpCloudUsageIfAllowed).not.toHaveBeenCalled()
    expect(state.recordMCPCallUsage).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', count: 1, keyId: 'grant-1', source: 'grant' }),
    )
  })

  it('429s when the combined monthly pool is exhausted', async () => {
    state.quota = { allowed: false, used: 1000 }
    const handler = await loadHandler()
    const event = makeEvent({ __body: toolCallBody('contentrain_content_save') })

    await expect(handler(event as never)).rejects.toMatchObject({ statusCode: 429 })
    expect(state.proxyRequest).not.toHaveBeenCalled()
  })

  it('429s with Retry-After when rate limited', async () => {
    state.rateCheck = { allowed: false, remaining: 0, retryAfterMs: 12_500 }
    const handler = await loadHandler()
    const event = makeEvent({ __body: toolCallBody('contentrain_content_list') })

    await expect(handler(event as never)).rejects.toMatchObject({ statusCode: 429 })
    expect(state.setResponseHeader).toHaveBeenCalledWith(expect.anything(), 'Retry-After', 13)
  })

  it('read-scope tokens calling a write tool get the 403 insufficient_scope step-up', async () => {
    state.grant!.scope = 'content:read project:metadata'
    const handler = await loadHandler()
    const event = makeEvent({ __body: toolCallBody('contentrain_content_save') })

    await expect(handler(event as never)).rejects.toMatchObject({ statusCode: 403 })
    const challenge = wwwAuthenticate()!
    expect(challenge).toContain('error="insufficient_scope"')
    // Recommended approach: existing scopes are preserved in the challenge.
    expect(challenge).toContain('scope="content:read content:write project:metadata"')
    expect(state.incrementOauthUsage).not.toHaveBeenCalled()
    expect(state.proxyRequest).not.toHaveBeenCalled()
  })

  it('metadata-only tokens calling a content read get a step-up for content:read', async () => {
    state.grant!.scope = 'project:metadata'
    const handler = await loadHandler()
    const event = makeEvent({ __body: toolCallBody('contentrain_content_list') })

    await expect(handler(event as never)).rejects.toMatchObject({ statusCode: 403 })
    expect(wwwAuthenticate()).toContain('scope="content:read project:metadata"')
  })

  it('media-scoped grants pass a media tool and get the media headers when eligible', async () => {
    state.mediaProvider = { listAssets: vi.fn() }
    state.grant!.scope = 'content:read media:read media:write offline_access'
    const handler = await loadHandler()
    await expect(handler(makeEvent({ __body: toolCallBody('contentrain_media_ingest') }) as never)).resolves.toBe('proxied')

    const headers = (state.proxyRequest.mock.calls.at(-1)![2] as { headers: Record<string, unknown> }).headers
    expect(headers).toMatchObject({ 'x-cr-project-id': 'proj-1', 'x-cr-media-owner': 'owner-1', 'x-cr-plan': 'pro' })
  })

  it('grants without a media scope get the 403 insufficient_scope step-up on a media tool', async () => {
    state.mediaProvider = { listAssets: vi.fn() }
    state.grant!.scope = 'content:read content:write project:metadata'
    const handler = await loadHandler()

    await expect(handler(makeEvent({ __body: toolCallBody('contentrain_media_ingest') }) as never)).rejects.toMatchObject({ statusCode: 403 })
    const challenge = wwwAuthenticate()!
    expect(challenge).toContain('error="insufficient_scope"')
    expect(challenge).toContain('media:write')
    expect(state.proxyRequest).not.toHaveBeenCalled()
  })

  it('lifecycle tools stay a plain 403 — no step-up loop for ungrantable tools', async () => {
    const handler = await loadHandler()
    const event = makeEvent({ __body: toolCallBody('contentrain_merge') })

    await expect(handler(event as never)).rejects.toMatchObject({
      statusCode: 403,
      message: 'mcp_cloud.tool_not_allowed',
    })
    expect(wwwAuthenticate()).toBeUndefined()
  })

  it('invalidates brain cache and reconciles auto-merge on write tools with the grant context', async () => {
    const handler = await loadHandler()
    const event = makeEvent({ __body: toolCallBody('contentrain_content_save') })

    await handler(event as never)

    expect(state.invalidateBrainCache).toHaveBeenCalledWith('proj-1')
    expect(state.reconcile).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      installationId: 42,
      repoFullName: 'acme/site',
    }))
  })

  it('strips client-supplied x-cr-* headers and attaches Studio-signed ones', async () => {
    const handler = await loadHandler()
    const event = makeEvent({ __body: toolCallBody('contentrain_content_list') })
    event.node.req.headers['x-cr-installation-id'] = '666'

    await handler(event as never)

    expect(event.node.req.headers['x-cr-installation-id']).toBeUndefined()
    expect(state.proxyRequest).toHaveBeenCalledWith(
      expect.anything(),
      'http://127.0.0.1:9999/mcp',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-cr-installation-id': '42',
          'x-cr-repo-owner': 'acme',
          'x-cr-repo-name': 'site',
        }),
      }),
    )
  })
})
