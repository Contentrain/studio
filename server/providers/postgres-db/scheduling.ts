/**
 * Deploy target + scheduled publication methods (plain-Postgres DatabaseProvider).
 * Behavior parity with supabase-db/scheduling.ts.
 */
import { sql } from 'kysely'
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

function detail(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown'
}

export function schedulingMethods(): SchedulingMethods {
  return {
    async setProjectDeployTarget(projectId, target) {
      try {
        await getAdmin()
          .updateTable('projects')
          .set({ deploy_target: target ? JSON.stringify(target) : null } as never)
          .where('id', '=', projectId)
          .execute()
      }
      catch (error) {
        throw createError({ statusCode: 500, message: detail(error) })
      }
    },

    async upsertScheduledPublications(rows) {
      if (rows.length === 0) return
      const now = new Date().toISOString()
      try {
        await getAdmin()
          .insertInto('scheduled_publications')
          .values(rows.map(r => ({ ...r, fired_at: null, updated_at: now })) as never)
          .onConflict(oc => oc
            .columns(['project_id', 'model_id', 'entry_id', 'locale', 'kind'])
            .doUpdateSet({
              fire_at: sql`excluded.fire_at`,
              workspace_id: sql`excluded.workspace_id`,
              fired_at: null,
              updated_at: now,
            } as never))
          .execute()
      }
      catch (error) {
        throw createError({ statusCode: 500, message: detail(error) })
      }
    },

    async clearScheduledPublications(projectId, modelId, entryIds, locale, kinds) {
      if (entryIds.length === 0) return
      try {
        let query = getAdmin()
          .deleteFrom('scheduled_publications')
          .where('project_id', '=', projectId)
          .where('model_id', '=', modelId)
          .where('entry_id', 'in', entryIds)
          .where('fired_at', 'is', null)
        if (locale) query = query.where('locale', '=', locale)
        if (kinds?.length) query = query.where('kind', 'in', kinds)
        await query.execute()
      }
      catch (error) {
        throw createError({ statusCode: 500, message: detail(error) })
      }
    },

    async claimDueScheduledPublications(now, limit) {
      try {
        const result = await sql<DatabaseRow>`
          SELECT * FROM public.claim_due_scheduled_publications(${now.toISOString()}::timestamptz, ${limit})
        `.execute(getAdmin())
        return result.rows
      }
      catch (error) {
        throw createError({ statusCode: 500, message: detail(error) })
      }
    },

    async listPendingScheduledPublications(projectId) {
      try {
        const rows = await getAdmin()
          .selectFrom('scheduled_publications')
          .selectAll()
          .where('project_id', '=', projectId)
          .where('fired_at', 'is', null)
          .orderBy('fire_at', 'asc')
          .limit(200)
          .execute()
        return rows as DatabaseRow[]
      }
      catch {
        return []
      }
    },
  }
}
