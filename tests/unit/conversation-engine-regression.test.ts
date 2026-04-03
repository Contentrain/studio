import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitProvider } from '../../server/providers/git'
import type { AgentPermissions } from '../../server/utils/agent-permissions'
import type { ChatUIContext } from '../../server/utils/agent-types'

async function loadConversationEngineModule() {
  return import('../../server/utils/conversation-engine')
}

describe('conversation engine regression', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('emits webhook events for content-mutating tools', async () => {
    const { emptyAffected } = await import('../../server/utils/agent-types')
    const git = {} as GitProvider
    const permissions: AgentPermissions = {
      workspaceRole: 'owner',
      projectRole: null,
      specificModels: false,
      allowedModels: [],
      allowedLocales: [],
      availableTools: ['save_content', 'delete_content', 'save_model', 'merge_branch', 'reject_branch'],
    }
    const uiContext: ChatUIContext = {
      activeModelId: null,
      activeLocale: 'en',
      activeEntryId: null,
      panelState: 'overview',
      activeBranch: null,
    }

    vi.stubGlobal('emptyAffected', emptyAffected)
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))

    const mockEmit = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('emitWebhookEvent', mockEmit)
    vi.stubGlobal('invalidateBrainCache', vi.fn())
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({
      models: new Map([['posts', { id: 'posts', kind: 'collection' }]]),
    }))

    const writeResult = {
      branch: 'cr/content-posts-en',
      commit: { sha: 'abc123' },
      diff: [],
      validation: { valid: true, errors: [] },
    }
    const mockEngine = {
      saveContent: vi.fn().mockResolvedValue(writeResult),
      deleteContent: vi.fn().mockResolvedValue(writeResult),
      saveModel: vi.fn().mockResolvedValue(writeResult),
      mergeBranch: vi.fn().mockResolvedValue({ merged: true }),
      rejectBranch: vi.fn().mockResolvedValue(undefined),
    }

    const { executeToolWithAutoMerge } = await loadConversationEngineModule()

    // Test save_content emits content.saved
    await executeToolWithAutoMerge(
      'save_content', { model: 'posts', locale: 'en', data: { e1: { title: 'Hello' } } },
      mockEngine as never, git, 'user@test.com', 'user-1', 'content', 'auto-merge',
      permissions, 'pro', 'project-1', 'workspace-1', uiContext,
    )
    expect(mockEmit).toHaveBeenCalledWith('project-1', 'workspace-1', 'content.saved', expect.objectContaining({
      models: ['posts'], source: 'conversation',
    }))

    // Test delete_content emits content.deleted
    mockEmit.mockClear()
    await executeToolWithAutoMerge(
      'delete_content', { model: 'posts', locale: 'en', entryIds: ['e1'] },
      mockEngine as never, git, 'user@test.com', 'user-1', 'content', 'auto-merge',
      permissions, 'pro', 'project-1', 'workspace-1', uiContext,
    )
    expect(mockEmit).toHaveBeenCalledWith('project-1', 'workspace-1', 'content.deleted', expect.objectContaining({
      models: ['posts'], entryIds: ['e1'], source: 'conversation',
    }))

    // Test merge_branch emits branch.merged
    mockEmit.mockClear()
    await executeToolWithAutoMerge(
      'merge_branch', { branch: 'cr/test' },
      mockEngine as never, git, 'user@test.com', 'user-1', 'content', 'auto-merge',
      permissions, 'pro', 'project-1', 'workspace-1', uiContext,
    )
    expect(mockEmit).toHaveBeenCalledWith('project-1', 'workspace-1', 'branch.merged', expect.objectContaining({
      branch: 'cr/test', source: 'conversation',
    }))

    // Test reject_branch emits branch.rejected
    mockEmit.mockClear()
    await executeToolWithAutoMerge(
      'reject_branch', { branch: 'cr/test' },
      mockEngine as never, git, 'user@test.com', 'user-1', 'content', 'auto-merge',
      permissions, 'pro', 'project-1', 'workspace-1', uiContext,
    )
    expect(mockEmit).toHaveBeenCalledWith('project-1', 'workspace-1', 'branch.rejected', expect.objectContaining({
      branch: 'cr/test', source: 'conversation',
    }))
  })

  it('returns unavailable schema validation instead of a fake 100 score', async () => {
    const { emptyAffected } = await import('../../server/utils/agent-types')
    const git = {} as GitProvider
    const permissions: AgentPermissions = {
      workspaceRole: 'owner',
      projectRole: null,
      specificModels: false,
      allowedModels: [],
      allowedLocales: [],
      availableTools: ['validate_schema'],
    }
    const uiContext: ChatUIContext = {
      activeModelId: null,
      activeLocale: 'en',
      activeEntryId: null,
      panelState: 'overview',
      activeBranch: null,
    }

    vi.stubGlobal('emptyAffected', emptyAffected)
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({
      schemaValidation: null,
      models: new Map([
        ['posts', { id: 'posts', kind: 'collection' }],
      ]),
    }))

    const { executeToolWithAutoMerge } = await loadConversationEngineModule()
    const result = await executeToolWithAutoMerge(
      'validate_schema',
      {},
      {} as never,
      git,
      'owner@example.com',
      'user-1',
      'content',
      'review',
      permissions,
      'pro',
      'project-1',
      'workspace-1',
      uiContext,
    )

    expect(result.result).toMatchObject({
      valid: null,
      healthScore: null,
      validModels: 0,
      unavailable: true,
    })
  })
})
