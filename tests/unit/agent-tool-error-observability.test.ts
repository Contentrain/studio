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
  availableTools: ['brain_query', 'not_a_real_tool', 'update_status'],
}

const UI_CONTEXT: ChatUIContext = {
  activeModelId: null,
  activeLocale: 'en',
  activeEntryId: null,
  panelState: 'overview',
  activeBranch: null,
}

async function runTool(toolName: string, params: Record<string, unknown>, brainCache: unknown, engine: unknown = {}) {
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
    engine as never,
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

  it('reports a { error } tool result with the tool name, ids and a cause code derived from the message', async () => {
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
        // "Unknown tool: not_a_real_tool" — the label before the colon,
        // not the tool name (which would make every distinct tool name a
        // distinct Sentry tag value instead of grouping by cause).
        errorClass: 'Unknown tool',
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

  it('falls back to the whole message as the cause code when there is no colon to split on', async () => {
    const restrictedPermissions: AgentPermissions = { ...PERMISSIONS, allowedLocales: ['tr'] }
    vi.stubGlobal('emptyAffected', (await import('../../server/utils/agent-types')).emptyAffected)
    vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
    vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({ content: new Map(), meta: new Map(), models: new Map() }))

    const { executeToolWithAutoMerge } = await import('../../server/utils/conversation-engine')
    const { result } = await executeToolWithAutoMerge(
      'brain_query', { model: 'articles', locale: 'en' }, {} as never, {} as GitProvider,
      'owner@example.com', 'user-1', 'content', 'auto-merge', restrictedPermissions, 'pro',
      'project-42', 'workspace-7', UI_CONTEXT,
    )

    expect(result).toMatchObject({ error: expect.stringContaining('not allowed') })
    expect(reportAgentToolError).toHaveBeenCalledWith(
      expect.stringContaining('not allowed'),
      expect.objectContaining({ errorClass: expect.stringContaining('not allowed') }),
    )
  })

  it('buckets every validation failure under one cause code, whatever entries it names', async () => {
    // Validation errors name their entry, field and locale (#286). Without a
    // fixed prefix, the cause code — the text before the first ':' — was that
    // location, so each entry opened its own Sentry bucket.
    vi.stubGlobal('errorMessage', vi.fn((key: string) => key === 'write.validation_failed'
      ? 'The change was not applied because it failed validation'
      : key))
    const failing = (entry: string) => ({
      updateEntryStatus: vi.fn().mockResolvedValue({
        branch: '',
        commit: { sha: '' },
        diff: [],
        validation: { valid: false, errors: [{ severity: 'error', entry, field: 'status', locale: 'tr', message: 'Invalid status' }] },
      }),
    })

    for (const entry of ['a1', 'b2']) {
      const { result } = await runTool('update_status', { model: 'articles', locale: 'tr', entryIds: [entry], status: 'draft' }, {}, failing(entry))
      expect((result as { error: string }).error).toBe(`The change was not applied because it failed validation: ${entry}.status (tr): Invalid status`)
    }

    const classes = reportAgentToolError.mock.calls.map(call => (call[1] as { errorClass: string }).errorClass)
    expect(classes).toEqual([
      'The change was not applied because it failed validation',
      'The change was not applied because it failed validation',
    ])
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
