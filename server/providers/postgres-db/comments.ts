/**
 * Comment methods for the plain-Postgres DatabaseProvider.
 * Behavior parity with supabase-db/comments.ts (contract: tests/contract/comments.contract.test.ts).
 */
import { sql } from 'kysely'
import type { CommentStatus, DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin } from './helpers'

type CommentMethods = Pick<
  DatabaseProvider,
  | 'createComment'
  | 'createCommentIfAllowed'
  | 'listPublicComments'
  | 'listComments'
  | 'getComment'
  | 'updateCommentStatus'
  | 'deleteComment'
  | 'bulkUpdateComments'
  | 'countMonthlyComments'
  | 'countCommentsByStatus'
  | 'importComments'
  | 'getCommentThread'
  | 'setCommentThreadClosed'
>

const REPLY_FETCH_CAP = 500

function moderationStamp(status: CommentStatus, moderatedBy?: string): Record<string, unknown> {
  const now = new Date().toISOString()
  const updates: Record<string, unknown> = { status, updated_at: now }
  if (status !== 'pending') {
    updates.moderated_at = now
    if (moderatedBy) updates.moderated_by = moderatedBy
  }
  return updates
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown'
}

export function commentMethods(): CommentMethods {
  return {
    async createComment(comment) {
      try {
        const row = await getAdmin()
          .insertInto('comments')
          .values({ ...comment } as never)
          .returningAll()
          .executeTakeFirst()

        if (!row) throw new Error('empty insert response')
        return row as DatabaseRow
      }
      catch (error) {
        throw createError({ statusCode: 500, message: errorMessage('comments.create_failed', { detail: detail(error) }) })
      }
    },

    async createCommentIfAllowed(workspaceId, monthlyLimit, comment) {
      let result: {
        allowed: boolean
        reason?: 'thread_closed' | 'parent_not_found' | 'depth_exceeded' | 'monthly_limit'
        current_count?: number
        comment?: Record<string, unknown>
      }
      try {
        const outcome = await sql<{ result: typeof result }>`
          SELECT public.create_comment_if_allowed(
            p_workspace_id => ${workspaceId},
            p_monthly_limit => ${monthlyLimit},
            p_project_id => ${comment.project_id},
            p_model_id => ${comment.model_id},
            p_entry_id => ${comment.entry_id},
            p_locale => ${comment.locale ?? 'en'},
            p_parent_id => ${comment.parent_id ?? null},
            p_max_depth => ${comment.max_depth},
            p_author_name => ${comment.author_name},
            p_author_email => ${comment.author_email ?? null},
            p_author_url => ${comment.author_url ?? null},
            p_body => ${comment.body},
            p_status => ${comment.status ?? 'pending'},
            p_source_ip => ${comment.source_ip ?? null},
            p_user_agent => ${comment.user_agent ?? null},
            p_referrer => ${comment.referrer ?? null}
          ) AS result
        `.execute(getAdmin())

        result = outcome.rows[0]!.result
      }
      catch (error) {
        throw createError({ statusCode: 500, message: `Atomic comment check failed: ${detail(error)}` })
      }

      return {
        allowed: result.allowed,
        reason: result.reason,
        currentCount: result.current_count,
        comment: result.comment as DatabaseRow | undefined,
      }
    },

    async listPublicComments(projectId, key, options) {
      const page = options?.page ?? 1
      const limit = Math.min(options?.limit ?? 20, 100)
      const offset = (page - 1) * limit

      try {
        const base = getAdmin()
          .selectFrom('comments')
          .where('project_id', '=', projectId)
          .where('model_id', '=', key.model_id)
          .where('entry_id', '=', key.entry_id)
          .where('locale', '=', key.locale)
          .where('status', '=', 'approved')
          .where('depth', '=', 0)

        const totalRow = await base
          .select(eb => eb.fn.countAll().as('total'))
          .executeTakeFirst()

        const roots = await base
          .selectAll()
          .orderBy('created_at', options?.sort === 'newest' ? 'desc' : 'asc')
          .limit(limit)
          .offset(offset)
          .execute()

        if (roots.length === 0)
          return { roots: [], replies: [], total: Number(totalRow?.total ?? 0) }

        const replies = await getAdmin()
          .selectFrom('comments')
          .selectAll()
          .where('root_id', 'in', roots.map(r => r.id))
          .where('depth', '>', 0)
          .where('status', '=', 'approved')
          .orderBy('created_at', 'asc')
          .limit(REPLY_FETCH_CAP)
          .execute()

        return { roots: roots as DatabaseRow[], replies: replies as DatabaseRow[], total: Number(totalRow?.total ?? 0) }
      }
      catch (error) {
        throw createError({ statusCode: 500, message: errorMessage('comments.list_failed', { detail: detail(error) }) })
      }
    },

    async listComments(workspaceId, projectId, options) {
      const page = options?.page ?? 1
      const limit = Math.min(options?.limit ?? 50, 100)
      const offset = (page - 1) * limit

      try {
        let base = getAdmin()
          .selectFrom('comments')
          .where('workspace_id', '=', workspaceId)
          .where('project_id', '=', projectId)

        if (options?.modelId) base = base.where('model_id', '=', options.modelId)
        if (options?.entryId) base = base.where('entry_id', '=', options.entryId)
        if (options?.locale) base = base.where('locale', '=', options.locale)
        if (options?.status) base = base.where('status', '=', options.status)

        const totalRow = await base
          .select(eb => eb.fn.countAll().as('total'))
          .executeTakeFirst()

        const rows = await base
          .selectAll()
          .orderBy('created_at', options?.sort === 'oldest' ? 'asc' : 'desc')
          .limit(limit)
          .offset(offset)
          .execute()

        return { comments: rows as DatabaseRow[], total: Number(totalRow?.total ?? 0) }
      }
      catch (error) {
        throw createError({ statusCode: 500, message: errorMessage('comments.list_failed', { detail: detail(error) }) })
      }
    },

    async getComment(commentId) {
      // Failure reads as null (parity with the Supabase impl).
      try {
        const row = await getAdmin()
          .selectFrom('comments')
          .selectAll()
          .where('id', '=', commentId)
          .executeTakeFirst()
        return (row as DatabaseRow) ?? null
      }
      catch {
        return null
      }
    },

    async updateCommentStatus(commentId, status, moderatedBy) {
      try {
        const row = await getAdmin()
          .updateTable('comments')
          .set(moderationStamp(status, moderatedBy) as never)
          .where('id', '=', commentId)
          .returningAll()
          .executeTakeFirst()

        if (!row) throw new Error('comment not found')
        return row as DatabaseRow
      }
      catch (error) {
        throw createError({ statusCode: 500, message: errorMessage('comments.update_failed', { detail: detail(error) }) })
      }
    },

    async deleteComment(commentId) {
      try {
        await getAdmin()
          .deleteFrom('comments')
          .where('id', '=', commentId)
          .execute()
      }
      catch (error) {
        throw createError({ statusCode: 500, message: errorMessage('comments.delete_failed', { detail: detail(error) }) })
      }
    },

    async bulkUpdateComments(commentIds, status, moderatedBy, scope) {
      if (commentIds.length === 0) return 0
      try {
        let query = getAdmin()
          .updateTable('comments')
          .set(moderationStamp(status, moderatedBy) as never)
          .where('id', 'in', commentIds)

        if (scope?.workspaceId) query = query.where('workspace_id', '=', scope.workspaceId)
        if (scope?.projectId) query = query.where('project_id', '=', scope.projectId)

        const rows = await query.returning('id').execute()
        return rows.length
      }
      catch {
        return 0
      }
    },

    async countMonthlyComments(workspaceId) {
      const now = new Date()
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

      try {
        const row = await getAdmin()
          .selectFrom('comments')
          .select(eb => eb.fn.countAll().as('count'))
          .where('workspace_id', '=', workspaceId)
          .where('source', '=', 'web')
          .where('created_at', '>=', monthStart.toISOString())
          .executeTakeFirst()

        return Number(row?.count ?? 0)
      }
      catch {
        return 0
      }
    },

    async countCommentsByStatus(projectId, modelId) {
      const counts: Record<CommentStatus, number> = { pending: 0, approved: 0, spam: 0, rejected: 0 }
      try {
        let query = getAdmin()
          .selectFrom('comments')
          .select(['status', eb => eb.fn.countAll().as('count')])
          .where('project_id', '=', projectId)
        if (modelId) query = query.where('model_id', '=', modelId)
        const rows = await query.groupBy('status').execute()
        for (const row of rows) {
          if (row.status in counts) counts[row.status as CommentStatus] = Number(row.count)
        }
      }
      catch {
        // Counts are advisory (UI badges) — a failure reads as zero.
      }
      return counts
    },

    async importComments(projectId, workspaceId, payload) {
      let result: {
        inserted: number
        skipped_existing: number
        orphan_count: number
        orphan_parents: Array<{ source_id: string, source_parent_id: string }>
        max_depth: number
        threads_closed: number
      }
      try {
        const outcome = await sql<{ result: typeof result }>`
          SELECT public.import_comments(
            p_project_id => ${projectId},
            p_workspace_id => ${workspaceId},
            p_payload => ${JSON.stringify(payload)}::jsonb
          ) AS result
        `.execute(getAdmin())
        result = outcome.rows[0]!.result
      }
      catch (error) {
        throw createError({ statusCode: 500, message: errorMessage('comments.import_failed', { detail: detail(error) }) })
      }

      return {
        inserted: result.inserted,
        skippedExisting: result.skipped_existing,
        orphanCount: result.orphan_count,
        orphanParents: result.orphan_parents ?? [],
        maxDepth: result.max_depth,
        threadsClosed: result.threads_closed,
      }
    },

    async getCommentThread(projectId, key) {
      try {
        const row = await getAdmin()
          .selectFrom('comment_threads')
          .selectAll()
          .where('project_id', '=', projectId)
          .where('model_id', '=', key.model_id)
          .where('entry_id', '=', key.entry_id)
          .where('locale', '=', key.locale)
          .executeTakeFirst()
        return (row as DatabaseRow) ?? null
      }
      catch {
        return null
      }
    },

    async setCommentThreadClosed(projectId, workspaceId, key, closed, userId) {
      const now = new Date().toISOString()
      const closedAt = closed ? now : null
      const closedBy = closed ? (userId ?? null) : null
      try {
        const row = await getAdmin()
          .insertInto('comment_threads')
          .values({
            project_id: projectId,
            workspace_id: workspaceId,
            model_id: key.model_id,
            entry_id: key.entry_id,
            locale: key.locale,
            closed_at: closedAt,
            closed_by: closedBy,
            updated_at: now,
          } as never)
          .onConflict(oc => oc
            .columns(['project_id', 'model_id', 'entry_id', 'locale'])
            .doUpdateSet({ closed_at: closedAt, closed_by: closedBy, updated_at: now } as never))
          .returningAll()
          .executeTakeFirst()

        if (!row) throw new Error('empty upsert response')
        return row as DatabaseRow
      }
      catch (error) {
        throw createError({ statusCode: 500, message: errorMessage('comments.update_failed', { detail: detail(error) }) })
      }
    },
  }
}
