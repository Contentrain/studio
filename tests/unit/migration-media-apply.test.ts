import { canonicalStringify } from '@contentrain/types'
import { describe, expect, it } from 'vitest'
import { planMigrationMediaApply } from '../../server/utils/migration-media-apply'
import { parseMigrationMediaManifest } from '../../server/utils/migration-media'

/**
 * Pointing a migrated site at Studio: refs rewritten by walking to the value
 * (exact / contains / relation), never a text replace over the file; drift
 * reported, not forced; studio.json bound; local files deleted only when
 * nothing can still point at them.
 */

const STUDIO = 'https://studio.test/api/cdn/v1/p-1/media/original'
const A = `${STUDIO}/a.png`
const B = `${STUDIO}/b.png`
const H = '0'.repeat(64)

const manifest = (over: Array<Record<string, unknown>> = []) => parseMigrationMediaManifest({
  version: 1,
  assets: [
    {
      id: 'a', repoPath: 'public/media/2024/a.png', localUrl: '/media/2024/a.png', sha256: H, bytes: 10, mime: 'image/png',
      refs: [
        { file: 'content/blog/en.json', pointer: '/post-1/cover', match: 'exact' },
        { file: 'content/blog/en.json', pointer: '/post-1/body', match: 'contains' },
        { file: 'content/media/en.json', pointer: '/a/url', match: 'exact' },
        { file: 'content/blog/en.json', pointer: '/post-1/cover_id', match: 'relation' },
        { file: 'content/pages/about.md', pointer: '', match: 'contains' },
      ],
    },
    {
      id: 'b', repoPath: 'public/media/2024/b.png', localUrl: '/media/2024/b.png', sha256: H, bytes: 10, mime: 'image/png',
      refs: [{ file: 'content/blog/en.json', pointer: '/post-1/body', match: 'contains' }],
    },
    ...over,
  ],
})

const blog = {
  'post-1': {
    cover: '/media/2024/a.png',
    cover_id: 'a',
    body: '<img src="/media/2024/a.png" srcset="/media/2024/a.png 1x, /media/2024/a.png-300x200.png 300w"><img src="/media/2024/b.png">'
      + '<!-- wp:image {"url":"\\/media\\/2024\\/a.png"} --><a href="/media/2024/a.png.webp">x</a>',
  },
}
const repo = (over: Record<string, string | null> = {}): Record<string, string | null> => ({
  'content/blog/en.json': canonicalStringify(blog),
  'content/media/en.json': canonicalStringify({ a: { url: '/media/2024/a.png' } }),
  'content/pages/about.md': '---\ntitle: About\n---\n![Team](/media/2024/a.png)\n',
  'studio.json': null,
  ...over,
})
const imported = new Map([['public/media/2024/a.png', A], ['public/media/2024/b.png', B]])

async function plan(opts: { files?: Record<string, string | null>, imported?: Map<string, string>, deleteLocal?: boolean, root?: string, m?: ReturnType<typeof manifest>, mediaBaseUrl?: string, noList?: boolean } = {}) {
  const files = opts.files ?? repo()
  return planMigrationMediaApply({
    manifest: opts.m ?? manifest(),
    root: opts.root ?? '',
    imported: opts.imported ?? imported,
    read: async path => files[path] ?? null,
    studio: { baseUrl: 'https://studio.test/', projectId: 'p-1', ...(opts.mediaBaseUrl ? { mediaBaseUrl: opts.mediaBaseUrl } : {}) },
    deleteLocal: opts.deleteLocal ?? false,
    ...(opts.noList ? {} : { listFiles: async () => Object.keys(files).filter(k => files[k] !== null).map(path => ({ path, size: files[path]!.length })) }),
  })
}

const contentOf = (changes: Array<{ path: string, content: string | null }>, path: string) => changes.find(c => c.path === path)?.content

describe('planMigrationMediaApply', () => {
  it('rewrites exact values, occurrences inside a value (plain and \\/-escaped), and markdown; leaves relations and look-alikes', async () => {
    const { changes, counts } = await plan()
    const post = JSON.parse(contentOf(changes, 'content/blog/en.json')!)['post-1']
    expect(post.cover).toBe(A)
    expect(post.cover_id).toBe('a')
    expect(post.body).toBe(`<img src="${A}" srcset="${A} 1x, /media/2024/a.png-300x200.png 300w"><img src="${B}">`
      + `<!-- wp:image {"url":"${A.replace(/\//g, '\\/')}"} --><a href="/media/2024/a.png.webp">x</a>`)
    expect(JSON.parse(contentOf(changes, 'content/media/en.json')!)).toEqual({ a: { url: A } })
    expect(contentOf(changes, 'content/pages/about.md')).toBe(`---\ntitle: About\n---\n![Team](${A})\n`)
    expect(counts).toMatchObject({ rewritten: 7, relations: 1, drifted: [], remaining: [], filesChanged: 3, keptBecause: 'not_requested', deleted: 0 })
  })

  it('writes studio.json as canonical JSON, and leaves it alone when it already says the same', async () => {
    const written = await plan()
    expect(contentOf(written.changes, 'studio.json')).toBe('{\n  "baseUrl": "https://studio.test",\n  "projectId": "p-1"\n}\n')
    expect(written.counts.studioBinding).toBe('written')
    const same = await plan({ files: repo({ 'studio.json': contentOf(written.changes, 'studio.json')! }) })
    expect(same.counts.studioBinding).toBe('unchanged')
    expect(contentOf(same.changes, 'studio.json')).toBeUndefined()
    // mediaBaseUrl is the project's full delivery base; written only when media is served from another host.
    const cdn = await plan({ mediaBaseUrl: 'https://cdn.studio.test/api/cdn/v1/p-1/' })
    expect(JSON.parse(contentOf(cdn.changes, 'studio.json')!)).toEqual({ baseUrl: 'https://studio.test', mediaBaseUrl: 'https://cdn.studio.test/api/cdn/v1/p-1', projectId: 'p-1' })
    const sameHost = await plan({ mediaBaseUrl: 'https://studio.test/api/cdn/v1/p-1' })
    expect(JSON.parse(contentOf(sameHost.changes, 'studio.json')!)).toEqual({ baseUrl: 'https://studio.test', projectId: 'p-1' })
  })

  it('a value edited since the migration is reported as drifted and left as it is', async () => {
    const edited = { 'post-1': { ...blog['post-1'], cover: 'https://elsewhere.test/new.png' } }
    const { changes, counts } = await plan({ files: repo({ 'content/blog/en.json': canonicalStringify(edited) }) })
    expect(JSON.parse(contentOf(changes, 'content/blog/en.json')!)['post-1'].cover).toBe('https://elsewhere.test/new.png')
    expect(counts.drifted).toEqual([{ file: 'content/blog/en.json', pointer: '/post-1/cover', repoPath: 'public/media/2024/a.png' }])
  })

  it('run again after landing: nothing left to rewrite, every ref counted as already done', async () => {
    const first = await plan()
    const landed = { ...repo() }
    for (const c of first.changes) landed[c.path] = c.content
    const second = await plan({ files: landed })
    expect(second.changes).toEqual([])
    expect(second.counts).toMatchObject({ rewritten: 0, alreadyRewritten: 5, drifted: [] })
  })

  it('a file nothing was rewritten in is not reformatted', async () => {
    const m = manifest([{ id: 'c', repoPath: 'public/media/c.png', localUrl: '/media/c.png', sha256: H, bytes: 1, mime: 'image/png', refs: [{ file: 'content/other/en.json', pointer: '/x', match: 'exact' }] }])
    const { changes } = await plan({ m, files: repo({ 'content/other/en.json': '{"x":"/media/elsewhere.png","b":1}' }) })
    expect(contentOf(changes, 'content/other/en.json')).toBeUndefined()
  })

  it('deletes the local files only when asked and nothing can still point at them', async () => {
    const all = await plan({ deleteLocal: true })
    expect(all.counts).toMatchObject({ keptBecause: null, deleted: 2 })
    expect(all.changes.filter(c => c.content === null).map(c => c.path)).toEqual(['public/media/2024/a.png', 'public/media/2024/b.png'])

    const partial = await plan({ deleteLocal: true, imported: new Map([['public/media/2024/a.png', A]]) })
    expect(partial.counts).toMatchObject({ keptBecause: 'not_all_imported', deleted: 0, notImported: ['public/media/2024/b.png'] })
    expect(partial.changes.some(c => c.content === null)).toBe(false)

    const drifted = await plan({ deleteLocal: true, files: repo({ 'content/media/en.json': canonicalStringify({ a: { url: 'changed' } }) }) })
    expect(drifted.counts.keptBecause).toBe('drifted')

    // The manifest missed a place: the local URL is still in a file it does touch.
    const extra = canonicalStringify({ 'post-1': { ...blog['post-1'], summary: 'see /media/2024/b.png' } })
    const remaining = await plan({ deleteLocal: true, files: repo({ 'content/blog/en.json': extra }) })
    expect(remaining.counts.keptBecause).toBe('remaining_refs')
    expect(remaining.counts.remaining).toEqual([{ file: 'content/blog/en.json', url: '/media/2024/b.png' }])
  })

  it('before deleting, the site\'s own code, styles and config are searched too — not only the files the manifest lists', async () => {
    const withSite = (extra: Record<string, string>) => repo({ '.contentrain/migrate/media.json': '{"assets":[{"localUrl":"/media/2024/a.png"}]}', ...extra })
    // The manifest itself names every local URL; it is not a reference.
    expect((await plan({ deleteLocal: true, files: withSite({}) })).counts.keptBecause).toBeNull()
    for (const [path, text] of [
      ['src/components/Hero.astro', '<img src="/media/2024/a.png" alt="">'],
      ['src/styles/global.css', '.hero { background: url(/media/2024/b.png) }'],
      ['public/_headers', '/media/2024/a.png\n  Cache-Control: max-age=31536000'],
      ['astro.config.mjs', 'const logo = "/media/2024/b.png"'],
      ['public/site.webmanifest', '{"icons":[{"src":"/media/2024/a.png"}]}'],
    ] as const) {
      const { counts, changes } = await plan({ deleteLocal: true, files: withSite({ [path]: text }) })
      expect(counts.keptBecause, path).toBe('remaining_refs')
      expect(counts.remaining.map(r => r.file), path).toEqual([path])
      expect(changes.some(c => c.content === null), path).toBe(false)
    }
    // A look-alike name is not a reference.
    expect((await plan({ deleteLocal: true, files: withSite({ 'src/x.astro': '<img src="/media/2024/a.png-300x200.png">' }) })).counts.keptBecause).toBeNull()
  })

  it('a project that cannot be searched (no file list, or too many files) keeps its local files', async () => {
    expect((await plan({ deleteLocal: true, noList: true })).counts.keptBecause).toBe('too_large_to_verify')
    const many: Record<string, string> = {}
    for (let i = 0; i <= 1500; i++) many[`src/gen/f${i}.ts`] = 'export {}'
    const { counts, changes } = await plan({ deleteLocal: true, files: repo(many) })
    expect(counts.keptBecause).toBe('too_large_to_verify')
    expect(changes.some(c => c.content === null)).toBe(false)
  })

  it('a project in a subdirectory: every path is under its root', async () => {
    const files: Record<string, string | null> = {}
    for (const [k, v] of Object.entries(repo())) files[`site/${k}`] = v
    const { changes, counts } = await plan({ root: 'site', files, imported: new Map([['site/public/media/2024/a.png', A], ['site/public/media/2024/b.png', B]]), deleteLocal: true })
    expect(counts.keptBecause).toBeNull()
    expect(changes.map(c => c.path)).toEqual([
      'site/content/blog/en.json', 'site/content/media/en.json', 'site/content/pages/about.md',
      'site/public/media/2024/a.png', 'site/public/media/2024/b.png', 'site/studio.json',
    ])
  })
})
