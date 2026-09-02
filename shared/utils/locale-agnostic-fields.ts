/**
 * Field types whose value carries no language.
 *
 * A media field holds a delivery URL; a relation holds an entry ref. Neither
 * has a Turkish and an English version, yet on an `i18n: true` model the
 * editor scoped them per locale like prose: an editor swapped a hero image
 * with `en` selected, the site rendered `tr`, and nothing changed. The schema
 * has no `localized` flag yet, so the type decides — these fields are written
 * to every locale of the model, and the editor says so beside them.
 */
export const LOCALE_AGNOSTIC_FIELD_TYPES: readonly string[] = ['image', 'video', 'file', 'relation', 'relations']

export function isLocaleAgnosticField(def: { type?: string } | null | undefined): boolean {
  return !!def?.type && LOCALE_AGNOSTIC_FIELD_TYPES.includes(def.type)
}

/** The ids of a model's locale-agnostic fields, in the model's own order. */
export function localeAgnosticFieldIds(fields: Record<string, { type?: string } | null | undefined> | null | undefined): string[] {
  if (!fields) return []
  return Object.keys(fields).filter(id => isLocaleAgnosticField(fields[id]))
}
