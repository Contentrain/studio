/**
 * Provider-agnostic auth interface.
 *
 * Session management (encrypted cookies, refresh orchestration) lives in
 * server/utils/session.ts — NOT here.
 *
 * AuthProvider is responsible only for:
 *  - Validating tokens (is this token still good?)
 *  - Refreshing tokens (give me new ones)
 *  - OAuth redirect URL generation
 *  - Token exchange (code → session data)
 *  - Magic link / invite
 *  - User lookup
 *
 * Current impl: Supabase (server/providers/supabase-auth.ts)
 * Future impls: AuthJS, Clerk, plain OAuth + JWT, etc.
 */

export interface AuthUser {
  id: string
  email: string | null
  avatarUrl: string | null
  provider: 'github' | 'google' | 'email' | null
  providerAccountId: string | null
}

export interface AuthTokens {
  accessToken: string
  refreshToken: string | null
  expiresAt: number // Unix timestamp in seconds
}

export interface AuthSession {
  user: AuthUser
  tokens: AuthTokens
}

export interface OAuthRedirectResult {
  url: string
  /** Provider-managed state token for CSRF protection. */
  state?: string
}

export interface AuthProvider {
  /**
   * Validate an access token and return the associated user.
   * Returns null if the token is expired or invalid.
   */
  validateToken: (accessToken: string) => Promise<AuthUser | null>

  /**
   * Refresh an expired session using a refresh token.
   * Returns new token set, or null if refresh is not possible.
   */
  refreshSession: (refreshToken: string) => Promise<AuthTokens | null>

  /**
   * Generate OAuth redirect URL for a given provider.
   */
  getOAuthRedirectUrl: (provider: 'github' | 'google', redirectTo: string) => Promise<OAuthRedirectResult>

  /**
   * Exchange an OAuth authorization code for a full session.
   * State is provider-managed — validated by provider if applicable.
   */
  exchangeCode: (code: string, state?: string) => Promise<AuthSession>

  /**
   * Exchange raw tokens (from OAuth hash callback) for a full session.
   */
  exchangeTokens: (accessToken: string, refreshToken?: string) => Promise<AuthSession>

  /**
   * Send magic link email.
   */
  sendMagicLink: (email: string, redirectTo: string) => Promise<void>

  /**
   * Invite a user by email (creates account if not exists).
   */
  inviteUserByEmail: (email: string, options?: { redirectTo?: string }) => Promise<{ userId: string }>

  /**
   * Look up a user by their ID.
   */
  getUserById: (userId: string) => Promise<AuthUser | null>
}
