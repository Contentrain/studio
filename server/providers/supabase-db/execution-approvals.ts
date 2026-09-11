/**
 * Approval + receipt methods for the Supabase DatabaseProvider.
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

export function executionApprovalMethods(): ApprovalMethods {
  return {
    async recordApproval(input) {
      const { data, error } = await getAdmin()
        .from('execution_approvals')
        .upsert({
          project_id: input.projectId,
          workspace_id: input.workspaceId,
          target: input.target,
          gate: input.gate,
          plan_hash: input.planHash,
          commit_sha: input.commitSha ?? null,
          approver_id: input.approverId,
          approver_email: input.approverEmail.toLowerCase(),
          approver_role: input.approverRole ?? null,
          note: input.note ?? null,
          approved_at: new Date().toISOString(),
        }, { onConflict: 'project_id,target,gate,approver_email' })
        .select()
        .single()
      if (error || !data) throw createError({ statusCode: 500, message: error?.message ?? 'approval upsert failed' })
      return data as DatabaseRow
    },

    async listApprovals(projectId, target) {
      const { data, error } = await getAdmin()
        .from('execution_approvals')
        .select('*')
        .eq('project_id', projectId)
        .eq('target', target)
        .order('approved_at', { ascending: true })
      if (error) throw createError({ statusCode: 500, message: error.message })
      return (data ?? []) as DatabaseRow[]
    },

    async deleteApproval(projectId, target, approverEmail) {
      await getAdmin()
        .from('execution_approvals')
        .delete()
        .eq('project_id', projectId)
        .eq('target', target)
        .eq('approver_email', approverEmail.toLowerCase())
    },

    async clearApprovals(projectId, target) {
      await getAdmin()
        .from('execution_approvals')
        .delete()
        .eq('project_id', projectId)
        .eq('target', target)
    },

    async recordReceipt(input) {
      const { data, error } = await getAdmin()
        .from('execution_receipts')
        .insert({
          project_id: input.projectId,
          workspace_id: input.workspaceId,
          target: input.target,
          plan_hash: input.planHash,
          receipt: input.receipt,
        })
        .select()
        .single()
      if (error || !data) throw createError({ statusCode: 500, message: error?.message ?? 'receipt insert failed' })
      return data as DatabaseRow
    },

    async listReceipts(projectId, limit = 50) {
      const { data, error } = await getAdmin()
        .from('execution_receipts')
        .select('*')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false })
        .limit(limit)
      if (error) throw createError({ statusCode: 500, message: error.message })
      return (data ?? []) as DatabaseRow[]
    },
  }
}
