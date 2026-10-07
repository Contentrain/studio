/**
 * Searching the entries a relation field can point at.
 *
 * Framework-free so the fast node suite exercises it. The picker filters on the
 * label an editor reads (the target's `title_field`, nested dotted paths
 * included) and on the id or slug they may paste from elsewhere, ignoring case
 * and diacritics — `istanbul` finds `İstanbul`, `sehir` finds `Şehir`.
 */

/** One entry a relation field can point at. */
export interface RelationPickerOption {
  /** What is stored: the ref, or `model::ref` for a polymorphic relation. */
  value: string
  /** What chips and read views print. Polymorphic labels are prefixed `model: `. */
  label: string
  /** Polymorphic only: the target model's id. */
  group?: string
  /** Polymorphic only: the model's display name. */
  groupLabel?: string
  /** Polymorphic only: the label without the model prefix (the group heading says it). */
  text?: string
}

/** The part of `value` an editor knows as the entry's id or slug. */
export function relationOptionRef(option: Pick<RelationPickerOption, 'value' | 'group'>): string {
  if (!option.group) return option.value
  const prefix = `${option.group}::`
  return option.value.startsWith(prefix) ? option.value.slice(prefix.length) : option.value
}

/**
 * Lowercase, drop diacritics, fold the dotless/dotted Turkish i, and collapse
 * whitespace. `String#toLowerCase` is locale-independent here on purpose: the
 * result is only ever compared with itself.
 */
export function normalizeSearchText(input: string): string {
  return input
    .replaceAll('ı', 'i')
    .toLowerCase()
    .normalize('NFD')
    .replaceAll(/\p{M}+/gu, '')
    .replaceAll('ß', 'ss')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

export interface RelationSearchResult {
  /** At most `limit` matches, in the options' own order. */
  items: RelationPickerOption[]
  /** How many options matched in all (≥ items.length). */
  total: number
}

/**
 * Every whitespace-separated term of the query must appear in the entry's label,
 * id/slug or model name. An empty query matches everything.
 */
export function filterRelationOptions(options: readonly RelationPickerOption[], query: string, limit = 100): RelationSearchResult {
  const terms = normalizeSearchText(query).split(' ').filter(Boolean)
  const items: RelationPickerOption[] = []
  let total = 0
  for (const option of options) {
    if (terms.length > 0) {
      const haystack = normalizeSearchText(`${option.text ?? option.label} ${relationOptionRef(option)} ${option.groupLabel ?? ''} ${option.group ?? ''}`)
      if (!terms.every(term => haystack.includes(term))) continue
    }
    total++
    if (items.length < limit) items.push(option)
  }
  return { items, total }
}

export interface RelationOptionGroup {
  key: string
  label: string
  items: RelationPickerOption[]
}

/**
 * Group matches by target model for a polymorphic relation, keeping the order
 * models first appear in. A plain relation has one unnamed group.
 */
export function groupRelationOptions(items: readonly RelationPickerOption[]): RelationOptionGroup[] {
  const groups = new Map<string, RelationOptionGroup>()
  for (const item of items) {
    const key = item.group ?? ''
    let group = groups.get(key)
    if (!group) {
      group = { key, label: item.groupLabel ?? item.group ?? '', items: [] }
      groups.set(key, group)
    }
    group.items.push(item)
  }
  return [...groups.values()]
}
