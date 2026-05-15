import type { ContentrainConfig, ModelDefinition } from '@contentrain/types'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { agentPrompt } from '../../server/utils/content-strings'
import { getPlanParams, getUpgradeParams, PLAN_PRICING } from '../../shared/utils/license'
import type { AgentPermissions } from '../../server/utils/agent-permissions'
import { buildSystemPromptBlocks, toSystemBlocks } from '../../server/utils/agent-system-prompt'
import type { ChatUIContext, ClassifiedIntent } from '../../server/utils/agent-types'

// `agent-system-prompt.ts` uses these via Nuxt auto-imports; for the
// unit test we hoist them onto the global so the module's internal
// calls resolve. Real Nuxt server runtime already exposes them.
beforeAll(() => {
  vi.stubGlobal('agentPrompt', agentPrompt)
  vi.stubGlobal('getPlanParams', getPlanParams)
  vi.stubGlobal('getUpgradeParams', getUpgradeParams)
  vi.stubGlobal('PLAN_PRICING', PLAN_PRICING)
})

const baseModels: ModelDefinition[] = [
  { id: 'posts', name: 'Posts', kind: 'collection', domain: 'public', i18n: 'translated', fields: { title: { type: 'string', required: true } } } as ModelDefinition,
  { id: 'pages', name: 'Pages', kind: 'document', domain: 'public', i18n: 'translated', fields: { slug: { type: 'string', required: true } } } as ModelDefinition,
]

const baseConfig: ContentrainConfig = {
  stack: 'nuxt',
  domains: ['public'],
  locales: { default: 'en', supported: ['en'] },
  workflow: 'auto-merge',
} as ContentrainConfig

const basePermissions: AgentPermissions = {
  workspaceRole: 'admin',
  projectRole: null,
  specificModels: false,
  allowedModels: [],
  allowedLocales: [],
  availableTools: ['get_content'],
}

const baseState = {
  initialized: true,
  pendingBranches: [],
  projectStatus: 'active',
  phase: 'active' as const,
  contentContext: null,
}

const baseIntent: ClassifiedIntent = {
  category: 'navigation',
  confidence: 'high',
  inferred: {},
}

describe('buildSystemPromptBlocks — static/dynamic separation', () => {
  it('keeps the active model marker out of the static block', () => {
    // Same project, two different UI contexts — only `activeModelId`
    // changes. If the marker leaks into the static block the cached
    // prefix breaks and we'd pay for cache_creation every turn.
    const uiA: ChatUIContext = {
      activeModelId: 'posts',
      activeLocale: 'en',
      activeEntryId: null,
      panelState: 'overview',
      activeBranch: null,
    }
    const uiB: ChatUIContext = {
      activeModelId: 'pages',
      activeLocale: 'en',
      activeEntryId: null,
      panelState: 'overview',
      activeBranch: null,
    }
    const a = buildSystemPromptBlocks(baseConfig, baseModels, basePermissions, baseState, uiA, baseIntent, null)
    const b = buildSystemPromptBlocks(baseConfig, baseModels, basePermissions, baseState, uiB, baseIntent, null)

    expect(a.static).toBe(b.static)
    expect(a.static).not.toContain('▶')
    expect(a.dynamic).not.toBe(b.dynamic)
  })

  it('keeps the intent out of the static block', () => {
    // Off-topic intent activates an additional rule; that rule must
    // not bleed into the static body or every intent change would
    // bust the cache.
    const ui: ChatUIContext = {
      activeModelId: null,
      activeLocale: 'en',
      activeEntryId: null,
      panelState: 'overview',
      activeBranch: null,
    }
    const onTopic: ClassifiedIntent = { category: 'navigation', confidence: 'high', inferred: {} }
    const offTopic: ClassifiedIntent = { category: 'out_of_scope', confidence: 'high', inferred: {} }

    const a = buildSystemPromptBlocks(baseConfig, baseModels, basePermissions, baseState, ui, onTopic, null)
    const b = buildSystemPromptBlocks(baseConfig, baseModels, basePermissions, baseState, ui, offTopic, null)

    expect(a.static).toBe(b.static)
    expect(b.dynamic).toMatch(/off|out.?of.?scope|topic/i)
  })

  it('keeps the project state out of the static block', () => {
    const ui: ChatUIContext = {
      activeModelId: null,
      activeLocale: 'en',
      activeEntryId: null,
      panelState: 'overview',
      activeBranch: null,
    }
    const stateA = { ...baseState, pendingBranches: [] }
    const stateB = { ...baseState, pendingBranches: [{ name: 'cr/test', sha: 'abc', protected: false }] }

    const a = buildSystemPromptBlocks(baseConfig, baseModels, basePermissions, stateA, ui, baseIntent, null)
    const b = buildSystemPromptBlocks(baseConfig, baseModels, basePermissions, stateB, ui, baseIntent, null)

    expect(a.static).toBe(b.static)
    expect(a.dynamic).not.toBe(b.dynamic)
  })

  it('emits a non-empty static body with role, schema, and base rules', () => {
    const ui: ChatUIContext = {
      activeModelId: null,
      activeLocale: 'en',
      activeEntryId: null,
      panelState: 'overview',
      activeBranch: null,
    }
    const blocks = buildSystemPromptBlocks(baseConfig, baseModels, basePermissions, baseState, ui, baseIntent, null)
    // Schema model names should appear in the static block
    expect(blocks.static).toContain('Posts')
    expect(blocks.static).toContain('Pages')
    // Permissions section appears in static
    expect(blocks.static).toContain('Permissions')
    // Rules header appears in static
    expect(blocks.static).toContain('## Rules')
  })

  it('returns contentIndex separately and is preserved when non-empty', () => {
    const ui: ChatUIContext = {
      activeModelId: null,
      activeLocale: 'en',
      activeEntryId: null,
      panelState: 'overview',
      activeBranch: null,
    }
    const a = buildSystemPromptBlocks(baseConfig, baseModels, basePermissions, baseState, ui, baseIntent, 'index payload')
    const b = buildSystemPromptBlocks(baseConfig, baseModels, basePermissions, baseState, ui, baseIntent, null)
    expect(a.contentIndex).toBe('index payload')
    expect(b.contentIndex).toBeNull()
    // The static block does NOT inline the index — it lives in its own cacheable block.
    expect(a.static).not.toContain('index payload')
  })

  it('treats whitespace-only contentIndex as absent', () => {
    const ui: ChatUIContext = {
      activeModelId: null,
      activeLocale: 'en',
      activeEntryId: null,
      panelState: 'overview',
      activeBranch: null,
    }
    const blocks = buildSystemPromptBlocks(baseConfig, baseModels, basePermissions, baseState, ui, baseIntent, '   \n  ')
    expect(blocks.contentIndex).toBeNull()
  })
})

describe('toSystemBlocks — cache breakpoint assembly', () => {
  it('places cache_control on the static and contentIndex blocks and leaves dynamic uncached', () => {
    const blocks = toSystemBlocks({
      static: 'STATIC_BODY',
      contentIndex: 'INDEX_BODY',
      dynamic: 'DYNAMIC_BODY',
    })
    expect(blocks).toEqual([
      { type: 'text', text: 'STATIC_BODY', cacheControl: { type: 'ephemeral' } },
      { type: 'text', text: 'INDEX_BODY', cacheControl: { type: 'ephemeral' } },
      { type: 'text', text: 'DYNAMIC_BODY' },
    ])
  })

  it('omits the contentIndex block when null', () => {
    const blocks = toSystemBlocks({
      static: 'STATIC_BODY',
      contentIndex: null,
      dynamic: 'DYNAMIC_BODY',
    })
    expect(blocks).toEqual([
      { type: 'text', text: 'STATIC_BODY', cacheControl: { type: 'ephemeral' } },
      { type: 'text', text: 'DYNAMIC_BODY' },
    ])
  })

  it('omits the dynamic block when empty', () => {
    const blocks = toSystemBlocks({
      static: 'STATIC_BODY',
      contentIndex: 'INDEX_BODY',
      dynamic: '',
    })
    expect(blocks).toEqual([
      { type: 'text', text: 'STATIC_BODY', cacheControl: { type: 'ephemeral' } },
      { type: 'text', text: 'INDEX_BODY', cacheControl: { type: 'ephemeral' } },
    ])
  })

  it('produces at most 2 cached blocks (within Anthropic 4-breakpoint limit, leaving room for tools)', () => {
    const blocks = toSystemBlocks({
      static: 'a',
      contentIndex: 'b',
      dynamic: 'c',
    })
    const cached = blocks.filter(b => b.cacheControl?.type === 'ephemeral')
    expect(cached.length).toBeLessThanOrEqual(2)
  })
})
