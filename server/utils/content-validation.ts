import type { FieldDef, ModelDefinition, ValidationError, ValidationResult } from '@contentrain/types'
import { SLUG_PATTERN, ENTRY_ID_PATTERN } from '@contentrain/types'

/**
 * Schema-based content validation using @contentrain/types FieldDef.
 * Returns ValidationResult — same format as MCP validation.
 *
 * Supports:
 * - 27 field types with type-specific rules
 * - min/max (string length, number range, array size)
 * - pattern (regex)
 * - select options
 * - required / unique
 * - relation referential integrity
 * - nested object validation (max 2 levels)
 * - array item validation
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

  // Required check
  if (def.required && (value === null || value === undefined || value === '')) {
    errors.push({ severity: 'error', ...errCtx, message: `${fieldId} is required` })
    return errors
  }

  // Skip validation if value is absent and not required
  if (value === null || value === undefined) return errors

  // Unique check (collection-level)
  if (def.unique && ctx?.allEntries) {
    for (const [otherId, otherEntry] of Object.entries(ctx.allEntries)) {
      if (otherId === ctx?.currentEntryId) continue
      if (otherEntry[fieldId] === value) {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be unique — "${String(value)}" already exists in entry ${otherId}` })
        break
      }
    }
  }

  // Type-specific validation
  switch (def.type) {
    case 'string':
    case 'text':
    case 'email':
    case 'url':
    case 'phone':
    case 'code':
    case 'icon':
    case 'markdown':
    case 'richtext':
      if (typeof value !== 'string') {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be a string` })
        break
      }
      if (def.min !== undefined && value.length < def.min) {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be at least ${def.min} characters` })
      }
      if (def.max !== undefined && value.length > def.max) {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be at most ${def.max} characters` })
      }
      if (def.pattern) {
        try {
          if (!new RegExp(def.pattern).test(value)) {
            errors.push({ severity: 'error', ...errCtx, message: `${fieldId} does not match pattern ${def.pattern}` })
          }
        }
        catch {
          errors.push({ severity: 'warning', ...errCtx, message: `${fieldId} has invalid regex pattern: ${def.pattern}` })
        }
      }
      if (def.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        errors.push({ severity: 'warning', ...errCtx, message: `${fieldId} may not be a valid email` })
      }
      if (def.type === 'url' && !/^https?:\/\/.+/.test(value) && !value.startsWith('/')) {
        errors.push({ severity: 'warning', ...errCtx, message: `${fieldId} may not be a valid URL` })
      }
      break

    case 'slug':
      if (typeof value !== 'string') {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be a string` })
      }
      else if (!SLUG_PATTERN.test(value)) {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be a valid slug (lowercase, alphanumeric, hyphens)` })
      }
      break

    case 'color':
      if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be a hex color (#rrggbb)` })
      }
      break

    case 'number':
    case 'integer':
    case 'decimal':
    case 'percent':
    case 'rating':
      if (typeof value !== 'number') {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be a number` })
        break
      }
      if (def.type === 'integer' && !Number.isInteger(value)) {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be an integer` })
      }
      if (def.min !== undefined && value < def.min) {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be at least ${def.min}` })
      }
      if (def.max !== undefined && value > def.max) {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be at most ${def.max}` })
      }
      if (def.type === 'percent' && (value < 0 || value > 100)) {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be between 0 and 100` })
      }
      if (def.type === 'rating' && (value < 1 || value > 5 || !Number.isInteger(value))) {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be an integer between 1 and 5` })
      }
      break

    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be a boolean` })
      }
      break

    case 'date':
    case 'datetime':
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be a valid date string` })
      }
      break

    case 'select':
      if (def.options && !def.options.includes(value as string)) {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be one of: ${def.options.join(', ')}` })
      }
      break

    case 'array': {
      if (!Array.isArray(value)) {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be an array` })
        break
      }
      if (def.min !== undefined && value.length < def.min) {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must have at least ${def.min} items` })
      }
      if (def.max !== undefined && value.length > def.max) {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must have at most ${def.max} items` })
      }
      // Validate array items
      if (def.items && value.length > 0) {
        if (typeof def.items === 'string') {
          // Simple type: items: "string"
          for (let i = 0; i < value.length; i++) {
            const itemErrors = validateArrayItemType(value[i], def.items, modelId, locale, entryId, `${fieldId}[${i}]`)
            errors.push(...itemErrors)
          }
        }
        else if (typeof def.items === 'object' && def.items.type === 'object' && def.items.fields) {
          // Object items: items: { type: "object", fields: { ... } }
          for (let i = 0; i < value.length; i++) {
            if (typeof value[i] !== 'object' || value[i] === null) {
              errors.push({ severity: 'error', ...errCtx, field: `${fieldId}[${i}]`, message: `${fieldId}[${i}] must be an object` })
            }
            else {
              const nested = validateContent(value[i] as Record<string, unknown>, def.items.fields, modelId, locale, entryId)
              errors.push(...nested.errors.map(e => ({ ...e, field: `${fieldId}[${i}].${e.field}` })))
            }
          }
        }
      }
      break
    }

    case 'relation': {
      // Single relation — value must be a string ID/slug or polymorphic { model, ref }
      const targets = Array.isArray(def.model) ? def.model : (def.model ? [def.model] : [])
      if (targets.length > 1) {
        // Polymorphic: value must be { model: string, ref: string }
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
      else {
        // Single target: value must be a string (entry ID or slug)
        if (typeof value !== 'string') {
          errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be a string (entry ID or slug)` })
        }
      }
      // Relation integrity is checked separately via checkRelationIntegrity
      break
    }

    case 'relations': {
      if (!Array.isArray(value)) {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be an array` })
        break
      }
      if (def.min !== undefined && value.length < def.min) {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must have at least ${def.min} items` })
      }
      if (def.max !== undefined && value.length > def.max) {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must have at most ${def.max} items` })
      }
      // Validate each ref is a string
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] !== 'string') {
          errors.push({ severity: 'error', ...errCtx, message: `${fieldId}[${i}] must be a string (entry ID or slug)` })
        }
      }
      break
    }

    case 'image':
    case 'video':
    case 'file':
      if (typeof value !== 'string') {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be a file path string` })
      }
      break

    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push({ severity: 'error', ...errCtx, message: `${fieldId} must be an object` })
      }
      else if (def.fields) {
        const nested = validateContent(value as Record<string, unknown>, def.fields, modelId, locale, entryId)
        errors.push(...nested.errors)
      }
      break
  }

  return errors
}

/** Validate simple array item types */
function validateArrayItemType(
  value: unknown,
  itemType: string,
  modelId: string,
  locale: string,
  entryId: string | undefined,
  fieldPath: string,
): ValidationError[] {
  const errCtx = { model: modelId, locale, entry: entryId, field: fieldPath }

  switch (itemType) {
    case 'string':
    case 'email':
    case 'url':
    case 'slug':
    case 'image':
    case 'video':
    case 'file':
      if (typeof value !== 'string') {
        return [{ severity: 'error', ...errCtx, message: `${fieldPath} must be a string` }]
      }
      break
    case 'number':
    case 'integer':
    case 'decimal':
      if (typeof value !== 'number') {
        return [{ severity: 'error', ...errCtx, message: `${fieldPath} must be a number` }]
      }
      if (itemType === 'integer' && !Number.isInteger(value)) {
        return [{ severity: 'error', ...errCtx, message: `${fieldPath} must be an integer` }]
      }
      break
    case 'boolean':
      if (typeof value !== 'boolean') {
        return [{ severity: 'error', ...errCtx, message: `${fieldPath} must be a boolean` }]
      }
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
 */
export function validateEntryId(id: string): boolean {
  return ENTRY_ID_PATTERN.test(id)
}
