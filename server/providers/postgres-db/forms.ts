/**
 * Form submission methods for the plain-Postgres DatabaseProvider.
 * Behavior parity with supabase-db/forms.ts.
 */
import { sql } from 'kysely'
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
  | 'createFormSubmissionIfAllowed'
>

export function formMethods(): FormMethods {
  return {
    async createFormSubmission(submission) {
      try {
        const values: Record<string, unknown> = { ...submission }
        // jsonb payload — stringify so node-pg never misreads a JS array
        if (values.data !== undefined && values.data !== null && typeof values.data === 'object')
          values.data = JSON.stringify(values.data)

        const row = await getAdmin()
          .insertInto('form_submissions')
          .values(values as never)
          .returningAll()
          .executeTakeFirst()

        if (!row) throw new Error('empty insert response')
        return row as DatabaseRow
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: errorMessage('forms.create_failed', { detail: error instanceof Error ? error.message : 'unknown' }),
        })
      }
    },

    async listFormSubmissions(workspaceId, projectId, modelId, options) {
      const page = options?.page ?? 1
      const limit = Math.min(options?.limit ?? 50, 100)
      const offset = (page - 1) * limit

      try {
        let base = getAdmin()
          .selectFrom('form_submissions')
          .where('workspace_id', '=', workspaceId)
          .where('project_id', '=', projectId)
          .where('model_id', '=', modelId)

        if (options?.status)
          base = base.where('status', '=', options.status)

        const totalRow = await base
          .select(eb => eb.fn.countAll().as('total'))
          .executeTakeFirst()

        const rows = await base
          .selectAll()
          .orderBy('created_at', options?.sort === 'oldest' ? 'asc' : 'desc')
          .limit(limit)
          .offset(offset)
          .execute()

        return { submissions: rows as DatabaseRow[], total: Number(totalRow?.total ?? 0) }
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: errorMessage('forms.list_failed', { detail: error instanceof Error ? error.message : 'unknown' }),
        })
      }
    },

    async getFormSubmission(submissionId) {
      // Failure reads as null (the Supabase impl never checks the error).
      try {
        const row = await getAdmin()
          .selectFrom('form_submissions')
          .selectAll()
          .where('id', '=', submissionId)
          .executeTakeFirst()

        return (row as DatabaseRow | undefined) ?? null
      }
      catch {
        return null
      }
    },

    async updateFormSubmissionStatus(submissionId, status, approvedBy, entryId) {
      const updates: Record<string, unknown> = { status }
      if (status === 'approved') {
        updates.approved_at = new Date().toISOString()
        if (approvedBy) updates.approved_by = approvedBy
        if (entryId) updates.entry_id = entryId
      }

      try {
        const row = await getAdmin()
          .updateTable('form_submissions')
          .set(updates as never)
          .where('id', '=', submissionId)
          .returningAll()
          .executeTakeFirst()

        if (!row) throw new Error('empty update response')
        return row as DatabaseRow
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: errorMessage('forms.update_failed', { detail: error instanceof Error ? error.message : 'unknown' }),
        })
      }
    },

    async deleteFormSubmission(submissionId) {
      try {
        await getAdmin()
          .deleteFrom('form_submissions')
          .where('id', '=', submissionId)
          .execute()
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: errorMessage('forms.delete_failed', { detail: error instanceof Error ? error.message : 'unknown' }),
        })
      }
    },

    async bulkUpdateSubmissions(submissionIds, status, approvedBy, scope) {
      const updates: Record<string, unknown> = { status }
      if (status === 'approved') {
        updates.approved_at = new Date().toISOString()
        if (approvedBy) updates.approved_by = approvedBy
      }

      // Failure reads as 0 updated (the Supabase impl never checks the error).
      try {
        let query = getAdmin()
          .updateTable('form_submissions')
          .set(updates as never)
          .where('id', 'in', submissionIds)

        if (scope?.workspaceId) query = query.where('workspace_id', '=', scope.workspaceId)
        if (scope?.projectId) query = query.where('project_id', '=', scope.projectId)
        if (scope?.modelId) query = query.where('model_id', '=', scope.modelId)

        const rows = await query.returning('id').execute()
        return rows.length
      }
      catch {
        return 0
      }
    },

    async countMonthlySubmissions(workspaceId) {
      const now = new Date()
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

      // Failure reads as 0 (the Supabase impl never checks the error).
      try {
        const row = await getAdmin()
          .selectFrom('form_submissions')
          .select(eb => eb.fn.countAll().as('count'))
          .where('workspace_id', '=', workspaceId)
          .where('created_at', '>=', monthStart.toISOString())
          .executeTakeFirst()

        return Number(row?.count ?? 0)
      }
      catch {
        return 0
      }
    },

    async createFormSubmissionIfAllowed(workspaceId, monthlyLimit, submission) {
      let result: { allowed: boolean, current_count: number, submission?: Record<string, unknown> }
      try {
        const outcome = await sql<{ result: typeof result }>`
          SELECT public.create_form_submission_if_allowed(
            p_workspace_id => ${workspaceId},
            p_monthly_limit => ${monthlyLimit},
            p_project_id => ${submission.project_id},
            p_model_id => ${submission.model_id},
            p_data => ${JSON.stringify(submission.data)}::jsonb,
            p_status => ${'pending'},
            p_source_ip => ${submission.source_ip ?? null},
            p_user_agent => ${submission.user_agent ?? null},
            p_referrer => ${submission.referrer ?? null},
            p_locale => ${submission.locale ?? 'en'}
          ) AS result
        `.execute(getAdmin())

        result = outcome.rows[0]!.result
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: `Atomic submission check failed: ${error instanceof Error ? error.message : 'unknown'}`,
        })
      }

      return {
        allowed: result.allowed,
        currentCount: result.current_count,
        submission: result.submission as DatabaseRow | undefined,
      }
    },
  }
}
