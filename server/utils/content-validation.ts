import type { FieldDef, ValidationError, ValidationResult } from '@contentrain/types'
import { SLUG_PATTERN, ENTRY_ID_PATTERN } from '@contentrain/types'

/**
 * Schema-based content validation using @contentrain/types FieldDef.
 * Returns ValidationResult — same format as MCP validation.
 */

export function validateContent(
  data: Record<string, unknown>,
  fields: Record<string, FieldDef>,
  modelId: string,
  locale: string,
  entryId?: string,
): ValidationResult {
  const errors: ValidationError[] = []

  for (const [fieldId, def] of Object.entries(fields)) {
    const value = data[fieldId]
    const fieldErrors = validateField(value, def, modelId, locale, entryId, fieldId)
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
): ValidationError[] {
  const errors: ValidationError[] = []
  const ctx = { model: modelId, locale, entry: entryId, field: fieldId }

  // Required check
  if (def.required && (value === null || value === undefined || value === '')) {
    errors.push({ severity: 'error', ...ctx, message: `${fieldId} is required` })
    return errors // Skip further validation if missing
  }

  // Skip validation if value is absent and not required
  if (value === null || value === undefined) return errors

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
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} must be a string` })
        break
      }
      if (def.min !== undefined && value.length < def.min) {
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} must be at least ${def.min} characters` })
      }
      if (def.max !== undefined && value.length > def.max) {
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} must be at most ${def.max} characters` })
      }
      if (def.pattern && !new RegExp(def.pattern).test(value)) {
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} does not match pattern ${def.pattern}` })
      }
      // Email format
      if (def.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        errors.push({ severity: 'warning', ...ctx, message: `${fieldId} may not be a valid email` })
      }
      // URL format
      if (def.type === 'url' && !/^https?:\/\/.+/.test(value) && !value.startsWith('/')) {
        errors.push({ severity: 'warning', ...ctx, message: `${fieldId} may not be a valid URL` })
      }
      break

    case 'slug':
      if (typeof value !== 'string') {
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} must be a string` })
      }
      else if (!SLUG_PATTERN.test(value)) {
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} must be a valid slug (lowercase, alphanumeric, hyphens)` })
      }
      break

    case 'color':
      if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} must be a hex color (#rrggbb)` })
      }
      break

    case 'number':
    case 'integer':
    case 'decimal':
    case 'percent':
    case 'rating':
      if (typeof value !== 'number') {
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} must be a number` })
        break
      }
      if (def.type === 'integer' && !Number.isInteger(value)) {
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} must be an integer` })
      }
      if (def.min !== undefined && value < def.min) {
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} must be at least ${def.min}` })
      }
      if (def.max !== undefined && value > def.max) {
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} must be at most ${def.max}` })
      }
      if (def.type === 'percent' && (value < 0 || value > 100)) {
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} must be between 0 and 100` })
      }
      if (def.type === 'rating' && (value < 1 || value > 5 || !Number.isInteger(value))) {
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} must be an integer between 1 and 5` })
      }
      break

    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} must be a boolean` })
      }
      break

    case 'date':
    case 'datetime':
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} must be a valid date string` })
      }
      break

    case 'select':
      if (def.options && !def.options.includes(value as string)) {
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} must be one of: ${def.options.join(', ')}` })
      }
      break

    case 'array':
      if (!Array.isArray(value)) {
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} must be an array` })
        break
      }
      if (def.min !== undefined && value.length < def.min) {
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} must have at least ${def.min} items` })
      }
      if (def.max !== undefined && value.length > def.max) {
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} must have at most ${def.max} items` })
      }
      break

    case 'relation':
      if (typeof value !== 'string') {
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} must be a string (entry ID)` })
      }
      break

    case 'relations':
      if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} must be an array of strings (entry IDs)` })
      }
      break

    case 'image':
    case 'video':
    case 'file':
      if (typeof value !== 'string') {
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} must be a file path string` })
      }
      break

    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push({ severity: 'error', ...ctx, message: `${fieldId} must be an object` })
      }
      else if (def.fields) {
        // Recursively validate nested fields
        const nested = validateContent(value as Record<string, unknown>, def.fields, modelId, locale, entryId)
        errors.push(...nested.errors)
      }
      break
  }

  return errors
}

/**
 * Validate an entry ID format.
 */
export function validateEntryId(id: string): boolean {
  return ENTRY_ID_PATTERN.test(id)
}
