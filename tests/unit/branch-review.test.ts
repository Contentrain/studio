import type { ContentrainConfig, FileDiff, ModelDefinition } from '@contentrain/types'
import { describe, expect, it } from 'vitest'
import type { BranchReviewInput } from '../../server/utils/branch-review'
import { buildBranchReview } from '../../server/utils/branch-review'

const CONFIG: ContentrainConfig = {
  version: 1,
  stack: 'nuxt',
  workflow: 'auto-merge',
  locales: { default: 'en', supported: ['en', 'tr'] },
  domains: ['system'],
} as ContentrainConfig

const PLANS: ModelDefinition = {
  id: 'plans',
  name: 'Plans',
  kind: 'collection',
  domain: 'system',
  i18n: true,
  title_field: 'name',
  fields: {
    name: { type: 'string', label: 'Plan name', order: 1 },
    price_monthly: { type: 'number', label: { en: 'Monthly price', tr: 'Aylık ücret' }, order: 2 },
    is_highlighted: { type: 'boolean', order: 3 },
  },
}

/** Build a reader over a `${ref}:${path}` map. */
function reader(files: Record<string, string>) {
  return async (path: string, ref: string) => files[`${ref}:${path}`] ?? null
}

function run(overrides: Partial<BranchReviewInput> & Pick<BranchReviewInput, 'files' | 'read'>) {
  return buildBranchReview({
    branch: 'cr/content/plans/en/1755612345-a3f2',
    baseRef: 'contentrain',
    branchRef: 'cr/content/plans/en/1755612345-a3f2',
    models: new Map([['plans', PLANS]]),
    config: CONFIG,
    contentRoot: '',
    canMerge: true,
    canReject: true,
    ...overrides,
  })
}

const CONTENT_PATH = '.contentrain/content/system/plans/en.json'
const META_PATH = '.contentrain/meta/plans/en.json'

const CONTENT_FILES: FileDiff[] = [
  { path: CONTENT_PATH, status: 'modified' },
  { path: META_PATH, status: 'modified' },
]

describe('buildBranchReview — collections', () => {
  it('reports the changed field of the changed entry, not the whole entry', async () => {
    const review = await run({
      files: CONTENT_FILES,
      read: reader({
        [`contentrain:${CONTENT_PATH}`]: JSON.stringify({
          free: { name: 'Free', price_monthly: 0, is_highlighted: false },
          pro: { name: 'Pro', price_monthly: 29, is_highlighted: true },
        }),
        [`cr/content/plans/en/1755612345-a3f2:${CONTENT_PATH}`]: JSON.stringify({
          free: { name: 'Free', price_monthly: 9, is_highlighted: false },
          pro: { name: 'Pro', price_monthly: 29, is_highlighted: true },
        }),
        [`contentrain:${META_PATH}`]: JSON.stringify({ free: { status: 'published', updated_by: 'a@b.c', updated_at: '2026-08-01T00:00:00.000Z' } }),
        [`cr/content/plans/en/1755612345-a3f2:${META_PATH}`]: JSON.stringify({ free: { status: 'published', updated_by: 'editor@contentrain.io', updated_at: '2026-08-19T10:00:00.000Z' } }),
      }),
    })

    expect(review.groups).toHaveLength(1)
    const group = review.groups[0]!
    expect(group.modelName).toBe('Plans')
    expect(group.locale).toBe('en')
    expect(group.entries).toHaveLength(1)

    const entry = group.entries[0]!
    expect(entry.entryId).toBe('free')
    expect(entry.title).toBe('Free')
    expect(entry.kind).toBe('updated')
    expect(entry.fields).toEqual([
      expect.objectContaining({ fieldId: 'price_monthly', label: 'Monthly price', type: 'number', before: 0, after: 9 }),
    ])
    expect(entry.updatedBy).toBe('editor@contentrain.io')
    expect(review.summary).toEqual({ added: 0, updated: 1, removed: 0 })
  })

  it('orders fields by the model, not alphabetically', async () => {
    const branchRef = 'cr/content/plans/en/1755612345-a3f2'
    const review = await run({
      files: [{ path: CONTENT_PATH, status: 'modified' }],
      read: reader({
        [`contentrain:${CONTENT_PATH}`]: JSON.stringify({ free: { name: 'Free', price_monthly: 0, is_highlighted: false } }),
        [`${branchRef}:${CONTENT_PATH}`]: JSON.stringify({ free: { name: 'Starter', price_monthly: 9, is_highlighted: true } }),
      }),
    })

    expect(review.groups[0]!.entries[0]!.fields.map(f => f.fieldId)).toEqual([
      'name',
      'price_monthly',
      'is_highlighted',
    ])
  })

  it('drops a meta record that moved nothing but its own timestamp', async () => {
    const branchRef = 'cr/content/plans/en/1755612345-a3f2'
    const body = JSON.stringify({ free: { name: 'Free', price_monthly: 0 } })
    const review = await run({
      files: CONTENT_FILES,
      read: reader({
        [`contentrain:${CONTENT_PATH}`]: body,
        [`${branchRef}:${CONTENT_PATH}`]: body,
        [`contentrain:${META_PATH}`]: JSON.stringify({ free: { status: 'draft', updated_at: '2026-08-01T00:00:00.000Z' } }),
        [`${branchRef}:${META_PATH}`]: JSON.stringify({ free: { status: 'draft', updated_at: '2026-08-19T10:00:00.000Z' } }),
      }),
    })

    expect(review.groups).toHaveLength(0)
  })

  it('surfaces a status-only write as a status transition with no field noise', async () => {
    const branchRef = 'cr/content/plans/en/1755612345-a3f2'
    const body = JSON.stringify({ free: { name: 'Free', price_monthly: 0 } })
    const review = await run({
      files: CONTENT_FILES,
      read: reader({
        [`contentrain:${CONTENT_PATH}`]: body,
        [`${branchRef}:${CONTENT_PATH}`]: body,
        [`contentrain:${META_PATH}`]: JSON.stringify({ free: { status: 'draft' } }),
        [`${branchRef}:${META_PATH}`]: JSON.stringify({ free: { status: 'published' } }),
      }),
    })

    const entry = review.groups[0]!.entries[0]!
    expect(entry.fields).toEqual([])
    expect(entry.statusBefore).toBe('draft')
    expect(entry.statusAfter).toBe('published')
  })

  it('classifies a new entry as added and a deleted one as removed', async () => {
    const branchRef = 'cr/content/plans/en/1755612345-a3f2'
    const review = await run({
      files: [{ path: CONTENT_PATH, status: 'modified' }],
      read: reader({
        [`contentrain:${CONTENT_PATH}`]: JSON.stringify({ legacy: { name: 'Legacy' } }),
        [`${branchRef}:${CONTENT_PATH}`]: JSON.stringify({ team: { name: 'Team', price_monthly: 99 } }),
      }),
    })

    const entries = review.groups[0]!.entries
    expect(entries.map(e => [e.entryId, e.kind])).toEqual([
      ['legacy', 'removed'],
      ['team', 'added'],
    ])
    expect(review.summary).toEqual({ added: 1, updated: 0, removed: 1 })
  })

  it('accepts MCP array-form collections as well as object maps', async () => {
    const branchRef = 'cr/content/plans/en/1755612345-a3f2'
    const review = await run({
      files: [{ path: CONTENT_PATH, status: 'modified' }],
      read: reader({
        [`contentrain:${CONTENT_PATH}`]: JSON.stringify([{ id: 'free', name: 'Free' }]),
        [`${branchRef}:${CONTENT_PATH}`]: JSON.stringify([{ id: 'free', name: 'Free forever' }]),
      }),
    })

    expect(review.groups[0]!.entries[0]!.fields[0]).toMatchObject({
      fieldId: 'name',
      before: 'Free',
      after: 'Free forever',
    })
  })
})

describe('buildBranchReview — path layouts', () => {
  it('reports no locale for a non-i18n model and reads its data.json', async () => {
    const model: ModelDefinition = { ...PLANS, i18n: false }
    const path = '.contentrain/content/system/plans/data.json'
    const branchRef = 'cr/content/plans/1755612345-a3f2'
    const review = await run({
      branch: branchRef,
      branchRef,
      models: new Map([['plans', model]]),
      files: [{ path, status: 'modified' }],
      read: reader({
        [`contentrain:${path}`]: JSON.stringify({ free: { name: 'Free' } }),
        [`${branchRef}:${path}`]: JSON.stringify({ free: { name: 'Free forever' } }),
      }),
    })

    expect(review.groups[0]!.locale).toBeNull()
    expect(review.groups[0]!.entries[0]!.fields[0]!.after).toBe('Free forever')
  })

  it('honours the suffix locale strategy', async () => {
    const model: ModelDefinition = { ...PLANS, locale_strategy: 'suffix' }
    const path = '.contentrain/content/system/plans/plans.tr.json'
    const branchRef = 'cr/content/plans/tr/1755612345-a3f2'
    const review = await run({
      branch: branchRef,
      branchRef,
      models: new Map([['plans', model]]),
      files: [{ path, status: 'modified' }],
      read: reader({
        [`contentrain:${path}`]: JSON.stringify({ free: { name: 'Ücretsiz' } }),
        [`${branchRef}:${path}`]: JSON.stringify({ free: { name: 'Bedava' } }),
      }),
    })

    expect(review.groups[0]!.locale).toBe('tr')
    // The label resolves for the locale the change belongs to.
    expect(review.groups[0]!.entries[0]!.fields[0]!.label).toBe('Plan name')
  })

  it('honours a content_path override', async () => {
    const model: ModelDefinition = { ...PLANS, content_path: 'content/pricing' }
    const path = 'content/pricing/en.json'
    const branchRef = 'cr/content/plans/en/1755612345-a3f2'
    const review = await run({
      branchRef,
      models: new Map([['plans', model]]),
      files: [{ path, status: 'modified' }],
      read: reader({
        [`contentrain:${path}`]: JSON.stringify({ free: { name: 'Free' } }),
        [`${branchRef}:${path}`]: JSON.stringify({ free: { name: 'Free forever' } }),
      }),
    })

    expect(review.unclassified).toEqual([])
    expect(review.groups).toHaveLength(1)
  })

  it('prefixes every path with the project content root', async () => {
    const path = 'apps/web/.contentrain/content/system/plans/en.json'
    const branchRef = 'cr/content/plans/en/1755612345-a3f2'
    const review = await run({
      contentRoot: 'apps/web',
      branchRef,
      files: [{ path, status: 'modified' }],
      read: reader({
        [`contentrain:${path}`]: JSON.stringify({ free: { name: 'Free' } }),
        [`${branchRef}:${path}`]: JSON.stringify({ free: { name: 'Free forever' } }),
      }),
    })

    expect(review.groups).toHaveLength(1)
  })

  it('never swallows a path it cannot attribute', async () => {
    const review = await run({
      files: [{ path: 'src/content/mystery.json', status: 'added' }],
      read: reader({}),
    })

    expect(review.groups).toEqual([])
    expect(review.unclassified).toEqual([{ path: 'src/content/mystery.json', status: 'added' }])
  })

  it('ignores context.json, which never belongs on a feature branch', async () => {
    const review = await run({
      files: [{ path: '.contentrain/context.json', status: 'modified' }],
      read: reader({}),
    })

    expect(review.unclassified).toEqual([])
    expect(review.groups).toEqual([])
  })
})

describe('buildBranchReview — singletons, dictionaries, documents', () => {
  const SETTINGS: ModelDefinition = {
    id: 'site-settings',
    name: 'Site Settings',
    kind: 'singleton',
    domain: 'system',
    i18n: true,
    title_field: 'title',
    fields: { title: { type: 'string' }, tagline: { type: 'string' } },
  }

  it('treats a singleton as one entry whose fields are its own keys', async () => {
    const path = '.contentrain/content/system/site-settings/en.json'
    const branchRef = 'cr/content/site-settings/en/1755612345-a3f2'
    const review = await run({
      branch: branchRef,
      branchRef,
      models: new Map([['site-settings', SETTINGS]]),
      files: [{ path, status: 'modified' }],
      read: reader({
        [`contentrain:${path}`]: JSON.stringify({ title: 'Contentrain', tagline: 'Old' }),
        [`${branchRef}:${path}`]: JSON.stringify({ title: 'Contentrain', tagline: 'New' }),
      }),
    })

    const entry = review.groups[0]!.entries[0]!
    expect(entry.entryId).toBe('site-settings')
    expect(entry.title).toBe('Contentrain')
    expect(entry.fields).toEqual([
      expect.objectContaining({ fieldId: 'tagline', before: 'Old', after: 'New' }),
    ])
  })

  it('reads a dictionary key as a field of the dictionary', async () => {
    const dictionary: ModelDefinition = {
      id: 'ui-strings',
      name: 'UI Strings',
      kind: 'dictionary',
      domain: 'system',
      i18n: true,
      title_field: 'key',
    }
    const path = '.contentrain/content/system/ui-strings/en.json'
    const branchRef = 'cr/content/ui-strings/en/1755612345-a3f2'
    const review = await run({
      branch: branchRef,
      branchRef,
      models: new Map([['ui-strings', dictionary]]),
      files: [{ path, status: 'modified' }],
      read: reader({
        [`contentrain:${path}`]: JSON.stringify({ 'branch.reject': 'Reject', 'common.yes': 'Yes' }),
        [`${branchRef}:${path}`]: JSON.stringify({ 'branch.reject': 'Discard', 'common.yes': 'Yes' }),
      }),
    })

    expect(review.groups[0]!.entries[0]!.fields).toEqual([
      expect.objectContaining({ fieldId: 'branch.reject', label: 'branch.reject', type: 'string', before: 'Reject', after: 'Discard' }),
    ])
  })

  it('diffs a document as frontmatter plus a body that reads last', async () => {
    const article: ModelDefinition = {
      id: 'articles',
      name: 'Articles',
      kind: 'document',
      domain: 'blog',
      i18n: true,
      title_field: 'title',
      fields: { title: { type: 'string' }, author: { type: 'string' } },
    }
    const path = '.contentrain/content/blog/articles/hello-world/en.md'
    const branchRef = 'cr/content/articles/en/1755612345-a3f2'
    const review = await run({
      branch: branchRef,
      branchRef,
      models: new Map([['articles', article]]),
      files: [{ path, status: 'modified' }],
      read: reader({
        [`contentrain:${path}`]: '---\ntitle: Hello\nauthor: Ada\n---\n\nOld body.\n',
        [`${branchRef}:${path}`]: '---\ntitle: Hello world\nauthor: Ada\n---\n\nNew body.\n',
      }),
    })

    const entry = review.groups[0]!.entries[0]!
    expect(entry.entryId).toBe('hello-world')
    expect(entry.title).toBe('Hello world')
    expect(entry.fields.map(f => f.fieldId)).toEqual(['title', 'body'])
    expect(entry.fields[1]).toMatchObject({ type: 'markdown' })
    expect(String(entry.fields[1]!.after)).toContain('New body.')
  })
})

describe('buildBranchReview — schema and settings', () => {
  it('flags a removed field as destructive and a new one as not', async () => {
    const path = '.contentrain/models/plans.json'
    const branchRef = 'cr/model/plans/1755612345-a3f2'
    const review = await run({
      branch: branchRef,
      branchRef,
      files: [{ path, status: 'modified' }],
      read: reader({
        [`contentrain:${path}`]: JSON.stringify(PLANS),
        [`${branchRef}:${path}`]: JSON.stringify({
          ...PLANS,
          fields: { name: { type: 'string', label: 'Plan name' }, subtitle: { type: 'text' } },
        }),
      }),
    })

    expect(review.schema).toHaveLength(1)
    const change = review.schema[0]!
    expect(change.added.map(f => f.fieldId)).toEqual(['subtitle'])
    expect(change.removed.map(f => f.fieldId)).toEqual(['price_monthly', 'is_highlighted'])
    expect(change.destructive).toBe(true)
  })

  it('classifies content written for a model the branch itself adds', async () => {
    const modelPath = '.contentrain/models/faq.json'
    const contentPath = '.contentrain/content/system/faq/en.json'
    const branchRef = 'cr/model/faq/1755612345-a3f2'
    const faq: ModelDefinition = {
      id: 'faq',
      name: 'FAQ',
      kind: 'collection',
      domain: 'system',
      i18n: true,
      title_field: 'question',
      fields: { question: { type: 'string' } },
    }

    const review = await run({
      branch: branchRef,
      branchRef,
      models: new Map(),
      files: [
        { path: modelPath, status: 'added' },
        { path: contentPath, status: 'added' },
      ],
      read: reader({
        [`${branchRef}:${modelPath}`]: JSON.stringify(faq),
        [`${branchRef}:${contentPath}`]: JSON.stringify({ q1: { question: 'What is it?' } }),
      }),
    })

    expect(review.unclassified).toEqual([])
    expect(review.schema[0]!.kind).toBe('added')
    expect(review.groups[0]!.entries[0]!.kind).toBe('added')
  })

  it('summarises a locale addition without minting a sentence', async () => {
    const path = '.contentrain/config.json'
    const branchRef = 'cr/config/locales/1755612345-a3f2'
    const review = await run({
      branch: branchRef,
      branchRef,
      files: [{ path, status: 'modified' }],
      read: reader({
        [`contentrain:${path}`]: JSON.stringify({ ...CONFIG, locales: { default: 'en', supported: ['en'] } }),
        [`${branchRef}:${path}`]: JSON.stringify(CONFIG),
      }),
    })

    expect(review.settings).toEqual([
      { area: 'locales', items: [{ key: 'locale_added', values: ['tr'] }] },
    ])
    expect(review.info.modelId).toBeNull()
  })

  it('summarises vocabulary term changes', async () => {
    const path = '.contentrain/vocabulary.json'
    const branchRef = 'cr/config/vocabulary/1755612345-a3f2'
    const review = await run({
      branch: branchRef,
      branchRef,
      files: [{ path, status: 'modified' }],
      read: reader({
        [`contentrain:${path}`]: JSON.stringify({ version: 1, terms: { workspace: { en: 'Workspace' } } }),
        [`${branchRef}:${path}`]: JSON.stringify({ version: 1, terms: { workspace: { en: 'Team space' }, project: { en: 'Project' } } }),
      }),
    })

    expect(review.settings[0]).toEqual({
      area: 'vocabulary',
      items: [
        { key: 'term_added', values: ['project'] },
        { key: 'term_updated', values: ['workspace'] },
      ],
    })
  })
})

describe('buildBranchReview — relations and long values', () => {
  it('titles relation targets instead of showing bare refs', async () => {
    const authors: ModelDefinition = {
      id: 'authors',
      name: 'Authors',
      kind: 'collection',
      domain: 'blog',
      i18n: true,
      title_field: 'name',
      fields: { name: { type: 'string' } },
    }
    const posts: ModelDefinition = {
      id: 'posts',
      name: 'Posts',
      kind: 'collection',
      domain: 'blog',
      i18n: true,
      title_field: 'title',
      fields: { title: { type: 'string' }, author: { type: 'relation', model: 'authors' } },
    }
    const path = '.contentrain/content/blog/posts/en.json'
    const branchRef = 'cr/content/posts/en/1755612345-a3f2'

    const review = await run({
      branch: branchRef,
      branchRef,
      models: new Map([['posts', posts], ['authors', authors]]),
      relationSource: modelId => modelId === 'authors'
        ? { a1: { name: 'Ada Lovelace' }, a2: { name: 'Grace Hopper' } }
        : null,
      files: [{ path, status: 'modified' }],
      read: reader({
        [`contentrain:${path}`]: JSON.stringify({ p1: { title: 'Post', author: 'a1' } }),
        [`${branchRef}:${path}`]: JSON.stringify({ p1: { title: 'Post', author: 'a2' } }),
      }),
    })

    expect(review.groups[0]!.entries[0]!.fields[0]!.refLabels).toEqual({
      a1: 'Ada Lovelace',
      a2: 'Grace Hopper',
    })
  })

  it('clips a long value and says that it did', async () => {
    const branchRef = 'cr/content/plans/en/1755612345-a3f2'
    const long = 'x'.repeat(5000)
    const review = await run({
      branchRef,
      files: [{ path: CONTENT_PATH, status: 'modified' }],
      read: reader({
        [`contentrain:${CONTENT_PATH}`]: JSON.stringify({ free: { name: 'Free' } }),
        [`${branchRef}:${CONTENT_PATH}`]: JSON.stringify({ free: { name: long } }),
      }),
    })

    const field = review.groups[0]!.entries[0]!.fields[0]!
    expect(field.truncated).toBe(true)
    expect(String(field.after)).toHaveLength(4000)
  })
})

describe('buildBranchReview — branch identity', () => {
  it('reads model, locale and time out of the branch name', async () => {
    const review = await run({ files: [], read: reader({}) })

    expect(review.info).toMatchObject({
      scope: 'content',
      modelId: 'plans',
      modelName: 'Plans',
      locale: 'en',
      timestamp: 1755612345,
    })
  })

  it('carries the caller permissions so the panel never offers a 403', async () => {
    const review = await run({ files: [], read: reader({}), canMerge: false, canReject: false })

    expect(review.canMerge).toBe(false)
    expect(review.canReject).toBe(false)
  })
})
