import type { DatabaseProvider, DatabaseRow } from '../database'
import { getUser, toDatabaseRow } from './helpers'

const PROFILE_SELECT = 'id, display_name, email, avatar_url, created_at'

type ProfileMethods = Pick<DatabaseProvider, 'getProfile' | 'updateProfile'>

export function profileMethods(): ProfileMethods {
  return {
    async getProfile(accessToken: string, userId: string): Promise<DatabaseRow | null> {
      const client = getUser(accessToken)
      const { data, error } = await client
        .from('profiles')
        .select(PROFILE_SELECT)
        .eq('id', userId)
        .single()

      if (error) {
        if (error.code === 'PGRST116') return null
        throw createError({ statusCode: 500, message: error.message })
      }
      return data as DatabaseRow
    },

    async updateProfile(accessToken: string, userId: string, updates: { display_name?: string }): Promise<DatabaseRow> {
      const client = getUser(accessToken)
      const { data, error } = await client
        .from('profiles')
        .update(updates)
        .eq('id', userId)
        .select(PROFILE_SELECT)
        .single()

      if (error) throw createError({ statusCode: 500, message: error.message })
      return toDatabaseRow(data)
    },
  }
}
