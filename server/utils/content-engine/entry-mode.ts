import type { ValidationError } from '@contentrain/types'

/**
 * What a save means to do with each entry it names.
 *
 * - `create`: every entry must be new in this locale. An id (or document
 *   slug) that already exists is refused — never merged into.
 * - `update`: every entry must already exist in this locale. A missing one is
 *   refused, instead of being created from a partial payload.
 * - absent: the legacy upsert, kept for the manual content route and older
 *   callers that don't state an intent.
 *
 * The agent picks ids for new entries itself, and a "new" article once
 * reused the id of a different published one: the save upserted, the old
 * article was overwritten, and nothing said so (#298). A partial update sent
 * to a locale the entry didn't exist in likewise became a create with
 * placeholder text. Both are refused here, next to slug uniqueness, so a
 * create and an update can no longer be confused without an error.
 */
export type EntryWriteMode = 'create' | 'update'

export function isEntryWriteMode(value: unknown): value is EntryWriteMode {
  return value === 'create' || value === 'update'
}

export function entryModeErrors(
  mode: EntryWriteMode | undefined,
  entryIds: string[],
  exists: (entryId: string) => boolean,
  where: { model: string, locale: string },
): ValidationError[] {
  if (!mode) return []
  const errors: ValidationError[] = []
  for (const entryId of entryIds) {
    const present = exists(entryId)
    if (mode === 'create' && present) {
      errors.push({
        severity: 'error',
        ...where,
        entry: entryId,
        message: `An entry with this id already exists in ${where.locale}. To change it, save with mode "update"; to add a new entry, use a new id.`,
      })
    }
    if (mode === 'update' && !present) {
      errors.push({
        severity: 'error',
        ...where,
        entry: entryId,
        message: `No entry with this id exists in ${where.locale}. Read the entry's id first, or save with mode "create" to add it.`,
      })
    }
  }
  return errors
}

/** Which of the named entries this save creates and which it updates. */
export function partitionEntries(
  entryIds: string[],
  exists: (entryId: string) => boolean,
): { created: string[], updated: string[] } {
  const created: string[] = []
  const updated: string[] = []
  for (const entryId of entryIds) (exists(entryId) ? updated : created).push(entryId)
  return { created, updated }
}
