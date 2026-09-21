import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { GitProvider } from '../../server/providers/git'
import type { AgentPermissions } from '../../server/utils/agent-permissions'
import type { ChatUIContext } from '../../server/utils/agent-types'
import { STUDIO_TOOLS } from '../../server/utils/agent-tools'

/** save_content states create vs update, and says which entries it created (#298). */

const PERMISSIONS: AgentPermissions = {
  workspaceRole: 'owner',
  projectRole: null,
  specificModels: false,
  allowedModels: [],
  allowedLocales: [],
  availableTools: ['save_content'],
}

const UI: ChatUIContext = { activeModelId: null, activeLocale: 'tr', activeEntryId: null, panelState: 'overview', activeBranch: null }

async function runSave(params: Record<string, unknown>) {
  const { emptyAffected } = await import('../../server/utils/agent-types')
  vi.stubGlobal('emptyAffected', emptyAffected)
  vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
  vi.stubGlobal('errorMessage', vi.fn((key: string) => key))
  vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))
  vi.stubGlobal('invalidateBrainCache', vi.fn())
  vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({
    config: { locales: { default: 'tr' } },
    content: new Map(),
    meta: new Map(),
    models: new Map([['articles', { id: 'articles', kind: 'collection' }]]),
  }))
  const engine = {
    saveContent: vi.fn().mockResolvedValue({
      branch: 'cr/content/articles/tr/1',
      commit: { sha: 'c1' },
      diff: [],
      validation: { valid: true, errors: [] },
      entries: { created: ['n1'], updated: [] },
    }),
    mergeBranch: vi.fn().mockResolvedValue({ merged: true }),
  }
  const { executeToolWithAutoMerge } = await import('../../server/utils/conversation-engine')
  const out = await executeToolWithAutoMerge(
    'save_content', params, engine as never, {} as GitProvider, 'e@x.io', 'u1', 'content', 'auto-merge', PERMISSIONS, 'pro', 'p1', 'w1', UI,
  )
  return { ...out, engine }
}

describe('save_content write mode', () => {
  beforeAll(async () => {
    await import('../../server/utils/conversation-engine')
  }, 60_000)

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('makes the mode a required, enumerated part of the tool contract', () => {
    const tool = STUDIO_TOOLS.find(t => t.name === 'save_content')!
    const schema = tool.inputSchema as { required: string[], properties: Record<string, { enum?: string[] }> }
    expect(schema.required).toContain('mode')
    expect(schema.properties.mode!.enum).toEqual(['create', 'update'])
  })

  it('passes the stated mode to the engine', async () => {
    const { engine } = await runSave({ model: 'articles', locale: 'tr', mode: 'create', data: { n1: { title: 'Yeni' } } })
    expect(engine.saveContent.mock.calls[0]![4]).toMatchObject({ mode: 'create' })
  })

  it('ignores an unknown mode rather than passing it through', async () => {
    const { engine } = await runSave({ model: 'articles', locale: 'tr', mode: 'upsert', data: { n1: { title: 'Yeni' } } })
    expect(engine.saveContent.mock.calls[0]![4]).not.toHaveProperty('mode')
  })

  it('reports which entries were created and which updated', async () => {
    const { result } = await runSave({ model: 'articles', locale: 'tr', mode: 'create', data: { n1: { title: 'Yeni' } } })
    expect(result).toMatchObject({ created: ['n1'], updated: [] })
  })
})
