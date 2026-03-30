import { useDatabaseProvider } from './providers'

/**
 * Legacy compatibility shim.
 *
 * Application code is migrating to DatabaseProvider, but older routes/helpers
 * still call `useSupabaseAdmin()` / `useSupabaseUserClient()`. Keep those
 * names delegating through the active DatabaseProvider so adapter swaps only
 * require provider changes, not app-wide rewrites.
 */
export function useSupabaseAdmin() {
  return useDatabaseProvider().getAdminClient()
}

/**
 * Legacy compatibility shim for user-scoped database access.
 */
export function useSupabaseUserClient(accessToken: string) {
  return useDatabaseProvider().getUserClient(accessToken)
}
