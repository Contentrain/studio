import { describe, expect, it, vi } from 'vitest'
import { buildSystemPrompt } from '../../server/utils/agent-system-prompt'

vi.stubGlobal('agentPrompt', (key: string) => `[prompt:${key}]`)

describe('buildSystemPrompt', () => {
  it('includes architecture, context, permissions, and vocabulary guidance', () => {
    const prompt = buildSystemPrompt(
      {
        stack: 'nuxt',
        domains: ['marketing', 'system'],
        workflow: 'review',
        locales: {
          default: 'en',
          supported: ['en', 'tr'],
        },
      } as never,
      [
        {
          id: 'posts',
          name: 'Posts',
          kind: 'collection',
          domain: 'marketing',
          i18n: true,
          fields: {
            title: { type: 'string', required: true },
            heroImage: { type: 'image' },
          },
        },
      ] as never,
      {
        workspaceRole: 'member',
        projectRole: 'editor',
        specificModels: true,
        allowedModels: ['posts'],
        availableTools: ['get_content', 'save_content'],
      },
      {
        initialized: true,
        pendingBranches: [{ name: 'contentrain/save-1', sha: 'abc', protected: false }],
        projectStatus: 'active',
        phase: 'active',
        contentContext: {
          lastOperation: {
            tool: 'save_content',
            model: 'posts',
            locale: 'en',
          },
          stats: {
            models: 1,
            entries: 12,
            locales: ['en', 'tr'],
          },
        },
      },
      {
        activeModelId: 'posts',
        activeLocale: 'en',
        activeEntryId: 'entry-1',
        panelState: 'content',
        activeBranch: null,
        contextItems: [],
      },
      {
        category: 'update_content',
        confidence: 'high',
        inferred: {
          modelId: 'posts',
          locale: 'en',
          entryId: 'entry-1',
        },
      },
      {
        headline: {
          en: 'Headline',
          tr: 'Baslik',
        },
      },
      'business',
    )

    expect(prompt).toContain('## Contentrain Architecture')
    expect(prompt).toContain('## Inferred Intent: update_content')
    expect(prompt).toContain('Default model: posts')
    expect(prompt).toContain('Pending branches (1)')
    expect(prompt).toContain('Posts (`posts`)')
    expect(prompt).toContain('Role: member / editor')
    expect(prompt).toContain('Model access restricted to: posts')
    expect(prompt).toContain('## Vocabulary (1 terms)')
    expect(prompt).toContain('Workflow: review')
  })

  it('adds initialization guidance for uninitialized projects', () => {
    const prompt = buildSystemPrompt(
      null,
      [],
      {
        workspaceRole: 'owner',
        projectRole: null,
        specificModels: false,
        allowedModels: [],
        availableTools: ['init_project'],
      },
      {
        initialized: false,
        pendingBranches: [],
        projectStatus: 'setup',
        phase: 'uninitialized',
        contentContext: null,
      },
      {
        activeModelId: null,
        activeLocale: 'en',
        activeEntryId: null,
        panelState: 'overview',
        activeBranch: null,
        contextItems: [],
      },
      {
        category: 'init_project',
        confidence: 'medium',
        inferred: {},
      },
      null,
      'free',
    )

    expect(prompt).toContain('This project needs initialization')
    expect(prompt).toContain('Use init_project')
    expect(prompt).toContain('Available tools: init_project')
  })
})
