import type { MigrationHandoff } from '@contentrain/types'
import { describe, expect, it, vi } from 'vitest'
import {
  enrichMigrationHandoff,
  readMigrationHandoffFromRepo,
  renderMigrationHandoffForAgent,
  summarizeMigrationHandoff,
  validateMigrationHandoff,
} from '../../server/utils/migration-handoff'

function makeHandoff(overrides: Partial<MigrationHandoff> = {}): MigrationHandoff {
  return {
    version: 1,
    site_url: 'https://carriedils.com',
    generated_at: '2026-09-03T10:00:00.000Z',
    content_summary: { models: 7, entries: 95, locales: ['en'] },
    capabilities: [
      { key: 'seo', disposition: 'migrated_static' },
      { key: 'forms', disposition: 'needs_runtime', detail: 'Gravity Forms' },
      { key: 'comments', disposition: 'needs_runtime' },
      { key: 'analytics', disposition: 'dropped', detail: 'gtag' },
    ],
    comments: { total: 1009, export: { format: 'contentrain-comments@1', url: 'https://exports.example/comments.json' } },
    offers: [
      { capability: 'comments', provider: 'studio_managed' },
      { capability: 'comments', provider: 'keep_wordpress', warning: 'the WordPress server stays live' },
    ],
    notes: ['build ok', 'quality gate ok'],
    ...overrides,
  }
}

describe('validateMigrationHandoff', () => {
  it('accepts the contract shape', () => {
    expect(validateMigrationHandoff(makeHandoff())).toBeNull()
  })

  it('rejects wrong versions, missing required keys and malformed capabilities', () => {
    expect(validateMigrationHandoff(null)?.code).toBe('invalid_payload')
    expect(validateMigrationHandoff({ ...makeHandoff(), version: 2 })?.code).toBe('unsupported_version')
    expect(validateMigrationHandoff({ ...makeHandoff(), site_url: '' })?.detail).toBe('site_url')
    expect(validateMigrationHandoff({ ...makeHandoff(), generated_at: 'yesterday' })?.detail).toBe('generated_at')
    expect(validateMigrationHandoff({ ...makeHandoff(), capabilities: [{ key: 'seo' }] })?.code).toBe('invalid_capabilities')
    expect(validateMigrationHandoff({ ...makeHandoff(), comments: { export: {} } })?.detail).toBe('comments')
  })
})

describe('enrichMigrationHandoff', () => {
  it('fills repository from the project and leaves an existing one alone', () => {
    const enriched = enrichMigrationHandoff(makeHandoff(), { repo_full_name: 'acme/site', default_branch: 'main' })
    expect(enriched.repository).toEqual({ provider: 'github', owner: 'acme', name: 'site', default_branch: 'main' })

    const own = makeHandoff({ repository: { provider: 'gitlab', owner: 'x', name: 'y', default_branch: 'dev' } })
    expect(enrichMigrationHandoff(own, { repo_full_name: 'acme/site' }).repository?.provider).toBe('gitlab')
  })
})

describe('summarizeMigrationHandoff / renderMigrationHandoffForAgent', () => {
  it('groups capabilities, lists offers and reports the comments export', () => {
    const summary = summarizeMigrationHandoff(makeHandoff())
    expect(summary.needsRuntime).toEqual(['forms', 'comments'])
    expect(summary.comments).toEqual({ total: 1009, hasExport: true, unresolved: 0 })
    expect(summary.offers).toHaveLength(2)

    const block = renderMigrationHandoffForAgent(summary)
    expect(block).toContain('## Migration (from WordPress)')
    expect(block).toContain('https://carriedils.com')
    expect(block).toContain('needs_runtime: forms, comments')
    expect(block).toContain('dropped: analytics')
    expect(block).toContain('comments → studio_managed')
    expect(block).toContain('1009')
    expect(block).toContain('export available')
    expect(block.split('\n').length).toBeLessThan(15)
  })
})

describe('readMigrationHandoffFromRepo', () => {
  it('tries the content branch before the default branch and the content root before the repo root', async () => {
    const calls: Array<[string, string | undefined]> = []
    const git = {
      readFile: vi.fn(async (path: string, ref?: string) => {
        calls.push([path, ref])
        if (path === 'contentrain-handoff.json' && ref === 'main') return JSON.stringify(makeHandoff())
        throw new Error('not found')
      }),
    }
    const found = await readMigrationHandoffFromRepo(git as never, 'site', 'main')
    expect(found?.ref).toBe('main')
    expect(found?.path).toBe('contentrain-handoff.json')
    expect(calls).toEqual([
      ['site/contentrain-handoff.json', 'contentrain'],
      ['contentrain-handoff.json', 'contentrain'],
      ['site/contentrain-handoff.json', 'main'],
      ['contentrain-handoff.json', 'main'],
    ])
  })

  it('returns null when no branch carries the file', async () => {
    const git = { readFile: vi.fn().mockRejectedValue(new Error('404')) }
    expect(await readMigrationHandoffFromRepo(git as never, '', 'main')).toBeNull()
  })
})
