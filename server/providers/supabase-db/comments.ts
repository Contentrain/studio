/**
 * Comment methods for the Supabase DatabaseProvider.
 *
 * Mirrors forms.ts: admin client for every call (public endpoints have no
 * session; moderation routes authorize before they get here), the two
 * atomic paths (`create_comment_if_allowed`, `import_comments`) go through
 * SECURITY DEFINER functions shared with the postgres provider.
 */
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

const STATUSES: readonly CommentStatus[] = ['pending', 'approved', 'spam', 'rejected']
const REPLY_FETCH_CAP = 500

function moderationStamp(status: CommentStatus, moderatedBy?: string): Record<string, unknown> {
  const updates: Record<string, unknown> = { status, updated_at: new Date().toISOString() }
  if (status !== 'pending') {
    updates.moderated_at = new Date().toISOString()
    if (moderatedBy) updates.moderated_by = moderatedBy
  }
  return updates
}

export function commentMethods(): CommentMethods {
  return {
    async createComment(comment) {
      const { data, error } = await getAdmin()
        .from('comments')
        .insert(comment)
        .select()
        .single()

      if (error || !data) {
        throw createError({ statusCode: 500, message: errorMessage('comments.create_failed', { detail: error?.message ?? 'unknown' }) })
      }
      return data as DatabaseRow
    },

    async createCommentIfAllowed(workspaceId, monthlyLimit, comment) {
      const { data, error } = await getAdmin().rpc('create_comment_if_allowed', {
        p_workspace_id: workspaceId,
        p_monthly_limit: monthlyLimit,
        p_project_id: comment.project_id,
        p_model_id: comment.model_id,
        p_entry_id: comment.entry_id,
        p_locale: comment.locale ?? 'en',
        p_parent_id: comment.parent_id ?? null,
        p_max_depth: comment.max_depth,
        p_author_name: comment.author_name,
        p_author_email: comment.author_email ?? null,
        p_author_url: comment.author_url ?? null,
        p_body: comment.body,
        p_status: comment.status ?? 'pending',
        p_source_ip: comment.source_ip ?? null,
        p_user_agent: comment.user_agent ?? null,
        p_referrer: comment.referrer ?? null,
      })

      if (error) {
        throw createError({ statusCode: 500, message: `Atomic comment check failed: ${error.message}` })
      }

      const result = data as {
        allowed: boolean
        reason?: 'thread_closed' | 'parent_not_found' | 'depth_exceeded' | 'monthly_limit'
        current_count?: number
        comment?: Record<string, unknown>
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
      const ascending = options?.sort !== 'newest'

      const { data: roots, count, error } = await getAdmin()
        .from('comments')
        .select('*', { count: 'exact' })
        .eq('project_id', projectId)
        .eq('model_id', key.model_id)
        .eq('entry_id', key.entry_id)
        .eq('locale', key.locale)
        .eq('status', 'approved')
        .eq('depth', 0)
        .order('created_at', { ascending })
        .range(offset, offset + limit - 1)

      if (error) {
        throw createError({ statusCode: 500, message: errorMessage('comments.list_failed', { detail: error.message }) })
      }

      const rootRows = (roots ?? []) as DatabaseRow[]
      if (rootRows.length === 0)
        return { roots: [], replies: [], total: count ?? 0 }

      const { data: replies, error: replyError } = await getAdmin()
        .from('comments')
        .select('*')
        .in('root_id', rootRows.map(r => r.id as string))
        .gt('depth', 0)
        .eq('status', 'approved')
        .order('created_at', { ascending: true })
        .limit(REPLY_FETCH_CAP)

      if (replyError) {
        throw createError({ statusCode: 500, message: errorMessage('comments.list_failed', { detail: replyError.message }) })
      }

      return { roots: rootRows, replies: (replies ?? []) as DatabaseRow[], total: count ?? 0 }
    },

    async listComments(workspaceId, projectId, options) {
      const page = options?.page ?? 1
      const limit = Math.min(options?.limit ?? 50, 100)
      const offset = (page - 1) * limit

      let query = getAdmin()
        .from('comments')
        .select('*', { count: 'exact' })
        .eq('workspace_id', workspaceId)
        .eq('project_id', projectId)

      if (options?.modelId) query = query.eq('model_id', options.modelId)
      if (options?.entryId) query = query.eq('entry_id', options.entryId)
      if (options?.locale) query = query.eq('locale', options.locale)
      if (options?.status) query = query.eq('status', options.status)

      query = query.order('created_at', { ascending: options?.sort === 'oldest' })

      const { data, count, error } = await query.range(offset, offset + limit - 1)

      if (error) {
        throw createError({ statusCode: 500, message: errorMessage('comments.list_failed', { detail: error.message }) })
      }
      return { comments: (data ?? []) as DatabaseRow[], total: count ?? 0 }
    },

    async getComment(commentId) {
      const { data } = await getAdmin()
        .from('comments')
        .select('*')
        .eq('id', commentId)
        .single()

      return (data as DatabaseRow) ?? null
    },

    async updateCommentStatus(commentId, status, moderatedBy) {
      const { data, error } = await getAdmin()
        .from('comments')
        .update(moderationStamp(status, moderatedBy))
        .eq('id', commentId)
        .select()
        .single()

      if (error || !data) {
        throw createError({ statusCode: 500, message: errorMessage('comments.update_failed', { detail: error?.message ?? 'unknown' }) })
      }
      return data as DatabaseRow
    },

    async deleteComment(commentId) {
      const { error } = await getAdmin()
        .from('comments')
        .delete()
        .eq('id', commentId)

      if (error) {
        throw createError({ statusCode: 500, message: errorMessage('comments.delete_failed', { detail: error.message }) })
      }
    },

    async bulkUpdateComments(commentIds, status, moderatedBy, scope) {
      let query = getAdmin()
        .from('comments')
        .update(moderationStamp(status, moderatedBy))
        .in('id', commentIds)

      if (scope?.workspaceId) query = query.eq('workspace_id', scope.workspaceId)
      if (scope?.projectId) query = query.eq('project_id', scope.projectId)

      const { data } = await query.select('id')
      return data?.length ?? 0
    },

    async countMonthlyComments(workspaceId) {
      const now = new Date()
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

      const { count } = await getAdmin()
        .from('comments')
        .select('*', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('source', 'web')
        .gte('created_at', monthStart.toISOString())

      return count ?? 0
    },

    async countCommentsByStatus(projectId, modelId) {
      const counts = { pending: 0, approved: 0, spam: 0, rejected: 0 } satisfies Record<CommentStatus, number>
      await Promise.all(STATUSES.map(async (status) => {
        let query = getAdmin()
          .from('comments')
          .select('*', { count: 'exact', head: true })
          .eq('project_id', projectId)
          .eq('status', status)
        if (modelId) query = query.eq('model_id', modelId)
        const { count } = await query
        counts[status] = count ?? 0
      }))
      return counts
    },

    async importComments(projectId, workspaceId, payload) {
      const { data, error } = await getAdmin().rpc('import_comments', {
        p_project_id: projectId,
        p_workspace_id: workspaceId,
        p_payload: payload,
      })

      if (error) {
        throw createError({ statusCode: 500, message: errorMessage('comments.import_failed', { detail: error.message }) })
      }

      const result = data as {
        inserted: number
        skipped_existing: number
        orphan_count: number
        orphan_parents: Array<{ source_id: string, source_parent_id: string }>
        max_depth: number
        threads_closed: number
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
      const { data } = await getAdmin()
        .from('comment_threads')
        .select('*')
        .eq('project_id', projectId)
        .eq('model_id', key.model_id)
        .eq('entry_id', key.entry_id)
        .eq('locale', key.locale)
        .maybeSingle()

      return (data as DatabaseRow) ?? null
    },

    async setCommentThreadClosed(projectId, workspaceId, key, closed, userId) {
      const now = new Date().toISOString()
      const { data, error } = await getAdmin()
        .from('comment_threads')
        .upsert({
          project_id: projectId,
          workspace_id: workspaceId,
          model_id: key.model_id,
          entry_id: key.entry_id,
          locale: key.locale,
          closed_at: closed ? now : null,
          closed_by: closed ? (userId ?? null) : null,
          updated_at: now,
        }, { onConflict: 'project_id,model_id,entry_id,locale' })
        .select()
        .single()

      if (error || !data) {
        throw createError({ statusCode: 500, message: errorMessage('comments.update_failed', { detail: error?.message ?? 'unknown' }) })
      }
      return data as DatabaseRow
    },
  }
}
