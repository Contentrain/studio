import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadDbModule() {
  return import('../../server/utils/db')
}

function createErrorLike(input: { statusCode: number, message: string }) {
  return Object.assign(new Error(input.message), input)
}

describe('db helpers', () => {
  let mockDb: Record<string, ReturnType<typeof vi.fn>>

  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('createError', createErrorLike)
    vi.stubGlobal('errorMessage', (key: string) => key)

    mockDb = {
      requireWorkspaceRole: vi.fn().mockResolvedValue('owner'),
      getProjectMember: vi.fn().mockResolvedValue(null),
      getProjectForWorkspace: vi.fn().mockResolvedValue({
        id: 'project-1',
        repo_full_name: 'contentrain/studio',
        content_root: '/apps/web/',
        workspace_id: 'workspace-1',
        default_branch: 'main',
        detected_stack: 'nuxt',
        status: 'active',
      }),
      getProjectById: vi.fn().mockResolvedValue({
        id: 'project-1',
        repo_full_name: 'contentrain/studio',
        content_root: '/apps/web/',
        workspace_id: 'workspace-1',
        default_branch: 'main',
        detected_stack: 'nuxt',
        status: 'active',
      }),
      getWorkspaceById: vi.fn().mockResolvedValue({
        id: 'workspace-1',
        github_installation_id: 123,
        plan: 'pro',
      }),
      createConversation: vi.fn().mockResolvedValue('conv-1'),
      loadConversationMessages: vi.fn().mockResolvedValue([{ role: 'user', content: 'Hello', tool_calls: null }]),
      insertMessage: vi.fn().mockResolvedValue(undefined),
      insertMessages: vi.fn().mockResolvedValue(undefined),
      upsertAgentUsage: vi.fn().mockResolvedValue(undefined),
      updateAgentUsageTokens: vi.fn().mockResolvedValue(undefined),
      decrementAgentUsage: vi.fn().mockResolvedValue(undefined),
      updateAPIUsageTokens: vi.fn().mockResolvedValue(undefined),
      decrementAPIUsage: vi.fn().mockResolvedValue(undefined),
      updateConversationTimestamp: vi.fn().mockResolvedValue(undefined),
      getBYOAKey: vi.fn().mockResolvedValue(null),
    }
    vi.stubGlobal('useDatabaseProvider', () => mockDb)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves project context and normalizes the content root', async () => {
    const git = { provider: 'git' }
    vi.stubGlobal('useGitProvider', vi.fn().mockReturnValue(git))

    const { resolveProjectContext } = await loadDbModule()
    const result = await resolveProjectContext('workspace-1', 'project-1')

    expect(result.contentRoot).toBe('apps/web')
    expect(result.git).toBe(git)
    expect(result.workspace.id).toBe('workspace-1')
    expect(mockDb.getProjectById).toHaveBeenCalledWith('project-1', expect.any(String))
  })

  it('allows workspace owners to access any project without project membership', async () => {
    mockDb.requireWorkspaceRole.mockResolvedValue('owner')

    const { requireProjectAccess } = await loadDbModule()

    await expect(requireProjectAccess('user-1', 'workspace-1', 'project-1', 'token-1')).resolves.toBeUndefined()
    expect(mockDb.getProjectMember).not.toHaveBeenCalled()
  })

  it('allows workspace members when they are assigned to the project', async () => {
    mockDb.requireWorkspaceRole.mockResolvedValue('member')
    mockDb.getProjectMember.mockResolvedValue({ id: 'project-member-1', role: 'editor' })

    const { requireProjectAccess } = await loadDbModule()

    await expect(requireProjectAccess('user-1', 'workspace-1', 'project-1', 'token-1')).resolves.toBeUndefined()
    expect(mockDb.getProjectMember).toHaveBeenCalledWith('project-1', 'user-1')
  })

  it('rejects workspace members who are not assigned to the project', async () => {
    mockDb.requireWorkspaceRole.mockResolvedValue('member')
    mockDb.getProjectMember.mockResolvedValue(null)

    const { requireProjectAccess } = await loadDbModule()

    await expect(requireProjectAccess('user-1', 'workspace-1', 'project-1', 'token-1')).rejects.toMatchObject({
      statusCode: 403,
      message: 'project.access_denied',
    })
  })

  it('saves chat results as a single batched trace insert', async () => {
    const { saveChatResult } = await loadDbModule()
    await saveChatResult({
      conversationId: 'conv-1',
      userMessage: 'Hello',
      iterations: [
        { iteration: 1, assistantBlocks: [{ type: 'text', text: 'World' }], toolResultBlocks: [] },
      ],
      lastAssistantContent: [{ type: 'text', text: 'World' }],
      model: 'claude-sonnet-4-20250514',
      inputTokens: 7,
      outputTokens: 3,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      workspaceId: 'workspace-1',
      userId: 'user-1',
      usageSource: 'studio',
      usageMonth: '2026-04',
    })

    // Single round-trip for the whole turn.
    expect(mockDb.insertMessages).toHaveBeenCalledTimes(1)
    const rows = mockDb.insertMessages.mock.calls[0]![0] as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ role: 'user', content: 'Hello', internal: false, turnSequence: 0, iteration: null })
    expect(rows[1]).toMatchObject({ role: 'assistant', content: 'World', internal: false, turnSequence: 1 })
    // All rows in one batch share the same turn_id.
    expect(rows[0]!.turnId).toBe(rows[1]!.turnId)
    expect(typeof rows[0]!.turnId).toBe('string')

    expect(mockDb.updateAgentUsageTokens).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      month: '2026-04',
      source: 'studio',
      inputTokens: 7,
      outputTokens: 3,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    }))
    expect(mockDb.updateConversationTimestamp).toHaveBeenCalledWith('conv-1')
  })

  it('writes intermediate iterations as internal rows and the final as visible', async () => {
    const { saveChatResult } = await loadDbModule()
    await saveChatResult({
      conversationId: 'conv-1',
      userMessage: 'do X then Y',
      iterations: [
        {
          iteration: 1,
          assistantBlocks: [
            { type: 'text', text: 'I will check first.' },
            { type: 'tool_use', id: 't1', name: 'get_content', input: {} },
          ],
          toolResultBlocks: [{ type: 'tool_result', toolUseId: 't1', content: '{"ok":true}' }],
        },
        { iteration: 2, assistantBlocks: [{ type: 'text', text: 'Done.' }], toolResultBlocks: [] },
      ],
      lastAssistantContent: [{ type: 'text', text: 'Done.' }],
      model: 'claude-sonnet-4-5',
      inputTokens: 50,
      outputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      workspaceId: 'workspace-1',
      userId: 'user-1',
      usageSource: 'studio',
      usageMonth: '2026-04',
    })

    const rows = mockDb.insertMessages.mock.calls[0]![0] as Array<Record<string, unknown>>
    // 1 seed user + 2 assistant + 1 tool_result = 4 rows
    expect(rows).toHaveLength(4)
    expect(rows[0]).toMatchObject({ role: 'user', internal: false, iteration: null })
    expect(rows[1]).toMatchObject({ role: 'assistant', internal: true, iteration: 1 })
    expect(rows[2]).toMatchObject({ role: 'user', internal: true, iteration: 1 })
    expect(rows[3]).toMatchObject({ role: 'assistant', internal: false, iteration: 2 })
    // turnSequence is monotonically increasing within the turn so a
    // batch insert with identical created_at still resolves deterministically.
    expect(rows.map(r => r.turnSequence)).toEqual([0, 1, 2, 3])
    // All four rows share the single turn_id.
    expect(new Set(rows.map(r => r.turnId)).size).toBe(1)
    // Token counts land only on the final visible assistant row.
    expect(rows[1]).not.toHaveProperty('tokenCountInput')
    expect(rows[3]).toMatchObject({
      tokenCountInput: 50,
      tokenCountOutput: 10,
      model: 'claude-sonnet-4-5',
    })
  })

  it('propagates cache token buckets onto the final assistant row', async () => {
    const { saveChatResult } = await loadDbModule()
    await saveChatResult({
      conversationId: 'conv-1',
      userMessage: 'follow up',
      iterations: [
        { iteration: 1, assistantBlocks: [{ type: 'text', text: 'short' }], toolResultBlocks: [] },
      ],
      lastAssistantContent: [{ type: 'text', text: 'short' }],
      model: 'claude-sonnet-4-5',
      inputTokens: 80,
      outputTokens: 12,
      cacheCreationInputTokens: 150,
      cacheReadInputTokens: 9000,
      workspaceId: 'workspace-1',
      userId: 'user-1',
      usageSource: 'studio',
      usageMonth: '2026-04',
    })

    expect(mockDb.updateAgentUsageTokens).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      month: '2026-04',
      source: 'studio',
      inputTokens: 80,
      outputTokens: 12,
      cacheCreationInputTokens: 150,
      cacheReadInputTokens: 9000,
    })
    const rows = mockDb.insertMessages.mock.calls[0]![0] as Array<Record<string, unknown>>
    expect(rows.at(-1)).toMatchObject({
      role: 'assistant',
      cacheCreationInputTokens: 150,
      cacheReadInputTokens: 9000,
    })
  })

  it('saveApiChatResult writes the trace and points tokens at api_message_usage', async () => {
    const { saveApiChatResult } = await loadDbModule()
    await saveApiChatResult({
      conversationId: 'conv-2',
      userMessage: 'Hello',
      iterations: [
        { iteration: 1, assistantBlocks: [{ type: 'text', text: 'World' }], toolResultBlocks: [] },
      ],
      lastAssistantContent: [{ type: 'text', text: 'World' }],
      model: 'claude-sonnet-4-5',
      inputTokens: 11,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      workspaceId: 'workspace-1',
      apiKeyId: 'key-abc',
      usageMonth: '2026-04',
    })

    expect(mockDb.insertMessages).toHaveBeenCalledTimes(1)
    const rows = mockDb.insertMessages.mock.calls[0]![0] as Array<Record<string, unknown>>
    expect(rows.map(r => r.role)).toEqual(['user', 'assistant'])

    expect(mockDb.updateAPIUsageTokens).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      apiKeyId: 'key-abc',
      month: '2026-04',
      inputTokens: 11,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    })
    // Critical: must NOT touch the user-keyed agent_usage path.
    expect(mockDb.updateAgentUsageTokens).not.toHaveBeenCalled()
    expect(mockDb.updateConversationTimestamp).toHaveBeenCalledWith('conv-2')
  })
})
