import type { AuthProvider, AuthSession, AuthTokens, AuthUser, OAuthRedirectResult } from './auth'

/**
 * Supabase implementation of AuthProvider.
 *
 * Uses Supabase Admin client (service_role key) for all operations.
 * Token validation, refresh, and user lookup all go through Supabase Auth API.
 */
export function createSupabaseAuthProvider(): AuthProvider {
  return {
    async validateToken(accessToken: string): Promise<AuthUser | null> {
      const admin = useSupabaseAdmin()
      const { data, error } = await admin.auth.getUser(accessToken)

      if (error || !data.user)
        return null

      return mapSupabaseUser(data.user)
    },

    async refreshSession(refreshToken: string): Promise<AuthTokens | null> {
      const admin = useSupabaseAdmin()
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
      const admin = useSupabaseAdmin()
      const config = useRuntimeConfig()

      // Generate CSRF state token — stored by caller, validated on code exchange
      const { randomBytes } = await import('node:crypto')
      const state = randomBytes(32).toString('hex')

      const { data, error } = await admin.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: `${config.public.siteUrl}${redirectTo}`,
          skipBrowserRedirect: true,
          scopes: provider === 'github' ? 'read:user user:email' : undefined,
        },
      })

      if (error || !data.url)
        throw createError({ statusCode: 500, message: `OAuth redirect failed: ${error?.message}` })

      // State is NOT appended to URL — Supabase manages its own OAuth state/PKCE
      // Our state is stored in a server cookie and validated separately on callback
      return { url: data.url, state }
    },

    async exchangeCode(code: string, _state?: string): Promise<AuthSession> {
      // State validation is done at the route level (session cookie comparison)
      // Supabase PKCE handles the code_verifier/code_challenge exchange
      const admin = useSupabaseAdmin()
      const { data, error } = await admin.auth.exchangeCodeForSession(code)

      if (error || !data.session)
        throw createError({ statusCode: 401, message: `Code exchange failed: ${error?.message}` })

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
      const admin = useSupabaseAdmin()
      const { data, error } = await admin.auth.getUser(accessToken)

      if (error || !data.user)
        throw createError({ statusCode: 401, message: `Token validation failed: ${error?.message}` })

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
      const admin = useSupabaseAdmin()
      const config = useRuntimeConfig()

      const { error } = await admin.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${config.public.siteUrl}${redirectTo}`,
        },
      })

      if (error)
        throw createError({ statusCode: 500, message: `Magic link failed: ${error.message}` })
    },

    async inviteUserByEmail(email: string): Promise<{ userId: string }> {
      const admin = useSupabaseAdmin()
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email)

      if (error)
        throw createError({ statusCode: 500, message: `Invite failed: ${error.message}` })

      return { userId: data.user.id }
    },

    async getUserById(userId: string): Promise<AuthUser | null> {
      const admin = useSupabaseAdmin()
      const { data, error } = await admin.auth.admin.getUserById(userId)

      if (error || !data.user)
        return null

      return mapSupabaseUser(data.user)
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
