/**
 * Form submission methods for the Supabase DatabaseProvider.
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin } from './helpers'

type FormMethods = Pick<
  DatabaseProvider,
  | 'createFormSubmission'
  | 'listFormSubmissions'
  | 'getFormSubmission'
  | 'updateFormSubmissionStatus'
  | 'deleteFormSubmission'
  | 'bulkUpdateSubmissions'
  | 'countMonthlySubmissions'
>

export function formMethods(): FormMethods {
  return {
    async createFormSubmission(submission) {
      const { data, error } = await getAdmin()
        .from('form_submissions')
        .insert(submission)
        .select()
        .single()

      if (error || !data) {
        throw createError({ statusCode: 500, message: errorMessage('forms.create_failed', { detail: error?.message ?? 'unknown' }) })
      }
      return data as DatabaseRow
    },

    async listFormSubmissions(workspaceId, projectId, modelId, options) {
      const page = options?.page ?? 1
      const limit = Math.min(options?.limit ?? 50, 100)
      const offset = (page - 1) * limit

      let query = getAdmin()
        .from('form_submissions')
        .select('*', { count: 'exact' })
        .eq('workspace_id', workspaceId)
        .eq('project_id', projectId)
        .eq('model_id', modelId)

      if (options?.status) {
        query = query.eq('status', options.status)
      }

      query = options?.sort === 'oldest'
        ? query.order('created_at', { ascending: true })
        : query.order('created_at', { ascending: false })

      const { data, count, error } = await query.range(offset, offset + limit - 1)

      if (error) {
        throw createError({ statusCode: 500, message: errorMessage('forms.list_failed', { detail: error.message }) })
      }
      return { submissions: (data ?? []) as DatabaseRow[], total: count ?? 0 }
    },

    async getFormSubmission(submissionId) {
      const { data } = await getAdmin()
        .from('form_submissions')
        .select('*')
        .eq('id', submissionId)
        .single()

      return (data as DatabaseRow) ?? null
    },

    async updateFormSubmissionStatus(submissionId, status, approvedBy, entryId) {
      const updates: Record<string, unknown> = { status }
      if (status === 'approved') {
        updates.approved_at = new Date().toISOString()
        if (approvedBy) updates.approved_by = approvedBy
        if (entryId) updates.entry_id = entryId
      }

      const { data, error } = await getAdmin()
        .from('form_submissions')
        .update(updates)
        .eq('id', submissionId)
        .select()
        .single()

      if (error || !data) {
        throw createError({ statusCode: 500, message: errorMessage('forms.update_failed', { detail: error?.message ?? 'unknown' }) })
      }
      return data as DatabaseRow
    },

    async deleteFormSubmission(submissionId) {
      const { error } = await getAdmin()
        .from('form_submissions')
        .delete()
        .eq('id', submissionId)

      if (error) {
        throw createError({ statusCode: 500, message: errorMessage('forms.delete_failed', { detail: error.message }) })
      }
    },

    async bulkUpdateSubmissions(submissionIds, status, approvedBy, scope) {
      const updates: Record<string, unknown> = { status }
      if (status === 'approved') {
        updates.approved_at = new Date().toISOString()
        if (approvedBy) updates.approved_by = approvedBy
      }

      let query = getAdmin()
        .from('form_submissions')
        .update(updates)
        .in('id', submissionIds)

      if (scope?.workspaceId) query = query.eq('workspace_id', scope.workspaceId)
      if (scope?.projectId) query = query.eq('project_id', scope.projectId)
      if (scope?.modelId) query = query.eq('model_id', scope.modelId)

      const { data } = await query.select('id')
      return data?.length ?? 0
    },

    async countMonthlySubmissions(workspaceId) {
      const now = new Date()
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

      const { count } = await getAdmin()
        .from('form_submissions')
        .select('*', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .gte('created_at', monthStart.toISOString())

      return count ?? 0
    },
  }
}
