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
