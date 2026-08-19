/**
 * What a field is called, and in what order fields are read.
 *
 * `@contentrain/types` has carried `FieldDef.label` and `FieldDef.order` since
 * 1.x and Studio used neither: the editor labelled inputs with the raw field id
 * and listed them alphabetically, so a 16-field article model opened with
 * `author` first, `title` fifteenth, and a checkbox labelled `is_category_hero`.
 *
 * Both answers live here so the editor, the content views, the filter axes and
 * the review panel cannot disagree about them — the review panel is served the
 * label the server resolved with this same function.
 */
import type { FieldDef } from '@contentrain/types'
import { orderedFieldNames, resolveFieldLabel } from '@contentrain/types'

/**
 * A field id turned into something readable: `body_public` → `Body public`.
 *
 * The last resort, for a field whose model declares no label. It is wrong for
 * ids that are not words — a dictionary's keys are `branch.reject`, not a name
 * — which is why callers opt out for those.
 */
export function humanizeFieldId(fieldId: string): string {
  const spaced = fieldId.replace(/[_-]+/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export interface FieldLabelOptions {
  locale?: string
  defaultLocale?: string
  /**
   * Fall back to a humanised id when the model declares no label. True by
   * default; pass false where the id is an identifier rather than a name (a
   * dictionary key, a machine-generated field).
   */
  humanize?: boolean
}

/**
 * A field's display label: what the model declares for this locale, else a
 * humanised form of its id, else the id itself.
 */
export function fieldLabel(
  fieldId: string,
  def: FieldDef | undefined | null,
  options: FieldLabelOptions = {},
): string {
  const { locale, defaultLocale, humanize = true } = options
  // `resolveFieldLabel` returns the field name when nothing is declared, which
  // is how we tell "declared" from "absent" without re-reading `def.label`.
  const declared = resolveFieldLabel(fieldId, def ?? {}, locale, defaultLocale)
  if (declared !== fieldId) return declared
  return humanize ? humanizeFieldId(fieldId) : fieldId
}

/**
 * Field ids in display order — ascending `FieldDef.order`, then alphabetically
 * among the fields that declare none. Tolerates the loosely-typed field maps
 * the brain snapshot hands the app.
 */
export function orderedFieldIds(fields: Record<string, unknown> | null | undefined): string[] {
  if (!fields) return []
  return orderedFieldNames(fields as Record<string, FieldDef>)
}
