import type { AuthProvider } from '../providers/auth'
import { createSupabaseAuthProvider } from '../providers/supabase-auth'

/**
 * Singleton provider instances.
 *
 * All server code accesses providers through this factory — never by
 * importing concrete implementations directly. Swap the create*() call
 * to switch providers (e.g. AuthJS, Clerk, plain OAuth).
 */

let _authProvider: AuthProvider | null = null

export function useAuthProvider(): AuthProvider {
  if (!_authProvider)
    _authProvider = createSupabaseAuthProvider()

  return _authProvider
}
