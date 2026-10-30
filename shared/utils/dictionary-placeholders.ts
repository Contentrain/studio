/**
 * `{name}` placeholders in a dictionary value — the tokens `useContent().t()`
 * (and `@contentrain/query` readers) substitute. A value that loses one still
 * saves; the reader then prints the literal key's text without the number or
 * name it was meant to carry, which is why the editor warns about it.
 */
const PLACEHOLDER = /\{(\w+)\}/g

export function placeholdersOf(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return [...new Set([...value.matchAll(PLACEHOLDER)].map(m => m[1]!))]
}

export interface PlaceholderDrift {
  /** In the value before this edit, gone from the new one. */
  dropped: string[]
  /** Differ from the same key in the reference (default) locale, either way. */
  mismatched: string[]
}

/**
 * How a new value's placeholders differ from its own saved value and from the
 * reference locale's value for the same key. Empty lists mean nothing to say;
 * an absent reference skips the second check.
 */
export function placeholderDrift(before: unknown, after: unknown, reference?: unknown): PlaceholderDrift {
  const now = new Set(placeholdersOf(after))
  const dropped = placeholdersOf(before).filter(name => !now.has(name))
  if (typeof reference !== 'string') return { dropped, mismatched: [] }
  const ref = new Set(placeholdersOf(reference))
  const mismatched = [...new Set([...ref, ...now])].filter(name => ref.has(name) !== now.has(name)).sort()
  return { dropped, mismatched }
}
