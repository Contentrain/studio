/**
 * W3 regression: with a projectId, post-merge context regeneration
 * derives context.json from the brain snapshot (no MCP repo walk).
 * Engines without a projectId keep the MCP fallback — covered by the
 * existing regen test in content-engine.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContentEngine } from '../../server/utils/content-engine'
import { buildContextChangeFromBrain } from '../../server/utils/content-engine/context-build'
import type { BrainCacheEntry } from '../../server/utils/brain-cache'

const brainState = vi.hoisted(() => ({
  getOrBuildBrainCache: vi.fn(),
}))

vi.mock('../../server/utils/brain-cache', () => ({
  getOrBuildBrainCache: brainState.getOrBuildBrainCache,
}))

function makeBrain(): BrainCacheEntry {
  return {
    treeSha: 'sha',
    fileShas: new Map(),
    stale: false,
    config: {
      version: 1,
      stack: 'nuxt',
      workflow: 'auto-merge',
      domains: ['marketing'],
      locales: { default: 'en', supported: ['en'] },
    } as never,
    models: new Map([['faq', { id: 'faq', name: 'FAQ', kind: 'collection', domain: 'marketing', i18n: true, fields: {} } as never]]),
    content: new Map([['faq:en', { q1: { question: 'Hi?' }, q2: { question: 'Why?' } }]]),
    meta: new Map(),
    vocabulary: null,
    contentContext: null,
    contentSummary: {},
    schemaValidation: null,
    lastRefresh: Date.now(),
    projectId: 'project-1',
  }
}

describe('context regeneration via brain (projectId engines)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-08T12:00:00.000Z'))
    brainState.getOrBuildBrainCache.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('commits brain-derived context.json and skips the MCP stats walk', async () => {
    const brain = makeBrain()
    brainState.getOrBuildBrainCache.mockResolvedValue(brain)

    const applyPlan = vi.fn().mockResolvedValue({ sha: 'ctx-sha', message: 'm', author: { name: 'a', email: 'e' }, timestamp: 't' })
    const readFile = vi.fn().mockRejectedValue(new Error('no context.json yet'))
    const listDirectory = vi.fn()
    const git = {
      mergeBranch: vi.fn().mockResolvedValue({ merged: true, sha: 'merge-sha', pullRequestUrl: null }),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      applyPlan,
      readFile,
      listDirectory,
    }

    const engine = createContentEngine({ git: git as never, contentRoot: '', projectId: 'project-1' })
    await engine.mergeBranch('cr/content/faq/en/1234567890-abcd')

    expect(brainState.getOrBuildBrainCache).toHaveBeenCalledWith(git, '', 'project-1')

    const expected = buildContextChangeFromBrain(brain, { contentRoot: '' }, { tool: 'merge', model: 'faq', locale: 'en' })
    expect(applyPlan).toHaveBeenCalledWith(expect.objectContaining({
      branch: 'contentrain',
      base: 'contentrain',
      changes: [expected],
    }))
    expect(JSON.parse(expected!.content!).stats).toMatchObject({ models: 1, entries: 2 })

    // The MCP walk never ran: no models-directory listing.
    expect(listDirectory).not.toHaveBeenCalled()
  })
})
