/**
 * How a media field value is presented in the read-only content views.
 *
 * Split out of `ContentFieldDisplay.vue` because these are decisions about a
 * string, not about the DOM, and a table of inputs is a better description of
 * them than a mounted component.
 */

const STORED_ASSET = /^media\//
const ABSOLUTE_URL = /^(?:https?:)?\/\//
const UUID_STEM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A value Studio itself stored, and can therefore be held responsible for. */
export function isStoredAssetPath(value: string): boolean {
  return STORED_ASSET.test(value)
}

/**
 * Whether the browser could fetch this at all. A project-specific reference is
 * reported as what it is rather than turned into a 404 and a broken thumbnail —
 * the two used to be indistinguishable, and only one of them is an error.
 */
export function canRenderMediaValue(value: string): boolean {
  return isStoredAssetPath(value) || ABSOLUTE_URL.test(value) || value.startsWith('/')
}

/**
 * `8d2ed576-57e5-4cab-8f57-bfe52d56ddff.webp` is not a name: it takes the whole
 * row and tells the editor nothing. A storage UUID collapses to its kind plus
 * enough of the id to tell two rows apart; a real filename is left alone,
 * because a real filename is the best label there is.
 */
export function readableMediaName(value: string): string {
  const base = (value.split(/[?#]/)[0] ?? value).split('/').pop() || value
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot + 1) : ''
  if (!UUID_STEM.test(stem)) return base
  return ext ? `${ext.toUpperCase()} · ${stem.slice(0, 8)}` : stem.slice(0, 8)
}
