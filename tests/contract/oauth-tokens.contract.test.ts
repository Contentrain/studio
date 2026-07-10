import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { oauthTokenMethods } from '../../server/providers/postgres-db/oauth-tokens'
import { deleteSeededUser, getDb, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

describe('postgres-db oauth-tokens (contract)', () => {
  const methods = oauthTokenMethods()
  let user: SeededUser

  beforeAll(async () => {
    user = await seedUser('oauth')
  })

  afterAll(async () => {
    await deleteSeededUser(user.userId)
  })

  it('round-trips an encrypted token with unix-second expiries', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600

    await methods.upsertOAuthProviderToken({
      userId: user.userId,
      provider: 'github',
      accessToken: 'gho_contract_access_token',
      refreshToken: 'ghr_contract_refresh_token',
      expiresAt,
      refreshTokenExpiresAt: null,
    })

    const stored = await methods.getOAuthProviderToken(user.userId, 'github')

    expect(stored).not.toBeNull()
    expect(stored!.accessToken).toBe('gho_contract_access_token')
    expect(stored!.refreshToken).toBe('ghr_contract_refresh_token')
    expect(stored!.expiresAt).toBe(expiresAt)
    expect(stored!.refreshTokenExpiresAt).toBeNull()
  })

  it('stores ciphertext at rest, not the raw token', async () => {
    const row = await sql<{ encrypted_access_token: string }>`
      SELECT encrypted_access_token FROM public.oauth_provider_tokens
      WHERE user_id = ${user.userId} AND provider = 'github'
    `.execute(getDb())

    expect(row.rows[0]!.encrypted_access_token).toMatch(/^v1:/)
    expect(row.rows[0]!.encrypted_access_token).not.toContain('gho_contract_access_token')
  })

  it('upsert on the same (user, provider) rotates the stored values', async () => {
    await methods.upsertOAuthProviderToken({
      userId: user.userId,
      provider: 'github',
      accessToken: 'gho_rotated_token',
      refreshToken: null,
      expiresAt: null,
      refreshTokenExpiresAt: null,
    })

    const stored = await methods.getOAuthProviderToken(user.userId, 'github')

    expect(stored!.accessToken).toBe('gho_rotated_token')
    expect(stored!.refreshToken).toBeNull()
    expect(stored!.expiresAt).toBeNull()
  })

  it('treats an undecryptable row as a missing token (re-auth path)', async () => {
    await sql`
      UPDATE public.oauth_provider_tokens
      SET encrypted_access_token = 'v1:bm90LXJlYWwtY2lwaGVydGV4dA=='
      WHERE user_id = ${user.userId} AND provider = 'github'
    `.execute(getDb())

    const stored = await methods.getOAuthProviderToken(user.userId, 'github')

    expect(stored).toBeNull()
  })

  it('returns null for an unknown user and after delete', async () => {
    expect(await methods.getOAuthProviderToken('00000000-0000-4000-8000-000000000000', 'github')).toBeNull()

    await methods.upsertOAuthProviderToken({
      userId: user.userId,
      provider: 'github',
      accessToken: 'gho_to_delete',
      refreshToken: null,
      expiresAt: null,
      refreshTokenExpiresAt: null,
    })
    await methods.deleteOAuthProviderToken(user.userId, 'github')

    expect(await methods.getOAuthProviderToken(user.userId, 'github')).toBeNull()
  })
})
