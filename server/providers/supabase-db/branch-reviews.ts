/**
 * Branch review (request-changes) methods for the Supabase DatabaseProvider.
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

export function branchReviewMethods(): BranchReviewMethods {
  return {
    async requestBranchChanges(input) {
      const now = new Date().toISOString()
      const { data, error } = await getAdmin()
        .from('branch_reviews')
        .upsert({
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
        }, { onConflict: 'project_id,branch' })
        .select()
        .single()
      if (error || !data) throw createError({ statusCode: 500, message: error?.message ?? 'branch review upsert failed' })
      return data as DatabaseRow
    },

    async getBranchChangeRequest(projectId, branch) {
      const { data } = await getAdmin()
        .from('branch_reviews')
        .select('*')
        .eq('project_id', projectId)
        .eq('branch', branch)
        .eq('status', 'changes_requested')
        .maybeSingle()
      return (data as DatabaseRow) ?? null
    },

    async listBranchChangeRequests(projectId) {
      const { data, error } = await getAdmin()
        .from('branch_reviews')
        .select('*')
        .eq('project_id', projectId)
        .eq('status', 'changes_requested')
        .order('requested_at', { ascending: false })
      if (error) throw createError({ statusCode: 500, message: error.message })
      return (data ?? []) as DatabaseRow[]
    },

    async resolveBranchChangeRequest(projectId, branch, resolvedBy) {
      const now = new Date().toISOString()
      const { error } = await getAdmin()
        .from('branch_reviews')
        .update({ status: 'resolved', resolved_at: now, resolved_by: resolvedBy ?? null, updated_at: now })
        .eq('project_id', projectId)
        .eq('branch', branch)
      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    async clearBranchChangeRequest(projectId, branch) {
      await getAdmin()
        .from('branch_reviews')
        .delete()
        .eq('project_id', projectId)
        .eq('branch', branch)
    },
  }
}
