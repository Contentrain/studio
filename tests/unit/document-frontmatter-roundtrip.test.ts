import { parseMarkdownFrontmatter } from '@contentrain/types'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createContentEngine } from '../../server/utils/content-engine'
import { validateContent } from '../../server/utils/content-validation'
import type { GitProvider } from '../../server/providers/git'
import {
  resolveConfigPath,
  resolveContentPath,
  resolveContextPath,
  resolveMetaPath,
  resolveModelPath,
  resolveModelsDir,
  resolveVocabularyPath,
} from '../../server/utils/content-paths'

/**
 * Document frontmatter is written by `@contentrain/mcp` (through
 * `serializeMarkdownFrontmatter`) and read back by Studio itself —
 * `cdn-builder.ts`, `branch-review.ts` and the engine's own read-merge all call
 * `parseMarkdownFrontmatter`. The two live in `@contentrain/types` and must
 * agree; when they drifted, a value came back truncated at its first newline,
 * a quoted string came back carrying its own escapes, and a SKU of `007` came
 * back as the number 7 — each of them silent.
 *
 * Mocked git hides all of that: the engine's own tests assert the file
 * `toContain` a value, which a corrupted round trip still satisfies. So this
 * pins the round trip itself, on the values that actually broke.
 */

const commit = {
  sha: 'commit-sha',
  message: 'noop',
  author: { name: 'bot', email: 'bot@example.com' },
  timestamp: '2026-03-25T00:00:00.000Z',
}

const model = {
  id: 'guide',
  kind: 'document',
  i18n: true,
  domain: 'editorial',
  fields: {
    title: { type: 'string', required: true },
    excerpt: { type: 'text' },
    sku: { type: 'string' },
    featured: { type: 'boolean' },
    tags: { type: 'array' },
  },
}

const config = { domains: ['editorial'], locales: { default: 'en', supported: ['en'] }, stack: 'astro', version: 1, workflow: 'auto-merge' }

/** Every value here broke a round trip before the shared reader landed. */
const tricky = {
  title: 'He said "Hi" to C:\\Users',
  excerpt: 'First line.\nSecond line.',
  sku: '007',
  featured: true,
  tags: [] as string[],
}

function createGitProvider(overrides: Partial<GitProvider> = {}): GitProvider {
  return {
    capabilities: {
      localWorktree: false,
      sourceRead: false,
      sourceWrite: false,
      pushRemote: true,
      branchProtection: true,
      pullRequestFallback: true,
      astScan: false,
    },
    getTree: vi.fn(),
    readFile: vi.fn(),
    listDirectory: vi.fn().mockResolvedValue([]),
    fileExists: vi.fn().mockResolvedValue(false),
    createBranch: vi.fn(),
    listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'abc', protected: false }]),
    getBranchDiff: vi.fn().mockResolvedValue([]),
    mergeBranch: vi.fn().mockResolvedValue({ merged: true, sha: 'merge-sha', pullRequestUrl: null }),
    deleteBranch: vi.fn(),
    applyPlan: vi.fn().mockResolvedValue(commit),
    commitFiles: vi.fn().mockResolvedValue(commit),
    createPR: vi.fn(),
    mergePR: vi.fn(),
    getPermissions: vi.fn(),
    getBranchProtection: vi.fn(),
    getDefaultBranch: vi.fn().mockResolvedValue('main'),
    detectFramework: vi.fn(),
    isMerged: vi.fn().mockResolvedValue(false),
    ...overrides,
  } as unknown as GitProvider
}

/** Reader that serves the model + config, and `existing` as the document when given. */
function reader(existing?: string) {
  return vi.fn(async (path: string) => {
    if (path.includes('/models/guide')) return JSON.stringify(model)
    if (path.endsWith('config.json')) return JSON.stringify(config)
    if (existing && path.includes('/guide/') && path.includes('field-notes') && path.endsWith('.md')) return existing
    throw new Error(`not found: ${path}`)
  })
}

function writtenMarkdown(applyPlan: ReturnType<typeof vi.fn>, call = 0): string {
  const changes = applyPlan.mock.calls[call]![0].changes as Array<{ path: string, content: string | null }>
  return changes.find(c => c.path.endsWith('.md'))?.content ?? ''
}

describe('document frontmatter round trip', () => {
  beforeEach(() => {
    vi.stubGlobal('resolveModelPath', resolveModelPath)
    vi.stubGlobal('resolveContentPath', resolveContentPath)
    vi.stubGlobal('resolveMetaPath', resolveMetaPath)
    vi.stubGlobal('resolveContextPath', resolveContextPath)
    vi.stubGlobal('resolveConfigPath', resolveConfigPath)
    vi.stubGlobal('resolveVocabularyPath', resolveVocabularyPath)
    vi.stubGlobal('resolveModelsDir', resolveModelsDir)
    vi.stubGlobal('validateContent', validateContent)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads back every written value as the value that was written', async () => {
    const applyPlan = vi.fn().mockResolvedValue(commit)
    const engine = createContentEngine({ git: createGitProvider({ readFile: reader(), applyPlan }), contentRoot: '' })

    const result = await engine.saveDocument('guide', 'en', 'field-notes', { ...tricky }, 'Body paragraph.', 'user@example.com')
    expect(result.validation.valid).toBe(true)

    const { frontmatter, body } = parseMarkdownFrontmatter(writtenMarkdown(applyPlan))
    expect(frontmatter.title).toBe(tricky.title)
    expect(frontmatter.excerpt).toBe(tricky.excerpt)
    expect(frontmatter.sku).toBe('007') // a string of digits stays a string
    expect(frontmatter.featured).toBe(true) // a boolean stays a boolean
    expect(frontmatter.tags).toEqual([])
    expect(body).toContain('Body paragraph.')
  })

  it('leaves untouched values byte-identical when a later save merges one field', async () => {
    // The corruption path: read the file, merge one field, write it back. A
    // reader that misreads a value hands the writer the misread value, and the
    // damage is committed under an edit that never named that field.
    const first = vi.fn().mockResolvedValue(commit)
    const engineOne = createContentEngine({ git: createGitProvider({ readFile: reader(), applyPlan: first }), contentRoot: '' })
    await engineOne.saveDocument('guide', 'en', 'field-notes', { ...tricky }, 'Body paragraph.', 'user@example.com')
    const written = writtenMarkdown(first)

    const second = vi.fn().mockResolvedValue(commit)
    const engineTwo = createContentEngine({ git: createGitProvider({ readFile: reader(written), applyPlan: second }), contentRoot: '' })
    await engineTwo.saveDocument('guide', 'en', 'field-notes', { sku: '008' }, '', 'user@example.com')

    const rewritten = writtenMarkdown(second)
    const { frontmatter, body } = parseMarkdownFrontmatter(rewritten)
    expect(frontmatter.sku).toBe('008')
    expect(frontmatter.title).toBe(tricky.title)
    expect(frontmatter.excerpt).toBe(tricky.excerpt)
    expect(frontmatter.featured).toBe(true)
    expect(frontmatter.tags).toEqual([])
    expect(body).toContain('Body paragraph.')
  })
})
