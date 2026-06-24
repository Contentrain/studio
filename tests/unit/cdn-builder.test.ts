import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelDefinition } from '@contentrain/types'
import type { GitProvider } from '../../server/providers/git'
import type { CDNProvider } from '../../server/providers/cdn'
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
    getObject: vi.fn(),
    deleteObject: vi.fn(),
    deletePrefix: vi.fn(),
    listObjects: vi.fn(),
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
  })
})
