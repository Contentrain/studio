/**
 * Shared Supabase client factory — internal to the Supabase adapter layer.
 *
 * Both supabase-auth.ts and supabase-db.ts import from here.
 * This file is NOT part of the public provider interface.
 * It must NEVER be imported outside of server/providers/supabase-*.ts files.
 */
import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

let _adminClient: SupabaseClient | null = null

/**
 * Service-role admin client (singleton).
 * Bypasses RLS — use only for admin operations after app-level auth checks.
 */
export function createSupabaseAdminClient(): SupabaseClient {
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
 * Per-request user client with RLS-enforced access token.
 * Created fresh per request — do NOT cache.
 */
export function createSupabaseUserClient(accessToken: string): SupabaseClient {
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
