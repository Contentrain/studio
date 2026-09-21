import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FieldDef } from '@contentrain/types'
import type { GitProvider } from '../../server/providers/git'
import { createContentEngine } from '../../server/utils/content-engine'
import { entryModeErrors, partitionEntries } from '../../server/utils/content-engine/entry-mode'
import { mergeEntryFields } from '../../server/utils/content-engine/field-merge'
import { validateContent } from '../../server/utils/content-validation'
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
 * #283 — a partial update of an object field dropped its other keys: each
 * save of `social_links` kept only the networks it named, and the agent
 * reported success every time.
 *
 * #298 — the agent picks ids for new entries; a "new" article reused the id
 * of a different published one, the save upserted, and the old article was
 * gone. A partial update sent to a locale the entry was missing from became a
 * create with placeholder text.
 */

const SOCIAL: Record<string, FieldDef> = {
  site_title: { type: 'string' },
  social_links: {
    type: 'object',
    fields: {
      instagram: { type: 'url' },
      tiktok: { type: 'url' },
      x: { type: 'url' },
      contact: { type: 'object', fields: { email: { type: 'email' }, phone: { type: 'string' } } },
    },
  } as FieldDef,
  tags: { type: 'array', items: 'string' } as FieldDef,
}

describe('mergeEntryFields (#283)', () => {
  const stored = {
    site_title: 'Site',
    social_links: { instagram: 'https://i.g/a', tiktok: 'https://t.t/a', x: 'https://x.c/a', contact: { email: 'a@x.io', phone: '1' } },
    tags: ['one', 'two'],
  }

  it('changes only the object sub-keys that were sent', () => {
    const merged = mergeEntryFields(stored, { social_links: { instagram: 'https://i.g/new' } }, SOCIAL)
    expect(merged.social_links).toEqual({ ...stored.social_links, instagram: 'https://i.g/new' })
  })

  it('removes a sub-key sent as null', () => {
    const merged = mergeEntryFields(stored, { social_links: { tiktok: null } }, SOCIAL)
    expect(merged.social_links).not.toHaveProperty('tiktok')
    expect(merged.social_links).toMatchObject({ instagram: 'https://i.g/a', x: 'https://x.c/a' })
  })

  it('merges through nested object fields', () => {
    const merged = mergeEntryFields(stored, { social_links: { contact: { phone: '2' } } }, SOCIAL)
    expect((merged.social_links as Record<string, unknown>).contact).toEqual({ email: 'a@x.io', phone: '2' })
  })

  it('replaces arrays and non-object fields as sent', () => {
    const merged = mergeEntryFields(stored, { tags: ['three'], site_title: 'New' }, SOCIAL)
    expect(merged.tags).toEqual(['three'])
    expect(merged.site_title).toBe('New')
  })

  it('keeps fields that were not sent, and takes undeclared ones as sent', () => {
    const merged = mergeEntryFields(stored, { extra: { a: 1 } }, SOCIAL)
    expect(merged).toMatchObject({ site_title: 'Site', tags: ['one', 'two'], extra: { a: 1 } })
  })

  it('an object field with no stored value takes the sent object', () => {
    const merged = mergeEntryFields({}, { social_links: { instagram: 'https://i.g/a' } }, SOCIAL)
    expect(merged.social_links).toEqual({ instagram: 'https://i.g/a' })
  })
})

describe('entry write mode (#298)', () => {
  const where = { model: 'articles', locale: 'tr' }
  const existing = new Set(['a1'])
  const exists = (id: string) => existing.has(id)

  it('refuses a create that names an existing id', () => {
    const errors = entryModeErrors('create', ['a1', 'n1'], exists, where)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ severity: 'error', entry: 'a1', locale: 'tr', model: 'articles' })
  })

  it('refuses an update of an id that does not exist in the locale', () => {
    const errors = entryModeErrors('update', ['a1', 'missing'], exists, where)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ entry: 'missing' })
  })

  it('keeps the legacy upsert when no mode is stated', () => {
    expect(entryModeErrors(undefined, ['a1', 'n1'], exists, where)).toEqual([])
  })

  it('partitions entries into created and updated', () => {
    expect(partitionEntries(['a1', 'n1'], exists)).toEqual({ created: ['n1'], updated: ['a1'] })
  })
})

// ── through the engine ──

const commit = { sha: 'c1', message: 'm', author: { name: 'bot', email: 'bot@example.com' }, timestamp: '' }
const config = { version: 1, stack: 'nuxt', workflow: 'auto-merge', domains: ['blog', 'system'], locales: { default: 'tr', supported: ['tr'] } }

function gitWith(files: Record<string, unknown>): GitProvider & { applyPlan: ReturnType<typeof vi.fn> } {
  return {
    readFile: vi.fn(async (path: string) => {
      for (const [suffix, value] of Object.entries(files)) {
        if (path.endsWith(suffix)) return typeof value === 'string' ? value : JSON.stringify(value)
      }
      throw Object.assign(new Error(`not found: ${path}`), { status: 404 })
    }),
    listDirectory: vi.fn().mockResolvedValue([]),
    fileExists: vi.fn().mockResolvedValue(false),
    listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'abc', protected: false }]),
    mergeBranch: vi.fn().mockResolvedValue({ merged: true, sha: 'm', pullRequestUrl: null }),
    getBranchDiff: vi.fn().mockResolvedValue([]),
    getDefaultBranch: vi.fn().mockResolvedValue('main'),
    applyPlan: vi.fn().mockResolvedValue(commit),
  } as unknown as GitProvider & { applyPlan: ReturnType<typeof vi.fn> }
}

const articles = { id: 'articles', name: 'Articles', kind: 'collection', domain: 'blog', i18n: true, fields: { title: { type: 'string', required: true } } }
const settings = { id: 'settings', name: 'Settings', kind: 'singleton', domain: 'system', i18n: true, fields: SOCIAL }
const guides = { id: 'guides', name: 'Guides', kind: 'document', domain: 'blog', i18n: true, fields: { title: { type: 'string', required: true } } }

function writtenFile(git: { applyPlan: ReturnType<typeof vi.fn> }, suffix: string): Record<string, unknown> {
  const changes = git.applyPlan.mock.calls[0]![0].changes as Array<{ path: string, content: string }>
  return JSON.parse(changes.find(c => c.path.endsWith(suffix))!.content)
}

describe('save paths honour mode and merge objects', () => {
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

  it('refuses to create over an existing article and writes nothing', async () => {
    const git = gitWith({
      'models/articles.json': articles,
      'config.json': config,
      'content/blog/articles/tr.json': { a1: { title: 'Published article' } },
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.saveContent('articles', 'tr', { a1: { title: 'A different article' } }, 'e@x.io', { mode: 'create' })

    expect(result.validation.valid).toBe(false)
    expect(result.validation.errors).toEqual([expect.objectContaining({ entry: 'a1', locale: 'tr' })])
    expect(git.applyPlan).not.toHaveBeenCalled()
  })

  it('refuses an update of an entry missing from the locale instead of creating it', async () => {
    const git = gitWith({
      'models/articles.json': articles,
      'config.json': config,
      'content/blog/articles/tr.json': { a1: { title: 'Existing' } },
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.saveContent('articles', 'tr', { zz: { title: 'x' } }, 'e@x.io', { mode: 'update' })

    expect(result.validation.valid).toBe(false)
    expect(git.applyPlan).not.toHaveBeenCalled()
  })

  it('reports which entries a save created and which it updated', async () => {
    const git = gitWith({
      'models/articles.json': articles,
      'config.json': config,
      'content/blog/articles/tr.json': { a1: { title: 'Existing' } },
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.saveContent('articles', 'tr', { a1: { title: 'Changed' }, n1: { title: 'New' } }, 'e@x.io')

    expect(result.entries).toEqual({ created: ['n1'], updated: ['a1'] })
  })

  it('a partial social_links update keeps the other networks (#283 regression)', async () => {
    const git = gitWith({
      'models/settings.json': settings,
      'config.json': config,
      'content/system/settings/tr.json': { site_title: 'Site', social_links: { instagram: 'https://i.g/a', tiktok: 'https://t.t/a', x: 'https://x.c/a' } },
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.saveContent('settings', 'tr', { social_links: { instagram: 'https://i.g/new' } }, 'e@x.io', { mode: 'update' })

    expect(result.validation.valid).toBe(true)
    expect(writtenFile(git, 'content/system/settings/tr.json').social_links).toEqual({
      instagram: 'https://i.g/new',
      tiktok: 'https://t.t/a',
      x: 'https://x.c/a',
    })
  })

  it('refuses to create a document over an existing slug', async () => {
    const git = gitWith({
      'models/guides.json': guides,
      'config.json': config,
      'content/blog/guides/intro/tr.md': '---\ntitle: Intro\n---\nBody\n',
    })
    const engine = createContentEngine({ git, contentRoot: '' })

    const result = await engine.saveDocument('guides', 'tr', 'intro', { title: 'Another intro' }, 'Other body', 'e@x.io', { mode: 'create' })

    expect(result.validation.valid).toBe(false)
    expect(result.validation.errors).toEqual(expect.arrayContaining([expect.objectContaining({ entry: 'intro' })]))
    expect(git.applyPlan).not.toHaveBeenCalled()
  })
})
