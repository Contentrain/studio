import type { DatabaseProvider, DatabaseRow } from '../database'
import { throwDbError, withUser } from './helpers'

const PROFILE_SELECT = ['id', 'display_name', 'email', 'avatar_url', 'theme', 'created_at'] as const

type ProfileMethods = Pick<DatabaseProvider, 'getProfile' | 'updateProfile'>

export function profileMethods(): ProfileMethods {
  return {
    async getProfile(accessToken, userId) {
      try {
        return await withUser(accessToken, async (trx) => {
          const row = await trx
            .selectFrom('profiles')
            .select(PROFILE_SELECT)
            .where('id', '=', userId)
            .executeTakeFirst()

          // RLS self-scope: a foreign userId yields no row → null, matching
          // the Supabase implementation's PGRST116 → null path.
          return (row as DatabaseRow | undefined) ?? null
        })
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async updateProfile(accessToken, userId, updates) {
      try {
        return await withUser(accessToken, async (trx) => {
          const changes = Object.fromEntries(
            Object.entries(updates).filter(([, value]) => value !== undefined),
          ) as typeof updates

          const row = await trx
            .updateTable('profiles')
            .set(changes)
            .where('id', '=', userId)
            .returning(PROFILE_SELECT)
            .executeTakeFirst()

          // RLS-blocked or missing row — the Supabase impl's .single() throws
          // a 500 here; keep the same contract.
          if (!row)
            throw createError({ statusCode: 500, message: 'Invalid database response' })

          return row as DatabaseRow
        })
      }
      catch (error) {
        throwDbError(error)
      }
    },
  }
}
