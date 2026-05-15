import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AIMessage, AIProvider } from '../../server/providers/ai'
import type { GitProvider } from '../../server/providers/git'
import type { AgentPermissions } from '../../server/utils/agent-permissions'
import type { ChatUIContext, ProjectPhase } from '../../server/utils/agent-types'

async function loadConversationEngineModule() {
  return import('../../server/utils/conversation-engine')
}

function emptyAffectedValue() {
  return { models: [], locales: [], snapshotChanged: false, branchesChanged: false }
}

function stubLoopGlobals(aiProvider: Partial<AIProvider>) {
  vi.stubGlobal('emptyAffected', vi.fn(emptyAffectedValue))
  vi.stubGlobal('mergeAffected', vi.fn((a, b) => ({
    models: [...new Set([...a.models, ...b.models])],
    locales: [...new Set([...a.locales, ...b.locales])],
    snapshotChanged: a.snapshotChanged || b.snapshotChanged,
    branchesChanged: a.branchesChanged || b.branchesChanged,
  })))
  vi.stubGlobal('checkStateTransition', vi.fn().mockReturnValue({
    allowed: false,
    reason: 'blocked by test',
    suggestion: 'continue',
  }))
  vi.stubGlobal('useAIProvider', vi.fn().mockReturnValue(aiProvider))
}

function createToolContext() {
  return {
    engine: {} as never,
    git: {} as GitProvider,
    userEmail: 'user@example.com',
    userId: 'user-1',
    contentRoot: 'content',
    workflow: 'auto-merge',
    permissions: {
      workspaceRole: 'owner',
      projectRole: null,
      specificModels: false,
      allowedModels: [],
      allowedLocales: [],
      availableTools: ['test_tool', 'second_tool'],
    } as AgentPermissions,
    plan: 'pro',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    uiContext: {
      activeModelId: null,
      activeLocale: 'en',
      activeEntryId: null,
      panelState: 'overview',
      activeBranch: null,
    } as ChatUIContext,
    phase: 'active' as ProjectPhase,
  }
}

async function collectConversationEvents(input: {
  aiProvider: Partial<AIProvider>
  messages?: AIMessage[]
  maxToolIterations?: number
}) {
  stubLoopGlobals(input.aiProvider)
  const { runConversationLoop } = await loadConversationEngineModule()
  const messages = input.messages ?? [{ role: 'user', content: 'hello' } as AIMessage]
  const events = []

  for await (const evt of runConversationLoop(
    {
      model: 'claude-test',
      apiKey: 'sk-test',
      systemPrompt: 'system',
      messages,
      tools: [{ name: 'test_tool', description: 'test', inputSchema: { type: 'object' } }],
      maxToolIterations: input.maxToolIterations,
    },
    createToolContext(),
  )) {
    events.push(evt)
  }

  return { events, messages }
}

describe('conversation engine regression', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns streamed text-only responses in done.lastContent', async () => {
    const { events, messages } = await collectConversationEvents({
      aiProvider: {
        streamCompletion: async function* () {
          yield { type: 'text', content: 'Hello ' }
          yield { type: 'text', content: 'world.' }
          yield {
            type: 'message_end',
            stopReason: 'end_turn',
            usage: { inputTokens: 7, outputTokens: 3 },
          }
        },
        createCompletion: vi.fn(),
      },
    })

    const done = events[events.length - 1]!
    expect(done).toMatchObject({
      type: 'done',
      usage: { inputTokens: 7, outputTokens: 3 },
      lastContent: [{ type: 'text', text: 'Hello world.' }],
    })
    expect(messages).toHaveLength(1)
  })

  it('preserves streamed assistant text before tool use in the next model message', async () => {
    const { events, messages } = await collectConversationEvents({
      aiProvider: {
        streamCompletion: async function* () {
          yield { type: 'text', content: 'I will inspect the project.' }
          yield { type: 'tool_use_start', toolId: 'tool-1', toolName: 'test_tool' }
          yield { type: 'tool_use_end', toolId: 'tool-1', toolName: 'test_tool', toolInput: { model: 'posts' } }
          yield {
            type: 'message_end',
            stopReason: 'tool_use',
            usage: { inputTokens: 10, outputTokens: 5 },
          }
        },
        createCompletion: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'Done.' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 4, outputTokens: 2 },
        }),
      },
    })

    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will inspect the project.' },
        { type: 'tool_use', id: 'tool-1', name: 'test_tool', input: { model: 'posts' } },
      ],
    })
    expect(messages[2]).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'tool-1' }],
    })
    expect(events[events.length - 1]).toMatchObject({
      type: 'done',
      lastContent: [{ type: 'text', text: 'Done.' }],
    })
  })

  it('preserves streamed interleaved text and tool_use block order', async () => {
    const { events, messages } = await collectConversationEvents({
      maxToolIterations: 1,
      aiProvider: {
        streamCompletion: async function* () {
          yield { type: 'text', content: 'First step.' }
          yield { type: 'tool_use_start', toolId: 'tool-1', toolName: 'test_tool' }
          yield { type: 'tool_use_end', toolId: 'tool-1', toolName: 'test_tool', toolInput: { first: true } }
          yield { type: 'text', content: 'Second step.' }
          yield { type: 'tool_use_start', toolId: 'tool-2', toolName: 'second_tool' }
          yield { type: 'tool_use_end', toolId: 'tool-2', toolName: 'second_tool', toolInput: { second: true } }
          yield {
            type: 'message_end',
            stopReason: 'tool_use',
            usage: { inputTokens: 12, outputTokens: 6 },
          }
        },
        createCompletion: vi.fn(),
      },
    })

    const expectedBlocks = [
      { type: 'text', text: 'First step.' },
      { type: 'tool_use', id: 'tool-1', name: 'test_tool', input: { first: true } },
      { type: 'text', text: 'Second step.' },
      { type: 'tool_use', id: 'tool-2', name: 'second_tool', input: { second: true } },
    ]
    expect(messages[1]).toEqual({ role: 'assistant', content: expectedBlocks })
    expect(events[events.length - 1]).toMatchObject({
      type: 'done',
      lastContent: expectedBlocks,
    })
  })

  it('preserves non-streaming assistant text before tool use in later iterations', async () => {
    const { messages } = await collectConversationEvents({
      maxToolIterations: 2,
      aiProvider: {
        streamCompletion: async function* () {
          yield { type: 'tool_use_start', toolId: 'tool-1', toolName: 'test_tool' }
          yield { type: 'tool_use_end', toolId: 'tool-1', toolName: 'test_tool', toolInput: { first: true } }
          yield {
            type: 'message_end',
            stopReason: 'tool_use',
            usage: { inputTokens: 5, outputTokens: 2 },
          }
        },
        createCompletion: vi.fn().mockResolvedValue({
          content: [
            { type: 'text', text: 'I need one more check.' },
            { type: 'tool_use', id: 'tool-2', name: 'test_tool', input: { second: true } },
          ],
          stopReason: 'tool_use',
          usage: { inputTokens: 6, outputTokens: 3 },
        }),
      },
    })

    expect(messages[3]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'I need one more check.' },
        { type: 'tool_use', id: 'tool-2', name: 'test_tool', input: { second: true } },
      ],
    })
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
