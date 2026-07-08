/**
 * Byte-parity suite for the Studio-side context.json builder.
 *
 * `buildContextChangeFromBrain` must produce EXACTLY the content MCP's
 * `buildContextChange` produces over the same fixture repo — same keys,
 * ordering, indentation, trailing newline, and entry counts — since
 * external readers treat context.json as MCP's contract. Timestamps are
 * frozen with fake timers so the comparison is total.
 */
import { buildContextChange } from '@contentrain/mcp/core/context'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Virtual fixture repo (served to BOTH the brain build and MCP's reader) ──

const FILES: Record<string, string> = {
  '.contentrain/config.json': JSON.stringify({
    stack: 'nuxt',
    domains: ['marketing'],
    workflow: 'auto-merge',
    locales: { default: 'en', supported: ['en', 'tr'] },
  }),
  '.contentrain/models/posts.json': JSON.stringify({
    id: 'posts',
    name: 'Posts',
    kind: 'collection',
    domain: 'marketing',
    i18n: true,
    fields: { title: { type: 'string' } },
  }),
  '.contentrain/models/settings.json': JSON.stringify({
    id: 'settings',
    name: 'Settings',
    kind: 'singleton',
    domain: 'marketing',
    i18n: true,
    fields: { headline: { type: 'string' } },
  }),
  '.contentrain/models/ui.json': JSON.stringify({
    id: 'ui',
    name: 'UI',
    kind: 'dictionary',
    domain: 'marketing',
    i18n: false,
    fields: {},
  }),
  '.contentrain/models/blog.json': JSON.stringify({
    id: 'blog',
    name: 'Blog',
    kind: 'document',
    domain: 'marketing',
    i18n: true,
    fields: { title: { type: 'string' } },
  }),
  // collection: en=2 + tr=1 → 3
  '.contentrain/content/marketing/posts/en.json': JSON.stringify({ a: { title: 'A' }, b: { title: 'B' } }),
  '.contentrain/content/marketing/posts/tr.json': JSON.stringify({ a: { title: 'A-tr' } }),
  // singleton: one per locale file → 2
  '.contentrain/content/marketing/settings/en.json': JSON.stringify({ headline: 'Hi' }),
  '.contentrain/content/marketing/settings/tr.json': JSON.stringify({ headline: 'Selam' }),
  // dictionary non-i18n: data.json → 1
  '.contentrain/content/marketing/ui/data.json': JSON.stringify({ 'common.save': 'Save' }),
  // document i18n: (first: en+tr) + (second: en) → 3
  '.contentrain/content/marketing/blog/first/en.md': '---\ntitle: First\n---\n\nBody.\n',
  '.contentrain/content/marketing/blog/first/tr.md': '---\ntitle: Ilk\n---\n\nGovde.\n',
  '.contentrain/content/marketing/blog/second/en.md': '---\ntitle: Second\n---\n\nBody.\n',
}
// Expected total: 3 + 2 + 1 + 3 = 9

const DIRS: Record<string, string[]> = {
  '.contentrain/models': ['posts.json', 'settings.json', 'ui.json', 'blog.json'],
  '.contentrain/content/marketing/posts': ['en.json', 'tr.json'],
  '.contentrain/content/marketing/settings': ['en.json', 'tr.json'],
  '.contentrain/content/marketing/ui': ['data.json'],
  '.contentrain/content/marketing/blog': ['first', 'second'],
  '.contentrain/content/marketing/blog/first': ['en.md', 'tr.md'],
  '.contentrain/content/marketing/blog/second': ['en.md'],
}

function makeReader(files: Record<string, string>, dirs: Record<string, string[]>) {
  return {
    readFile: async (path: string) => {
      const f = files[path]
      if (f === undefined) throw new Error(`not found: ${path}`)
      return f
    },
    listDirectory: async (path: string) => {
      const d = dirs[path]
      if (d === undefined) throw new Error(`not found: ${path}`)
      return d
    },
    fileExists: async (path: string) => files[path] !== undefined,
  }
}

function makeGit(files: Record<string, string>, dirs: Record<string, string[]>) {
  const reader = makeReader(files, dirs)
  return {
    getTree: vi.fn(async () => Object.keys(files).map(path => ({ path, sha: `sha-${path}`, type: 'blob' as const }))),
    readFile: vi.fn(async (path: string) => reader.readFile(path)),
    listDirectory: vi.fn(async (path: string) => reader.listDirectory(path)),
  }
}

describe('buildContextChangeFromBrain — byte parity with MCP', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-08T12:00:00.000Z'))
    // brain-cache resolves paths via auto-imported globals
    vi.stubGlobal('resolveConfigPath', () => '.contentrain/config.json')
    vi.stubGlobal('resolveModelsDir', () => '.contentrain/models')
    vi.stubGlobal('resolveVocabularyPath', () => '.contentrain/vocabulary.json')
    vi.stubGlobal('resolveContextPath', () => '.contentrain/context.json')
    vi.stubGlobal('resolveContentPath', (_ctx: unknown, model: { id: string, domain: string, i18n?: boolean }, locale: string) =>
      model.i18n
        ? `.contentrain/content/${model.domain}/${model.id}/${locale}.json`
        : `.contentrain/content/${model.domain}/${model.id}/data.json`)
    vi.stubGlobal('resolveMetaPath', (_ctx: unknown, model: { id: string }, locale: string, slug?: string) =>
      slug
        ? `.contentrain/meta/${model.id}/${slug}/${locale}.json`
        : `.contentrain/meta/${model.id}/${locale}.json`)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('matches MCP output byte-for-byte on a mixed-kind repo', async () => {
    const { buildBrainSnapshot } = await import('../../server/utils/brain-cache')
    const { buildContextChangeFromBrain } = await import('../../server/utils/content-engine/context-build')

    const brain = await buildBrainSnapshot(makeGit(FILES, DIRS) as never, '', 'parity-project')
    const operation = { tool: 'merge', model: 'posts', locale: 'en' }

    const studio = buildContextChangeFromBrain(brain, { contentRoot: '' }, operation)
    const mcp = await buildContextChange(makeReader(FILES, DIRS) as never, operation, 'mcp-studio')

    expect(studio).not.toBeNull()
    expect(studio!.path).toBe(mcp.path)
    expect(studio!.content).toBe(mcp.content)

    // Sanity on the parity-critical number: entries are SUMMED across
    // locales (not contentSummary's per-model max).
    expect(JSON.parse(studio!.content!).stats.entries).toBe(9)
  })

  it('collapses entries to null when a model has no readable content (both sides)', async () => {
    const files = {
      ...FILES,
      '.contentrain/models/ghost.json': JSON.stringify({
        id: 'ghost',
        name: 'Ghost',
        kind: 'collection',
        domain: 'marketing',
        i18n: true,
        fields: {},
      }),
      // no content dir for ghost — MCP's listDirectory throws, the brain
      // ends up with zero content keys
    }
    const dirs = {
      ...DIRS,
      '.contentrain/models': [...DIRS['.contentrain/models']!, 'ghost.json'],
    }

    const { buildBrainSnapshot } = await import('../../server/utils/brain-cache')
    const { buildContextChangeFromBrain } = await import('../../server/utils/content-engine/context-build')

    const brain = await buildBrainSnapshot(makeGit(files, dirs) as never, '', 'parity-null')
    const operation = { tool: 'merge', model: 'ghost' }

    const studio = buildContextChangeFromBrain(brain, { contentRoot: '' }, operation)
    const mcp = await buildContextChange(makeReader(files, dirs) as never, operation, 'mcp-studio')

    expect(studio).not.toBeNull()
    // canonicalStringify drops null values — the key is absent in MCP's
    // output too; byte equality below is the real assertion.
    expect(JSON.parse(studio!.content!).stats.entries).toBeUndefined()
    expect(studio!.content).toBe(mcp.content)
  })

  it('returns null (MCP fallback) for non-default locale strategies', async () => {
    const { buildBrainSnapshot } = await import('../../server/utils/brain-cache')
    const { buildContextChangeFromBrain } = await import('../../server/utils/content-engine/context-build')

    const files = {
      ...FILES,
      '.contentrain/models/posts.json': JSON.stringify({
        id: 'posts',
        name: 'Posts',
        kind: 'collection',
        domain: 'marketing',
        i18n: true,
        locale_strategy: 'suffix',
        fields: {},
      }),
    }
    const brain = await buildBrainSnapshot(makeGit(files, DIRS) as never, '', 'parity-strategy')
    expect(buildContextChangeFromBrain(brain, { contentRoot: '' }, { tool: 'merge', model: 'posts' })).toBeNull()
  })
})
