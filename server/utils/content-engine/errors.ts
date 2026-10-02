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

/**
 * The branch tip could not be read, so an approved merge cannot be pinned to
 * the approved commit. Nothing lands: merging by name would land whatever the
 * branch points at now.
 */
export class BranchTipUnreadableError extends Error {
  readonly code = 'branch_tip_unreadable'
  constructor(readonly branch: string, options?: { cause?: unknown }) {
    super(`could not read the tip of ${branch}; the approved merge is not pinned`, options)
  }
}

export function isBranchTipUnreadable(e: unknown): e is BranchTipUnreadableError {
  return (e as { code?: unknown } | null)?.code === 'branch_tip_unreadable'
}
