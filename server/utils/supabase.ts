import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

let _adminClient: SupabaseClient | null = null

/**
 * Server-side Supabase admin client (service_role key).
 * Used for privileged operations: invite users, manage auth, bypass RLS.
 */
export function useSupabaseAdmin(): SupabaseClient {
  if (_adminClient)
    return _adminClient

  const config = useRuntimeConfig()

  _adminClient = createClient(
    config.supabase.url,
    config.supabase.serviceRoleKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  )

  return _adminClient
}

/**
 * Server-side Supabase client scoped to a user's session.
 * Respects RLS policies.
 */
export function useSupabaseUserClient(accessToken: string): SupabaseClient {
  const config = useRuntimeConfig()

  return createClient(
    config.supabase.url,
    config.supabase.anonKey,
    {
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  )
}
