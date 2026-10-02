/**
 * The branch is no longer at the commit that was approved. What was reviewed
 * is not what would land, so nothing lands — the new tip goes back to review.
 */
export class BranchMovedError extends Error {
  readonly code = 'branch_moved'
  constructor(readonly branch: string, readonly expected: string, readonly actual: string | null) {
    super(`${branch} moved from ${expected} to ${actual ?? 'nowhere'} after it was approved`)
  }
}

/** By code, not `instanceof`: the class may come from another module instance. */
export function isBranchMoved(e: unknown): e is BranchMovedError {
  return (e as { code?: unknown } | null)?.code === 'branch_moved'
}
