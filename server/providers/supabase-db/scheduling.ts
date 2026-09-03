/**
 * Deploy target + scheduled publication methods (Supabase DatabaseProvider).
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin } from './helpers'

type SchedulingMethods = Pick<
  DatabaseProvider,
  | 'setProjectDeployTarget'
  | 'upsertScheduledPublications'
  | 'clearScheduledPublications'
  | 'claimDueScheduledPublications'
  | 'listPendingScheduledPublications'
>

export function schedulingMethods(): SchedulingMethods {
  return {
    async setProjectDeployTarget(projectId, target) {
      const { error } = await getAdmin()
        .from('projects')
        .update({ deploy_target: target })
        .eq('id', projectId)
      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    async upsertScheduledPublications(rows) {
      if (rows.length === 0) return
      const now = new Date().toISOString()
      const { error } = await getAdmin()
        .from('scheduled_publications')
        .upsert(rows.map(r => ({ ...r, fired_at: null, updated_at: now })), { onConflict: 'project_id,model_id,entry_id,locale,kind' })
      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    async clearScheduledPublications(projectId, modelId, entryIds, locale, kinds) {
      if (entryIds.length === 0) return
      let query = getAdmin()
        .from('scheduled_publications')
        .delete()
        .eq('project_id', projectId)
        .eq('model_id', modelId)
        .in('entry_id', entryIds)
        .is('fired_at', null)
      if (locale) query = query.eq('locale', locale)
      if (kinds?.length) query = query.in('kind', kinds)
      const { error } = await query
      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    async claimDueScheduledPublications(now, limit) {
      const { data, error } = await getAdmin().rpc('claim_due_scheduled_publications', {
        p_now: now.toISOString(),
        p_limit: limit,
      })
      if (error) throw createError({ statusCode: 500, message: error.message })
      return (data ?? []) as DatabaseRow[]
    },

    async listPendingScheduledPublications(projectId) {
      const { data, error } = await getAdmin()
        .from('scheduled_publications')
        .select('*')
        .eq('project_id', projectId)
        .is('fired_at', null)
        .order('fire_at', { ascending: true })
        .limit(200)
      if (error) throw createError({ statusCode: 500, message: error.message })
      return (data ?? []) as DatabaseRow[]
    },
  }
}
