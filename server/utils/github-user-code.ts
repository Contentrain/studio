/**
 * Finish GitHub's "authorize during installation" for the setup callback: the
 * `code` it sends back is exchanged, with the Studio App's own client
 * credentials, for the installing user's tokens, and the user is read with
 * them. Same client the sign-in uses (`NUXT_OAUTH_GITHUB_CLIENT_ID/SECRET`).
 */
import type { ProviderTokens } from '../providers/auth'

export interface GitHubInstallerIdentity {
  /** GitHub's numeric user id, as a decimal string. */
  id: string
  login: string
  tokens: ProviderTokens
}

const toUnixOrNull = (seconds: unknown): number | null =>
  typeof seconds === 'number' ? Math.floor(Date.now() / 1000) + seconds : null

/** The installer, or null when the code is not accepted or GitHub cannot be asked. */
export async function exchangeGitHubInstallCode(code: string): Promise<GitHubInstallerIdentity | null> {
  const github = (useRuntimeConfig().oauth as { github?: { clientId?: string, clientSecret?: string } } | undefined)?.github
  if (!github?.clientId || !github.clientSecret) return null

  try {
    const token = await $fetch<{
      access_token?: string
      refresh_token?: string
      expires_in?: number
      refresh_token_expires_in?: number
      error?: string
    }>('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: { client_id: github.clientId, client_secret: github.clientSecret, code },
    })
    if (token.error || !token.access_token) return null

    const user = await $fetch<{ id?: number, login?: string }>('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json' },
    })
    if (typeof user.id !== 'number') return null

    return {
      id: String(user.id),
      login: user.login ?? '',
      tokens: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? null,
        expiresAt: toUnixOrNull(token.expires_in),
        refreshTokenExpiresAt: toUnixOrNull(token.refresh_token_expires_in),
      },
    }
  }
  catch {
    return null
  }
}
