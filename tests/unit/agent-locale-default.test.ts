import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { GitProvider } from '../../server/providers/git'
import type { AgentPermissions } from '../../server/utils/agent-permissions'
import type { ChatUIContext } from '../../server/utils/agent-types'
import { formatValidationError, formatValidationErrors } from '../../server/utils/validation-format'

/**
 * A write with no `locale` must land in the locale the agent read from.
 *
 * Incident (customer project, default locale `tr`, 2026-08/09): reads resolved
 * `params.locale ?? activeLocale`, while save_content, delete_content and
 * update_status resolved `params.locale ?? 'en'`. Turkish edits were written
 * into `en`, deletes removed only the `en` file while the agent said "deleted
 * from every language", and the locale showed up only inside the branch name,
 * so neither the agent nor the editor could see it (#281, #284).
 */

const PERMISSIONS: AgentPermissions = {
  workspaceRole: 'owner',
  projectRole: null,
  specificModels: false,
  allowedModels: [],
  allowedLocales: [],
  availableTools: ['save_content', 'delete_content', 'update_status'],
}

function uiContext(activeLocale: string | null): ChatUIContext {
  return { activeModelId: null, activeLocale, activeEntryId: null, panelState: 'overview', activeBranch: null }
}

/** A `tr`-default project, the shape that exposed the bug. */
function stubTrDefaultBrain() {
  vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({
    config: { locales: { default: 'tr', supported: ['tr', 'en'] } },
    content: new Map(),
    meta: new Map(),
    models: new Map([['articles', { id: 'articles', kind: 'collection' }]]),
  }))
  vi.stubGlobal('invalidateBrainCache', vi.fn())
}

function writeResult(paths: string[], extra: Record<string, unknown> = {}) {
  return {
    branch: 'cr/content/articles/x/1',
    commit: { sha: 'abc' },
    diff: paths.map(path => ({ path, status: 'modified', before: null, after: null })),
    validation: { valid: true, errors: [] },
    ...extra,
  }
}

function engineStub(result: Record<string, unknown>) {
  return {
    saveContent: vi.fn().mockResolvedValue(result),
    deleteContent: vi.fn().mockResolvedValue(result),
    updateEntryStatus: vi.fn().mockResolvedValue(result),
    mergeBranch: vi.fn().mockResolvedValue({ merged: true }),
    mergeToContentrain: vi.fn().mockResolvedValue({ merged: true }),
  }
}

async function runTool(toolName: string, params: Record<string, unknown>, engine: unknown, ui: ChatUIContext) {
  const { emptyAffected } = await import('../../server/utils/agent-types')
  vi.stubGlobal('emptyAffected', emptyAffected)
  vi.stubGlobal('hasFeature', vi.fn().mockReturnValue(true))
  vi.stubGlobal('errorMessage', vi.fn((key: string) => key))
  vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))

  const { executeToolWithAutoMerge } = await import('../../server/utils/conversation-engine')
  return executeToolWithAutoMerge(
    toolName,
    params,
    engine as never,
    {} as GitProvider,
    'editor@example.com',
    'user-1',
    'content',
    'auto-merge',
    PERMISSIONS,
    'pro',
    'project-1',
    'workspace-1',
    ui,
  )
}

describe('write tools default to the locale the user works in', () => {
  // The first import transforms the whole engine graph; keep that cost out of
  // the first test's 5 s budget.
  beforeAll(async () => {
    await import('../../server/utils/conversation-engine')
  }, 60_000)

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  const WRITES = [
    { tool: 'save_content', method: 'saveContent', params: { model: 'articles', data: { a1: { title: 'Başlık' } } } },
    { tool: 'delete_content', method: 'deleteContent', params: { model: 'articles', entryIds: ['a1'] } },
    { tool: 'update_status', method: 'updateEntryStatus', params: { model: 'articles', entryIds: ['a1'], status: 'draft' } },
  ] as const

  for (const { tool, method, params } of WRITES) {
    it(`${tool} without a locale uses the project default when the UI names none`, async () => {
      stubTrDefaultBrain()
      const engine = engineStub(writeResult(['.contentrain/content/blog/articles/tr.json']))

      const { result } = await runTool(tool, params, engine, uiContext(null))

      expect(engine[method].mock.calls[0]![1]).toBe('tr')
      expect(result).toMatchObject({ locale: 'tr' })
    })

    it(`${tool} without a locale follows the locale the user is viewing`, async () => {
      stubTrDefaultBrain()
      const engine = engineStub(writeResult(['.contentrain/content/blog/articles/en.json']))

      const { result } = await runTool(tool, params, engine, uiContext('en'))

      expect(engine[method].mock.calls[0]![1]).toBe('en')
      expect(result).toMatchObject({ locale: 'en' })
    })

    it(`${tool} keeps an explicit locale`, async () => {
      stubTrDefaultBrain()
      const engine = engineStub(writeResult(['.contentrain/content/blog/articles/en.json']))

      await runTool(tool, { ...params, locale: 'en' }, engine, uiContext('tr'))

      expect(engine[method].mock.calls[0]![1]).toBe('en')
    })
  }

  it('reports which files a write touched, not just how many', async () => {
    stubTrDefaultBrain()
    // A document delete removes every locale's file — the paths say so, where
    // a bare `filesChanged: 2` let the agent claim a locale it never checked.
    const paths = ['.contentrain/content/guides/intro/en.md', '.contentrain/content/guides/intro/tr.md']
    const engine = engineStub(writeResult(paths))

    const { result } = await runTool('delete_content', { model: 'articles', entryIds: ['intro'], locale: 'tr' }, engine, uiContext('tr'))

    expect(result).toMatchObject({ locale: 'tr', filesChanged: 2, files: paths })
  })

  it('names the entry, field and locale of each validation error', async () => {
    stubTrDefaultBrain()
    const engine = engineStub(writeResult([], {
      branch: '',
      validation: {
        valid: false,
        errors: [
          { severity: 'error', model: 'articles', locale: 'tr', entry: 'a1', field: 'author', message: 'author is required' },
          { severity: 'error', model: 'articles', locale: 'tr', entry: 'a1', field: 'category', message: 'Required field is missing or empty' },
        ],
      },
    }))

    const { result } = await runTool('save_content', { model: 'articles', data: { a1: { title: 'x' } } }, engine, uiContext(null))

    expect((result as { error: string }).error).toBe(
      'content.validation_failed: a1.author (tr): author is required; a1.category (tr): Required field is missing or empty',
    )
  })
})

describe('formatValidationError', () => {
  it('uses the slug when a document error has no entry id', () => {
    expect(formatValidationError({ slug: 'intro', field: 'title', locale: 'en', message: 'too long' }))
      .toBe('intro.title (en): too long')
  })

  it('falls back to the bare message when the error carries no location', () => {
    expect(formatValidationError({ message: 'Dictionary value must be a string' })).toBe('Dictionary value must be a string')
  })

  it('joins with the given separator', () => {
    expect(formatValidationErrors([{ field: 'a', message: 'x' }, { field: 'b', message: 'y' }], ', ')).toBe('a: x, b: y')
  })
})
