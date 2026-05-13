import type { DatabaseProvider } from '../database'
import { decryptApiKey, encryptApiKey } from '../../utils/encryption'
import { getAdmin } from './helpers'

/**
 * Encrypted storage for provider-side OAuth tokens (e.g. GitHub
 * `gho_*` / `ghu_*` user-to-server tokens captured from Supabase Auth).
 *
 * Tokens are encrypted at rest with the same AES-256-GCM helper used
 * for BYOA API keys (`server/utils/encryption.ts`) — versioned base64
 * with rotation support via NUXT_SESSION_SECRET_PREVIOUS. Decryption
 * failure (rotation without the previous secret set, or row written
 * by a different secret entirely) is treated as a missing token so
 * the caller drives re-authentication instead of throwing 500.
 */

type OAuthTokenMethods = Pick<
  DatabaseProvider,
  'upsertOAuthProviderToken' | 'getOAuthProviderToken' | 'deleteOAuthProviderToken'
>

function toIsoOrNull(unixSeconds: number | null): string | null {
  return unixSeconds === null ? null : new Date(unixSeconds * 1000).toISOString()
}

function fromIsoOrNull(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

export function oauthTokenMethods(): OAuthTokenMethods {
  return {
    async upsertOAuthProviderToken(input) {
      const config = useRuntimeConfig()
      const secret = config.sessionSecret as string
      if (!secret) throw createError({ statusCode: 500, message: 'NUXT_SESSION_SECRET is not configured' })

      const encryptedAccessToken = encryptApiKey(input.accessToken, secret)
      const encryptedRefreshToken = input.refreshToken ? encryptApiKey(input.refreshToken, secret) : null

      const { error } = await getAdmin().from('oauth_provider_tokens').upsert({
        user_id: input.userId,
        provider: input.provider,
        encrypted_access_token: encryptedAccessToken,
        encrypted_refresh_token: encryptedRefreshToken,
        access_token_expires_at: toIsoOrNull(input.expiresAt),
        refresh_token_expires_at: toIsoOrNull(input.refreshTokenExpiresAt),
      }, { onConflict: 'user_id,provider' })

      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    async getOAuthProviderToken(userId, provider) {
      const config = useRuntimeConfig()
      const secret = config.sessionSecret as string
      const previousSecret = (config.sessionSecretPrevious as string) || undefined
      if (!secret) throw createError({ statusCode: 500, message: 'NUXT_SESSION_SECRET is not configured' })

      const { data, error } = await getAdmin()
        .from('oauth_provider_tokens')
        .select('encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at')
        .eq('user_id', userId)
        .eq('provider', provider)
        .maybeSingle()

      if (error && error.code !== 'PGRST116')
        throw createError({ statusCode: 500, message: error.message })
      if (!data) return null

      const encryptedAccess = data.encrypted_access_token as string
      const encryptedRefresh = data.encrypted_refresh_token as string | null

      try {
        return {
          accessToken: decryptApiKey(encryptedAccess, secret, previousSecret),
          refreshToken: encryptedRefresh ? decryptApiKey(encryptedRefresh, secret, previousSecret) : null,
          expiresAt: fromIsoOrNull(data.access_token_expires_at),
          refreshTokenExpiresAt: fromIsoOrNull(data.refresh_token_expires_at),
        }
      }
      catch {
        return null
      }
    },

    async deleteOAuthProviderToken(userId, provider) {
      const { error } = await getAdmin()
        .from('oauth_provider_tokens')
        .delete()
        .eq('user_id', userId)
        .eq('provider', provider)

      if (error) throw createError({ statusCode: 500, message: error.message })
    },
  }
}
