/**
 * Word-level diff for long text values.
 *
 * A review that shows a 2,000-character markdown body struck through next to
 * an almost identical 2,000-character body has told the reader nothing — worse,
 * with the old 120-character clipping it read as "unchanged" whenever the edit
 * was past the clip. This marks the words that actually moved.
 *
 * The alignment itself is `lcsMerge`, shared with the array-field diff so a
 * paragraph and a list cannot disagree about what "changed" means. What lives
 * here is what is specific to prose: tokenising while keeping whitespace, the
 * common prefix/suffix trim that keeps the alignment small, and the decision
 * to stop aligning when two texts share almost nothing.
 */
import type { DiffKind } from './lcs'
import { lcsMerge } from './lcs'

export type WordDiffKind = DiffKind

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

  for (const part of lcsMerge(midA, midB)) {
    if (part.kind === 'removed') push(before, 'removed', part.value)
    else if (part.kind === 'added') push(after, 'added', part.value)
    else {
      push(before, 'same', part.value)
      push(after, 'same', part.value)
    }
  }

  push(before, 'same', suffix)
  push(after, 'same', suffix)

  return { before, after, coarse: false }
}
