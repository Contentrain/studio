/**
 * Pure helpers for the content editor's relation + document-field handling.
 *
 * Kept framework-free (no Vue/Nuxt imports) so they can be unit-tested in the
 * fast node suite and shared between ContentEditModal and ContentFieldEditor.
 *
 * Relation storage shapes follow the Contentrain contract (@contentrain/mcp
 * validator): a relation/relations field whose `model` lists MORE THAN ONE
 * target is polymorphic and stores compound `{ model, ref }` values; a single
 * target stores a bare ref string (entry `id` for collections, `slug` for
 * documents).
 */

// Imported explicitly rather than relying on Nuxt's auto-import: this module is
// exercised by the plain node suite, which has no auto-imports.
import type { TitleFieldModel } from '~~/shared/utils/entry-title'
import { resolveTitleFieldId } from '~~/shared/utils/entry-title'

/** A relation reference as stored on disk. */
export type RelationRef = string | { model: string, ref: string }

/** A selectable option for a relation dropdown. */
export interface RelationOption {
  value: string
  label: string
}

/**
 * True when a relation field targets more than one model — its values are then
 * stored as `{ model, ref }` compounds rather than bare ref strings.
 */
export function isPolymorphicRelation(model: string | string[] | undefined): boolean {
  return Array.isArray(model) && model.length > 1
}

/**
 * Stored relation item → the option-value key used by the select and for label
 * lookup. Polymorphic compounds collapse to `"<model>::<ref>"`; bare refs pass
 * through unchanged.
 */
export function relationItemKey(item: unknown): string {
  if (item !== null && typeof item === 'object' && 'ref' in item) {
    const o = item as { model?: string, ref?: string }
    return `${o.model ?? ''}::${o.ref ?? ''}`
  }
  return String(item ?? '')
}

/**
 * Option-value key → stored relation item. Round-trips the polymorphic
 * encoding from {@link relationItemKey}; for non-polymorphic fields the key is
 * the ref itself.
 */
export function relationKeyToItem(key: string, polymorphic: boolean): RelationRef {
  if (!polymorphic) return key
  const sep = key.indexOf('::')
  return sep === -1 ? key : { model: key.slice(0, sep), ref: key.slice(sep + 2) }
}

/**
 * Normalize any model's content into selectable relation refs. Handles all three
 * shapes the brain can hold:
 * - collection object-map  `{ id: entry }`        → keyed by entry id
 * - collection array       `[{ id, ...fields }]`  → keyed by entry id
 * - document array         `[{ slug, frontmatter, body }]` → keyed by slug
 *
 * Singletons and dictionaries are never relation targets, so their shapes are
 * intentionally not produced here.
 */
export function toSelectableRefs(data: unknown): Array<{ ref: string, entry: Record<string, unknown> }> {
  const out: Array<{ ref: string, entry: Record<string, unknown> }> = []
  if (Array.isArray(data)) {
    for (const item of data as Array<Record<string, unknown>>) {
      if (!item || typeof item !== 'object') continue
      // Document entry: { slug, frontmatter, body }
      if (typeof item.slug === 'string' && item.frontmatter !== null && typeof item.frontmatter === 'object') {
        out.push({ ref: item.slug, entry: item.frontmatter as Record<string, unknown> })
      }
      else {
        // Collection-as-array: { id | ID, ...fields }
        const ref = (item.id as string) ?? (item.ID as string)
        if (ref) out.push({ ref, entry: item })
      }
    }
  }
  else if (data !== null && typeof data === 'object') {
    for (const [ref, entry] of Object.entries(data as Record<string, Record<string, unknown>>)) {
      if (entry !== null && typeof entry === 'object') out.push({ ref, entry })
    }
  }
  return out
}

/**
 * Pick a human-readable label for a relation target entry.
 *
 * When the target model is known, its declared `title_field` decides — the same
 * answer the entry list uses, so a hero slide's `ARTICLE` field names the
 * article instead of showing `f3a81c09d24e`. Without the model (the target is
 * not loaded, or predates the field) this falls back to the old key scan.
 */
export function findRelationLabel(
  entry: Record<string, unknown>,
  targetModel?: TitleFieldModel | null,
): string | null {
  const declared = targetModel ? resolveTitleFieldId(targetModel) : null
  if (declared) {
    const value = entry[declared]
    if (typeof value === 'string' && value) return value
  }

  for (const key of ['name', 'title', 'label', 'slug']) {
    if (typeof entry[key] === 'string' && entry[key]) return entry[key] as string
  }
  for (const value of Object.values(entry)) {
    if (typeof value === 'string' && value.length > 0 && value.length < 80) return value
  }
  return null
}

/**
 * Build the relation dropdown options for one target model. Polymorphic fields
 * encode the target model into the value (so it round-trips to `{ model, ref }`)
 * and prefix the label to disambiguate across models.
 */
export function buildRelationOptions(
  targetModelId: string,
  data: unknown,
  polymorphic: boolean,
  targetModel?: TitleFieldModel | null,
): RelationOption[] {
  return toSelectableRefs(data).map(({ ref, entry }) => {
    const label = findRelationLabel(entry, targetModel) ?? ref.substring(0, 8)
    return {
      value: polymorphic ? `${targetModelId}::${ref}` : ref,
      label: polymorphic ? `${targetModelId}: ${label}` : label,
    }
  })
}

/**
 * Infer an editor field type for a document frontmatter key the model schema
 * does not describe (so it still renders an appropriate input rather than being
 * dropped from the form).
 */
export function inferFieldType(value: unknown): string {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (Array.isArray(value)) return 'array'
  if (value !== null && typeof value === 'object') return 'object'
  return 'string'
}
