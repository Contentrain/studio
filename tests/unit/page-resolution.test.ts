import type { ContentrainConfig, ModelDefinition } from '@contentrain/types'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentPermissions } from '../../server/utils/agent-permissions'
import type { ChatUIContext, ClassifiedIntent } from '../../server/utils/agent-types'
import { buildRequestContext, buildSystemPromptBlocks } from '../../server/utils/agent-system-prompt'
import { agentPrompt } from '../../server/utils/content-strings'
import { extractPageUrls, resolvePageUrl } from '../../server/utils/page-resolution'
import { getPlanParams, getUpgradeParams, PLAN_PRICING } from '../../shared/utils/license'

/**
 * #288 — editors attach the live page they want changed and give a short
 * order. The agent treated every attached page as source material: "delete
 * this" started creating the article, "update its cover" created a new one, a
 * different article got deleted, and once it asked for a hand-made table of
 * 22 URL → slug pairs because the site "did not match this project".
 */

const models = new Map<string, ModelDefinition>([
  ['articles', { id: 'articles', name: 'Articles', kind: 'collection', domain: 'blog', i18n: true, fields: { title: { type: 'string' }, slug: { type: 'slug' } } } as ModelDefinition],
  ['guides', { id: 'guides', name: 'Guides', kind: 'document', domain: 'blog', i18n: true, fields: { title: { type: 'string' } } } as ModelDefinition],
  ['banners', { id: 'banners', name: 'Banners', kind: 'collection', domain: 'marketing', i18n: false, fields: { title: { type: 'string' }, slug: { type: 'slug' } } } as ModelDefinition],
  ['settings', { id: 'settings', name: 'Settings', kind: 'singleton', domain: 'system', i18n: false, fields: { slug: { type: 'slug' } } } as ModelDefinition],
])

const brain = {
  models,
  content: new Map<string, unknown>([
    ['articles:tr', {
      b7d4e1a9c6f2: { title: 'Creator Economy\'de TikTok\'un Konumu', slug: 'creator-economyde-tiktokun-konumu' },
      c1a2b3c4d5e6: { title: 'Şımart Kendini', slug: 'şımart-kendini' },
      d0d0d0d0d0d0: { title: 'Lansman', slug: 'lansman' },
    }],
    ['articles:en', {
      b7d4e1a9c6f2: { title: 'TikTok in the Creator Economy', slug: 'creator-economyde-tiktokun-konumu' },
    }],
    ['guides:tr', [
      { slug: 'youtube', frontmatter: { title: 'YouTube Rehberi' }, body: '…' },
    ]],
    ['banners:tr', { x1: { title: 'Lansman bannerı', slug: 'lansman' } }],
    ['settings:tr', { slug: 'should-never-match' }],
  ]),
}

describe('extractPageUrls', () => {
  it('takes attached links and URLs pasted in the message, once each', () => {
    const urls = extractPageUrls(
      'bu haberi sil https://site.example/creator-economyde-tiktokun-konumu, ve şunu da: https://site.example/rehberler/youtube.',
      ['https://site.example/creator-economyde-tiktokun-konumu', 'notes.docx'],
    )
    expect(urls).toEqual([
      'https://site.example/creator-economyde-tiktokun-konumu',
      'https://site.example/rehberler/youtube',
    ])
  })

  it('skips assets and bare hosts, which are not pages', () => {
    expect(extractPageUrls('https://studio.example/api/cdn/v1/p/media/original/a.webp https://site.example/', [])).toEqual([])
  })

  it('caps the number of pages resolved per message', () => {
    const many = Array.from({ length: 8 }, (_, i) => `https://site.example/p${i}`).join(' ')
    expect(extractPageUrls(many, [])).toHaveLength(5)
  })
})

describe('resolvePageUrl', () => {
  it('resolves a collection page by its slug field, across locales', () => {
    expect(resolvePageUrl('https://site.example/creator-economyde-tiktokun-konumu', brain)).toEqual({
      url: 'https://site.example/creator-economyde-tiktokun-konumu',
      status: 'resolved',
      candidates: [{ model: 'articles', entry: 'b7d4e1a9c6f2', title: 'Creator Economy\'de TikTok\'un Konumu', locales: ['tr', 'en'] }],
    })
  })

  it('resolves a document page by its slug, from the last path segment', () => {
    const page = resolvePageUrl('https://site.example/rehberler/youtube?utm=x#top', brain)
    expect(page.status).toBe('resolved')
    expect(page.candidates[0]).toMatchObject({ model: 'guides', entry: 'youtube', title: 'YouTube Rehberi' })
  })

  it('decodes a percent-encoded Turkish slug', () => {
    const page = resolvePageUrl(`https://site.example/${encodeURIComponent('şımart-kendini')}`, brain)
    expect(page.candidates[0]).toMatchObject({ model: 'articles', entry: 'c1a2b3c4d5e6' })
  })

  it('lists every candidate when a slug is used by more than one entry', () => {
    const page = resolvePageUrl('https://site.example/lansman', brain)
    expect(page.status).toBe('ambiguous')
    expect(page.candidates.map(c => `${c.model}/${c.entry}`).sort()).toEqual(['articles/d0d0d0d0d0d0', 'banners/x1'])
  })

  it('says none when no entry has the slug — and ignores singletons', () => {
    expect(resolvePageUrl('https://site.example/iletisim', brain)).toMatchObject({ status: 'none', candidates: [] })
    expect(resolvePageUrl('https://site.example/should-never-match', brain).status).toBe('none')
  })
})

describe('linked pages in the prompt', () => {
  beforeAll(() => {
    vi.stubGlobal('agentPrompt', agentPrompt)
    vi.stubGlobal('getPlanParams', getPlanParams)
    vi.stubGlobal('getUpgradeParams', getUpgradeParams)
    vi.stubGlobal('PLAN_PRICING', PLAN_PRICING)
  })

  const config = { stack: 'nuxt', domains: ['blog'], locales: { default: 'tr', supported: ['tr', 'en'] }, workflow: 'auto-merge' } as ContentrainConfig
  const permissions: AgentPermissions = { workspaceRole: 'admin', projectRole: null, specificModels: false, allowedModels: [], allowedLocales: [], availableTools: ['delete_content'] }
  const state = { initialized: true, pendingBranches: [], projectStatus: 'active', phase: 'active' as const, contentContext: null }
  const ui: ChatUIContext = { activeModelId: null, activeLocale: 'tr', activeEntryId: null, panelState: 'overview', activeBranch: null }
  const intent: ClassifiedIntent = { category: 'content_operation', confidence: 'high', inferred: {} }
  const build = (pages?: ReturnType<typeof resolvePageUrl>[]) =>
    buildSystemPromptBlocks(config, [...models.values()], permissions, state, ui, intent, null, null, undefined, null, undefined, undefined, pages)

  it('names the entry a linked page resolves to, in the user turn', () => {
    const blocks = build([
      resolvePageUrl('https://site.example/creator-economyde-tiktokun-konumu', brain),
      resolvePageUrl('https://site.example/lansman', brain),
      resolvePageUrl('https://site.example/iletisim', brain),
    ])
    const context = buildRequestContext(blocks)!
    expect(context).toContain('## Linked pages (this message)')
    expect(context).toContain('https://site.example/creator-economyde-tiktokun-konumu → articles/b7d4e1a9c6f2 "Creator Economy\'de TikTok\'un Konumu" (tr, en)')
    expect(context).toContain(agentPrompt('context.linked_page_ambiguous'))
    expect(context).toContain(agentPrompt('context.linked_page_none'))
  })

  it('keeps pages out of the cached static prompt, which carries the rule instead', () => {
    const withPages = build([resolvePageUrl('https://site.example/lansman', brain)])
    const without = build()
    expect(withPages.static).toBe(without.static)
    expect(without.static).toContain(agentPrompt('rules.linked_page_target'))
    expect(without.dynamic).not.toContain('Linked pages')
  })
})
