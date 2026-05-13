/**
 * Resolve a usable GitHub user OAuth token for the given user, refreshing
 * it lazily if the stored copy has expired.
 *
 * Returns:
 *  - `string` — a valid access token, ready for `GET /user/installations`
 *    and similar user-scoped GitHub API calls.
 *  - `null` — the user has no stored token (Google sign-in / magic link /
 *    never went through GitHub OAuth) OR the stored token expired AND
 *    the refresh attempt failed. Either case requires the user to
 *    re-authenticate with GitHub; the stored row (if any) has already
 *    been deleted so subsequent reads return null until reauth completes.
 *
 * Refresh policy (PostHog pattern):
 *  - Token still has >60s before expiry → return as-is (no refresh).
 *  - Token expiring or expired + we have a refresh token →
 *    `AuthProvider.refreshProviderToken('github', ...)`; persist the
 *    new pair; return the fresh access token.
 *  - Refresh failed (provider returned `bad_refresh_token` /
 *    `bad_credentials`, or network error) → delete the stored row and
 *    return null.
 *
 * Concurrency note: this is not protected against two requests racing
 * to refresh the same token. GitHub's refresh endpoint is idempotent in
 * the success case (returns the same new pair for ~5s after first call)
 * but rotates the refresh token; a race could leave one request with a
 * stale refresh token and the next refresh attempt would fail. For the
 * traffic this code serves (interactive user actions, not high-RPS),
 * the race window is too narrow to justify a locking layer.
 */
export async function getValidGitHubUserToken(userId: string): Promise<string | null> {
  const db = useDatabaseProvider()
  const stored = await db.getOAuthProviderToken(userId, 'github')
  if (!stored) return null

  const now = Math.floor(Date.now() / 1000)
  // Non-expiring (legacy OAuth Apps): use as-is.
  if (stored.expiresAt === null) return stored.accessToken
  // Still valid with at least 60s headroom.
  if (stored.expiresAt > now + 60) return stored.accessToken

  // Expired (or about to expire). Need refresh token to recover.
  if (!stored.refreshToken) {
    await db.deleteOAuthProviderToken(userId, 'github')
    return null
  }

  const auth = useAuthProvider()
  const refreshed = await auth.refreshProviderToken('github', stored.refreshToken)
  if (!refreshed) {
    await db.deleteOAuthProviderToken(userId, 'github')
    return null
  }

  await db.upsertOAuthProviderToken({
    userId,
    provider: 'github',
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
    refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt,
  })
  return refreshed.accessToken
}

/**
 * Standard error code returned by endpoints that require a GitHub user
 * OAuth token but couldn't obtain one (no stored token or refresh
 * failed). The frontend listens for this code to trigger the
 * "Reconnect GitHub" reauth flow.
 */
export const GITHUB_REAUTH_REQUIRED_CODE = 'GITHUB_REAUTH_REQUIRED'
