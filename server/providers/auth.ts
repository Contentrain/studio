import type { H3Event } from 'h3'

export interface AuthUser {
  id: string
  email: string | null
  avatarUrl: string | null
  provider: 'github' | 'google' | 'email' | null
  providerAccountId: string | null
}

export interface AuthSession {
  user: AuthUser
  accessToken: string
  refreshToken: string | null
}

export interface OAuthRedirectResult {
  url: string
}

export interface AuthProvider {
  /**
   * Get the current session from request headers
   */
  getSession: (event: H3Event) => Promise<AuthSession | null>

  /**
   * Generate OAuth redirect URL for a given provider
   */
  getOAuthRedirectUrl: (provider: 'github' | 'google', redirectTo: string) => Promise<OAuthRedirectResult>

  /**
   * Exchange OAuth callback code for session
   */
  handleOAuthCallback: (event: H3Event) => Promise<AuthSession>

  /**
   * Send magic link email
   */
  sendMagicLink: (email: string, redirectTo: string) => Promise<void>

  /**
   * Sign out and invalidate session
   */
  signOut: (event: H3Event) => Promise<void>

  /**
   * Invite a user by email (creates account if not exists)
   */
  inviteUserByEmail: (email: string) => Promise<{ userId: string }>

  /**
   * Get user by ID
   */
  getUserById: (userId: string) => Promise<AuthUser | null>
}
