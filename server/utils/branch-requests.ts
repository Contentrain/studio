/**
 * Best-effort cleanup of a branch's "changes requested" row once the branch
 * is merged or rejected. Never throws — the merge/reject already happened,
 * and a provider double without the method (older tests, partial mocks)
 * must not turn that into a failure.
 */
export function clearBranchRequestSafe(projectId: string, branch: string): void {
  try {
    const db = useDatabaseProvider() as { clearBranchChangeRequest?: (projectId: string, branch: string) => Promise<void> }
    db.clearBranchChangeRequest?.(projectId, branch)?.catch(() => {})
  }
  catch {
    // ignore
  }
}
