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

  it('surfaces a typed error when the model is cut off at the output-token limit', async () => {
    // Regression: a `max_tokens` stop mid-response (the model was
    // emitting a tool call that never completed) used to fall through
    // the generic "final iteration" check and end the turn silently,
    // stranding the user on a "…saving now:" preamble whose save never
    // ran. It must instead emit an `output_truncated` error and still
    // close the turn, preserving whatever text streamed.
    const { events } = await collectConversationEvents({
      aiProvider: {
        streamCompletion: async function* () {
          yield { type: 'text', content: 'Saving now:' }
          yield {
            type: 'message_end',
            stopReason: 'max_tokens',
            usage: { inputTokens: 100, outputTokens: 4096 },
          }
        },
        createCompletion: vi.fn(),
      },
    })

    const errorEvent = events.find(e => e.type === 'error')
    expect(errorEvent).toBeTruthy()
    expect(errorEvent).toMatchObject({ type: 'error', code: 'output_truncated' })

    // The turn still closes cleanly and keeps the partial text.
    const done = events[events.length - 1]!
    expect(done).toMatchObject({
      type: 'done',
      lastContent: [{ type: 'text', text: 'Saving now:' }],
    })
  })

  it('streams the post-tool continuation instead of buffering it', async () => {
    // Every iteration now streams — the first turn AND the post-tool
    // continuation. The follow-up answer must arrive as streamed text
    // deltas, and the blocking createCompletion path must never be used.
    let call = 0
    const createCompletion = vi.fn()
    const { events, messages } = await collectConversationEvents({
      aiProvider: {
        streamCompletion() {
          const idx = call++
          return (async function* () {
            if (idx === 0) {
              yield { type: 'text', content: 'I will inspect the project.' }
              yield { type: 'tool_use_start', toolId: 'tool-1', toolName: 'test_tool' }
              yield { type: 'tool_use_end', toolId: 'tool-1', toolName: 'test_tool', toolInput: { model: 'posts' } }
              yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } }
            }
            else {
              yield { type: 'text', content: 'Done.' }
              yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 4, outputTokens: 2 } }
            }
          })()
        },
        createCompletion,
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
    expect(events).toContainEqual({ type: 'text', content: 'Done.' })
    expect(createCompletion).not.toHaveBeenCalled()
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

  it('streams assistant text before tool use in later iterations', async () => {
    let call = 0
    const { messages } = await collectConversationEvents({
      maxToolIterations: 2,
      aiProvider: {
        streamCompletion() {
          const idx = call++
          return (async function* () {
            if (idx === 0) {
              yield { type: 'tool_use_start', toolId: 'tool-1', toolName: 'test_tool' }
              yield { type: 'tool_use_end', toolId: 'tool-1', toolName: 'test_tool', toolInput: { first: true } }
              yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 2 } }
            }
            else if (idx === 1) {
              yield { type: 'text', content: 'I need one more check.' }
              yield { type: 'tool_use_start', toolId: 'tool-2', toolName: 'test_tool' }
              yield { type: 'tool_use_end', toolId: 'tool-2', toolName: 'test_tool', toolInput: { second: true } }
              yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 6, outputTokens: 3 } }
            }
            else {
              // graceful-close summary (iteration ceiling reached)
              yield { type: 'text', content: 'Wrapped up.' }
              yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
            }
          })()
        },
        createCompletion: vi.fn(),
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

  it('emits a streamed tools-disabled summary when the iteration ceiling is hit mid-tool-use', async () => {
    // Loop runs out of iterations while the model still wants tools.
    // Instead of leaving the user with an answer that stops mid-work,
    // the engine makes one final tools-disabled streaming call so the
    // model summarizes — and that summary becomes the visible answer.
    let call = 0
    const toolsPerCall: number[] = []
    const { events } = await collectConversationEvents({
      maxToolIterations: 1,
      aiProvider: {
        streamCompletion(request) {
          const idx = call++
          toolsPerCall.push(request.tools.length)
          return (async function* () {
            if (idx === 0) {
              yield { type: 'text', content: 'Working on it.' }
              yield { type: 'tool_use_start', toolId: 'tool-1', toolName: 'test_tool' }
              yield { type: 'tool_use_end', toolId: 'tool-1', toolName: 'test_tool', toolInput: {} }
              yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 2 } }
            }
            else {
              yield { type: 'text', content: 'All done — fixed everything.' }
              yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 4 } }
            }
          })()
        },
        createCompletion: vi.fn(),
      },
    })

    // Two model calls: the ceiling iteration + the graceful-close summary.
    expect(call).toBe(2)
    // The summary call runs with tools disabled.
    expect(toolsPerCall).toEqual([1, 0])
    // The streamed summary is the final visible assistant content.
    expect(events).toContainEqual({ type: 'text', content: 'All done — fixed everything.' })
    expect(events[events.length - 1]).toMatchObject({
      type: 'done',
      lastContent: [{ type: 'text', text: 'All done — fixed everything.' }],
    })
  })

  it('does not truncate large tool results below the 32k cap', async () => {
    // Regression: the old 2k cap chopped content reads into invalid JSON
    // mid-object, so the agent could never see a full entry and looped
    // re-reading it. A 5k payload must now pass through intact.
    let call = 0
    vi.stubGlobal('emptyAffected', vi.fn(emptyAffectedValue))
    vi.stubGlobal('mergeAffected', vi.fn((a: unknown) => a))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
    vi.stubGlobal('checkStateTransition', vi.fn().mockReturnValue({ allowed: true }))
    vi.stubGlobal('invalidateBrainCache', vi.fn())
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({
      models: new Map([['posts', { id: 'posts', kind: 'collection' }]]),
      content: new Map([['posts:en', { e1: { title: 'x'.repeat(5000) } }]]),
      meta: new Map(),
    }))
    vi.stubGlobal('useAIProvider', vi.fn().mockReturnValue({
      streamCompletion() {
        const idx = call++
        return (async function* () {
          if (idx === 0) {
            yield { type: 'tool_use_start', toolId: 't1', toolName: 'brain_query' }
            yield { type: 'tool_use_end', toolId: 't1', toolName: 'brain_query', toolInput: { model: 'posts', locale: 'en' } }
            yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }
          }
          else {
            yield { type: 'text', content: 'ok' }
            yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
          }
        })()
      },
      createCompletion: vi.fn(),
    }))

    const { runConversationLoop } = await loadConversationEngineModule()
    const messages: AIMessage[] = [{ role: 'user', content: 'show posts' }]
    const ctx = createToolContext()
    ctx.permissions.availableTools = ['brain_query']

    const events = []
    for await (const evt of runConversationLoop(
      {
        model: 'm',
        apiKey: 'k',
        systemPrompt: 's',
        messages,
        tools: [{ name: 'brain_query', description: '', inputSchema: { type: 'object' } }],
        maxToolIterations: 1,
      },
      ctx,
    )) { events.push(evt) }

    const blocks = messages[2]!.content as Array<{ type: string, toolUseId?: string, content: string }>
    expect(blocks[0]!.type).toBe('tool_result')
    expect(blocks[0]!.content.length).toBeGreaterThan(4000)
    expect(blocks[0]!.content).not.toContain('truncated')

    // tool_result events carry per-tool `affected` so the client can do a
    // live, debounced context-panel refresh as each operation lands.
    const toolResultEvent = events.find(e => e.type === 'tool_result')
    expect(toolResultEvent).toBeDefined()
    expect(toolResultEvent!.affected).toMatchObject({ models: expect.any(Array), snapshotChanged: expect.any(Boolean) })
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

describe('turn-end merge coalescing (W4)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function makeWriteEngine() {
    let n = 0
    return {
      saveContent: vi.fn().mockImplementation(async () => ({
        branch: `cr/content/posts/en/${++n}-test`,
        commit: { sha: `sha-${n}` },
        diff: [],
        validation: { valid: true, errors: [] },
      })),
      mergeToContentrain: vi.fn().mockResolvedValue({ merged: true, sha: 'step1-sha' }),
      finalizeContentrain: vi.fn().mockResolvedValue({ merged: true, sha: 'final-sha', pullRequestUrl: null }),
      mergeBranch: vi.fn().mockResolvedValue({ merged: true, sha: 'legacy-sha', pullRequestUrl: null }),
    }
  }

  function stubWriteGlobals(aiProvider: Partial<AIProvider>) {
    vi.stubGlobal('emptyAffected', vi.fn(emptyAffectedValue))
    vi.stubGlobal('mergeAffected', vi.fn((a, b) => ({
      models: [...new Set([...a.models, ...b.models])],
      locales: [...new Set([...a.locales, ...b.locales])],
      snapshotChanged: a.snapshotChanged || b.snapshotChanged,
      branchesChanged: a.branchesChanged || b.branchesChanged,
    })))
    vi.stubGlobal('checkStateTransition', vi.fn().mockReturnValue({ allowed: true }))
    vi.stubGlobal('useAIProvider', vi.fn().mockReturnValue(aiProvider))
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
    vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
    vi.stubGlobal('invalidateBrainCache', vi.fn())
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({
      models: new Map([['posts', { id: 'posts', kind: 'collection' }]]),
      content: new Map(),
      config: null,
    }))
  }

  function writeToolContext(engine: ReturnType<typeof makeWriteEngine>, overrides: { workflow?: string, workspaceRole?: string } = {}) {
    const ctx = createToolContext()
    return {
      ...ctx,
      engine: engine as never,
      workflow: overrides.workflow ?? 'auto-merge',
      permissions: {
        ...ctx.permissions,
        workspaceRole: (overrides.workspaceRole ?? 'owner') as never,
        availableTools: ['save_content'],
      },
    }
  }

  /** Provider: iteration 1 emits `saves` × save_content, iteration 2 ends the turn. */
  function twoPhaseProvider(saves: number): Partial<AIProvider> {
    let call = 0
    return {
      streamCompletion() {
        const idx = call++
        return (async function* () {
          if (idx === 0) {
            for (let i = 1; i <= saves; i++) {
              yield { type: 'tool_use_start', toolId: `tool-${i}`, toolName: 'save_content' }
              yield { type: 'tool_use_end', toolId: `tool-${i}`, toolName: 'save_content', toolInput: { model: 'posts', locale: 'en', data: { [`e${i}`]: { title: `T${i}` } } } }
            }
            yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } }
          }
          else {
            yield { type: 'text', content: 'All saved.' }
            yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 4, outputTokens: 2 } }
          }
        })() as never
      },
      createCompletion: vi.fn(),
    }
  }

  it('lands each save on contentrain immediately and finalizes once, before done', async () => {
    const engine = makeWriteEngine()
    const provider = twoPhaseProvider(2)
    stubWriteGlobals(provider)
    const { runConversationLoop } = await loadConversationEngineModule()

    let finalizeCallsAtDone = -1
    for await (const evt of runConversationLoop(
      {
        model: 'claude-test',
        apiKey: 'sk-test',
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'update posts' } as AIMessage],
        tools: [{ name: 'save_content', description: 'save', inputSchema: { type: 'object' } }],
      },
      writeToolContext(engine),
    )) {
      if (evt.type === 'done') finalizeCallsAtDone = engine.finalizeContentrain.mock.calls.length
    }

    expect(engine.mergeToContentrain).toHaveBeenCalledTimes(2)
    expect(engine.mergeBranch).not.toHaveBeenCalled()
    expect(engine.finalizeContentrain).toHaveBeenCalledTimes(1)
    expect(engine.finalizeContentrain).toHaveBeenCalledWith([
      'cr/content/posts/en/1-test',
      'cr/content/posts/en/2-test',
    ])
    // Flush happens BEFORE the done event reaches the client.
    expect(finalizeCallsAtDone).toBe(1)
  })

  it('still finalizes landed branches when the model stream fails mid-turn', async () => {
    const engine = makeWriteEngine()
    let call = 0
    const provider: Partial<AIProvider> = {
      streamCompletion() {
        const idx = call++
        return (async function* () {
          if (idx === 0) {
            yield { type: 'tool_use_start', toolId: 'tool-1', toolName: 'save_content' }
            yield { type: 'tool_use_end', toolId: 'tool-1', toolName: 'save_content', toolInput: { model: 'posts', locale: 'en', data: { e1: { title: 'T' } } } }
            yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }
          }
          else {
            throw new Error('provider crashed')
          }
        })() as never
      },
      createCompletion: vi.fn(),
    }
    stubWriteGlobals(provider)
    const { runConversationLoop } = await loadConversationEngineModule()

    await expect(async () => {
      for await (const _evt of runConversationLoop(
        {
          model: 'claude-test',
          apiKey: 'sk-test',
          systemPrompt: 'system',
          messages: [{ role: 'user', content: 'update posts' } as AIMessage],
          tools: [{ name: 'save_content', description: 'save', inputSchema: { type: 'object' } }],
        },
        writeToolContext(engine),
      )) { /* drain */ }
    }).rejects.toThrow('provider crashed')

    expect(engine.finalizeContentrain).toHaveBeenCalledTimes(1)
    expect(engine.finalizeContentrain).toHaveBeenCalledWith(['cr/content/posts/en/1-test'])
  })

  it('finalizes landed branches when the consumer stops iterating early', async () => {
    const engine = makeWriteEngine()
    const provider = twoPhaseProvider(1)
    stubWriteGlobals(provider)
    const { runConversationLoop } = await loadConversationEngineModule()

    for await (const evt of runConversationLoop(
      {
        model: 'claude-test',
        apiKey: 'sk-test',
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'update posts' } as AIMessage],
        tools: [{ name: 'save_content', description: 'save', inputSchema: { type: 'object' } }],
      },
      writeToolContext(engine),
    )) {
      // Client disconnect: bail after the first tool result.
      if (evt.type === 'tool_result') break
    }

    expect(engine.finalizeContentrain).toHaveBeenCalledTimes(1)
    expect(engine.finalizeContentrain).toHaveBeenCalledWith(['cr/content/posts/en/1-test'])
  })

  it('never finalizes in review workflow for non-admin members', async () => {
    const engine = makeWriteEngine()
    const provider = twoPhaseProvider(1)
    stubWriteGlobals(provider)
    const { runConversationLoop } = await loadConversationEngineModule()

    const events = []
    for await (const evt of runConversationLoop(
      {
        model: 'claude-test',
        apiKey: 'sk-test',
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'update posts' } as AIMessage],
        tools: [{ name: 'save_content', description: 'save', inputSchema: { type: 'object' } }],
      },
      writeToolContext(engine, { workflow: 'review', workspaceRole: 'member' }),
    )) {
      events.push(evt)
    }

    expect(engine.mergeToContentrain).not.toHaveBeenCalled()
    expect(engine.finalizeContentrain).not.toHaveBeenCalled()
    expect(engine.mergeBranch).not.toHaveBeenCalled()
    const toolResult = events.find(e => e.type === 'tool_result') as { result: { reviewBranch?: string } }
    expect(toolResult.result.reviewBranch).toBe('cr/content/posts/en/1-test')
  })
})
