import type { FieldDef, ModelDefinition, ValidationError, ValidationResult } from '@contentrain/types'
import { detectSecrets, validateEntryId as _validateEntryId, validateFieldValue } from '@contentrain/types'

/**
 * Schema-based content validation using @contentrain/types.
 *
 * Pure field validation (type checks, min/max, pattern, select) is delegated
 * to validateFieldValue() from @contentrain/types — single source of truth
 * shared with MCP.
 *
 * Studio-specific concerns handled here:
 * - Cross-entry unique checks (stateful — needs all entries)
 * - Relation referential integrity (async — needs I/O)
 * - Secret detection per field (security layer)
 * - Nested object / array-of-object recursion with field path context
 */

/** Context for cross-entry validation (unique, relations) */
export interface ValidationContext {
  /** All entries in the collection (for unique checks) */
  allEntries?: Record<string, Record<string, unknown>>
  /** Current entry ID being validated (excluded from unique checks) */
  currentEntryId?: string
  /** All models (for relation target resolution) */
  models?: ModelDefinition[]
  /** Content loader for relation integrity checks */
  loadContent?: (modelId: string, locale: string) => Promise<Record<string, unknown> | null>
}

export function validateContent(
  data: Record<string, unknown>,
  fields: Record<string, FieldDef>,
  modelId: string,
  locale: string,
  entryId?: string,
  ctx?: ValidationContext,
): ValidationResult {
  const errors: ValidationError[] = []

  for (const [fieldId, def] of Object.entries(fields)) {
    const value = data[fieldId]
    const fieldErrors = validateField(value, def, modelId, locale, entryId, fieldId, ctx)
    errors.push(...fieldErrors)
  }

  return {
    valid: errors.filter(e => e.severity === 'error').length === 0,
    errors,
  }
}

function validateField(
  value: unknown,
  def: FieldDef,
  modelId: string,
  locale: string,
  entryId: string | undefined,
  fieldId: string,
  ctx?: ValidationContext,
): ValidationError[] {
  const errors: ValidationError[] = []
  const errCtx = { model: modelId, locale, entry: entryId, field: fieldId }

  // ── Secret detection (security — not in types' validateFieldValue) ──
  if (value !== null && value !== undefined && value !== '') {
    const secretErrors = detectSecrets(value)
    if (secretErrors.length > 0) {
      errors.push(...secretErrors.map(e => ({ ...e, ...errCtx })))
    }
  }

  // ── Pure field validation (type, required, min/max, pattern, select) ──
  // Skip types' validateFieldValue for relation/relations — Studio handles these with richer checks below
  const skipTypesValidation = def.type === 'relation' || def.type === 'relations'
  if (!skipTypesValidation) {
    const fieldErrors = validateFieldValue(value, def)
    if (fieldErrors.length > 0) {
      errors.push(...fieldErrors.map((e: ValidationError) => ({ ...e, ...errCtx })))
      if (fieldErrors.some((e: ValidationError) => e.severity === 'error')) return errors
    }
  }
  else {
    // For relations, only check required ourselves
    if (def.required && (value === null || value === undefined || value === '')) {
      errors.push({ severity: 'error', ...errCtx, message: `${fieldId} is required` })
      return errors
    }
  }

  // Skip further checks if value is absent
  if (value === null || value === undefined) return errors

  // ── Unique check (collection-level — stateful) ──
  if (def.unique && ctx?.allEntries) {
    for (const [otherId, otherEntry] of Object.entries(ctx.allEntries)) {
      if (otherId === ctx?.currentEntryId) continue
      if (otherEntry[fieldId] === value) {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be unique — "${String(value)}" already exists in entry ${otherId}` })
        break
      }
    }
  }

  // ── Supplementary checks not covered by validateFieldValue ──

  // Email/URL heuristic warnings
  if (def.type === 'email' && typeof value === 'string' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    errors.push({ severity: 'warning', ...errCtx, message: `${fieldId} may not be a valid email` })
  }
  if (def.type === 'url' && typeof value === 'string' && !/^https?:\/\/.+/.test(value) && !value.startsWith('/')) {
    errors.push({ severity: 'warning', ...errCtx, message: `${fieldId} may not be a valid URL` })
  }

  // Relation: polymorphic model validation + scalar type check
  if (def.type === 'relation' && def.model) {
    const targets = Array.isArray(def.model) ? def.model : [def.model]
    if (targets.length > 1) {
      if (typeof value !== 'object' || value === null || !('model' in value) || !('ref' in value)) {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be { model, ref } for polymorphic relation` })
      }
      else {
        const polyVal = value as { model: string, ref: string }
        if (!targets.includes(polyVal.model)) {
          errors.push({ severity: 'error', ...errCtx, message: `${fieldId} target model "${polyVal.model}" must be one of: ${targets.join(', ')}` })
        }
      }
    }
    else if (typeof value !== 'string') {
      errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be a string (entry ID or slug)` })
    }
  }

  // Relations: array of string IDs + min/max
  if (def.type === 'relations') {
    if (!Array.isArray(value)) {
      errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be an array` })
    }
    else {
      if (def.min !== undefined && value.length < def.min)
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must have at least ${def.min} items` })
      if (def.max !== undefined && value.length > def.max)
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must have at most ${def.max} items` })
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] !== 'string')
          errors.push({ severity: 'error', ...errCtx, message: `${fieldId}[${i}] must be a string (entry ID or slug)` })
      }
    }
  }

  // Array: simple item type validation
  if (def.type === 'array' && Array.isArray(value) && def.items && typeof def.items === 'string') {
    for (let i = 0; i < value.length; i++) {
      const itemErrors = validateArrayItemType(value[i], def.items, errCtx, `${fieldId}[${i}]`)
      errors.push(...itemErrors)
    }
  }

  // ── Nested object validation ──
  if (def.type === 'object' && def.fields && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const nested = validateContent(value as Record<string, unknown>, def.fields, modelId, locale, entryId)
    errors.push(...nested.errors)
  }

  // ── Array-of-object validation ──
  if (def.type === 'array' && Array.isArray(value) && def.items && typeof def.items === 'object' && def.items.type === 'object' && def.items.fields) {
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] === 'object' && value[i] !== null) {
        const nested = validateContent(value[i] as Record<string, unknown>, def.items.fields, modelId, locale, entryId)
        errors.push(...nested.errors.map(e => ({ ...e, field: `${fieldId}[${i}].${e.field}` })))
      }
    }
  }

  return errors
}

/** Validate simple array item types (not covered by types' validateFieldValue) */
function validateArrayItemType(
  value: unknown,
  itemType: string,
  errCtx: { model: string, locale: string, entry: string | undefined, field: string },
  fieldPath: string,
): ValidationError[] {
  const ctx = { ...errCtx, field: fieldPath }
  switch (itemType) {
    case 'string': case 'email': case 'url': case 'slug': case 'image': case 'video': case 'file':
      if (typeof value !== 'string') return [{ severity: 'error', ...ctx, message: `${fieldPath} must be a string` }]
      break
    case 'number': case 'integer': case 'decimal':
      if (typeof value !== 'number') return [{ severity: 'error', ...ctx, message: `${fieldPath} must be a number` }]
      if (itemType === 'integer' && !Number.isInteger(value)) return [{ severity: 'error', ...ctx, message: `${fieldPath} must be an integer` }]
      break
    case 'boolean':
      if (typeof value !== 'boolean') return [{ severity: 'error', ...ctx, message: `${fieldPath} must be a boolean` }]
      break
  }
  return []
}

/**
 * Check relation referential integrity.
 * Verifies that relation field values point to existing entries in target models.
 * Called separately from validateContent because it requires async content loading.
 */
export async function checkRelationIntegrity(
  data: Record<string, unknown>,
  fields: Record<string, FieldDef>,
  modelId: string,
  locale: string,
  entryId: string | undefined,
  loadContent: (targetModelId: string, locale: string) => Promise<Record<string, unknown> | null>,
): Promise<ValidationError[]> {
  const errors: ValidationError[] = []

  for (const [fieldId, def] of Object.entries(fields)) {
    const value = data[fieldId]
    if (value === null || value === undefined) continue

    if (def.type === 'relation' && def.model) {
      const targets = Array.isArray(def.model) ? def.model : [def.model]

      if (targets.length > 1 && typeof value === 'object' && value !== null) {
        // Polymorphic: { model, ref }
        const polyVal = value as { model: string, ref: string }
        if (polyVal.model && polyVal.ref) {
          const targetContent = await loadContent(polyVal.model, locale)
          if (targetContent && !(polyVal.ref in targetContent)) {
            errors.push({
              severity: 'warning',
              model: modelId,
              locale,
              entry: entryId,
              field: fieldId,
              message: `Broken relation: "${polyVal.ref}" not found in ${polyVal.model}`,
            })
          }
        }
      }
      else if (typeof value === 'string' && targets[0]) {
        const targetContent = await loadContent(targets[0], locale)
        if (targetContent && !(value in targetContent)) {
          errors.push({
            severity: 'warning',
            model: modelId,
            locale,
            entry: entryId,
            field: fieldId,
            message: `Broken relation: "${value}" not found in ${targets[0]}`,
          })
        }
      }
    }

    if (def.type === 'relations' && def.model && Array.isArray(value)) {
      const target = Array.isArray(def.model) ? def.model[0] : def.model
      if (target) {
        const targetContent = await loadContent(target, locale)
        if (targetContent) {
          for (const ref of value) {
            if (typeof ref === 'string' && !(ref in targetContent)) {
              errors.push({
                severity: 'warning',
                model: modelId,
                locale,
                entry: entryId,
                field: fieldId,
                message: `Broken relation: "${ref}" not found in ${target}`,
              })
            }
          }
        }
      }
    }
  }

  return errors
}

/**
 * Validate an entry ID format.
 * Returns true if valid, false otherwise (Studio compat wrapper).
 */
export function validateEntryId(id: string): boolean {
  return _validateEntryId(id) === null
}
