/**
 * Longest-common-subsequence alignment over two token lists.
 *
 * Shared because two places need the same answer from the same algorithm: the
 * word-level diff of a markdown body, and the item-level diff of an array
 * field. The alternative — a second DP table written slightly differently —
 * is how a list and a paragraph end up disagreeing about what "changed" means.
 *
 * Dependency-free on purpose; the inputs are paragraphs and short lists, not
 * files.
 */

export type DiffKind = 'same' | 'added' | 'removed'

export interface DiffPart<T> {
  value: T
  kind: DiffKind
}

/**
 * Align `before` against `after` and return one merged sequence: shared items
 * in order, with removals and additions marked where they occur.
 *
 * Items are compared by the string `key` produces, so callers can align
 * objects by identity while carrying the original value through.
 */
export function lcsMerge<T>(
  before: readonly T[],
  after: readonly T[],
  key: (item: T) => string = item => String(item),
): Array<DiffPart<T>> {
  const a = before.map(key)
  const b = after.map(key)
  const cols = b.length + 1
  const lcs = new Uint32Array((a.length + 1) * cols)

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * cols + j] = a[i] === b[j]
        ? lcs[(i + 1) * cols + (j + 1)]! + 1
        : Math.max(lcs[(i + 1) * cols + j]!, lcs[i * cols + (j + 1)]!)
    }
  }

  const out: Array<DiffPart<T>> = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ value: after[j]!, kind: 'same' })
      i++
      j++
    }
    else if (lcs[(i + 1) * cols + j]! >= lcs[i * cols + (j + 1)]!) {
      out.push({ value: before[i]!, kind: 'removed' })
      i++
    }
    else {
      out.push({ value: after[j]!, kind: 'added' })
      j++
    }
  }
  while (i < a.length) out.push({ value: before[i++]!, kind: 'removed' })
  while (j < b.length) out.push({ value: after[j++]!, kind: 'added' })

  return out
}
