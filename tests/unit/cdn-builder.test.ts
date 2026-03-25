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
})
