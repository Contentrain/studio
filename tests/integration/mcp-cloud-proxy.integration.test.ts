import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * MCP Cloud proxy route gating — allowlist, quota semantics, rate limit,
 * write detection. The loopback proxy hop itself is mocked; these tests
 * pin the gate order and the "only tools/call consumes quota" contract.
 */

const state = vi.hoisted(() => ({
  keyData: {
    keyId: 'key-1',
    projectId: 'proj-1',
    workspaceId: 'ws-1',
    name: 'test key',
    allowedTools: [] as string[],
    rateLimitPerMinute: 60,
    monthlyCallLimit: null as number | null,
  },
  rateCheck: { allowed: true, remaining: 59, retryAfterMs: 0 },
  quota: { allowed: true, used: 1 },
  db: {
    getProjectById: vi.fn(),
    getWorkspaceById: vi.fn(),
    incrementMcpCloudUsageIfAllowed: vi.fn(),
  },
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

vi.mock('~~/server/utils/mcp-cloud-keys', () => ({
  validateMcpCloudKey: vi.fn(async () => state.keyData),
}))

vi.mock('~~/server/utils/mcp-cloud-runtime', () => ({
  getInternalMcpUrl: vi.fn(() => 'http://127.0.0.1:9999/mcp'),
}))

vi.mock('~~/server/utils/providers', () => ({
  useDatabaseProvider: vi.fn(() => state.db),
}))

vi.mock('~~/server/utils/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => state.rateCheck),
}))

vi.mock('~~/server/utils/license', () => ({
  getWorkspacePlan: vi.fn(() => 'pro'),
  hasFeature: vi.fn(() => true),
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
    __headers: { authorization: 'Bearer crn_mcp_test' },
    __params: { projectId: 'proj-1', slug: 'mcp' },
    __body: undefined,
    ...overrides,
  }
}

function toolCallBody(name: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } })
}

async function loadHandler() {
  return (await import('../../server/api/mcp/v1/[projectId]/[...slug]')).default
}

describe('MCP Cloud proxy gating', () => {
  beforeEach(() => {
    state.keyData.allowedTools = []
    state.keyData.monthlyCallLimit = null
    state.rateCheck = { allowed: true, remaining: 59, retryAfterMs: 0 }
    state.quota = { allowed: true, used: 1 }

    state.db.getProjectById.mockResolvedValue({
      id: 'proj-1',
      repo_full_name: 'acme/site',
      content_root: '',
      workspace_id: 'ws-1',
    })
    state.db.getWorkspaceById.mockResolvedValue({
      id: 'ws-1',
      github_installation_id: 42,
      plan: 'pro',
      overage_settings: {},
    })
    state.db.incrementMcpCloudUsageIfAllowed.mockImplementation(async () => state.quota)
    state.proxyRequest.mockResolvedValue('proxied')
    state.reconcile.mockResolvedValue(undefined)

    vi.stubGlobal('recordMCPCallUsage', state.recordMCPCallUsage.mockResolvedValue(undefined))
  })

  it('does not consume quota for protocol traffic (initialize)', async () => {
    const handler = await loadHandler()
    const event = makeEvent({
      __body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
    })

    const result = await handler(event as never)

    expect(result).toBe('proxied')
    expect(state.db.incrementMcpCloudUsageIfAllowed).not.toHaveBeenCalled()
    expect(state.recordMCPCallUsage).not.toHaveBeenCalled()
  })

  it('forwards the client Accept to the loopback (h3 strips it; the MCP transport requires it)', async () => {
    const handler = await loadHandler()
    const event = makeEvent({
      __headers: { authorization: 'Bearer crn_mcp_test', accept: 'application/json, text/event-stream' },
      __body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
    })

    await handler(event as never)

    expect(state.proxyRequest).toHaveBeenCalledWith(
      event,
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ accept: 'application/json, text/event-stream' }),
      }),
    )
  })

  it('injects a streamable-HTTP-compatible Accept when the client sends none', async () => {
    const handler = await loadHandler()
    const event = makeEvent({
      __headers: { authorization: 'Bearer crn_mcp_test' },
      __body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
    })

    await handler(event as never)

    expect(state.proxyRequest).toHaveBeenCalledWith(
      event,
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ accept: 'application/json, text/event-stream' }),
      }),
    )
  })

  it('does not consume quota for GET (SSE stream open)', async () => {
    const handler = await loadHandler()
    const event = makeEvent({ method: 'GET', __body: undefined })

    await handler(event as never)

    expect(state.db.incrementMcpCloudUsageIfAllowed).not.toHaveBeenCalled()
  })

  it('consumes quota and meters exactly on tools/call', async () => {
    const handler = await loadHandler()
    const event = makeEvent({ __body: toolCallBody('contentrain_content_list') })

    await handler(event as never)

    expect(state.db.incrementMcpCloudUsageIfAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', keyId: 'key-1', limit: 1000 }),
    )
    expect(state.recordMCPCallUsage).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', count: 1, keyId: 'key-1' }),
    )
  })

  it('rejects a tool outside the key allowlist with 403 and no quota consumption', async () => {
    state.keyData.allowedTools = ['contentrain_content_list', 'contentrain_describe']
    const handler = await loadHandler()
    const event = makeEvent({ __body: toolCallBody('contentrain_content_save') })

    await expect(handler(event as never)).rejects.toMatchObject({ statusCode: 403 })
    expect(state.db.incrementMcpCloudUsageIfAllowed).not.toHaveBeenCalled()
    expect(state.proxyRequest).not.toHaveBeenCalled()
  })

  it('allows listed tools when the allowlist is non-empty', async () => {
    state.keyData.allowedTools = ['contentrain_content_list']
    const handler = await loadHandler()
    const event = makeEvent({ __body: toolCallBody('contentrain_content_list') })

    await expect(handler(event as never)).resolves.toBe('proxied')
  })

  it('treats an empty allowlist as unrestricted', async () => {
    state.keyData.allowedTools = []
    const handler = await loadHandler()
    const event = makeEvent({ __body: toolCallBody('contentrain_model_save') })

    await expect(handler(event as never)).resolves.toBe('proxied')
  })

  it('returns 429 with a Retry-After header when rate limited', async () => {
    state.rateCheck = { allowed: false, remaining: 0, retryAfterMs: 12_500 }
    const handler = await loadHandler()
    const event = makeEvent({ __body: toolCallBody('contentrain_content_list') })

    await expect(handler(event as never)).rejects.toMatchObject({ statusCode: 429 })
    expect(state.setResponseHeader).toHaveBeenCalledWith(expect.anything(), 'Retry-After', 13)
  })

  it('returns 429 when the monthly quota is exhausted', async () => {
    state.quota = { allowed: false, used: 1000 }
    const handler = await loadHandler()
    const event = makeEvent({ __body: toolCallBody('contentrain_content_save') })

    await expect(handler(event as never)).rejects.toMatchObject({ statusCode: 429 })
    expect(state.proxyRequest).not.toHaveBeenCalled()
  })

  it('invalidates brain cache and reconciles auto-merge on write tools', async () => {
    state.reconcile.mockResolvedValue(undefined)
    const handler = await loadHandler()
    const event = makeEvent({ __body: toolCallBody('contentrain_content_save') })

    await handler(event as never)

    expect(state.invalidateBrainCache).toHaveBeenCalledWith('proj-1')
    expect(state.reconcile).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj-1' }))
  })

  it('does not invalidate brain cache on read tools', async () => {
    const handler = await loadHandler()
    const event = makeEvent({ __body: toolCallBody('contentrain_content_list') })

    await handler(event as never)

    expect(state.invalidateBrainCache).not.toHaveBeenCalled()
    expect(state.reconcile).not.toHaveBeenCalled()
  })

  it('never triggers reconcile for Studio-owned lifecycle tools', async () => {
    const handler = await loadHandler()
    const event = makeEvent({ __body: toolCallBody('contentrain_merge') })

    await handler(event as never)

    expect(state.invalidateBrainCache).not.toHaveBeenCalled()
    expect(state.reconcile).not.toHaveBeenCalled()
  })

  it('strips client-supplied x-cr-* headers and attaches Studio-signed ones', async () => {
    const handler = await loadHandler()
    const event = makeEvent({ __body: toolCallBody('contentrain_content_list') })
    event.node.req.headers['x-cr-installation-id'] = '666'

    await handler(event as never)

    expect(event.node.req.headers['x-cr-installation-id']).toBeUndefined()
    expect(state.proxyRequest).toHaveBeenCalledWith(
      expect.anything(),
      'http://127.0.0.1:9999/mcp/mcp',
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
