import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * MCP Cloud key management routes — create-input validation and the
 * per-key usage enrichment on list.
 */

const state = vi.hoisted(() => ({
  db: {
    requireWorkspaceRole: vi.fn(),
    getWorkspaceById: vi.fn(),
    getProjectById: vi.fn(),
    countActiveMcpCloudKeys: vi.fn(),
    createMcpCloudKey: vi.fn(),
    listMcpCloudKeys: vi.fn(),
    getMcpCloudKeyUsage: vi.fn(),
  },
  body: {} as Record<string, unknown>,
}))

vi.mock('h3', async () => {
  const actual = await vi.importActual<typeof import('h3')>('h3')
  return {
    ...actual,
    getRouterParam: (_event: unknown, key: string) => (key === 'workspaceId' ? 'ws-1' : undefined),
    getQuery: () => ({}),
    readBody: async () => state.body,
  }
})

vi.mock('~~/server/utils/auth', () => ({
  requireAuth: vi.fn(() => ({ user: { id: 'user-1' }, accessToken: 'token-1' })),
}))

vi.mock('~~/server/utils/providers', () => ({
  useDatabaseProvider: vi.fn(() => state.db),
}))

// The real key-generation module is needed (the route returns a generated
// plaintext key), but it resolves `./providers` relatively — mock that
// path too so the Supabase provider graph never loads.
vi.mock('~~/server/utils/mcp-cloud-keys', async () => await import('../../server/utils/mcp-cloud-keys'))
vi.mock('../../server/utils/providers', () => ({
  useDatabaseProvider: vi.fn(() => state.db),
}))

vi.mock('~~/server/utils/license', () => ({
  getWorkspacePlan: vi.fn(() => 'pro'),
  hasFeature: vi.fn(() => true),
  getPlanLimit: vi.fn(() => 10),
}))

vi.mock('~~/server/utils/content-strings', () => ({
  errorMessage: (key: string) => key,
}))

async function loadCreateHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/mcp-cloud-keys/index.post')).default
}

async function loadListHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/mcp-cloud-keys/index.get')).default
}

describe('POST /mcp-cloud-keys validation', () => {
  beforeEach(() => {
    state.db.requireWorkspaceRole.mockResolvedValue(undefined)
    state.db.getWorkspaceById.mockResolvedValue({ id: 'ws-1', plan: 'pro' })
    state.db.getProjectById.mockResolvedValue({ id: 'proj-1', workspace_id: 'ws-1' })
    state.db.countActiveMcpCloudKeys.mockResolvedValue(0)
    state.db.createMcpCloudKey.mockImplementation(async (input: Record<string, unknown>) => ({
      id: 'key-1',
      key_prefix: 'crn_mcp_xxxx',
      name: input.name,
      project_id: input.projectId,
      allowed_tools: input.allowedTools,
      rate_limit_per_minute: input.rateLimitPerMinute ?? 60,
      monthly_call_limit: input.monthlyCallLimit ?? null,
      created_at: '2026-01-01T00:00:00Z',
    }))
    state.body = { name: 'ci key', projectId: 'proj-1' }
  })

  it('creates a key with defaults', async () => {
    const handler = await loadCreateHandler()
    const result = await handler({} as never)

    expect(result.key).toMatch(/^crn_mcp_/)
    expect(result.allowedTools).toEqual([])
  })

  it('accepts a valid allowedTools whitelist', async () => {
    state.body.allowedTools = ['contentrain_content_list', 'contentrain_describe']
    const handler = await loadCreateHandler()
    const result = await handler({} as never)

    expect(result.allowedTools).toEqual(['contentrain_content_list', 'contentrain_describe'])
  })

  it('rejects unknown tool names in allowedTools', async () => {
    state.body.allowedTools = ['contentrain_content_list', 'not_a_tool']
    const handler = await loadCreateHandler()

    await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 400 })
    expect(state.db.createMcpCloudKey).not.toHaveBeenCalled()
  })

  it.each([0, -5, 601, 1.5, Number.NaN])('rejects rateLimitPerMinute = %s', async (value) => {
    state.body.rateLimitPerMinute = value
    const handler = await loadCreateHandler()

    await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 400 })
  })

  it.each([0, -1, 2.5])('rejects monthlyCallLimit = %s', async (value) => {
    state.body.monthlyCallLimit = value
    const handler = await loadCreateHandler()

    await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('accepts a null monthlyCallLimit (no key-level cap)', async () => {
    state.body.monthlyCallLimit = null
    const handler = await loadCreateHandler()

    await expect(handler({} as never)).resolves.toMatchObject({ monthlyCallLimit: null })
  })
})

describe('GET /mcp-cloud-keys usage enrichment', () => {
  beforeEach(() => {
    state.db.requireWorkspaceRole.mockResolvedValue(undefined)
    state.db.listMcpCloudKeys.mockResolvedValue([
      { id: 'key-1', name: 'a' },
      { id: 'key-2', name: 'b' },
    ])
  })

  it('attaches current-month call counts per key', async () => {
    state.db.getMcpCloudKeyUsage.mockResolvedValue([
      { mcp_key_id: 'key-1', call_count: 17 },
    ])
    const handler = await loadListHandler()
    const result = await handler({} as never)

    expect(result.keys).toEqual([
      expect.objectContaining({ id: 'key-1', calls_this_month: 17 }),
      expect.objectContaining({ id: 'key-2', calls_this_month: 0 }),
    ])
  })

  it('degrades to zero counts when the usage read fails', async () => {
    state.db.getMcpCloudKeyUsage.mockRejectedValue(new Error('boom'))
    const handler = await loadListHandler()
    const result = await handler({} as never)

    expect(result.keys.every((k: { calls_this_month: number }) => k.calls_this_month === 0)).toBe(true)
  })
})
