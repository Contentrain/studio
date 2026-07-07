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
let _authFlowClient: SupabaseClient | null = null

/**
 * Service-role admin client (singleton).
 * Bypasses RLS — use only for admin operations after app-level auth checks.
 *
 * NEVER call user-session GoTrue methods (`refreshSession`,
 * `exchangeCodeForSession`, `signInWith*`, `setSession`) on this client —
 * use `createSupabaseAuthFlowClient()` instead. supabase-js prefers the
 * client's in-memory auth session over the API key when building the
 * PostgREST Authorization header, so a user session landing here would
 * downgrade every "admin" query to that user's RLS scope for the whole
 * process. The explicit global Authorization header below pins REST
 * requests to the service-role key as a second line of defense
 * (supabase-js only injects the session token when the header is absent).
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
      global: {
        headers: {
          Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
        },
      },
    },
  )

  return _adminClient
}

/**
 * Auth-flow client (singleton) — user-session GoTrue operations ONLY.
 *
 * `refreshSession()` and `exchangeCodeForSession()` store the resulting
 * user session in the client's in-memory storage (`persistSession: false`
 * only disables disk persistence), and supabase-js then serves every
 * PostgREST request on that client with the session's access token
 * instead of the API key. When these flows ran on the admin client, the
 * first token auto-refresh silently downgraded it to that user's RLS
 * scope until the next redeploy — RLS-protected reads like
 * `payment_accounts` (no user policies) returned empty and every
 * workspace rendered as the free plan.
 *
 * This client keeps those session-bearing flows isolated: it is NEVER
 * used for `.from()` queries, so whatever session it accumulates is
 * inert. It also owns the in-memory PKCE code-verifier storage shared
 * between `signInWithOAuth` and `exchangeCodeForSession`, which is why
 * it must stay a process-wide singleton rather than per-call.
 */
export function createSupabaseAuthFlowClient(): SupabaseClient {
  if (_authFlowClient)
    return _authFlowClient

  const config = useRuntimeConfig()
  _authFlowClient = createClient(
    config.supabase.url,
    config.supabase.serviceRoleKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  )

  return _authFlowClient
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
