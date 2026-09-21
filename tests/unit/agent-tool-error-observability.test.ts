import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitProvider } from '../../server/providers/git'
import type { AgentPermissions } from '../../server/utils/agent-permissions'
import type { ChatUIContext } from '../../server/utils/agent-types'

/**
 * Agent tool errors were returned to the model as data only, never
 * reported anywhere — the most user-visible failures (delete_content,
 * save_content) were invisible to monitoring (#294).
 */

const reportAgentToolError = vi.fn()
vi.mock('../../server/utils/alert', () => ({
  reportAgentToolError: (...args: unknown[]) => reportAgentToolError(...args),
}))

const PERMISSIONS: AgentPermissions = {
  workspaceRole: 'owner',
  projectRole: null,
  specificModels: false,
  allowedModels: [],
  allowedLocales: [],
  availableTools: ['brain_query', 'not_a_real_tool'],
}

const UI_CONTEXT: ChatUIContext = {
  activeModelId: null,
  activeLocale: 'en',
  activeEntryId: null,
  panelState: 'overview',
  activeBranch: null,
}

async function runTool(toolName: string, params: Record<string, unknown>, brainCache: unknown) {
  const { emptyAffected } = await import('../../server/utils/agent-types')
  vi.stubGlobal('emptyAffected', emptyAffected)
  vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
  vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockImplementation(async () => {
    if (brainCache instanceof Error) throw brainCache
    return brainCache
  }))

  const { executeToolWithAutoMerge } = await import('../../server/utils/conversation-engine')
  return executeToolWithAutoMerge(
    toolName,
    params,
    {} as never,
    {} as GitProvider,
    'owner@example.com',
    'user-1',
    'content',
    'auto-merge',
    PERMISSIONS,
    'pro',
    'project-42',
    'workspace-7',
    UI_CONTEXT,
  )
}

describe('agent tool error observability (#294)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
    reportAgentToolError.mockClear()
  })

  it('reports a { error } tool result with the tool name, ids and a fixed error class', async () => {
    const { result } = await runTool('not_a_real_tool', { model: 'articles' }, {
      content: new Map(),
      meta: new Map(),
      models: new Map(),
    })

    expect(result).toMatchObject({ error: expect.stringContaining('Unknown tool') })
    expect(reportAgentToolError).toHaveBeenCalledTimes(1)
    expect(reportAgentToolError).toHaveBeenCalledWith(
      expect.stringContaining('Unknown tool'),
      expect.objectContaining({
        tool: 'not_a_real_tool',
        projectId: 'project-42',
        workspaceId: 'workspace-7',
        modelId: 'articles',
        errorClass: 'tool_result_error',
      }),
    )
  })

  it('reports a thrown exception with the real error class', async () => {
    const { result } = await runTool('brain_query', { model: 'articles', locale: 'tr' }, new Error('brain cache exploded'))

    expect(result).toMatchObject({ error: 'brain cache exploded' })
    expect(reportAgentToolError).toHaveBeenCalledTimes(1)
    expect(reportAgentToolError).toHaveBeenCalledWith(
      'brain cache exploded',
      expect.objectContaining({
        tool: 'brain_query',
        projectId: 'project-42',
        workspaceId: 'workspace-7',
        modelId: 'articles',
        errorClass: 'Error',
      }),
    )
  })

  it('does not report a successful tool result', async () => {
    const { result } = await runTool('brain_query', { model: 'articles', locale: 'tr' }, {
      content: new Map(),
      meta: new Map(),
      models: new Map(),
    })

    expect(result).not.toHaveProperty('error')
    expect(reportAgentToolError).not.toHaveBeenCalled()
  })
})
