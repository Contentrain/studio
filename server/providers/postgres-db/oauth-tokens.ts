import type { DatabaseProvider } from '../database'
import { decryptApiKey, encryptApiKey } from '../../utils/encryption'
import { getAdmin, throwDbError } from './helpers'

/**
 * Encrypted storage for provider-side OAuth tokens (e.g. GitHub
 * `gho_*` / `ghu_*` user-to-server tokens).
 *
 * Byte-for-byte the same at-rest format as the Supabase implementation:
 * AES-256-GCM via `server/utils/encryption.ts`, keyed off NUXT_SESSION_SECRET
 * (rotation via NUXT_SESSION_SECRET_PREVIOUS). Decryption failure is treated
 * as a missing token so the caller drives re-authentication instead of
 * throwing 500.
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

      const values = {
        encrypted_access_token: encryptApiKey(input.accessToken, secret),
        encrypted_refresh_token: input.refreshToken ? encryptApiKey(input.refreshToken, secret) : null,
        access_token_expires_at: toIsoOrNull(input.expiresAt),
        refresh_token_expires_at: toIsoOrNull(input.refreshTokenExpiresAt),
      }

      try {
        await getAdmin()
          .insertInto('oauth_provider_tokens')
          .values({ user_id: input.userId, provider: input.provider, ...values })
          .onConflict(oc => oc.columns(['user_id', 'provider']).doUpdateSet(values))
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async getOAuthProviderToken(userId, provider) {
      const config = useRuntimeConfig()
      const secret = config.sessionSecret as string
      const previousSecret = (config.sessionSecretPrevious as string) || undefined
      if (!secret) throw createError({ statusCode: 500, message: 'NUXT_SESSION_SECRET is not configured' })

      let row
      try {
        row = await getAdmin()
          .selectFrom('oauth_provider_tokens')
          .select(['encrypted_access_token', 'encrypted_refresh_token', 'access_token_expires_at', 'refresh_token_expires_at'])
          .where('user_id', '=', userId)
          .where('provider', '=', provider)
          .executeTakeFirst()
      }
      catch (error) {
        throwDbError(error)
      }

      if (!row) return null

      try {
        return {
          accessToken: decryptApiKey(row.encrypted_access_token, secret, previousSecret),
          refreshToken: row.encrypted_refresh_token
            ? decryptApiKey(row.encrypted_refresh_token, secret, previousSecret)
            : null,
          expiresAt: fromIsoOrNull(row.access_token_expires_at),
          refreshTokenExpiresAt: fromIsoOrNull(row.refresh_token_expires_at),
        }
      }
      catch {
        return null
      }
    },

    async deleteOAuthProviderToken(userId, provider) {
      try {
        await getAdmin()
          .deleteFrom('oauth_provider_tokens')
          .where('user_id', '=', userId)
          .where('provider', '=', provider)
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },
  }
}
