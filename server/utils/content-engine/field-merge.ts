import type { FieldDef } from '@contentrain/types'

/**
 * Merge a partial entry update into the stored entry, field by field.
 *
 * save_content's contract is "send only what changed". That held for
 * top-level fields but not inside an `object` field: sending
 * `{ social_links: { instagram } }` replaced the whole object and dropped
 * every other network — and each later partial save dropped a different
 * one (#283). Object-typed fields now merge key by key, recursively through
 * nested object fields:
 *
 * - a sub-key set to `null` removes that key;
 * - arrays, and every non-object field type, are replaced as sent;
 * - a sub-key the schema doesn't declare is taken as sent.
 */
export function mergeEntryFields(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  fields: Record<string, FieldDef>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing }
  for (const [key, value] of Object.entries(incoming)) {
    const def = fields[key]
    merged[key] = def ? mergeFieldValue(existing[key], value, def) : value
  }
  return merged
}

function mergeFieldValue(existing: unknown, incoming: unknown, def: FieldDef): unknown {
  if (def.type !== 'object' || !isPlainObject(existing) || !isPlainObject(incoming)) return incoming

  // A sub-key sent as null is removed; the file is written canonically, so
  // rebuilding the object doesn't change key order on disk.
  const merged = Object.fromEntries(Object.entries(existing).filter(([key]) => incoming[key] !== null))
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null) continue
    const subDef = def.fields?.[key]
    merged[key] = subDef ? mergeFieldValue(existing[key], value, subDef) : value
  }
  return merged
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
