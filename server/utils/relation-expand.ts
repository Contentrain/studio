import type { FieldDef } from '@contentrain/types'

/**
 * Relation traversal for the `relation_expand` agent tool.
 *
 * Forward: resolve a target entry's own relation fields to the referenced
 *   entries (ref + human label).
 * Reverse: find entries (in any model) whose relation fields point AT the
 *   target entry — the "what links here" query that otherwise needs manual
 *   chained brain_query calls.
 *
 * Pure + framework-free (operates on normalized model views) so it can be
 * unit-tested in the fast node suite. Relation value decoding mirrors
 * `relation-integrity` / `app/utils/content-relations`.
 */

export interface ExpandModelView {
  modelId: string
  fields: Record<string, FieldDef>
  /** ref (collection id or document slug) → entry fields. */
  entries: Map<string, Record<string, unknown>>
}

export interface ResolvedRef {
  model: string
  ref: string
  label: string | null
}

/**
 * Normalize one model's brain content (any of the three shapes) into a
 * `ref → entry` map. Mirrors `app/utils/content-relations:toSelectableRefs`.
 */
export function brainRefEntries(data: unknown): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>()
  if (Array.isArray(data)) {
    for (const item of data) {
      if (!item || typeof item !== 'object') continue
      const o = item as Record<string, unknown>
      if (typeof o.slug === 'string') {
        const fm = (o.frontmatter && typeof o.frontmatter === 'object' ? o.frontmatter : o) as Record<string, unknown>
        map.set(o.slug, fm)
      }
      else {
        const id = (o.id ?? o.ID)
        if (typeof id === 'string') map.set(id, o)
      }
    }
  }
  else if (data !== null && typeof data === 'object') {
    for (const [ref, entry] of Object.entries(data as Record<string, unknown>)) {
      if (entry && typeof entry === 'object') map.set(ref, entry as Record<string, unknown>)
    }
  }
  return map
}

/** Pick a human-readable label for an entry. */
export function pickLabel(entry: Record<string, unknown> | undefined): string | null {
  if (!entry) return null
  for (const key of ['name', 'title', 'label', 'slug']) {
    const v = entry[key]
    if (typeof v === 'string' && v) return v
  }
  for (const v of Object.values(entry)) {
    if (typeof v === 'string' && v.length > 0 && v.length < 80) return v
  }
  return null
}

function decode(value: unknown, targets: string[]): { model?: string, ref: string } | null {
  if (value && typeof value === 'object' && 'ref' in (value as object)) {
    const o = value as { model?: string, ref?: unknown }
    return typeof o.ref === 'string' && o.ref ? { model: o.model, ref: o.ref } : null
  }
  if (typeof value === 'string' && value) {
    return { model: targets.length === 1 ? targets[0] : undefined, ref: value }
  }
  return null
}

function relationTargets(def: FieldDef): string[] {
  return Array.isArray(def.model) ? def.model : (def.model ? [def.model] : [])
}

/** Forward: resolve a target entry's relation fields to referenced entries. */
export function expandForward(
  target: ExpandModelView,
  entryRef: string,
  getView: (modelId: string) => ExpandModelView | undefined,
): Array<{ field: string, refs: ResolvedRef[] }> {
  const entry = target.entries.get(entryRef)
  if (!entry) return []
  const out: Array<{ field: string, refs: ResolvedRef[] }> = []

  for (const [fieldId, def] of Object.entries(target.fields)) {
    if (def.type !== 'relation' && def.type !== 'relations') continue
    const value = entry[fieldId]
    if (value === undefined || value === null || value === '') continue
    const targets = relationTargets(def)
    if (targets.length === 0) continue

    const items = Array.isArray(value) ? value : [value]
    const refs: ResolvedRef[] = []
    for (const item of items) {
      const decoded = decode(item, targets)
      if (!decoded) continue
      const candidateModels = decoded.model ? [decoded.model] : targets
      const model = candidateModels.find(m => getView(m)?.entries.has(decoded.ref)) ?? candidateModels[0]!
      refs.push({ model, ref: decoded.ref, label: pickLabel(getView(model)?.entries.get(decoded.ref)) })
    }
    if (refs.length > 0) out.push({ field: fieldId, refs })
  }
  return out
}

/**
 * Find entries (across views) that reference ANY entry of `targetModelId`.
 * Used to guard model deletion: deleting a model that other content points
 * at would orphan those relations project-wide. `targetRefs` is the set of
 * the target model's own refs (across locales), used to resolve bare refs in
 * fields with more than one candidate target.
 */
export function findInboundModelRefs(
  targetModelId: string,
  targetRefs: Set<string>,
  views: ExpandModelView[],
): Array<{ model: string, ref: string, field: string }> {
  const out: Array<{ model: string, ref: string, field: string }> = []
  for (const view of views) {
    if (view.modelId === targetModelId) continue
    for (const [fieldId, def] of Object.entries(view.fields)) {
      if (def.type !== 'relation' && def.type !== 'relations') continue
      const targets = relationTargets(def)
      if (!targets.includes(targetModelId)) continue
      for (const [ref, entry] of view.entries) {
        const value = entry[fieldId]
        if (value === undefined || value === null || value === '') continue
        const items = Array.isArray(value) ? value : [value]
        const hit = items.some((item) => {
          const decoded = decode(item, targets)
          if (!decoded) return false
          // Polymorphic compound → match by model; bare ref → resolves into
          // the target model only if the ref is one of its entries.
          return decoded.model ? decoded.model === targetModelId : targetRefs.has(decoded.ref)
        })
        if (hit) out.push({ model: view.modelId, ref, field: fieldId })
      }
    }
  }
  return out
}

/** Reverse: entries (across views) whose relation fields reference the target. */
export function expandReverse(
  targetModelId: string,
  entryRef: string,
  views: ExpandModelView[],
): Array<{ model: string, ref: string, field: string, label: string | null }> {
  const out: Array<{ model: string, ref: string, field: string, label: string | null }> = []

  for (const view of views) {
    for (const [fieldId, def] of Object.entries(view.fields)) {
      if (def.type !== 'relation' && def.type !== 'relations') continue
      const targets = relationTargets(def)
      if (!targets.includes(targetModelId)) continue

      for (const [ref, entry] of view.entries) {
        const value = entry[fieldId]
        if (value === undefined || value === null || value === '') continue
        const items = Array.isArray(value) ? value : [value]
        const hit = items.some((item) => {
          const decoded = decode(item, targets)
          if (!decoded || decoded.ref !== entryRef) return false
          // For polymorphic compounds, the model must match; bare refs match
          // only when this field targets the model unambiguously (single target).
          return decoded.model ? decoded.model === targetModelId : true
        })
        if (hit) out.push({ model: view.modelId, ref, field: fieldId, label: pickLabel(entry) })
      }
    }
  }
  return out
}
