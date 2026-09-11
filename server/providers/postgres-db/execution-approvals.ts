/**
 * Approval + receipt methods for the plain-Postgres DatabaseProvider.
 * Behavior parity with supabase-db/execution-approvals.ts.
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin } from './helpers'

type ApprovalMethods = Pick<
  DatabaseProvider,
  | 'recordApproval'
  | 'listApprovals'
  | 'deleteApproval'
  | 'clearApprovals'
  | 'recordReceipt'
  | 'listReceipts'
>

function detail(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown'
}

export function executionApprovalMethods(): ApprovalMethods {
  return {
    async recordApproval(input) {
      const now = new Date().toISOString()
      const email = input.approverEmail.toLowerCase()
      try {
        const row = await getAdmin()
          .insertInto('execution_approvals')
          .values({
            project_id: input.projectId,
            workspace_id: input.workspaceId,
            target: input.target,
            gate: input.gate,
            plan_hash: input.planHash,
            commit_sha: input.commitSha ?? null,
            approver_id: input.approverId,
            approver_email: email,
            approver_role: input.approverRole ?? null,
            note: input.note ?? null,
            approved_at: now,
          } as never)
          .onConflict(oc => oc.columns(['project_id', 'target', 'gate', 'approver_email']).doUpdateSet({
            plan_hash: input.planHash,
            commit_sha: input.commitSha ?? null,
            approver_id: input.approverId,
            approver_role: input.approverRole ?? null,
            note: input.note ?? null,
            approved_at: now,
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

    async listApprovals(projectId, target) {
      try {
        const rows = await getAdmin()
          .selectFrom('execution_approvals')
          .selectAll()
          .where('project_id', '=', projectId)
          .where('target', '=', target)
          .orderBy('approved_at', 'asc')
          .execute()
        return rows as DatabaseRow[]
      }
      catch (error) {
        throw createError({ statusCode: 500, message: detail(error) })
      }
    },

    async deleteApproval(projectId, target, approverEmail) {
      try {
        await getAdmin()
          .deleteFrom('execution_approvals')
          .where('project_id', '=', projectId)
          .where('target', '=', target)
          .where('approver_email', '=', approverEmail.toLowerCase())
          .execute()
      }
      catch { /* already gone */ }
    },

    async clearApprovals(projectId, target) {
      try {
        await getAdmin()
          .deleteFrom('execution_approvals')
          .where('project_id', '=', projectId)
          .where('target', '=', target)
          .execute()
      }
      catch { /* already gone */ }
    },

    async recordReceipt(input) {
      try {
        const row = await getAdmin()
          .insertInto('execution_receipts')
          .values({
            project_id: input.projectId,
            workspace_id: input.workspaceId,
            target: input.target,
            plan_hash: input.planHash,
            receipt: JSON.stringify(input.receipt),
          } as never)
          .returningAll()
          .executeTakeFirst()
        if (!row) throw new Error('empty insert response')
        return row as DatabaseRow
      }
      catch (error) {
        throw createError({ statusCode: 500, message: detail(error) })
      }
    },

    async listReceipts(projectId, limit = 50) {
      try {
        const rows = await getAdmin()
          .selectFrom('execution_receipts')
          .selectAll()
          .where('project_id', '=', projectId)
          .orderBy('created_at', 'desc')
          .limit(limit)
          .execute()
        return rows as DatabaseRow[]
      }
      catch (error) {
        throw createError({ statusCode: 500, message: detail(error) })
      }
    },
  }
}
