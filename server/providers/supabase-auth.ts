import type { AuthProvider, AuthSession, AuthTokens, AuthUser, OAuthRedirectResult } from './auth'
import { createSupabaseAdminClient } from './supabase-client'

/**
 * Supabase implementation of AuthProvider.
 *
 * Uses Supabase Admin client (service_role key) for all operations.
 * Token validation, refresh, and user lookup all go through Supabase Auth API.
 */
export function createSupabaseAuthProvider(): AuthProvider {
  return {
    async validateToken(accessToken: string): Promise<AuthUser | null> {
      const admin = createSupabaseAdminClient()
      const { data, error } = await admin.auth.getUser(accessToken)

      if (error || !data.user)
        return null

      return mapSupabaseUser(data.user)
    },

    async refreshSession(refreshToken: string): Promise<AuthTokens | null> {
      const admin = createSupabaseAdminClient()
      const { data, error } = await admin.auth.refreshSession({ refresh_token: refreshToken })

      if (error || !data.session)
        return null

      return {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token ?? null,
        expiresAt: data.session.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
      }
    },

    async getOAuthRedirectUrl(provider: 'github' | 'google', redirectTo: string): Promise<OAuthRedirectResult> {
      const admin = createSupabaseAdminClient()
      const config = useRuntimeConfig()

      // Generate CSRF state token — stored by caller, validated on code exchange
      const { randomBytes } = await import('node:crypto')
      const state = randomBytes(32).toString('hex')

      const { data, error } = await admin.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: redirectTo.startsWith('http') ? redirectTo : `${config.public.siteUrl}${redirectTo}`,
          skipBrowserRedirect: true,
          // Let Supabase handle default scopes per provider
        },
      })

      if (error || !data.url)
        throw createError({ statusCode: 500, message: errorMessage('auth.oauth_redirect_failed', { detail: error?.message ?? 'Unknown error' }) })

      // State is NOT appended to URL — Supabase manages its own OAuth state/PKCE
      // Our state is stored in a server cookie and validated separately on callback
      return { url: data.url, state }
    },

    async exchangeCode(code: string, _state?: string): Promise<AuthSession> {
      // State validation is done at the route level (session cookie comparison)
      // Supabase PKCE handles the code_verifier/code_challenge exchange
      const admin = createSupabaseAdminClient()
      const { data, error } = await admin.auth.exchangeCodeForSession(code)

      if (error || !data.session)
        throw createError({ statusCode: 401, message: errorMessage('auth.code_exchange_failed', { detail: error?.message ?? 'Unknown error' }) })

      return {
        user: mapSupabaseUser(data.user),
        tokens: {
          accessToken: data.session.access_token,
          refreshToken: data.session.refresh_token ?? null,
          expiresAt: data.session.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
        },
      }
    },

    async exchangeTokens(accessToken: string, refreshToken?: string): Promise<AuthSession> {
      const admin = createSupabaseAdminClient()
      const { data, error } = await admin.auth.getUser(accessToken)

      if (error || !data.user)
        throw createError({ statusCode: 401, message: errorMessage('auth.token_validation_failed', { detail: error?.message ?? 'Unknown error' }) })

      // Decode JWT exp claim for accurate expiry
      let expiresAt = Math.floor(Date.now() / 1000) + 3600
      try {
        const payload = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64').toString())
        if (payload.exp) expiresAt = payload.exp
      }
      catch { /* fallback to 1 hour */ }

      return {
        user: mapSupabaseUser(data.user),
        tokens: {
          accessToken,
          refreshToken: refreshToken ?? null,
          expiresAt,
        },
      }
    },

    async sendMagicLink(email: string, redirectTo: string): Promise<void> {
      const admin = createSupabaseAdminClient()
      const config = useRuntimeConfig()

      const { error } = await admin.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${config.public.siteUrl}${redirectTo}`,
        },
      })

      if (error)
        throw createError({ statusCode: 500, message: errorMessage('auth.magic_link_failed', { detail: error.message }) })
    },

    async inviteUserByEmail(email: string, options?: { redirectTo?: string }): Promise<{ userId: string }> {
      const admin = createSupabaseAdminClient()
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo: options?.redirectTo,
      })

      if (error)
        throw createError({ statusCode: 500, message: errorMessage('auth.invite_failed', { detail: error.message }) })

      return { userId: data.user.id }
    },

    async getUserById(userId: string): Promise<AuthUser | null> {
      const admin = createSupabaseAdminClient()
      const { data, error } = await admin.auth.admin.getUserById(userId)

      if (error || !data.user)
        return null

      return mapSupabaseUser(data.user)
    },

    async getUserByEmail(email: string): Promise<AuthUser | null> {
      const admin = createSupabaseAdminClient()
      let page = 1
      const perPage = 1000
      while (true) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage })
        if (error) throw error
        const user = data?.users?.find(u => u.email === email)
        if (user) return mapSupabaseUser(user)
        if (!data?.users || data.users.length < perPage) break
        page++
      }
      return null
    },

    async deleteUser(userId: string): Promise<void> {
      const admin = createSupabaseAdminClient()
      const { error } = await admin.auth.admin.deleteUser(userId)
      if (error) {
        throw createError({ statusCode: 500, message: error.message })
      }
    },
  }
}

/**
 * Map Supabase User object to our AuthUser shape.
 */
function mapSupabaseUser(user: { id: string, email?: string, app_metadata?: Record<string, unknown>, user_metadata?: Record<string, unknown> }): AuthUser {
  return {
    id: user.id,
    email: user.email ?? null,
    avatarUrl: (user.user_metadata?.avatar_url as string) ?? null,
    provider: (user.app_metadata?.provider as AuthUser['provider']) ?? null,
    providerAccountId: (user.user_metadata?.provider_id as string) ?? null,
  }
}
