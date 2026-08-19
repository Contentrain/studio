import type { FieldDef } from '@contentrain/types'
import type { TitleFieldModel } from '~~/shared/utils/entry-title'
import { resolveEntryTitle } from '~~/shared/utils/entry-title'
import { fieldLabel } from '~~/shared/utils/field-label'

/**
 * Filtering and sorting a collection listing.
 *
 * The axes are derived from the model at runtime rather than configured: a
 * model with two `select` fields gets two axes, a model with none gets only
 * status. Deriving means nothing has to be kept in step by hand, and a model
 * that gains a field gains a filter.
 *
 * Kept pure and framework-free so the rules are described by a table of inputs
 * rather than by a mounted component.
 */

export type FilterAxisKind = 'status' | 'select' | 'boolean' | 'relation'

export interface FilterOption {
  value: string
  label: string
}

export interface FilterAxis {
  kind: FilterAxisKind
  /** Field id, or the reserved `__status__`. */
  id: string
  label: string
  options: FilterOption[]
}

/** Not a field name — status lives in entry meta, not in the schema. */
export const STATUS_AXIS_ID = '__status__'

/** Values a boolean axis offers. Absent from the map means "either". */
export const BOOLEAN_TRUE = 'true'
export const BOOLEAN_FALSE = 'false'

/** Selected values per axis id. An axis absent from the map is unfiltered. */
export type FilterSelection = Record<string, string[]>

export interface EntryMetaLike {
  status?: string
  updated_at?: string
}

export interface DeriveAxesInput {
  model: TitleFieldModel | null | undefined
  content: Record<string, Record<string, unknown>>
  meta?: Record<string, EntryMetaLike> | null
  /** Human labels for relation targets, keyed by field id then by ref. */
  relationLabels?: Record<string, Record<string, string>>
  /** Translates a status value and the reserved axis labels. */
  t: (key: string) => string
}

function fieldEntries(model: DeriveAxesInput['model']): [string, FieldDef][] {
  if (!model?.fields) return []
  return Object.entries(model.fields as Record<string, FieldDef>)
}

/**
 * Build the filter axes this model can offer.
 *
 * Status comes first and is always present — it needs no schema. Every other
 * axis appears only when the model actually has a field for it, so a model
 * without one shows a shorter list rather than an empty control.
 *
 * An axis with fewer than two options is dropped: filtering a column where
 * every row has the same value is a control that can only ever do nothing.
 */
export function deriveFilterAxes(input: DeriveAxesInput): FilterAxis[] {
  const { model, content, meta, relationLabels, t } = input
  const axes: FilterAxis[] = []

  // ── Status, from entry meta ───────────────────────────────
  // Derived from what is present rather than from a fixed list, so a project
  // that never archives anything is not offered an empty filter.
  const statuses = new Set<string>()
  for (const id of Object.keys(content)) {
    statuses.add(meta?.[id]?.status ?? 'draft')
  }
  if (statuses.size > 1) {
    axes.push({
      kind: 'status',
      id: STATUS_AXIS_ID,
      label: t('content.filter_status'),
      options: [...statuses].sort().map(value => ({
        value,
        label: t(`content.status_${value}`),
      })),
    })
  }

  for (const [fieldId, def] of fieldEntries(model)) {
    const label = fieldLabel(fieldId, def)

    if (def?.type === 'select' && Array.isArray(def.options) && def.options.length > 1) {
      // Straight from the schema — the cheapest and most reliable axis there
      // is, because nothing has to be inferred from the data.
      axes.push({
        kind: 'select',
        id: fieldId,
        label,
        options: (def.options as string[]).map(value => ({ value, label: value })),
      })
      continue
    }

    if (def?.type === 'boolean') {
      axes.push({
        kind: 'boolean',
        id: fieldId,
        label,
        options: [
          { value: BOOLEAN_TRUE, label: t('common.yes') },
          { value: BOOLEAN_FALSE, label: t('common.no') },
        ],
      })
      continue
    }

    if (def?.type === 'relation' || def?.type === 'relations') {
      // Labels are resolved by the caller through the target model's
      // `title_field`; without them this axis would list `f3a81c09d24e`.
      const labels = relationLabels?.[fieldId]
      if (!labels) continue
      const refs = new Set<string>()
      for (const entry of Object.values(content)) {
        for (const ref of relationRefs(entry?.[fieldId])) refs.add(ref)
      }
      if (refs.size < 2) continue
      axes.push({
        kind: 'relation',
        id: fieldId,
        label,
        options: [...refs]
          .map(ref => ({ value: ref, label: labels[ref] ?? ref }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      })
    }
  }

  return axes
}

/** Every ref a relation/relations value points at, in either storage shape. */
export function relationRefs(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : []
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const ref = (value as { ref?: unknown }).ref
    return typeof ref === 'string' && ref ? [ref] : []
  }
  if (Array.isArray(value)) return value.flatMap(relationRefs)
  return []
}

function matchesAxis(
  axis: FilterAxis,
  selected: string[],
  entry: Record<string, unknown> | undefined,
  entryMeta: EntryMetaLike | undefined,
): boolean {
  if (selected.length === 0) return true

  switch (axis.kind) {
    case 'status':
      return selected.includes(entryMeta?.status ?? 'draft')
    case 'select': {
      const value = entry?.[axis.id]
      return typeof value === 'string' && selected.includes(value)
    }
    case 'boolean': {
      const value = entry?.[axis.id]
      return selected.includes(value ? BOOLEAN_TRUE : BOOLEAN_FALSE)
    }
    case 'relation': {
      const refs = relationRefs(entry?.[axis.id])
      return refs.some(ref => selected.includes(ref))
    }
  }
}

/**
 * Narrow a list of ids by the current selection.
 *
 * Values within one axis are OR'd, axes are AND'd — the usual reading of
 * "category is ai or cdn, and status is published".
 */
export function applyFilters(
  ids: readonly string[],
  content: Record<string, Record<string, unknown>>,
  meta: Record<string, EntryMetaLike> | null | undefined,
  axes: readonly FilterAxis[],
  selection: FilterSelection,
): string[] {
  const active = axes.filter(axis => (selection[axis.id]?.length ?? 0) > 0)
  if (active.length === 0) return [...ids]

  return ids.filter(id =>
    active.every(axis => matchesAxis(axis, selection[axis.id] ?? [], content[id], meta?.[id])),
  )
}

export interface SortOption {
  /** `<field>:<asc|desc>`, or one of the reserved keys below. */
  value: string
  label: string
}

export const SORT_DEFAULT = 'default'
export const SORT_TITLE_ASC = 'title:asc'
export const SORT_TITLE_DESC = 'title:desc'
export const SORT_STATUS = 'status:asc'
export const SORT_UPDATED_DESC = 'updated:desc'

/** Field types worth ordering by. */
const ORDERABLE = new Set(['number', 'integer', 'decimal', 'percent', 'rating', 'date', 'datetime'])

export interface DeriveSortInput {
  model: TitleFieldModel | null | undefined
  meta?: Record<string, EntryMetaLike> | null
  hasStatusAxis: boolean
  t: (key: string, params?: Record<string, string | number>) => string
}

/**
 * Sort criteria this model can offer.
 *
 * "Recently updated" appears only when the data can answer it. `updated_at`
 * arrived with `@contentrain/types@1.0.0` and is deliberately not backfilled,
 * so a project whose entries all predate it would get a criterion that sorts
 * nothing — worse than not offering it.
 */
export function deriveSortOptions(input: DeriveSortInput): SortOption[] {
  const { model, meta, hasStatusAxis, t } = input

  const options: SortOption[] = [
    { value: SORT_DEFAULT, label: t('content.sort_default') },
    { value: SORT_TITLE_ASC, label: t('content.sort_title_asc') },
    { value: SORT_TITLE_DESC, label: t('content.sort_title_desc') },
  ]

  if (hasStatusAxis) options.push({ value: SORT_STATUS, label: t('content.filter_status') })

  const anyUpdatedAt = Object.values(meta ?? {}).some(m => !!m?.updated_at)
  if (anyUpdatedAt) options.push({ value: SORT_UPDATED_DESC, label: t('content.sort_updated') })

  for (const [fieldId, def] of fieldEntries(model)) {
    if (!ORDERABLE.has(def?.type ?? '')) continue
    const name = fieldLabel(fieldId, def)
    options.push({ value: `${fieldId}:asc`, label: t('content.sort_field_asc', { field: name }) })
    options.push({ value: `${fieldId}:desc`, label: t('content.sort_field_desc', { field: name }) })
  }

  return options
}

const STATUS_ORDER: Record<string, number> = { published: 0, draft: 1, archived: 2 }

function compareValues(a: unknown, b: unknown): number {
  const aMissing = a === null || a === undefined || a === ''
  const bMissing = b === null || b === undefined || b === ''
  // Missing sorts last in either direction: "unknown" is not a small value.
  if (aMissing && bMissing) return 0
  if (aMissing) return 1
  if (bMissing) return -1

  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

/**
 * Order ids by a criterion. Applied after filtering, so it only ever orders
 * what survived.
 *
 * `default` keeps the order the file gives, which is the order every other part
 * of Studio shows — an explicit choice to leave alone, not an absence of one.
 */
export function sortIds(
  ids: readonly string[],
  content: Record<string, Record<string, unknown>>,
  meta: Record<string, EntryMetaLike> | null | undefined,
  sort: string,
  model: TitleFieldModel | null | undefined,
): string[] {
  if (!sort || sort === SORT_DEFAULT) return [...ids]

  const titled = (id: string) => resolveEntryTitle(content[id], model, id)

  if (sort === SORT_TITLE_ASC || sort === SORT_TITLE_DESC) {
    const dir = sort === SORT_TITLE_ASC ? 1 : -1
    return [...ids].sort((a, b) => dir * titled(a).localeCompare(titled(b), undefined, { numeric: true }))
  }

  if (sort === SORT_STATUS) {
    return [...ids].sort((a, b) => {
      const sa = STATUS_ORDER[meta?.[a]?.status ?? 'draft'] ?? 99
      const sb = STATUS_ORDER[meta?.[b]?.status ?? 'draft'] ?? 99
      return sa - sb || titled(a).localeCompare(titled(b))
    })
  }

  if (sort === SORT_UPDATED_DESC) {
    // Entries written before `updated_at` existed have no recoverable value, so
    // they sort last rather than being given a fabricated one.
    //
    // Written out rather than reusing `compareValues` with its arguments
    // swapped: swapping reverses the missing-last rule along with everything
    // else, which put "never written" at the top of "most recently written".
    return [...ids].sort((a, b) => {
      const av = meta?.[a]?.updated_at
      const bv = meta?.[b]?.updated_at
      if (!av && !bv) return 0
      if (!av) return 1
      if (!bv) return -1
      return bv.localeCompare(av)
    })
  }

  const [fieldId, direction] = sort.split(':')
  if (!fieldId) return [...ids]
  const dir = direction === 'desc' ? -1 : 1

  return [...ids].sort((a, b) => {
    const av = content[a]?.[fieldId]
    const bv = content[b]?.[fieldId]
    const aMissing = av === null || av === undefined || av === ''
    const bMissing = bv === null || bv === undefined || bv === ''
    // A missing value stays last whichever way the rest is ordered — reversing
    // the sort should not promote "unknown" to the top.
    if (aMissing && bMissing) return 0
    if (aMissing) return 1
    if (bMissing) return -1
    return dir * compareValues(av, bv)
  })
}
