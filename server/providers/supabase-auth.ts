import type { H3Event } from 'h3'
import { getCookie, getHeader } from 'h3'
import type { AuthProvider, AuthSession, AuthUser, OAuthRedirectResult } from './auth'

export function createSupabaseAuthProvider(): AuthProvider {
  return {
    async getSession(event: H3Event): Promise<AuthSession | null> {
      let accessToken: string | null = null

      const authorization = getHeader(event, 'authorization')
      if (authorization?.startsWith('Bearer '))
        accessToken = authorization.slice(7)

      if (!accessToken) {
        const sessionCookie = getCookie(event, 'auth-session')
        if (sessionCookie) {
          try {
            const parsed = JSON.parse(sessionCookie)
            accessToken = parsed.accessToken ?? null
          }
          catch (e) {
            void e
          }
        }
      }

      if (!accessToken)
        return null

      const admin = useSupabaseAdmin()
      const { data, error } = await admin.auth.getUser(accessToken)

      if (error || !data.user)
        return null

      const user = data.user
      const provider = user.app_metadata?.provider as AuthUser['provider'] ?? null

      return {
        user: {
          id: user.id,
          email: user.email ?? null,
          avatarUrl: user.user_metadata?.avatar_url ?? null,
          provider,
          providerAccountId: user.user_metadata?.provider_id ?? null,
        },
        accessToken,
        refreshToken: null,
      }
    },

    async getOAuthRedirectUrl(provider: 'github' | 'google', redirectTo: string): Promise<OAuthRedirectResult> {
      const admin = useSupabaseAdmin()
      const config = useRuntimeConfig()

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

      return { url: data.url }
    },

    async handleOAuthCallback(event: H3Event): Promise<AuthSession> {
      const query = getQuery(event) as { access_token?: string, refresh_token?: string }

      if (!query.access_token)
        throw createError({ statusCode: 400, message: 'Missing access_token in callback' })

      const admin = useSupabaseAdmin()
      const { data, error } = await admin.auth.getUser(query.access_token)

      if (error || !data.user)
        throw createError({ statusCode: 401, message: `Auth callback failed: ${error?.message}` })

      const user = data.user
      const provider = user.app_metadata?.provider as AuthUser['provider'] ?? null

      return {
        user: {
          id: user.id,
          email: user.email ?? null,
          avatarUrl: user.user_metadata?.avatar_url ?? null,
          provider,
          providerAccountId: user.user_metadata?.provider_id ?? null,
        },
        accessToken: query.access_token,
        refreshToken: query.refresh_token ?? null,
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

    async signOut(event: H3Event): Promise<void> {
      const authorization = getHeader(event, 'authorization')
      if (!authorization?.startsWith('Bearer '))
        return

      const admin = useSupabaseAdmin()
      // Supabase admin can revoke a user's session via their JWT
      // For now, client-side sign out is sufficient
      // Server just acknowledges
      void admin
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

      const user = data.user
      const provider = user.app_metadata?.provider as AuthUser['provider'] ?? null

      return {
        id: user.id,
        email: user.email ?? null,
        avatarUrl: user.user_metadata?.avatar_url ?? null,
        provider,
        providerAccountId: user.user_metadata?.provider_id ?? null,
      }
    },
  }
}
