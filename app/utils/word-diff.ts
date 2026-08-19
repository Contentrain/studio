/**
 * Word-level diff for long text values.
 *
 * A review that shows a 2,000-character markdown body struck through next to
 * an almost identical 2,000-character body has told the reader nothing — worse,
 * with the old 120-character clipping it read as "unchanged" whenever the edit
 * was past the clip. This marks the words that actually moved.
 *
 * Kept dependency-free and framework-free: the whole algorithm is a common
 * prefix/suffix trim followed by an LCS over what is left, which is the shape
 * real edits have (a sentence changed inside a paragraph that did not).
 */

export type WordDiffKind = 'same' | 'added' | 'removed'

export interface WordDiffPart {
  value: string
  kind: WordDiffKind
}

export interface WordDiffResult {
  before: WordDiffPart[]
  after: WordDiffPart[]
  /** The texts were too far apart to align; each side is one whole part. */
  coarse: boolean
}

/**
 * Above this many differing tokens on either side, the quadratic alignment is
 * not worth its cost — and the result would be confetti rather than a diff, so
 * the differing region is reported whole.
 */
const MAX_ALIGNED_TOKENS = 400

/** Split into words while keeping the whitespace, so output reassembles exactly. */
function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? []
}

function push(parts: WordDiffPart[], kind: WordDiffKind, value: string): void {
  if (!value) return
  const last = parts[parts.length - 1]
  if (last && last.kind === kind) last.value += value
  else parts.push({ kind, value })
}

export function wordDiff(beforeText: string, afterText: string): WordDiffResult {
  const before: WordDiffPart[] = []
  const after: WordDiffPart[] = []

  if (beforeText === afterText) {
    push(before, 'same', beforeText)
    push(after, 'same', afterText)
    return { before, after, coarse: false }
  }

  const a = tokenize(beforeText)
  const b = tokenize(afterText)

  // Trim what both sides share at each end. For an edit inside a long body
  // this is nearly all of it, and it is what keeps the alignment small.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head
    && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++

  const prefix = a.slice(0, head).join('')
  const suffix = a.slice(a.length - tail).join('')
  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)

  push(before, 'same', prefix)
  push(after, 'same', prefix)

  if (midA.length > MAX_ALIGNED_TOKENS || midB.length > MAX_ALIGNED_TOKENS) {
    push(before, 'removed', midA.join(''))
    push(after, 'added', midB.join(''))
    push(before, 'same', suffix)
    push(after, 'same', suffix)
    return { before, after, coarse: true }
  }

  // Classic LCS table over the differing middle.
  const rows = midA.length + 1
  const cols = midB.length + 1
  const lcs = new Uint32Array(rows * cols)
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      lcs[i * cols + j] = midA[i] === midB[j]
        ? lcs[(i + 1) * cols + (j + 1)]! + 1
        : Math.max(lcs[(i + 1) * cols + j]!, lcs[i * cols + (j + 1)]!)
    }
  }

  let i = 0
  let j = 0
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      push(before, 'same', midA[i]!)
      push(after, 'same', midB[j]!)
      i++
      j++
    }
    else if (lcs[(i + 1) * cols + j]! >= lcs[i * cols + (j + 1)]!) {
      push(before, 'removed', midA[i]!)
      i++
    }
    else {
      push(after, 'added', midB[j]!)
      j++
    }
  }
  while (i < midA.length) push(before, 'removed', midA[i++]!)
  while (j < midB.length) push(after, 'added', midB[j++]!)

  push(before, 'same', suffix)
  push(after, 'same', suffix)

  return { before, after, coarse: false }
}
