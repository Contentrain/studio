import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelDefinition } from '@contentrain/types'
import type { GitProvider } from '../../server/providers/git'
import type { CDNObject, CDNProvider } from '../../server/providers/cdn'
import { executeCDNBuild, getAffectedModels } from '../../server/utils/cdn-builder'
import {
  resolveConfigPath,
  resolveContentPath,
  resolveMetaPath,
  resolveModelPath,
  resolveModelsDir,
} from '../../server/utils/content-paths'
import { rewriteMediaUrl, toDeliveryUrl } from '../../server/utils/media-url'

function createGitProvider(files: Record<string, string>): GitProvider {
  const normalize = (path: string) => path.replace(/^\/+/, '')

  return {
    getTree: vi.fn(),
    readFile: vi.fn(async (path: string) => {
      const value = files[normalize(path)]
      if (value == null) throw new Error(`Missing file: ${path}`)
      return value
    }),
    listDirectory: vi.fn(async (path: string) => {
      const normalizedPath = normalize(path).replace(/\/$/, '')
      if (normalizedPath === '.contentrain/models') return ['faq.json']
      return []
    }),
    fileExists: vi.fn(),
    createBranch: vi.fn(),
    listBranches: vi.fn(),
    getBranchDiff: vi.fn(),
    mergeBranch: vi.fn(),
    deleteBranch: vi.fn(),
    commitFiles: vi.fn(),
    createPR: vi.fn(),
    mergePR: vi.fn(),
    getPermissions: vi.fn(),
    getBranchProtection: vi.fn(),
    getDefaultBranch: vi.fn(),
    detectFramework: vi.fn(),
  } as unknown as GitProvider
}

function createCDNProvider() {
  // Backed by an in-memory Map keyed `${projectId}:${path}`, mirroring the R2
  // provider's flat `${projectId}/${path}` namespace so listObjects/deleteObject
  // actually exercise the build's stale-object sweep (Step 7).
  const objects = new Map<string, string>()

  const provider: CDNProvider = {
    putObject: vi.fn(async (projectId: string, path: string, data: string | Buffer, contentType: string) => {
      const value = typeof data === 'string' ? data : data.toString('utf-8')
      objects.set(`${projectId}:${path}`, value)
      return {
        path,
        size: value.length,
        contentType,
        etag: `${path}-etag`,
      }
    }),
    getObject: vi.fn(async (projectId: string, path: string) => {
      const value = objects.get(`${projectId}:${path}`)
      if (value == null) return null
      return { data: Buffer.from(value, 'utf-8'), contentType: 'application/json', etag: `${path}-etag` }
    }),
    deleteObject: vi.fn(async (projectId: string, path: string) => {
      objects.delete(`${projectId}:${path}`)
    }),
    deletePrefix: vi.fn(async (projectId: string, prefix: string) => {
      const full = `${projectId}:${prefix}`
      for (const key of [...objects.keys()]) {
        if (key.startsWith(full)) objects.delete(key)
      }
    }),
    listObjects: vi.fn(async (projectId: string, prefix?: string) => {
      const out: CDNObject[] = []
      for (const [key, value] of objects) {
        if (!key.startsWith(`${projectId}:`)) continue
        const path = key.slice(projectId.length + 1)
        if (prefix && !path.startsWith(prefix)) continue
        out.push({ path, size: value.length, contentType: 'application/json', etag: `${path}-etag` })
      }
      return out
    }),
    purgeCache: vi.fn().mockResolvedValue(undefined),
    getStorageKey: vi.fn((projectId: string, path: string) => `${projectId}/${path}`),
  }

  return { provider, objects }
}

describe('cdn builder', () => {
  beforeEach(() => {
    vi.stubGlobal('resolveConfigPath', resolveConfigPath)
    vi.stubGlobal('resolveModelPath', resolveModelPath)
    vi.stubGlobal('resolveModelsDir', resolveModelsDir)
    vi.stubGlobal('resolveContentPath', resolveContentPath)
    vi.stubGlobal('resolveMetaPath', resolveMetaPath)
    // cdn-builder calls these as auto-imports; wire the real implementations.
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl: 'https://cdn.test' } }))
    vi.stubGlobal('toDeliveryUrl', toDeliveryUrl)
    vi.stubGlobal('rewriteMediaUrl', rewriteMediaUrl)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('detects config and custom content_path changes when resolving affected models', () => {
    const models: ModelDefinition[] = [
      {
        id: 'faq',
        name: 'FAQ',
        kind: 'collection',
        domain: 'marketing',
        i18n: true,
        content_path: 'content/faq',
      },
    ]

    expect(getAffectedModels(['.contentrain/config.json'], models, '', '.contentrain/config.json')).toEqual(['faq'])
    expect(getAffectedModels(['content/faq/en.json'], models, '', '.contentrain/config.json')).toEqual(['faq'])
  })

  it('publishes only entries with published status in collection models', async () => {
    const files = {
      '.contentrain/config.json': JSON.stringify({
        stack: 'nuxt',
        locales: {
          default: 'en',
          supported: ['en'],
        },
        domains: ['marketing'],
      }),
      '.contentrain/models/faq.json': JSON.stringify({
        id: 'faq',
        name: 'FAQ',
        kind: 'collection',
        domain: 'marketing',
        i18n: true,
        fields: {},
      }),
      '.contentrain/content/marketing/faq/en.json': JSON.stringify({
        published: { question: 'Live question' },
        draft: { question: 'Draft question' },
      }),
      '.contentrain/meta/faq/en.json': JSON.stringify({
        published: { status: 'published' },
        draft: { status: 'draft' },
      }),
    }
    const git = createGitProvider(files)
    const { provider, objects } = createCDNProvider()

    const result = await executeCDNBuild({
      projectId: 'project-1',
      buildId: 'build-1',
      git,
      cdn: provider,
      contentRoot: '',
      commitSha: 'sha-1',
      branch: 'main',
      fullRebuild: true,
    })

    expect(result.error).toBeUndefined()
    expect(provider.purgeCache).toHaveBeenCalledWith('project-1')

    const content = JSON.parse(objects.get('project-1:content/faq/en.json') ?? '{}')
    const meta = JSON.parse(objects.get('project-1:meta/faq/en.json') ?? '{}')

    expect(content).toEqual({
      published: { question: 'Live question' },
    })
    expect(meta).toEqual({
      published: { status: 'published' },
    })
  })

  it('rewrites media-storage paths to delivery URLs in published collection content', async () => {
    const files = {
      '.contentrain/config.json': JSON.stringify({
        stack: 'nuxt',
        locales: { default: 'en', supported: ['en'] },
        domains: ['marketing'],
      }),
      '.contentrain/models/faq.json': JSON.stringify({
        id: 'faq',
        name: 'FAQ',
        kind: 'collection',
        domain: 'marketing',
        i18n: true,
        fields: {
          question: { type: 'string' },
          cover: { type: 'image' },
          gallery: { type: 'array', items: 'image' },
        },
      }),
      '.contentrain/content/marketing/faq/en.json': JSON.stringify({
        a1: {
          question: 'Q',
          cover: 'media/original/a.webp',
          gallery: ['media/original/b.webp', 'https://ext.example/c.jpg'],
        },
      }),
      '.contentrain/meta/faq/en.json': JSON.stringify({ a1: { status: 'published' } }),
    }
    const git = createGitProvider(files)
    const { provider, objects } = createCDNProvider()

    const result = await executeCDNBuild({
      projectId: 'proj',
      buildId: 'b',
      git,
      cdn: provider,
      contentRoot: '',
      commitSha: 's',
      branch: 'main',
      fullRebuild: true,
    })

    expect(result.error).toBeUndefined()
    const content = JSON.parse(objects.get('proj:content/faq/en.json') ?? '{}')
    // Media field → delivery URL; nested array media rewritten; external URL + plain string untouched.
    expect(content.a1.cover).toBe('https://cdn.test/api/cdn/v1/proj/media/original/a.webp')
    expect(content.a1.gallery[0]).toBe('https://cdn.test/api/cdn/v1/proj/media/original/b.webp')
    expect(content.a1.gallery[1]).toBe('https://ext.example/c.jpg')
    expect(content.a1.question).toBe('Q')
  })

  // Regression: the full-rebuild stale-object sweep must never delete media/*
  // binaries. They are uploaded out-of-band by the MediaProvider and are never
  // part of a build's uploadedPaths, so an unguarded sweep 404s every delivery
  // URL while the DB rows + _media_manifest survive.
  function seedProject(projectId: string) {
    const files = {
      '.contentrain/config.json': JSON.stringify({
        stack: 'nuxt',
        locales: { default: 'en', supported: ['en'] },
        domains: ['marketing'],
      }),
      '.contentrain/models/faq.json': JSON.stringify({
        id: 'faq',
        name: 'FAQ',
        kind: 'collection',
        domain: 'marketing',
        i18n: true,
        fields: {},
      }),
      '.contentrain/content/marketing/faq/en.json': JSON.stringify({
        a1: { question: 'Live' },
      }),
      '.contentrain/meta/faq/en.json': JSON.stringify({
        a1: { status: 'published' },
      }),
    }
    const git = createGitProvider(files)
    const { provider, objects } = createCDNProvider()

    // Out-of-band media (original + variant) written by the MediaProvider, plus
    // genuinely-stale build content from a model that no longer exists.
    objects.set(`${projectId}:media/original/keep.webp`, 'IMG')
    objects.set(`${projectId}:media/thumbnail/keep.jpg`, 'THUMB')
    objects.set(`${projectId}:content/old-model/en.json`, '{"gone":1}')
    objects.set(`${projectId}:meta/old-model/en.json`, '{"gone":1}')

    return { git, provider, objects }
  }

  it('preserves out-of-band media/* during a full rebuild while still pruning stale build content', async () => {
    const { git, provider, objects } = seedProject('proj')

    const result = await executeCDNBuild({
      projectId: 'proj',
      buildId: 'b',
      git,
      cdn: provider,
      contentRoot: '',
      commitSha: 's',
      branch: 'main',
      fullRebuild: true,
    })

    expect(result.error).toBeUndefined()
    // Media binaries survive — owned by MediaProvider, not the build.
    expect(objects.has('proj:media/original/keep.webp')).toBe(true)
    expect(objects.has('proj:media/thumbnail/keep.jpg')).toBe(true)
    // Genuinely-stale build content is still garbage-collected.
    expect(objects.has('proj:content/old-model/en.json')).toBe(false)
    expect(objects.has('proj:meta/old-model/en.json')).toBe(false)
    // filesDeleted counts the two stale content objects, never the media.
    expect(result.filesDeleted).toBe(2)
  })

  it('preserves media/* when a build runs with empty changedPaths (webhook empty-commits path)', async () => {
    const { git, provider, objects } = seedProject('proj2')

    // No fullRebuild, but empty changedPaths → same full-sweep branch as Rebuild now.
    const result = await executeCDNBuild({
      projectId: 'proj2',
      buildId: 'b',
      git,
      cdn: provider,
      contentRoot: '',
      commitSha: 's',
      branch: 'main',
      changedPaths: [],
    })

    expect(result.error).toBeUndefined()
    expect(objects.has('proj2:media/original/keep.webp')).toBe(true)
    expect(objects.has('proj2:media/thumbnail/keep.jpg')).toBe(true)
    expect(objects.has('proj2:content/old-model/en.json')).toBe(false)
  })

  it('rewrites media paths in document frontmatter, body, and rendered HTML', async () => {
    const md = [
      '---',
      'title: My Post',
      'cover_image: media/original/hero.webp',
      '---',
      'Inline ![alt](media/original/inline.webp) and [doc](media/original/file.pdf).',
      'External ![x](https://ext.example/y.jpg).',
    ].join('\n')

    const files: Record<string, string> = {
      '.contentrain/config.json': JSON.stringify({
        stack: 'nuxt',
        locales: { default: 'en', supported: ['en'] },
        domains: ['blog'],
      }),
      '.contentrain/models/posts.json': JSON.stringify({
        id: 'posts',
        name: 'Posts',
        kind: 'document',
        domain: 'blog',
        i18n: true,
        fields: { title: { type: 'string' }, cover_image: { type: 'image' } },
      }),
      '.contentrain/content/blog/posts/my-post/en.md': md,
    }

    // Document builds need a listDirectory that returns the model file AND the
    // slug directory; the shared mock only knows the models dir.
    const normalize = (p: string) => p.replace(/^\/+/, '').replace(/\/$/, '')
    const git = {
      ...createGitProvider(files),
      listDirectory: vi.fn(async (p: string) => {
        const n = normalize(p)
        if (n === '.contentrain/models') return ['posts.json']
        if (n === '.contentrain/content/blog/posts') return ['my-post']
        return []
      }),
    } as unknown as GitProvider
    const { provider, objects } = createCDNProvider()

    const result = await executeCDNBuild({
      projectId: 'proj',
      buildId: 'b',
      git,
      cdn: provider,
      contentRoot: '',
      commitSha: 's',
      branch: 'main',
      fullRebuild: true,
    })

    expect(result.error).toBeUndefined()
    const doc = JSON.parse(objects.get('proj:documents/posts/my-post/en.json') ?? '{}')
    expect(doc.frontmatter.cover_image).toBe('https://cdn.test/api/cdn/v1/proj/media/original/hero.webp')
    // body: markdown image + link targets rewritten, external untouched
    expect(doc.body).toContain('](https://cdn.test/api/cdn/v1/proj/media/original/inline.webp)')
    expect(doc.body).toContain('](https://cdn.test/api/cdn/v1/proj/media/original/file.pdf)')
    expect(doc.body).toContain('](https://ext.example/y.jpg)')
    // html: rendered <img>/<a> inherit the absolute URLs
    expect(doc.html).toContain('src="https://cdn.test/api/cdn/v1/proj/media/original/inline.webp"')
    expect(doc.html).toContain('href="https://cdn.test/api/cdn/v1/proj/media/original/file.pdf"')

    // The document index is bundled path-identically (per-slug bodies are not).
    const bundle = JSON.parse(objects.get('proj:_bundle/en.json') ?? '{}')
    expect(bundle.paths['documents/posts/_index/en.json']).toEqual(
      JSON.parse(objects.get('proj:documents/posts/_index/en.json') ?? '[]'),
    )
    expect(bundle.paths['documents/posts/my-post/en.json']).toBeUndefined()
  })

  it('emits per-locale bundles that mirror the standalone artifacts', async () => {
    const { git, provider, objects } = seedProject('proj')
    // A bundle for a locale the config no longer supports must be swept.
    objects.set('proj:_bundle/tr.json', '{"version":"1","paths":{}}')

    const result = await executeCDNBuild({
      projectId: 'proj',
      buildId: 'b',
      git,
      cdn: provider,
      contentRoot: '',
      commitSha: 'sha-bundle',
      branch: 'main',
      fullRebuild: true,
    })

    expect(result.error).toBeUndefined()
    const bundle = JSON.parse(objects.get('proj:_bundle/en.json') ?? '{}')
    expect(bundle.version).toBe('1')
    expect(bundle.commitSha).toBe('sha-bundle')
    expect(bundle.locale).toBe('en')
    // Bodies are identical to the standalone artifacts (SDK primes its cache from them).
    expect(bundle.paths['content/faq/en.json']).toEqual(
      JSON.parse(objects.get('proj:content/faq/en.json') ?? '{}'),
    )
    // meta/ stays per-path in bundle v1.
    expect(bundle.paths['meta/faq/en.json']).toBeUndefined()
    // The dropped-locale bundle is garbage-collected; the live one survives the sweep.
    expect(objects.has('proj:_bundle/tr.json')).toBe(false)
    expect(objects.has('proj:_bundle/en.json')).toBe(true)
  })

  it('merges unchanged models from storage into the bundle on selective builds', async () => {
    const files = {
      '.contentrain/config.json': JSON.stringify({
        stack: 'nuxt',
        locales: { default: 'en', supported: ['en'] },
        domains: ['marketing'],
      }),
      '.contentrain/models/faq.json': JSON.stringify({
        id: 'faq',
        name: 'FAQ',
        kind: 'collection',
        domain: 'marketing',
        i18n: true,
        fields: {},
      }),
      '.contentrain/models/team.json': JSON.stringify({
        id: 'team',
        name: 'Team',
        kind: 'collection',
        domain: 'marketing',
        i18n: true,
        fields: {},
      }),
      '.contentrain/content/marketing/faq/en.json': JSON.stringify({
        a1: { question: 'Fresh from git' },
      }),
      // NOTE: no team content in git — the bundle must source it from storage.
    }
    const normalize = (p: string) => p.replace(/^\/+/, '').replace(/\/$/, '')
    const git = {
      ...createGitProvider(files),
      listDirectory: vi.fn(async (p: string) => {
        if (normalize(p) === '.contentrain/models') return ['faq.json', 'team.json']
        return []
      }),
    } as unknown as GitProvider
    const { provider, objects } = createCDNProvider()

    // The unchanged model's artifact already lives in CDN storage.
    objects.set('proj:content/team/en.json', JSON.stringify({ m1: { name: 'Existing member' } }))

    const result = await executeCDNBuild({
      projectId: 'proj',
      buildId: 'b',
      git,
      cdn: provider,
      contentRoot: '',
      commitSha: 's',
      branch: 'main',
      changedPaths: ['.contentrain/content/marketing/faq/en.json'],
    })

    expect(result.error).toBeUndefined()
    expect(result.changedModels).toEqual(['faq'])

    const bundle = JSON.parse(objects.get('proj:_bundle/en.json') ?? '{}')
    expect(bundle.paths['content/faq/en.json']).toEqual({ a1: { question: 'Fresh from git' } })
    expect(bundle.paths['content/team/en.json']).toEqual({ m1: { name: 'Existing member' } })
  })

  it('includes non-i18n bodies in every locale bundle', async () => {
    const files = {
      '.contentrain/config.json': JSON.stringify({
        stack: 'nuxt',
        locales: { default: 'en', supported: ['en', 'tr'] },
        domains: ['marketing'],
      }),
      '.contentrain/models/faq.json': JSON.stringify({
        id: 'faq',
        name: 'FAQ',
        kind: 'collection',
        domain: 'marketing',
        i18n: true,
        fields: {},
      }),
      '.contentrain/models/settings.json': JSON.stringify({
        id: 'settings',
        name: 'Settings',
        kind: 'singleton',
        domain: 'marketing',
        i18n: false,
        fields: {},
      }),
      '.contentrain/content/marketing/faq/en.json': JSON.stringify({ a1: { q: 'EN' } }),
      '.contentrain/content/marketing/faq/tr.json': JSON.stringify({ a1: { q: 'TR' } }),
      '.contentrain/content/marketing/settings/data.json': JSON.stringify({ title: 'Shared' }),
    }
    const normalize = (p: string) => p.replace(/^\/+/, '').replace(/\/$/, '')
    const git = {
      ...createGitProvider(files),
      listDirectory: vi.fn(async (p: string) => {
        if (normalize(p) === '.contentrain/models') return ['faq.json', 'settings.json']
        return []
      }),
    } as unknown as GitProvider
    const { provider, objects } = createCDNProvider()

    const result = await executeCDNBuild({
      projectId: 'proj',
      buildId: 'b',
      git,
      cdn: provider,
      contentRoot: '',
      commitSha: 's',
      branch: 'main',
      fullRebuild: true,
    })

    expect(result.error).toBeUndefined()
    const en = JSON.parse(objects.get('proj:_bundle/en.json') ?? '{}')
    const tr = JSON.parse(objects.get('proj:_bundle/tr.json') ?? '{}')
    // Locale-specific bodies land in their own bundle...
    expect(en.paths['content/faq/en.json']).toEqual({ a1: { q: 'EN' } })
    expect(tr.paths['content/faq/tr.json']).toEqual({ a1: { q: 'TR' } })
    expect(en.paths['content/faq/tr.json']).toBeUndefined()
    // ...while the non-i18n body ships in every bundle under its real path.
    expect(en.paths['content/settings/data.json']).toEqual({ title: 'Shared' })
    expect(tr.paths['content/settings/data.json']).toEqual({ title: 'Shared' })
  })
})
