import type { FieldDef, ModelDefinition } from '@contentrain/types'
import { canonicalStringify } from '@contentrain/types'
import { DICTIONARY_TITLE_FIELD, TITLE_FIELD_TYPES } from '../../../shared/utils/entry-title'

/**
 * How a model save treats what is already there.
 *
 * A `save_model` call that carried only the field being added used to REPLACE
 * the whole definition: on Contentrain/iterum an "add one image field" request
 * wiped 38 of 39 fields from `home-page` and auto-merged the truncation to
 * `main` while every entry still used them. Nothing said the tool replaced,
 * nothing merged with the existing definition, and nothing checked the
 * content. These helpers are the merge and the check; `saveModel` applies
 * them.
 */
export interface ModelSaveOptions {
  /**
   * Field ids to drop from the existing definition. Omitting a field keeps
   * it; this is the only way a save removes one.
   */
  removeFields?: string[]
  /**
   * Proceed even when a removed or retyped field, or a changed kind/i18n,
   * still has content behind it. Off by default — the save is refused with
   * the affected count so the person can decide.
   */
  allowBreaking?: boolean
}

export interface ModelChangeSummary {
  action: 'created' | 'updated'
  addedFields: string[]
  changedFields: string[]
  removedFields: string[]
  /** Fields present before and after, unchanged. */
  keptFields: number
}

export interface BreakingModelChange {
  kind: 'field_removed' | 'field_type_changed' | 'kind_changed' | 'i18n_changed'
  field?: string
  from: string
  to?: string
  /** Entries that still carry a value the change would orphan or invalidate. */
  affectedEntries: number
}

/** Per-field usage: how many entries hold a non-empty value for each field. */
export interface FieldUsage {
  entries: number
  byField: Record<string, number>
}

/** A field id's shorthand for "nothing here": null, '', [], {}. */
export function hasContentValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value as object).length > 0
  return true
}

function definedEntries<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value
  }
  return out
}

/**
 * The definition that results from saving `incoming` over `existing`.
 *
 * Omitted means kept, at both levels: a top-level key the caller did not
 * send keeps its value (so `title_field`, `description`, a form config all
 * survive a fields-only save), and a field the caller did not send is still
 * there afterwards. A field that IS sent is merged property by property, so
 * adding a `label` does not silently drop `required`. Removal is explicit —
 * `removeFields` — because it is the one edit that can orphan content.
 */
export function mergeModelDefinition(
  existing: ModelDefinition,
  incoming: Partial<ModelDefinition> & { id: string },
  removeFields: string[] = [],
): ModelDefinition {
  const { fields: incomingFields, ...rest } = incoming
  const merged = { ...existing, ...definedEntries(rest) } as ModelDefinition

  if (merged.kind === 'dictionary') {
    delete merged.fields
    return merged
  }

  const fields: Record<string, FieldDef> = { ...(existing.fields ?? {}) }
  for (const [fieldId, def] of Object.entries(incomingFields ?? {})) {
    fields[fieldId] = fields[fieldId] ? { ...fields[fieldId], ...definedEntries(def) } as FieldDef : def
  }
  const removed = new Set(removeFields)
  merged.fields = Object.fromEntries(Object.entries(fields).filter(([fieldId]) => !removed.has(fieldId)))
  return merged
}

/** What a save did to the field list — so the caller can say so, exactly. */
export function summarizeModelChange(previous: ModelDefinition | null, next: ModelDefinition): ModelChangeSummary {
  const before = previous?.fields ?? {}
  const after = next.fields ?? {}
  const addedFields: string[] = []
  const changedFields: string[] = []
  const removedFields: string[] = []
  let keptFields = 0

  for (const fieldId of Object.keys(after)) {
    if (!(fieldId in before)) addedFields.push(fieldId)
    else if (canonicalStringify(before[fieldId]) !== canonicalStringify(after[fieldId])) changedFields.push(fieldId)
    else keptFields++
  }
  for (const fieldId of Object.keys(before)) {
    if (!(fieldId in after)) removedFields.push(fieldId)
  }

  return {
    action: previous ? 'updated' : 'created',
    addedFields: addedFields.toSorted(),
    changedFields: changedFields.toSorted(),
    removedFields: removedFields.toSorted(),
    keptFields,
  }
}

/**
 * The structural changes that COULD break content — before anyone has
 * counted. Cheap and pure, so `saveModel` reads content only when this is
 * non-empty.
 */
export function breakingCandidates(previous: ModelDefinition, next: ModelDefinition): Omit<BreakingModelChange, 'affectedEntries'>[] {
  const out: Omit<BreakingModelChange, 'affectedEntries'>[] = []
  if (previous.kind !== next.kind) out.push({ kind: 'kind_changed', from: previous.kind, to: next.kind })
  if (Boolean(previous.i18n) !== Boolean(next.i18n)) out.push({ kind: 'i18n_changed', from: String(Boolean(previous.i18n)), to: String(Boolean(next.i18n)) })

  const before = previous.fields ?? {}
  const after = next.fields ?? {}
  for (const [fieldId, def] of Object.entries(before)) {
    const nextDef = after[fieldId]
    if (!nextDef) out.push({ kind: 'field_removed', field: fieldId, from: def.type })
    else if (nextDef.type !== def.type) out.push({ kind: 'field_type_changed', field: fieldId, from: def.type, to: nextDef.type })
  }
  return out
}

/** The candidates that actually have content behind them. */
export function withAffectedEntries(
  candidates: Omit<BreakingModelChange, 'affectedEntries'>[],
  usage: FieldUsage,
): BreakingModelChange[] {
  return candidates
    .map(c => ({ ...c, affectedEntries: c.field ? (usage.byField[c.field] ?? 0) : usage.entries }))
    .filter(c => c.affectedEntries > 0)
}

/** One sentence per refused change, naming the field and the count. */
export function describeBreakingChange(change: BreakingModelChange): string {
  const n = change.affectedEntries
  const entries = n === 1 ? '1 entry' : `${n} entries`
  switch (change.kind) {
    case 'field_removed':
      return `Field "${change.field}" is still used by ${entries}; removing it would orphan that content. Clear it from those entries first, or confirm the removal explicitly (allow_breaking).`
    case 'field_type_changed':
      return `Field "${change.field}" is still used by ${entries}; changing its type from "${change.from}" to "${change.to}" would invalidate that content. Migrate the values first, or confirm the change explicitly (allow_breaking).`
    case 'kind_changed':
      return `Changing the model kind from "${change.from}" to "${change.to}" would strand ${entries} stored under the current layout. Confirm explicitly (allow_breaking) only if that content is meant to be abandoned.`
    case 'i18n_changed':
      return `Changing i18n from ${change.from} to ${change.to} would strand ${entries} stored under the current locale layout. Confirm explicitly (allow_breaking) only if that content is meant to be abandoned.`
  }
}

/**
 * `title_field` must name a field of this model that can render as text —
 * the same rule MCP's validator and the model PATCH route apply, so a bad
 * pick is refused here with a message rather than inside a git write.
 * Absent is allowed: models predate the field and the readers fall back.
 */
export function validateTitleField(model: ModelDefinition): string | null {
  const titleField = model.title_field
  if (titleField === undefined || titleField === null || titleField === '') return null
  if (model.kind === 'dictionary') {
    return titleField === DICTIONARY_TITLE_FIELD ? null : `title_field must be "${DICTIONARY_TITLE_FIELD}" on a dictionary model`
  }
  const def = model.fields?.[titleField]
  if (!def) return `title_field "${titleField}" does not name a field of model "${model.id}"`
  if (!TITLE_FIELD_TYPES.includes(def.type)) return `title_field "${titleField}" has type "${def.type}", which cannot render as a title (needs one of ${TITLE_FIELD_TYPES.join(', ')})`
  return null
}
