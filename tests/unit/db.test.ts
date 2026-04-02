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
      upsertAgentUsage: vi.fn().mockResolvedValue(undefined),
      updateAgentUsageTokens: vi.fn().mockResolvedValue(undefined),
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

  it('saves chat results via provider methods', async () => {
    const { saveChatResult } = await loadDbModule()
    await saveChatResult(
      'conv-1',
      'Hello',
      'World',
      [{ type: 'text', text: 'World' }],
      'claude-sonnet-4-20250514',
      7,
      3,
      'workspace-1',
      'user-1',
      'studio',
      '2026-04',
    )

    expect(mockDb.insertMessage).toHaveBeenCalledTimes(2)
    expect(mockDb.insertMessage).toHaveBeenCalledWith(expect.objectContaining({ role: 'user', content: 'Hello' }))
    expect(mockDb.insertMessage).toHaveBeenCalledWith(expect.objectContaining({ role: 'assistant', content: 'World' }))
    expect(mockDb.updateAgentUsageTokens).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      month: '2026-04',
      source: 'studio',
      inputTokens: 7,
      outputTokens: 3,
    }))
    expect(mockDb.updateConversationTimestamp).toHaveBeenCalledWith('conv-1')
  })

  it('updates token counts on the usage row reserved by the atomic limit check', async () => {
    const { saveChatResult } = await loadDbModule()
    await saveChatResult(
      'conv-1',
      'Hello',
      '',
      [],
      'claude-haiku-4-5-20251001',
      4,
      2,
      'workspace-1',
      'user-1',
      'byoa',
      '2026-04',
      'key-123',
    )

    expect(mockDb.updateAgentUsageTokens).toHaveBeenCalledWith(expect.objectContaining({
      source: 'byoa',
      month: '2026-04',
      inputTokens: 4,
      outputTokens: 2,
    }))
  })
})
