import { describe, expect, it } from 'vitest'
import {
  normalizeContentRoot,
  resolveConfigPath,
  resolveContentPath,
  resolveMetaPath,
  resolveModelPath,
  resolveVocabularyPath,
} from '../../server/utils/content-paths'

describe('content path resolution', () => {
  const rootCtx = { contentRoot: '' }
  const nestedCtx = { contentRoot: 'apps/web' }

  it('resolves config, model, and vocabulary paths with contentRoot prefixes', () => {
    expect(resolveConfigPath(rootCtx)).toBe('.contentrain/config.json')
    expect(resolveModelPath(nestedCtx, 'faq')).toBe('apps/web/.contentrain/models/faq.json')
    expect(resolveVocabularyPath(nestedCtx)).toBe('apps/web/.contentrain/vocabulary.json')
  })

  it('resolves standard json content and meta paths', () => {
    const collectionModel = {
      id: 'faq',
      kind: 'collection',
      domain: 'marketing',
      i18n: true,
      content_path: undefined,
    }

    expect(resolveContentPath(nestedCtx, collectionModel, 'en')).toBe('apps/web/.contentrain/content/marketing/faq/en.json')
    expect(resolveMetaPath(nestedCtx, collectionModel, 'en')).toBe('apps/web/.contentrain/meta/faq/en.json')
  })

  it('resolves non-i18n and custom content_path models correctly', () => {
    const singletonModel = {
      id: 'nav',
      kind: 'singleton',
      domain: 'marketing',
      i18n: false,
      content_path: undefined,
    }
    const documentModel = {
      id: 'docs',
      kind: 'document',
      domain: 'marketing',
      i18n: true,
      content_path: 'docs/content',
    }

    expect(resolveContentPath(rootCtx, singletonModel, 'tr')).toBe('.contentrain/content/marketing/nav/data.json')
    expect(resolveContentPath(nestedCtx, documentModel, 'en', 'intro')).toBe('apps/web/docs/content/intro/en.md')
    expect(resolveContentPath(nestedCtx, documentModel, 'en')).toBe('apps/web/docs/content')
  })

  it('normalizes content roots for monorepo and root projects', () => {
    expect(normalizeContentRoot('/')).toBe('')
    expect(normalizeContentRoot('')).toBe('')
    expect(normalizeContentRoot('/apps/web/')).toBe('apps/web')
  })
})
