/**
 * Schema validation — pure utility for model/content/config integrity checks.
 *
 * Validates:
 * - Model definitions against @contentrain/types type system (27 types)
 * - Content against model schemas (required, type, min/max, unique, relations)
 * - Locale parity (missing locales, entry ID mismatches, dictionary key gaps)
 * - Config validity (required fields, valid values)
 * - Breaking change detection (field type changes, removed required fields)
 * - Relation integrity (target model/entry existence)
 *
 * All functions are pure and synchronous (except relation integrity).
 * No side effects, no I/O — operates on in-memory BrainCacheEntry data.
 */

import type { ContentrainConfig, FieldDef, FieldType, ModelDefinition, ModelKind } from '@contentrain/types'
import type { BrainCacheEntry } from './brain-cache'
import { validateContent } from './content-validation'

// ─── Types ───

export type SchemaWarningType
  = | 'invalid_kind'
    | 'invalid_field_type'
    | 'duplicate_field_id'
    | 'id_filename_mismatch'
    | 'domain_not_in_config'
    | 'missing_fields'
    | 'dictionary_has_fields'
    | 'relation_target_missing'
    | 'select_missing_options'
    | 'object_nesting_too_deep'
    | 'invalid_pattern'
    | 'array_missing_item_fields'
    | 'config_invalid'
    | 'locale_file_missing'
    | 'locale_entry_parity'
    | 'locale_key_parity'
    | 'content_validation_error'
    | 'relation_integrity_broken'
    | 'model_removed'
    | 'kind_changed'
    | 'i18n_changed'
    | 'field_removed'
    | 'field_type_changed'
    | 'field_required_added'

export interface SchemaWarning {
  modelId: string
  type: SchemaWarningType
  field?: string
  previous?: string
  current?: string
  affectedEntries: number
  severity: 'critical' | 'error' | 'warning'
  message: string
}

export interface SchemaValidationResult {
  valid: boolean
  warnings: SchemaWarning[]
  healthScore: number
  modelCount: number
  validModels: number
  timestamp: string
}

// ─── Constants ───

const VALID_FIELD_TYPES: ReadonlySet<string> = new Set<FieldType>([
  'string', 'text', 'email', 'url', 'slug', 'color', 'phone', 'code', 'icon',
  'markdown', 'richtext',
  'number', 'integer', 'decimal', 'percent', 'rating',
  'boolean', 'date', 'datetime',
  'image', 'video', 'file',
  'relation', 'relations',
  'select', 'array', 'object',
])

const VALID_KINDS: ReadonlySet<string> = new Set<ModelKind>([
  'singleton', 'collection', 'document', 'dictionary',
])

const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

// ─── 1. Model Definition Validator ───

export function validateModelDefinition(
  model: ModelDefinition,
  config: ContentrainConfig | null,
  allModelIds: string[],
): SchemaWarning[] {
  const warnings: SchemaWarning[] = []
  const m = model.id

  // Kind
  if (!VALID_KINDS.has(model.kind)) {
    warnings.push({ modelId: m, type: 'invalid_kind', severity: 'error', affectedEntries: 0, current: model.kind, message: `Invalid model kind: "${model.kind}"` })
  }

  // ID format
  if (!KEBAB_CASE.test(m)) {
    warnings.push({ modelId: m, type: 'id_filename_mismatch', severity: 'warning', affectedEntries: 0, message: `Model ID "${m}" is not kebab-case` })
  }

  // Domain in config
  if (config && config.domains && !config.domains.includes(model.domain)) {
    warnings.push({ modelId: m, type: 'domain_not_in_config', severity: 'warning', affectedEntries: 0, current: model.domain, message: `Domain "${model.domain}" not in config.domains` })
  }

  // Fields presence
  if (model.kind === 'dictionary') {
    if (model.fields && Object.keys(model.fields).length > 0) {
      warnings.push({ modelId: m, type: 'dictionary_has_fields', severity: 'warning', affectedEntries: 0, message: `Dictionary model should not define fields` })
    }
  }
  else {
    if (!model.fields || Object.keys(model.fields).length === 0) {
      warnings.push({ modelId: m, type: 'missing_fields', severity: 'error', affectedEntries: 0, message: `Model has no field definitions` })
    }
  }

  // Field-level validation
  if (model.fields) {
    for (const [fieldId, def] of Object.entries(model.fields)) {
      warnings.push(...validateFieldDefinition(m, fieldId, def, allModelIds, 0))
    }
  }

  return warnings
}

function validateFieldDefinition(
  modelId: string,
  fieldId: string,
  def: FieldDef,
  allModelIds: string[],
  depth: number,
): SchemaWarning[] {
  const warnings: SchemaWarning[] = []

  // Field type
  if (!VALID_FIELD_TYPES.has(def.type)) {
    warnings.push({ modelId, type: 'invalid_field_type', field: fieldId, severity: 'error', affectedEntries: 0, current: def.type, message: `Invalid field type: "${def.type}"` })
    return warnings
  }

  // Relation target
  if ((def.type === 'relation' || def.type === 'relations') && def.model) {
    const targets = Array.isArray(def.model) ? def.model : [def.model]
    for (const target of targets) {
      if (!allModelIds.includes(target)) {
        warnings.push({ modelId, type: 'relation_target_missing', field: fieldId, severity: 'warning', affectedEntries: 0, current: target, message: `Relation target "${target}" not found in models` })
      }
    }
  }

  // Select options
  if (def.type === 'select' && (!def.options || def.options.length === 0)) {
    warnings.push({ modelId, type: 'select_missing_options', field: fieldId, severity: 'warning', affectedEntries: 0, message: `Select field has no options defined` })
  }

  // Pattern validity
  if (def.pattern) {
    try {
      new RegExp(def.pattern)
    }
    catch {
      warnings.push({ modelId, type: 'invalid_pattern', field: fieldId, severity: 'error', affectedEntries: 0, current: def.pattern, message: `Invalid regex pattern: "${def.pattern}"` })
    }
  }

  // Object nesting depth
  if (def.type === 'object') {
    if (depth >= 2) {
      warnings.push({ modelId, type: 'object_nesting_too_deep', field: fieldId, severity: 'error', affectedEntries: 0, message: `Object nesting exceeds maximum depth of 2` })
    }
    else if (def.fields) {
      for (const [nestedId, nestedDef] of Object.entries(def.fields)) {
        warnings.push(...validateFieldDefinition(modelId, `${fieldId}.${nestedId}`, nestedDef, allModelIds, depth + 1))
      }
    }
  }

  // Array with object items
  if (def.type === 'array' && def.items && typeof def.items === 'object') {
    if (def.items.type === 'object') {
      if (!def.items.fields || Object.keys(def.items.fields).length === 0) {
        warnings.push({ modelId, type: 'array_missing_item_fields', field: fieldId, severity: 'warning', affectedEntries: 0, message: `Array of objects has no item field definitions` })
      }
      else {
        for (const [nestedId, nestedDef] of Object.entries(def.items.fields)) {
          warnings.push(...validateFieldDefinition(modelId, `${fieldId}[].${nestedId}`, nestedDef, allModelIds, depth + 1))
        }
      }
    }
  }

  return warnings
}

// ─── 2. Config Validator ───

export function validateConfig(config: ContentrainConfig | null): SchemaWarning[] {
  const warnings: SchemaWarning[] = []
  const m = '_config'

  if (!config) {
    warnings.push({ modelId: m, type: 'config_invalid', severity: 'error', affectedEntries: 0, message: `config.json is missing or invalid` })
    return warnings
  }

  if (typeof config.version !== 'number') {
    warnings.push({ modelId: m, type: 'config_invalid', severity: 'error', affectedEntries: 0, field: 'version', message: `config.version must be a number` })
  }

  if (config.workflow !== 'auto-merge' && config.workflow !== 'review') {
    warnings.push({ modelId: m, type: 'config_invalid', severity: 'error', affectedEntries: 0, field: 'workflow', current: config.workflow, message: `config.workflow must be "auto-merge" or "review"` })
  }

  if (!config.locales?.default) {
    warnings.push({ modelId: m, type: 'config_invalid', severity: 'error', affectedEntries: 0, field: 'locales.default', message: `config.locales.default is required` })
  }

  if (!config.locales?.supported?.length) {
    warnings.push({ modelId: m, type: 'config_invalid', severity: 'error', affectedEntries: 0, field: 'locales.supported', message: `config.locales.supported must be a non-empty array` })
  }
  else if (config.locales.default && !config.locales.supported.includes(config.locales.default)) {
    warnings.push({ modelId: m, type: 'config_invalid', severity: 'warning', affectedEntries: 0, field: 'locales.supported', message: `config.locales.supported does not include default locale "${config.locales.default}"` })
  }

  if (!config.domains?.length) {
    warnings.push({ modelId: m, type: 'config_invalid', severity: 'warning', affectedEntries: 0, field: 'domains', message: `config.domains is empty` })
  }

  return warnings
}

// ─── 3. Content-Against-Schema Validator ───

export function validateContentAgainstSchema(brain: BrainCacheEntry): SchemaWarning[] {
  const warnings: SchemaWarning[] = []
  const supportedLocales = brain.config?.locales?.supported ?? []
  const defaultLocale = brain.config?.locales?.default ?? 'en'

  for (const [modelId, model] of brain.models) {
    // Locale file presence
    if (model.i18n && supportedLocales.length > 0) {
      for (const locale of supportedLocales) {
        const key = `${modelId}:${locale}`
        if (!brain.content.has(key)) {
          warnings.push({ modelId, type: 'locale_file_missing', severity: 'warning', affectedEntries: 0, current: locale, message: `Content missing for locale "${locale}"` })
        }
      }
    }

    // Collection: entry ID parity across locales
    if (model.kind === 'collection' && model.i18n) {
      const localeEntryIds = new Map<string, Set<string>>()
      for (const locale of supportedLocales) {
        const data = brain.content.get(`${modelId}:${locale}`)
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          localeEntryIds.set(locale, new Set(Object.keys(data as Record<string, unknown>)))
        }
      }
      if (localeEntryIds.size > 1) {
        const referenceLocale = defaultLocale
        const referenceIds = localeEntryIds.get(referenceLocale)
        if (referenceIds) {
          for (const [locale, ids] of localeEntryIds) {
            if (locale === referenceLocale) continue
            for (const refId of referenceIds) {
              if (!ids.has(refId)) {
                warnings.push({ modelId, type: 'locale_entry_parity', severity: 'warning', affectedEntries: 1, current: locale, message: `Entry "${refId}" missing in locale "${locale}"` })
              }
            }
          }
        }
      }
    }

    // Dictionary: key parity across locales
    if (model.kind === 'dictionary' && model.i18n) {
      const localeKeys = new Map<string, Set<string>>()
      for (const locale of supportedLocales) {
        const data = brain.content.get(`${modelId}:${locale}`)
        if (data && typeof data === 'object') {
          localeKeys.set(locale, new Set(Object.keys(data as Record<string, unknown>)))
        }
      }
      if (localeKeys.size > 1) {
        const referenceKeys = localeKeys.get(defaultLocale)
        if (referenceKeys) {
          for (const [locale, keys] of localeKeys) {
            if (locale === defaultLocale) continue
            const missing = [...referenceKeys].filter(k => !keys.has(k))
            if (missing.length > 0) {
              warnings.push({ modelId, type: 'locale_key_parity', severity: 'warning', affectedEntries: missing.length, current: locale, message: `${missing.length} keys missing in locale "${locale}": ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}` })
            }
          }
        }
      }
    }

    // Content validation against schema (non-dictionary only)
    if (model.fields && model.kind !== 'dictionary') {
      const locales = model.i18n ? supportedLocales : [defaultLocale]
      for (const locale of locales) {
        const data = brain.content.get(`${modelId}:${locale}`)
        if (!data || typeof data !== 'object') continue

        if (model.kind === 'collection') {
          const entries = data as Record<string, Record<string, unknown>>
          const allEntries = entries
          for (const [entryId, entry] of Object.entries(entries)) {
            if (typeof entry !== 'object' || entry === null) continue
            const result = validateContent(entry, model.fields, modelId, locale, entryId, { allEntries, currentEntryId: entryId })
            for (const err of result.errors) {
              if (err.severity === 'error') {
                warnings.push({ modelId, type: 'content_validation_error', field: err.field, severity: 'warning', affectedEntries: 1, message: `[${entryId}] ${err.message}` })
              }
            }
          }
        }
        else if (model.kind === 'singleton') {
          const result = validateContent(data as Record<string, unknown>, model.fields, modelId, locale)
          for (const err of result.errors) {
            if (err.severity === 'error') {
              warnings.push({ modelId, type: 'content_validation_error', field: err.field, severity: 'warning', affectedEntries: 1, message: err.message })
            }
          }
        }
      }
    }

    // Dictionary: all values must be strings
    if (model.kind === 'dictionary') {
      const locales = model.i18n ? supportedLocales : [defaultLocale]
      for (const locale of locales) {
        const data = brain.content.get(`${modelId}:${locale}`)
        if (!data || typeof data !== 'object') continue
        let nonStringCount = 0
        for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
          if (val !== null && val !== undefined && typeof val !== 'string') {
            nonStringCount++
            if (nonStringCount <= 3) {
              warnings.push({ modelId, type: 'content_validation_error', field: key, severity: 'warning', affectedEntries: 1, message: `Dictionary value for "${key}" is not a string` })
            }
          }
        }
      }
    }
  }

  return warnings
}

// ─── 4. Relation Integrity Checker ───

export function validateRelationIntegrity(brain: BrainCacheEntry): SchemaWarning[] {
  const warnings: SchemaWarning[] = []
  const defaultLocale = brain.config?.locales?.default ?? 'en'

  for (const [modelId, model] of brain.models) {
    if (!model.fields || model.kind === 'dictionary') continue

    // Find relation fields
    const relationFields = Object.entries(model.fields).filter(
      ([, def]) => def.type === 'relation' || def.type === 'relations',
    )
    if (relationFields.length === 0) continue

    // Get content for default locale (brain always stores with defaultLocale key)
    const locale = defaultLocale
    const data = brain.content.get(`${modelId}:${locale}`)
    if (!data || typeof data !== 'object') continue

    const entries = model.kind === 'collection'
      ? Object.entries(data as Record<string, Record<string, unknown>>)
      : [['_singleton', data as Record<string, unknown>]]

    for (const [entryId, entry] of entries) {
      if (typeof entry !== 'object' || entry === null) continue

      for (const [fieldId, def] of relationFields) {
        const value = entry[fieldId]
        if (value === null || value === undefined) continue

        const targets = Array.isArray(def.model) ? def.model : (def.model ? [def.model] : [])
        if (targets.length === 0) continue

        if (def.type === 'relation') {
          const brokenRef = checkSingleRelation(value, targets, brain, locale)
          if (brokenRef) {
            warnings.push({ modelId, type: 'relation_integrity_broken', field: fieldId, severity: 'warning', affectedEntries: 1, message: `[${entryId}] Broken relation: "${brokenRef.ref}" not found in ${brokenRef.target}` })
          }
        }
        else if (def.type === 'relations' && Array.isArray(value)) {
          const target = targets[0]!
          const targetData = brain.content.get(`${target}:${locale}`)
          if (targetData && typeof targetData === 'object') {
            const targetKeys = new Set(Object.keys(targetData as Record<string, unknown>))
            let brokenCount = 0
            for (const ref of value) {
              if (typeof ref === 'string' && !targetKeys.has(ref)) brokenCount++
            }
            if (brokenCount > 0) {
              warnings.push({ modelId, type: 'relation_integrity_broken', field: fieldId, severity: 'warning', affectedEntries: brokenCount, message: `[${entryId}] ${brokenCount} broken relation(s) in ${target}` })
            }
          }
        }
      }
    }
  }

  return warnings
}

function checkSingleRelation(
  value: unknown,
  targets: string[],
  brain: BrainCacheEntry,
  locale: string,
): { ref: string, target: string } | null {
  if (targets.length > 1 && typeof value === 'object' && value !== null) {
    // Polymorphic
    const poly = value as { model?: string, ref?: string }
    if (poly.model && poly.ref) {
      const targetData = brain.content.get(`${poly.model}:${locale}`)
      if (targetData && typeof targetData === 'object' && !(poly.ref in (targetData as Record<string, unknown>))) {
        return { ref: poly.ref, target: poly.model }
      }
    }
  }
  else if (typeof value === 'string' && targets[0]) {
    const target = targets[0]
    const targetData = brain.content.get(`${target}:${locale}`)
    if (targetData && typeof targetData === 'object' && !(value in (targetData as Record<string, unknown>))) {
      return { ref: value, target }
    }
  }
  return null
}

// ─── 5. Breaking Change Detector ───

export function detectBreakingChanges(
  previous: BrainCacheEntry,
  current: BrainCacheEntry,
): SchemaWarning[] {
  const warnings: SchemaWarning[] = []

  // Model removed
  for (const [modelId, prevModel] of previous.models) {
    if (!current.models.has(modelId)) {
      const entryCount = countEntries(previous, modelId)
      warnings.push({ modelId, type: 'model_removed', severity: 'critical', affectedEntries: entryCount, previous: prevModel.kind, message: `Model removed (had ${entryCount} entries)` })
    }
  }

  // Per-model changes
  for (const [modelId, currModel] of current.models) {
    const prevModel = previous.models.get(modelId)
    if (!prevModel) continue // new model — not a breaking change

    // Kind changed
    if (prevModel.kind !== currModel.kind) {
      warnings.push({ modelId, type: 'kind_changed', severity: 'critical', affectedEntries: countEntries(current, modelId), previous: prevModel.kind, current: currModel.kind, message: `Kind changed from "${prevModel.kind}" to "${currModel.kind}"` })
    }

    // i18n changed
    if (prevModel.i18n !== currModel.i18n) {
      warnings.push({ modelId, type: 'i18n_changed', severity: 'error', affectedEntries: countEntries(current, modelId), previous: String(prevModel.i18n), current: String(currModel.i18n), message: `i18n changed from ${prevModel.i18n} to ${currModel.i18n}` })
    }

    // Field changes
    if (prevModel.fields && currModel.fields) {
      for (const [fieldId, prevDef] of Object.entries(prevModel.fields)) {
        const currDef = currModel.fields[fieldId]
        if (!currDef) {
          warnings.push({ modelId, type: 'field_removed', field: fieldId, severity: 'warning', affectedEntries: countEntries(current, modelId), previous: prevDef.type, message: `Field "${fieldId}" removed` })
          continue
        }
        if (prevDef.type !== currDef.type) {
          warnings.push({ modelId, type: 'field_type_changed', field: fieldId, severity: 'error', affectedEntries: countEntries(current, modelId), previous: prevDef.type, current: currDef.type, message: `Field "${fieldId}" type changed from "${prevDef.type}" to "${currDef.type}"` })
        }
        if (!prevDef.required && currDef.required) {
          warnings.push({ modelId, type: 'field_required_added', field: fieldId, severity: 'warning', affectedEntries: countEntries(current, modelId), message: `Field "${fieldId}" is now required` })
        }
      }
    }
  }

  return warnings
}

function countEntries(brain: BrainCacheEntry, modelId: string): number {
  const summary = brain.contentSummary[modelId]
  return summary?.count ?? 0
}

// ─── 6. Orchestrator ───

export function validateProjectSchema(
  brain: BrainCacheEntry,
  previousBrain?: BrainCacheEntry | null,
): SchemaValidationResult {
  const allModelIds = [...brain.models.keys()]
  const allWarnings: SchemaWarning[] = []

  // Config validation
  allWarnings.push(...validateConfig(brain.config))

  // Model definition validation
  let validModels = 0
  for (const [, model] of brain.models) {
    const modelWarnings = validateModelDefinition(model, brain.config, allModelIds)
    allWarnings.push(...modelWarnings)
    if (modelWarnings.filter(w => w.severity === 'error' || w.severity === 'critical').length === 0) {
      validModels++
    }
  }

  // Content-against-schema validation
  allWarnings.push(...validateContentAgainstSchema(brain))

  // Relation integrity
  allWarnings.push(...validateRelationIntegrity(brain))

  // Breaking change detection
  if (previousBrain) {
    allWarnings.push(...detectBreakingChanges(previousBrain, brain))
  }

  // Health score
  let score = 100
  for (const w of allWarnings) {
    if (w.severity === 'critical') score -= 20
    else if (w.severity === 'error') score -= 10
    else if (w.severity === 'warning') score -= 3
  }
  score = Math.max(0, Math.min(100, score))

  return {
    valid: allWarnings.filter(w => w.severity === 'critical' || w.severity === 'error').length === 0,
    warnings: allWarnings,
    healthScore: score,
    modelCount: brain.models.size,
    validModels,
    timestamp: new Date().toISOString(),
  }
}
