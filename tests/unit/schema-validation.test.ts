/* eslint-disable @typescript-eslint/no-explicit-any -- intentional invalid types for testing validation */
import { describe, expect, it } from 'vitest'
import type { ContentrainConfig, ModelDefinition } from '@contentrain/types'
import type { BrainCacheEntry } from '../../server/utils/brain-cache'
import {
  detectBreakingChanges,
  validateConfig,
  validateContentAgainstSchema,
  validateModelDefinition,
  validateProjectSchema,
  validateRelationIntegrity,
} from '../../server/utils/schema-validation'

// ─── Helpers ───

function makeBrain(overrides: Partial<BrainCacheEntry> = {}): BrainCacheEntry {
  return {
    treeSha: 'test-sha',
    config: {
      version: 1,
      stack: 'nuxt',
      workflow: 'auto-merge',
      locales: { default: 'en', supported: ['en'] },
      domains: ['marketing'],
    } as ContentrainConfig,
    models: new Map(),
    content: new Map(),
    meta: new Map(),
    vocabulary: null,
    contentContext: null,
    contentSummary: {},
    schemaValidation: null,
    lastRefresh: Date.now(),
    projectId: 'test-project',
    ...overrides,
  }
}

function makeModel(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: 'test-model',
    name: 'Test Model',
    kind: 'collection',
    domain: 'marketing',
    i18n: true,
    fields: {
      title: { type: 'string', required: true },
    },
    ...overrides,
  }
}

// ─── Model Definition Validator ───

describe('validateModelDefinition', () => {
  const config = { version: 1, stack: 'nuxt', workflow: 'auto-merge', locales: { default: 'en', supported: ['en'] }, domains: ['marketing', 'system'] } as ContentrainConfig

  it('passes for valid model', () => {
    const model = makeModel()
    const warnings = validateModelDefinition(model, config, ['test-model', 'authors'])
    expect(warnings.length).toBe(0)
  })

  it('detects invalid kind', () => {
    const model = makeModel({ kind: 'invalid' as any })
    const warnings = validateModelDefinition(model, config, [])
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'invalid_kind', severity: 'error' }),
    ]))
  })

  it('detects invalid field type', () => {
    const model = makeModel({ fields: { bad: { type: 'foobar' as any } } })
    const warnings = validateModelDefinition(model, config, [])
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'invalid_field_type', field: 'bad', severity: 'error' }),
    ]))
  })

  it('detects domain not in config', () => {
    const model = makeModel({ domain: 'unknown' })
    const warnings = validateModelDefinition(model, config, [])
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'domain_not_in_config' }),
    ]))
  })

  it('detects missing fields for non-dictionary', () => {
    const model = makeModel({ fields: undefined })
    const warnings = validateModelDefinition(model, config, [])
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'missing_fields', severity: 'error' }),
    ]))
  })

  it('detects dictionary with fields', () => {
    const model = makeModel({ kind: 'dictionary', fields: { key: { type: 'string' } } })
    const warnings = validateModelDefinition(model, config, [])
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'dictionary_has_fields' }),
    ]))
  })

  it('detects missing relation target', () => {
    const model = makeModel({ fields: { author: { type: 'relation', model: 'nonexistent' } } })
    const warnings = validateModelDefinition(model, config, ['test-model'])
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'relation_target_missing', field: 'author' }),
    ]))
  })

  it('detects select without options', () => {
    const model = makeModel({ fields: { status: { type: 'select' } } })
    const warnings = validateModelDefinition(model, config, [])
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'select_missing_options', field: 'status' }),
    ]))
  })

  it('detects object nesting too deep', () => {
    const model = makeModel({
      fields: {
        level1: {
          type: 'object',
          fields: {
            level2: {
              type: 'object',
              fields: {
                level3: { type: 'object', fields: { deep: { type: 'string' } } },
              },
            },
          },
        },
      },
    })
    const warnings = validateModelDefinition(model, config, [])
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'object_nesting_too_deep' }),
    ]))
  })

  it('detects invalid regex pattern', () => {
    const model = makeModel({ fields: { code: { type: 'string', pattern: '[invalid(' } } })
    const warnings = validateModelDefinition(model, config, [])
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'invalid_pattern', severity: 'error' }),
    ]))
  })
})

// ─── Config Validator ───

describe('validateConfig', () => {
  it('passes for valid config', () => {
    const config = { version: 1, stack: 'nuxt', workflow: 'auto-merge', locales: { default: 'en', supported: ['en'] }, domains: ['marketing'] } as ContentrainConfig
    expect(validateConfig(config).length).toBe(0)
  })

  it('detects missing config', () => {
    const warnings = validateConfig(null)
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'config_invalid', severity: 'error' }),
    ]))
  })

  it('detects invalid workflow', () => {
    const config = { version: 1, stack: 'nuxt', workflow: 'invalid' as any, locales: { default: 'en', supported: ['en'] }, domains: [] } as ContentrainConfig
    const warnings = validateConfig(config)
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'workflow', severity: 'error' }),
    ]))
  })

  it('detects default locale not in supported', () => {
    const config = { version: 1, stack: 'nuxt', workflow: 'auto-merge', locales: { default: 'en', supported: ['tr'] }, domains: ['m'] } as ContentrainConfig
    const warnings = validateConfig(config)
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'locales.supported', severity: 'warning' }),
    ]))
  })
})

// ─── Content-Against-Schema ───

describe('validateContentAgainstSchema', () => {
  it('detects missing locale files', () => {
    const brain = makeBrain({
      config: { version: 1, stack: 'nuxt', workflow: 'auto-merge', locales: { default: 'en', supported: ['en', 'tr'] }, domains: ['marketing'] } as ContentrainConfig,
      models: new Map([['hero', makeModel({ id: 'hero', kind: 'singleton', i18n: true })]]),
      content: new Map([['hero:en', { title: 'Hello' }]]),
    })
    const warnings = validateContentAgainstSchema(brain)
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'locale_file_missing', modelId: 'hero', current: 'tr' }),
    ]))
  })

  it('detects collection entry parity gaps', () => {
    const brain = makeBrain({
      config: { version: 1, stack: 'nuxt', workflow: 'auto-merge', locales: { default: 'en', supported: ['en', 'tr'] }, domains: ['marketing'] } as ContentrainConfig,
      models: new Map([['team', makeModel({ id: 'team', kind: 'collection', i18n: true })]]),
      content: new Map([
        ['team:en', { a1: { title: 'Alice' }, b2: { title: 'Bob' } }],
        ['team:tr', { a1: { title: 'Alice TR' } }],
      ]),
    })
    const warnings = validateContentAgainstSchema(brain)
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'locale_entry_parity', modelId: 'team' }),
    ]))
  })

  it('detects dictionary key parity gaps', () => {
    const brain = makeBrain({
      config: { version: 1, stack: 'nuxt', workflow: 'auto-merge', locales: { default: 'en', supported: ['en', 'tr'] }, domains: ['system'] } as ContentrainConfig,
      models: new Map([['msgs', makeModel({ id: 'msgs', kind: 'dictionary', domain: 'system', i18n: true, fields: undefined })]]),
      content: new Map([
        ['msgs:en', { 'auth.login': 'Login', 'auth.logout': 'Logout' }],
        ['msgs:tr', { 'auth.login': 'Giriş' }],
      ]),
    })
    const warnings = validateContentAgainstSchema(brain)
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'locale_key_parity', modelId: 'msgs' }),
    ]))
  })
})

// ─── Relation Integrity ───

describe('validateRelationIntegrity', () => {
  it('detects broken single relation', () => {
    const brain = makeBrain({
      models: new Map([
        ['posts', makeModel({ id: 'posts', fields: { author: { type: 'relation', model: 'authors', required: true } } })],
        ['authors', makeModel({ id: 'authors' })],
      ]),
      content: new Map([
        ['posts:en', { p1: { author: 'nonexistent-id' } }],
        ['authors:en', { a1: { title: 'Alice' } }],
      ]),
    })
    const warnings = validateRelationIntegrity(brain)
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'relation_integrity_broken', modelId: 'posts', field: 'author' }),
    ]))
  })

  it('passes for valid relation', () => {
    const brain = makeBrain({
      models: new Map([
        ['posts', makeModel({ id: 'posts', fields: { author: { type: 'relation', model: 'authors' } } })],
        ['authors', makeModel({ id: 'authors' })],
      ]),
      content: new Map([
        ['posts:en', { p1: { author: 'a1' } }],
        ['authors:en', { a1: { title: 'Alice' } }],
      ]),
    })
    const warnings = validateRelationIntegrity(brain)
    expect(warnings.length).toBe(0)
  })
})

// ─── Breaking Change Detector ───

describe('detectBreakingChanges', () => {
  it('detects model removal', () => {
    const prev = makeBrain({
      models: new Map([['blog', makeModel({ id: 'blog' })]]),
      contentSummary: { blog: { count: 10, locales: ['en'], kind: 'collection' } },
    })
    const curr = makeBrain({ models: new Map() })
    const warnings = detectBreakingChanges(prev, curr)
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'model_removed', severity: 'critical', modelId: 'blog' }),
    ]))
  })

  it('detects kind change', () => {
    const prev = makeBrain({ models: new Map([['hero', makeModel({ id: 'hero', kind: 'collection' })]]) })
    const curr = makeBrain({ models: new Map([['hero', makeModel({ id: 'hero', kind: 'singleton' })]]) })
    const warnings = detectBreakingChanges(prev, curr)
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'kind_changed', severity: 'critical', previous: 'collection', current: 'singleton' }),
    ]))
  })

  it('detects field type change', () => {
    const prev = makeBrain({ models: new Map([['blog', makeModel({ id: 'blog', fields: { count: { type: 'string' } } })]]) })
    const curr = makeBrain({ models: new Map([['blog', makeModel({ id: 'blog', fields: { count: { type: 'integer' } } })]]) })
    const warnings = detectBreakingChanges(prev, curr)
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'field_type_changed', field: 'count', previous: 'string', current: 'integer' }),
    ]))
  })

  it('detects field removal', () => {
    const prev = makeBrain({ models: new Map([['blog', makeModel({ id: 'blog', fields: { title: { type: 'string' }, body: { type: 'text' } } })]]) })
    const curr = makeBrain({ models: new Map([['blog', makeModel({ id: 'blog', fields: { title: { type: 'string' } } })]]) })
    const warnings = detectBreakingChanges(prev, curr)
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'field_removed', field: 'body' }),
    ]))
  })

  it('detects required field added', () => {
    const prev = makeBrain({ models: new Map([['blog', makeModel({ id: 'blog', fields: { slug: { type: 'slug' } } })]]) })
    const curr = makeBrain({ models: new Map([['blog', makeModel({ id: 'blog', fields: { slug: { type: 'slug', required: true } } })]]) })
    const warnings = detectBreakingChanges(prev, curr)
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'field_required_added', field: 'slug' }),
    ]))
  })
})

// ─── Orchestrator ───

describe('validateProjectSchema', () => {
  it('returns healthy result for valid project', () => {
    const brain = makeBrain({
      models: new Map([
        ['hero', makeModel({ id: 'hero', kind: 'singleton', fields: { title: { type: 'string', required: true } } })],
      ]),
      content: new Map([['hero:en', { title: 'Hello World' }]]),
    })
    const result = validateProjectSchema(brain)
    expect(result.valid).toBe(true)
    expect(result.healthScore).toBeGreaterThanOrEqual(90)
    expect(result.modelCount).toBe(1)
    expect(result.validModels).toBe(1)
  })

  it('scores down for errors', () => {
    const brain = makeBrain({
      models: new Map([
        ['bad', makeModel({ id: 'bad', kind: 'invalid' as any, fields: { x: { type: 'badtype' as any } } })],
      ]),
    })
    const result = validateProjectSchema(brain)
    expect(result.valid).toBe(false)
    expect(result.healthScore).toBeLessThan(100)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('includes breaking changes when previousBrain provided', () => {
    const prev = makeBrain({
      models: new Map([['blog', makeModel({ id: 'blog' })]]),
      contentSummary: { blog: { count: 5, locales: ['en'], kind: 'collection' } },
    })
    const curr = makeBrain({ models: new Map() })
    const result = validateProjectSchema(curr, prev)
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'model_removed' }),
    ]))
  })
})
