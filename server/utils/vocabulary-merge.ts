/**
 * Vocabulary patch semantics, kept pure so the concurrency behaviour that
 * caused terms to vanish is unit-testable without a git provider.
 */

export interface Vocabulary {
  version: number
  terms: Record<string, Record<string, string>>
}

/** `null` deletes the term; an object merges into it per locale. */
export type TermPatch = Record<string, Record<string, string> | null>

/** Apply a patch to a snapshot, leaving untouched terms alone. */
export function applyVocabularyPatch(current: Vocabulary, patch: TermPatch): Vocabulary {
  const terms: Record<string, Record<string, string>> = {}

  for (const [key, existing] of Object.entries(current.terms ?? {})) {
    if (!(key in patch) || patch[key] !== null) terms[key] = existing
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null) terms[key] = { ...(terms[key] ?? {}), ...value }
  }

  return { ...current, version: current.version ?? 1, terms }
}

/**
 * Did the caller's patch survive the merge?
 *
 * Checks intent rather than byte equality: a concurrent writer adding a
 * different term is a perfectly good outcome and must not be treated as a
 * failure. Only the keys this caller asked to change are inspected.
 */
export function vocabularyPatchSatisfied(vocabulary: Vocabulary, patch: TermPatch): boolean {
  for (const [key, value] of Object.entries(patch)) {
    const landed = vocabulary.terms?.[key]

    if (value === null) {
      if (landed !== undefined) return false
      continue
    }

    if (!landed) return false
    for (const [locale, text] of Object.entries(value)) {
      if (landed[locale] !== text) return false
    }
  }
  return true
}
