/**
 * Best-effort access to a branch's "changes requested" state.
 *
 * Read paths (branch list, review payload) must render without it, and the
 * cleanup after a merge/reject must never fail the operation that already
 * happened — so every helper here swallows a missing method (older provider
 * doubles, partial mocks) and provider errors alike.
 */
import type { DatabaseRow } from '~~/server/providers/database'

interface BranchRequestReader {
  getBranchChangeRequest?: (projectId: string, branch: string) => Promise<DatabaseRow | null>
  listBranchChangeRequests?: (projectId: string) => Promise<DatabaseRow[]>
  clearBranchChangeRequest?: (projectId: string, branch: string) => Promise<void>
}

export async function getBranchRequestSafe(projectId: string, branch: string): Promise<DatabaseRow | null> {
  try {
    const db = useDatabaseProvider() as BranchRequestReader
    return (await db.getBranchChangeRequest?.(projectId, branch)) ?? null
  }
  catch {
    return null
  }
}

export async function listBranchRequestsSafe(projectId: string): Promise<DatabaseRow[]> {
  try {
    const db = useDatabaseProvider() as BranchRequestReader
    return (await db.listBranchChangeRequests?.(projectId)) ?? []
  }
  catch {
    return []
  }
}

export function clearBranchRequestSafe(projectId: string, branch: string): void {
  try {
    const db = useDatabaseProvider() as BranchRequestReader
    db.clearBranchChangeRequest?.(projectId, branch)?.catch(() => {})
  }
  catch {
    // ignore
  }
}
