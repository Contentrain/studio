import type { FieldDef } from '@contentrain/types'

/**
 * Server-side relation referential integrity for the agent write path.
 *
 * Structural validation (`@contentrain/mcp` validator) checks a relation
 * value's SHAPE (bare ref vs `{ model, ref }`, polymorphic target in the
 * allowed set) but not whether the referenced entry EXISTS. The UI prevents
 * dangling refs with a constrained dropdown built from the Content Brain;
 * this gives the agent the same guarantee by checking refs against the brain
 * before a save lands.
 *
 * Pure + framework-free so it can be unit-tested in the fast node suite. The
 * brain-content normalization mirrors `app/utils/content-relations:toSelectableRefs`
 * (collection object-map → ids, collection/document array → id/slug).
 */

/** Collect the set of valid refs (collection ids or document slugs) from one
 * model's brain content, across all three shapes the brain can hold. */
export function brainContentRefs(data: unknown): Set<string> {
  const refs = new Set<string>()
  if (Array.isArray(data)) {
    for (const item of data) {
      if (!item || typeof item !== 'object') continue
      const o = item as Record<string, unknown>
      if (typeof o.slug === 'string') refs.add(o.slug)
      else {
        const id = (o.id ?? o.ID)
        if (typeof id === 'string') refs.add(id)
      }
    }
  }
  else if (data !== null && typeof data === 'object') {
    for (const key of Object.keys(data as Record<string, unknown>)) refs.add(key)
  }
  return refs
}

/** Normalize one stored relation value into `{ model?, ref }`. */
function decodeRelationValue(value: unknown, targets: string[]): { model?: string, ref: string } | null {
  if (value && typeof value === 'object' && 'ref' in (value as object)) {
    const o = value as { model?: string, ref?: unknown }
    return typeof o.ref === 'string' && o.ref ? { model: o.model, ref: o.ref } : null
  }
  if (typeof value === 'string' && value) {
    // Bare ref: the target model is unambiguous only when there's one target.
    return { model: targets.length === 1 ? targets[0] : undefined, ref: value }
  }
  return null
}

/**
 * Find relation values on `entry` that point at a non-existent target.
 * `getRefs(modelId)` returns the valid ref set for a target model (from the
 * brain). Returns human-readable error strings (empty = all relations valid).
 */
export function findBrokenRelations(
  entry: Record<string, unknown>,
  fields: Record<string, FieldDef>,
  getRefs: (modelId: string) => Set<string>,
): string[] {
  const errors: string[] = []
  for (const [fieldId, def] of Object.entries(fields)) {
    if (def.type !== 'relation' && def.type !== 'relations') continue
    const value = entry[fieldId]
    if (value === undefined || value === null || value === '') continue

    const targets = Array.isArray(def.model) ? def.model : (def.model ? [def.model] : [])
    if (targets.length === 0) continue

    const items = Array.isArray(value) ? value : [value]
    for (const item of items) {
      const decoded = decodeRelationValue(item, targets)
      if (!decoded) continue
      // Unknown model (bare ref into a polymorphic field): accept if the ref
      // exists in ANY allowed target — don't over-reject on ambiguity.
      const candidateModels = decoded.model ? [decoded.model] : targets
      const exists = candidateModels.some(m => getRefs(m).has(decoded.ref))
      if (!exists) {
        errors.push(
          `Field "${fieldId}": relation target "${decoded.ref}"`
          + `${decoded.model ? ` in model "${decoded.model}"` : ''} does not exist`,
        )
      }
    }
  }
  return errors
}
