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

/**
 * OAuth provider tokens (e.g. GitHub `gho_*`/`ghu_*` user-to-server tokens
 * obtained via Supabase OAuth sign-in). Surfaced separately from
 * `AuthTokens` (which are the AuthProvider's own session tokens, e.g.
 * Supabase JWT) because they have different lifecycles and storage
 * requirements: provider tokens need encrypted persistence to enable
 * later API calls against the provider (e.g. `GET /user/installations`).
 */
export interface ProviderTokens {
  accessToken: string
  refreshToken: string | null
  /** Unix seconds. `null` = non-expiring (legacy OAuth Apps; GitHub Apps with expiring tokens off). */
  expiresAt: number | null
  /** Unix seconds. `null` = non-expiring refresh token. */
  refreshTokenExpiresAt: number | null
}

export interface AuthSession {
  user: AuthUser
  tokens: AuthTokens
  /**
   * Provider-side OAuth tokens, when the sign-in used an external OAuth
   * provider (GitHub / Google). `null` for magic-link or non-OAuth flows.
   * Captured at exchange time only — AuthProvider does not persist these
   * itself; caller is responsible for storing them via DatabaseProvider.
   */
  providerTokens?: ProviderTokens | null
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
   * Refresh an expired OAuth provider token (e.g. GitHub user-to-server
   * token, 8h TTL). Implementations call the provider's own refresh
   * endpoint — Supabase does not refresh provider tokens itself.
   *
   * Returns the new provider token set, or null if refresh failed
   * (refresh token expired, revoked, or provider returned an error).
   * Callers must treat null as "user must re-authenticate with the
   * provider" and clear any stored copy.
   */
  refreshProviderToken: (provider: 'github' | 'google', refreshToken: string) => Promise<ProviderTokens | null>

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

  /**
   * Look up a user by their email address.
   */
  getUserByEmail: (email: string) => Promise<AuthUser | null>

  /**
   * Delete a user account permanently.
   * Cascades to profiles, workspaces (owned), memberships, etc.
   */
  deleteUser: (userId: string) => Promise<void>

  /**
   * Revoke the server-side session behind a refresh token (logout).
   * Optional: cookie-only providers (Supabase pair — GoTrue sessions are
   * not tracked here) simply omit it; the managed pair revokes the whole
   * rotation family so the refresh token can never mint again.
   */
  revokeSession?: (refreshToken: string) => Promise<void>
}
