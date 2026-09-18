import type { CommentsExport, MigrationHandoff } from '@contentrain/types'
import { GitHubProvider } from '@contentrain/mcp/providers/github'
import { COMMENTS_EXPORT_FORMAT } from '@contentrain/types'
import { describe, expect, it, vi } from 'vitest'
import {
  describeOversizedManifest,
  enrichMigrationHandoff,
  EXPORT_MAX_BYTES,
  HANDOFF_MANIFEST_MAX_BYTES,
  readMigrationHandoffFromRepo,
  renderMigrationHandoffForAgent,
  splitMigrationHandoff,
  summarizeMigrationHandoff,
  validateMigrationHandoff,
} from '../../server/utils/migration-handoff'

const SOURCE = { path: 'contentrain-handoff.json', ref: 'contentrain' }

function makeExport(count: number, body = 'A reply'): CommentsExport {
  return {
    version: 1,
    format: COMMENTS_EXPORT_FORMAT,
    source: { kind: 'wxr' },
    generated_at: '2026-09-03T10:00:00.000Z',
    entries: { 10: { model_id: 'posts', entry_id: 'entry-1' } },
    threads_closed: [],
    comments: Array.from({ length: count }, (_, i) => ({ id: i + 1, post: 10, parent: null, author: 'Ada', date: '2020-05-01T10:00:00Z', content: body, approved: '1' })),
  } as unknown as CommentsExport
}

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
    expect(summary.comments).toEqual({ total: 1009, hasExport: true, source: 'url', unresolved: 0 })
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
    expect(found?.bytes).toBe(Buffer.byteLength(JSON.stringify(makeHandoff())))
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

describe('readMigrationHandoffFromRepo — content_root in a subdirectory', () => {
  // Regression guard for the provider Studio actually builds: MCP's
  // GitHubProvider without `contentRoot` (resolveProjectContext / connect).
  // The intake prefixes content_root itself; the provider must not add it again.
  function fakeOctokit(files: Record<string, string>) {
    const getContent = vi.fn(async ({ path, ref }: { path: string, ref: string }) => {
      const body = files[`${ref}:${path}`]
      if (body === undefined) throw Object.assign(new Error('Not Found'), { status: 404 })
      return { data: { type: 'file', encoding: 'base64', content: Buffer.from(body).toString('base64'), size: body.length, sha: 'sha' } }
    })
    return { getContent, client: { rest: { repos: { getContent } } } }
  }

  it('reads {content_root}/contentrain-handoff.json exactly once-prefixed', async () => {
    const { getContent, client } = fakeOctokit({ 'contentrain:apps/web/contentrain-handoff.json': JSON.stringify(makeHandoff()) })
    const git = new GitHubProvider(client as never, { owner: 'acme', name: 'mono' })
    const found = await readMigrationHandoffFromRepo(git as never, 'apps/web', 'main')
    expect(found?.path).toBe('apps/web/contentrain-handoff.json')
    expect(getContent.mock.calls.map(([arg]) => arg.path)).toEqual(['apps/web/contentrain-handoff.json'])
  })

  it('falls back to the repository root, never to a doubled prefix', async () => {
    const { getContent, client } = fakeOctokit({ 'main:contentrain-handoff.json': JSON.stringify(makeHandoff()) })
    const git = new GitHubProvider(client as never, { owner: 'acme', name: 'mono' })
    const found = await readMigrationHandoffFromRepo(git as never, 'apps/web', 'main')
    expect(found).toMatchObject({ path: 'contentrain-handoff.json', ref: 'main' })
    const paths = getContent.mock.calls.map(([arg]) => arg.path)
    expect(paths).toEqual(['apps/web/contentrain-handoff.json', 'contentrain-handoff.json', 'apps/web/contentrain-handoff.json', 'contentrain-handoff.json'])
    expect(paths.some(p => p.includes('apps/web/apps/web'))).toBe(false)
  })
})

describe('splitMigrationHandoff', () => {
  it('keeps an inline export off the manifest and records where to re-read it', () => {
    const inline = makeExport(5000, 'x'.repeat(650))
    const handoff = makeHandoff({ comments: { total: 5000, export: { format: COMMENTS_EXPORT_FORMAT, inline } } })
    const fileBytes = Buffer.byteLength(JSON.stringify(handoff))
    expect(fileBytes).toBeGreaterThan(3_400_000) // the size of the largest v2 cohort handoff

    const { manifest, manifestBytes } = splitMigrationHandoff(handoff, SOURCE, fileBytes)
    expect(manifest.comments?.export).toEqual({ format: COMMENTS_EXPORT_FORMAT })
    expect(JSON.stringify(manifest)).not.toContain('x'.repeat(650))
    expect(manifest.studio_intake).toMatchObject({ source: SOURCE, fileBytes, manifestBytes, comments: { kind: 'inline' }, unresolvedTotal: 0 })
    expect(manifestBytes).toBeLessThan(4 * 1024)
    expect(manifestBytes).toBeLessThan(HANDOFF_MANIFEST_MAX_BYTES)
  })

  it('prefers a URL over inline, and reads "none" when there is neither', () => {
    const both = makeHandoff({ comments: { total: 2, export: { format: COMMENTS_EXPORT_FORMAT, url: 'https://exports.example/c.json', inline: makeExport(2) } } })
    const split = splitMigrationHandoff(both, SOURCE, 1)
    expect(split.manifest.studio_intake?.comments).toEqual({ kind: 'url', url: 'https://exports.example/c.json' })
    expect(split.manifest.comments?.export).toEqual({ format: COMMENTS_EXPORT_FORMAT, url: 'https://exports.example/c.json' })

    const none = splitMigrationHandoff(makeHandoff({ comments: { total: 3 } }), SOURCE, 1)
    expect(none.manifest.studio_intake?.comments).toEqual({ kind: 'none' })
    expect(none.manifest.comments).toEqual({ total: 3 })
    expect(summarizeMigrationHandoff(none.manifest).comments).toMatchObject({ hasExport: false, source: 'none' })
  })

  it('trims `unresolved` to a sample and keeps the full count', () => {
    const unresolved = Array.from({ length: 4988 }, (_, i) => ({ comment_id: i, post: 1, reason: 'post_not_migrated' }))
    const { manifest } = splitMigrationHandoff(makeHandoff({ comments: { total: 5000, unresolved } }), SOURCE, 1)
    expect(manifest.comments?.unresolved).toHaveLength(100)
    expect(manifest.studio_intake?.unresolvedTotal).toBe(4988)
    expect(summarizeMigrationHandoff(manifest).comments?.unresolved).toBe(4988)
  })

  it('keeps the manifest when the inline export is over the ceiling, and says which field', () => {
    const inline = makeExport(1, 'y'.repeat(EXPORT_MAX_BYTES + 1024 * 1024))
    const { manifest } = splitMigrationHandoff(makeHandoff({ comments: { total: 1, export: { format: COMMENTS_EXPORT_FORMAT, inline } } }), SOURCE, EXPORT_MAX_BYTES + 2048)
    expect(manifest.studio_intake?.comments).toEqual({ kind: 'none' })
    const summary = summarizeMigrationHandoff(manifest)
    expect(summary.comments?.hasExport).toBe(false)
    expect(summary.issues).toContainEqual({ code: 'comments_export_too_large', detail: 'comments.export.inline 51.0 MB > 50.0 MB' })
  })

  it('names the largest field of an oversized manifest', () => {
    const handoff = makeHandoff({ notes: ['z'.repeat(2 * 1024 * 1024)] })
    const { manifest, manifestBytes } = splitMigrationHandoff(handoff, SOURCE, 1)
    expect(manifestBytes).toBeGreaterThan(HANDOFF_MANIFEST_MAX_BYTES)
    expect(describeOversizedManifest(manifest, manifestBytes)).toMatch(/^manifest 2\.0 MB > 1\.0 MB; largest field: notes \(2\.0 MB\)$/)
  })
})

describe('summarizeMigrationHandoff — what Studio cannot take over', () => {
  it('reports unsupported studio_managed offers, an unbound runtime and a missing preview URL', () => {
    const summary = summarizeMigrationHandoff(makeHandoff({
      capabilities: [
        { key: 'forms', disposition: 'needs_runtime' },
        { key: 'comments', disposition: 'needs_runtime' },
        { key: 'search', disposition: 'needs_runtime' },
        { key: 'ecommerce', disposition: 'needs_runtime' },
      ],
      offers: [
        { capability: 'forms', provider: 'studio_managed' },
        { capability: 'search', provider: 'studio_managed' },
        { capability: 'search', provider: 'keep_wordpress' },
        { capability: 'ecommerce', provider: 'studio_managed' },
      ],
    }))
    expect(summary.issues).toEqual([
      { code: 'offer_unsupported', capabilities: ['search', 'ecommerce'] },
      { code: 'runtime_unbound', capabilities: ['forms', 'comments'] },
      { code: 'preview_url_missing' },
    ])
    expect(summary.offers.filter(o => !o.supported).map(o => o.capability)).toEqual(['search', 'ecommerce'])

    const block = renderMigrationHandoffForAgent(summary)
    expect(block).toContain('- Open offers: forms → studio_managed; search → keep_wordpress')
    expect(block).toContain('- Not available in Studio (offered as studio_managed, no Studio runtime): search, ecommerce')
    expect(block).toContain('- Runtime not bound yet (the generated site is not pointed at this project): forms, comments')
    expect(block).toContain('- No preview URL in the handoff')
  })

  it('stays quiet once the preview URL and runtime binding are there', () => {
    const summary = summarizeMigrationHandoff(makeHandoff({
      preview_url: 'https://preview.example',
      runtime: { base_url: 'https://studio.example', project_id: 'p-1' },
    }))
    expect(summary.issues).toEqual([])
  })

  it('reads a row stored before the split (export inline, no intake) as importable', () => {
    const legacy = makeHandoff({ comments: { total: 2, export: { format: COMMENTS_EXPORT_FORMAT, inline: makeExport(2) } } })
    expect(summarizeMigrationHandoff(legacy).comments).toMatchObject({ hasExport: true, source: 'inline' })
  })
})
