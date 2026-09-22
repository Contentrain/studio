import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CDNObject, CDNProvider } from '../../server/providers/cdn'
import type { GitProvider } from '../../server/providers/git'

vi.mock('../../server/utils/branch-health', () => ({
  getHealthStatus: vi.fn().mockResolvedValue({ status: 'healthy', unmergedCount: 0 }),
  checkBranchHealth: vi.fn(),
}))

const OLD = 'https://staging.example.com/api/cdn/v1/old-proj'
const NEW = 'https://studio.example.com/api/cdn/v1/new-proj'

const CONFIG = JSON.stringify({ locales: { default: 'en', supported: ['en', 'tr'] } })
const POSTS = {
  id: 'posts',
  kind: 'collection',
  domain: 'blog',
  i18n: true,
  fields: { title: { type: 'string' }, cover: { type: 'image' }, body: { type: 'markdown' } },
}
const ARTICLES = { id: 'articles', kind: 'document', domain: 'blog', i18n: false, fields: { hero: { type: 'image' } } }

function repo(): Record<string, string> {
  return {
    '.contentrain/config.json': CONFIG,
    '.contentrain/models/posts.json': JSON.stringify(POSTS),
    '.contentrain/models/articles.json': JSON.stringify(ARTICLES),
    '.contentrain/content/blog/posts/en.json': `{\n  "p1": {\n    "body": "See ![a](${OLD}/media/original/a.webp) and <img src=\\"${OLD}/media/original/b.png?w=200\\">",\n    "cover": "${OLD}/media/original/a.webp",\n    "title": "Hello"\n  }\n}\n`,
    '.contentrain/content/blog/posts/tr.json': `{\n  "p1": {\n    "cover": "https://elsewhere.example.com/x.png",\n    "title": "Merhaba"\n  }\n}\n`,
    '.contentrain/content/blog/articles/launch.md': `---\nhero: ${OLD}/media/original/c.jpg\n---\n\n# Launch\n\n![c](${OLD}/media/original/c.jpg)\n`,
    '.contentrain/content/blog/articles/notes.txt': `${OLD}/media/original/ignored.png`,
  }
}

function createGit(files: Record<string, string>, merge: Record<string, unknown> = { merged: true, sha: 'merge-sha', pullRequestUrl: null }) {
  const git = {
    readFile: vi.fn(async (path: string) => {
      if (!(path in files)) throw Object.assign(new Error('Not found'), { status: 404 })
      return files[path]!
    }),
    listDirectory: vi.fn(async (dir: string) => Object.keys(files)
      .filter(p => p.startsWith(`${dir}/`))
      .map(p => p.slice(dir.length + 1))
      .filter(p => !p.includes('/'))),
    fileExists: vi.fn(async (path: string) => path in files),
    getTree: vi.fn(async () => Object.keys(files).map(path => ({ path, type: 'blob' as const, sha: 'x' }))),
    getBranchSha: vi.fn().mockResolvedValue('base-sha'),
    createBranchAt: vi.fn().mockResolvedValue(undefined),
    applyPlan: vi.fn().mockResolvedValue({ sha: 'commit-sha', message: '', author: { name: '', email: '' }, timestamp: '' }),
    deleteBranch: vi.fn().mockResolvedValue(undefined),
  }
  return { git: git as unknown as GitProvider & typeof git, merge: vi.fn().mockResolvedValue(merge) }
}

function createCdn(objects: Record<string, string[]>) {
  const store = Object.fromEntries(Object.entries(objects).map(([k, v]) => [k, new Set(v)]))
  const cdn = {
    listObjects: vi.fn(async (projectId: string, prefix = '') => [...(store[projectId] ?? [])]
      .filter(p => p.startsWith(prefix))
      .map(path => ({ path, size: 1, contentType: 'image/webp', etag: '' }) as CDNObject)),
    copyObject: vi.fn(async (fromProjectId: string, fromPath: string, toProjectId: string, toPath: string) => {
      if (!store[fromProjectId]?.has(fromPath)) throw new Error('NoSuchKey')
      ;(store[toProjectId] ??= new Set()).add(toPath)
    }),
  }
  return cdn as unknown as CDNProvider & typeof cdn
}

function createLibrary(rows: Record<string, string[]>, opts: { failInsert?: boolean } = {}) {
  const store = Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, [...v]]))
  const library = {
    listMediaAssetPaths: vi.fn(async (projectId: string) => [...(store[projectId] ?? [])]),
    copyMediaAssetRows: vi.fn(async (input: { fromProjectId: string, toProjectId: string, toWorkspaceId: string, originalPaths: string[] }) => {
      if (opts.failInsert) throw new Error('insert failed')
      const target = (store[input.toProjectId] ??= [])
      const add = input.originalPaths.filter(p => (store[input.fromProjectId] ?? []).includes(p) && !target.includes(p))
      target.push(...add)
      return add.length
    }),
  }
  return library
}

async function load() {
  return await import('../../server/utils/media-rehost')
}

function baseInput(git: GitProvider, cdn: CDNProvider, merge: ReturnType<typeof vi.fn>, library = createLibrary({})) {
  return {
    git,
    cdn,
    merge,
    library,
    workspaceId: 'ws-1',
    contentRoot: '',
    projectId: 'new-proj',
    siteUrl: 'https://studio.example.com/',
    from: { siteUrl: 'https://staging.example.com', projectId: 'old-proj' },
    dryRun: false,
    copyAssets: false,
    userEmail: 'owner@example.com',
  }
}

const ALL_PATHS = ['media/original/a.webp', 'media/original/b.png', 'media/original/c.jpg']

describe('rehostText', () => {
  beforeEach(() => vi.resetModules())

  it('rewrites field values, markdown targets and inline src, keeping query suffixes', async () => {
    const { rehostText } = await load()
    const text = `"${OLD}/media/a.webp" ![x](${OLD}/media/b.png) <img src='${OLD}/media/c.png?w=2'>`
    const result = rehostText(text, OLD, NEW)
    expect(result.text).toBe(`"${NEW}/media/a.webp" ![x](${NEW}/media/b.png) <img src='${NEW}/media/c.png?w=2'>`)
    expect(result.references).toBe(3)
    expect([...result.paths].sort()).toEqual(['media/a.webp', 'media/b.png', 'media/c.png'])
  })

  it('leaves other projects, look-alike ids, non-media paths and other hosts alone', async () => {
    const { rehostText } = await load()
    const text = [
      `${OLD}-2/media/a.webp`,
      `${OLD}/content/posts/en.json`,
      'https://staging.example.com/api/cdn/v1/other/media/a.webp',
      'https://staging.example.com.evil/api/cdn/v1/old-proj/media/a.webp',
      'media/relative.webp',
    ].join('\n')
    const result = rehostText(text, OLD, NEW)
    expect(result.text).toBe(text)
    expect(result.references).toBe(0)
  })
})

describe('checkRehostSource', () => {
  beforeEach(() => vi.resetModules())

  it('accepts another instance and rejects bad or no-op sources', async () => {
    const { checkRehostSource } = await load()
    const base = { projectId: 'new-proj', siteUrl: 'https://studio.example.com', copyAssets: false }
    expect(checkRehostSource({ ...base, from: { siteUrl: 'https://staging.example.com/', projectId: 'old-proj' } })).toBeNull()
    expect(checkRehostSource({ ...base, from: { siteUrl: 'not a url', projectId: 'old-proj' } })).toBe('invalid_source')
    expect(checkRehostSource({ ...base, from: { siteUrl: 'ftp://staging.example.com', projectId: 'old-proj' } })).toBe('invalid_source')
    expect(checkRehostSource({ ...base, from: { siteUrl: 'https://staging.example.com', projectId: 'a/../b' } })).toBe('invalid_source')
    expect(checkRehostSource({ ...base, from: { siteUrl: 'https://studio.example.com/', projectId: 'new-proj' } })).toBe('same_source')
  })

  it('copies assets only from a project on this instance', async () => {
    const { checkRehostSource } = await load()
    const base = { projectId: 'new-proj', siteUrl: 'https://studio.example.com', copyAssets: true }
    expect(checkRehostSource({ ...base, from: { siteUrl: 'https://staging.example.com', projectId: 'old-proj' } })).toBe('copy_other_instance')
    expect(checkRehostSource({ ...base, from: { siteUrl: 'https://studio.example.com', projectId: 'old-proj' } })).toBeNull()
  })
})

describe('runMediaRehost', () => {
  beforeEach(() => vi.resetModules())

  it('dry run counts files, references and distinct paths, lists missing assets, writes nothing', async () => {
    const { runMediaRehost } = await load()
    const { git, merge } = createGit(repo())
    const cdn = createCdn({ 'new-proj': ['media/original/a.webp'] })

    const result = await runMediaRehost({ ...baseInput(git, cdn, merge), dryRun: true })

    expect(result.status).toBe('dry_run')
    expect(result.counts).toMatchObject({
      from: OLD,
      to: NEW,
      filesScanned: 3, // posts en + tr, one .md document (notes.txt is not content)
      filesChanged: 2,
      references: 5,
      mediaPaths: 3,
      missing: ['media/original/b.png', 'media/original/c.jpg'],
    })
    expect(git.applyPlan).not.toHaveBeenCalled()
    expect(merge).not.toHaveBeenCalled()
  })

  it('commits nothing while any referenced asset is missing', async () => {
    const { runMediaRehost } = await load()
    const { git, merge } = createGit(repo())
    const cdn = createCdn({ 'new-proj': ['media/original/a.webp'] })

    const result = await runMediaRehost(baseInput(git, cdn, merge))

    expect(result.status).toBe('missing_assets')
    expect(result.counts.missing).toHaveLength(2)
    expect(git.applyPlan).not.toHaveBeenCalled()
    expect(git.createBranchAt).not.toHaveBeenCalled()
  })

  it('rewrites every reference in one commit forked from the read snapshot, and lands it', async () => {
    const { runMediaRehost } = await load()
    const files = repo()
    const { git, merge } = createGit(files)
    const cdn = createCdn({ 'new-proj': ALL_PATHS })

    const result = await runMediaRehost(baseInput(git, cdn, merge))

    expect(result).toMatchObject({ status: 'committed', commitSha: 'commit-sha', merged: true })
    expect(git.createBranchAt).toHaveBeenCalledWith(expect.stringMatching(/^cr\/media\/rehost\//), 'base-sha')
    expect(git.applyPlan).toHaveBeenCalledTimes(1)
    const plan = git.applyPlan.mock.calls[0]![0] as { changes: Array<{ path: string, content: string }>, message: string, base: string }
    expect(plan.base).toBe('contentrain')
    expect(plan.changes.map(c => c.path)).toEqual([
      '.contentrain/content/blog/articles/launch.md',
      '.contentrain/content/blog/posts/en.json',
    ])
    for (const change of plan.changes) {
      expect(change.content).not.toContain(OLD)
      // Byte-identical apart from the base: nothing else in the file moved.
      expect(change.content).toBe(files[change.path]!.replaceAll(OLD, NEW))
    }
    expect(plan.message).toContain('5 references to 3 media paths in 2 files')
    expect(merge).toHaveBeenCalledWith((result as { branch: string }).branch)
  })

  it('copies the old prefix\'s missing objects first when asked, skipping ones already there', async () => {
    const { runMediaRehost } = await load()
    const { git, merge } = createGit(repo())
    const cdn = createCdn({
      'old-proj': [...ALL_PATHS, 'media/variants/a-320.webp'],
      'new-proj': ['media/original/a.webp'],
    })
    const input = {
      ...baseInput(git, cdn, merge),
      siteUrl: 'https://staging.example.com',
      copyAssets: true,
    }

    const preview = await runMediaRehost({ ...input, dryRun: true })
    expect(preview.counts.copy).toEqual({ requested: true, toCopy: 3, copied: 0, failed: [] })
    expect(preview.counts.missing).toEqual([])
    expect(cdn.copyObject).not.toHaveBeenCalled()

    const result = await runMediaRehost(input)
    expect(result.status).toBe('committed')
    expect(result.counts.copy).toEqual({ requested: true, toCopy: 3, copied: 3, failed: [] })
    expect(cdn.copyObject).toHaveBeenCalledTimes(3)
    expect(cdn.copyObject).not.toHaveBeenCalledWith('old-proj', 'media/original/a.webp', 'new-proj', 'media/original/a.webp')
  })

  it('reports a conflict and drops the branch when content changed since the read', async () => {
    const { runMediaRehost } = await load()
    const { git, merge } = createGit(repo(), { merged: false, sha: null, pullRequestUrl: null, conflict: true })
    const cdn = createCdn({ 'new-proj': ALL_PATHS })

    const result = await runMediaRehost(baseInput(git, cdn, merge))

    expect(result.status).toBe('conflict')
    expect(git.deleteBranch).toHaveBeenCalledTimes(1)
  })

  it('treats a PR fallback toward a protected main as landed', async () => {
    const { runMediaRehost } = await load()
    const { git, merge } = createGit(repo(), { merged: false, sha: null, pullRequestUrl: 'https://github.com/o/r/pull/9' })
    const cdn = createCdn({ 'new-proj': ALL_PATHS })

    const result = await runMediaRehost(baseInput(git, cdn, merge))

    expect(result).toMatchObject({ status: 'committed', merged: false, pullRequestUrl: 'https://github.com/o/r/pull/9' })
    expect(git.deleteBranch).not.toHaveBeenCalled()
  })

  it('does not commit when no content references the old base', async () => {
    const { runMediaRehost } = await load()
    const { git, merge } = createGit(repo())
    const cdn = createCdn({ 'new-proj': [] })

    const result = await runMediaRehost({ ...baseInput(git, cdn, merge), from: { siteUrl: 'https://other.example.com', projectId: 'x' } })

    expect(result.status).toBe('nothing_to_do')
    expect(git.applyPlan).not.toHaveBeenCalled()
  })

  it('dry run counts library rows to add and already there, touching nothing', async () => {
    const { runMediaRehost } = await load()
    const { git, merge } = createGit(repo())
    const cdn = createCdn({ 'old-proj': ALL_PATHS, 'new-proj': ['media/original/a.webp'] })
    // An old row whose file is gone from storage is not a candidate.
    const library = createLibrary({ 'old-proj': [...ALL_PATHS, 'media/original/gone.webp'], 'new-proj': ['media/original/a.webp'] })

    const result = await runMediaRehost({ ...baseInput(git, cdn, merge, library), siteUrl: 'https://staging.example.com', copyAssets: true, dryRun: true })

    expect(result.counts.library).toEqual({ toAdd: 2, existing: 1, added: 0 })
    expect(library.copyMediaAssetRows).not.toHaveBeenCalled()
    expect(cdn.copyObject).not.toHaveBeenCalled()
  })

  it('adds the old library rows after the storage copy, skipping paths already listed, then commits', async () => {
    const { runMediaRehost } = await load()
    const { git, merge } = createGit(repo())
    const cdn = createCdn({ 'old-proj': ALL_PATHS, 'new-proj': ['media/original/a.webp'] })
    const library = createLibrary({ 'old-proj': ALL_PATHS, 'new-proj': ['media/original/a.webp'] })

    const result = await runMediaRehost({ ...baseInput(git, cdn, merge, library), siteUrl: 'https://staging.example.com', copyAssets: true })

    expect(result.status).toBe('committed')
    expect(result.counts.library).toEqual({ toAdd: 2, existing: 1, added: 2 })
    expect(library.copyMediaAssetRows).toHaveBeenCalledTimes(1)
    expect(library.copyMediaAssetRows).toHaveBeenCalledWith({
      fromProjectId: 'old-proj',
      toProjectId: 'new-proj',
      toWorkspaceId: 'ws-1',
      originalPaths: ['media/original/b.png', 'media/original/c.jpg'],
    })
    // Rows only after every file is in place, and before the commit.
    expect(cdn.copyObject.mock.invocationCallOrder.at(-1)!).toBeLessThan(library.copyMediaAssetRows.mock.invocationCallOrder[0]!)
    expect(library.copyMediaAssetRows.mock.invocationCallOrder[0]!).toBeLessThan(git.applyPlan.mock.invocationCallOrder[0]!)
  })

  it('stops with nothing committed and no rows when a storage copy fails', async () => {
    const { runMediaRehost } = await load()
    const { git, merge } = createGit(repo())
    const cdn = createCdn({ 'old-proj': ALL_PATHS, 'new-proj': [] })
    cdn.copyObject.mockImplementationOnce(async () => {
      throw new Error('R2 down')
    })
    const library = createLibrary({ 'old-proj': ALL_PATHS })

    const result = await runMediaRehost({ ...baseInput(git, cdn, merge, library), siteUrl: 'https://staging.example.com', copyAssets: true })

    expect(result.status).toBe('copy_failed')
    expect(result.counts.copy.failed).toHaveLength(1)
    expect(library.copyMediaAssetRows).not.toHaveBeenCalled()
    expect(git.applyPlan).not.toHaveBeenCalled()
  })

  it('stops with nothing committed when the library insert fails', async () => {
    const { runMediaRehost } = await load()
    const { git, merge } = createGit(repo())
    const cdn = createCdn({ 'old-proj': ALL_PATHS, 'new-proj': [] })
    const library = createLibrary({ 'old-proj': ALL_PATHS }, { failInsert: true })

    const result = await runMediaRehost({ ...baseInput(git, cdn, merge, library), siteUrl: 'https://staging.example.com', copyAssets: true })

    expect(result.status).toBe('library_failed')
    expect(result.counts.library).toEqual({ toAdd: 3, existing: 0, added: 0 })
    expect(git.applyPlan).not.toHaveBeenCalled()
  })

  it('leaves the library alone without copyAssets', async () => {
    const { runMediaRehost } = await load()
    const { git, merge } = createGit(repo())
    const cdn = createCdn({ 'new-proj': ALL_PATHS })
    const library = createLibrary({ 'old-proj': ALL_PATHS })

    const result = await runMediaRehost(baseInput(git, cdn, merge, library))

    expect(result.status).toBe('committed')
    expect(result.counts.library).toEqual({ toAdd: 0, existing: 0, added: 0 })
    expect(library.listMediaAssetPaths).not.toHaveBeenCalled()
    expect(library.copyMediaAssetRows).not.toHaveBeenCalled()
  })
})
