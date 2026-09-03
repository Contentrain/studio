/**
 * Branch review (request-changes) methods for the plain-Postgres DatabaseProvider.
 * Behavior parity with supabase-db/branch-reviews.ts.
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin } from './helpers'

type BranchReviewMethods = Pick<
  DatabaseProvider,
  | 'requestBranchChanges'
  | 'getBranchChangeRequest'
  | 'listBranchChangeRequests'
  | 'resolveBranchChangeRequest'
  | 'clearBranchChangeRequest'
>

function detail(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown'
}

export function branchReviewMethods(): BranchReviewMethods {
  return {
    async requestBranchChanges(input) {
      const now = new Date().toISOString()
      try {
        const row = await getAdmin()
          .insertInto('branch_reviews')
          .values({
            project_id: input.projectId,
            workspace_id: input.workspaceId,
            branch: input.branch,
            status: 'changes_requested',
            comment: input.comment,
            requested_by: input.requestedBy,
            requested_at: now,
            resolved_at: null,
            resolved_by: null,
            updated_at: now,
          } as never)
          .onConflict(oc => oc.columns(['project_id', 'branch']).doUpdateSet({
            status: 'changes_requested',
            comment: input.comment,
            requested_by: input.requestedBy,
            requested_at: now,
            resolved_at: null,
            resolved_by: null,
            updated_at: now,
          } as never))
          .returningAll()
          .executeTakeFirst()
        if (!row) throw new Error('empty upsert response')
        return row as DatabaseRow
      }
      catch (error) {
        throw createError({ statusCode: 500, message: detail(error) })
      }
    },

    async getBranchChangeRequest(projectId, branch) {
      try {
        const row = await getAdmin()
          .selectFrom('branch_reviews')
          .selectAll()
          .where('project_id', '=', projectId)
          .where('branch', '=', branch)
          .where('status', '=', 'changes_requested')
          .executeTakeFirst()
        return (row as DatabaseRow) ?? null
      }
      catch {
        return null
      }
    },

    async listBranchChangeRequests(projectId) {
      try {
        const rows = await getAdmin()
          .selectFrom('branch_reviews')
          .selectAll()
          .where('project_id', '=', projectId)
          .where('status', '=', 'changes_requested')
          .orderBy('requested_at', 'desc')
          .execute()
        return rows as DatabaseRow[]
      }
      catch (error) {
        throw createError({ statusCode: 500, message: detail(error) })
      }
    },

    async resolveBranchChangeRequest(projectId, branch, resolvedBy) {
      const now = new Date().toISOString()
      try {
        await getAdmin()
          .updateTable('branch_reviews')
          .set({ status: 'resolved', resolved_at: now, resolved_by: resolvedBy ?? null, updated_at: now } as never)
          .where('project_id', '=', projectId)
          .where('branch', '=', branch)
          .execute()
      }
      catch (error) {
        throw createError({ statusCode: 500, message: detail(error) })
      }
    },

    async clearBranchChangeRequest(projectId, branch) {
      try {
        await getAdmin()
          .deleteFrom('branch_reviews')
          .where('project_id', '=', projectId)
          .where('branch', '=', branch)
          .execute()
      }
      catch {
        // best-effort cleanup
      }
    },
  }
}
