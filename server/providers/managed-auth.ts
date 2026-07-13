/**
 * Managed AuthProvider — Studio-owned auth for the postgres pair.
 *
 * Replaces Supabase GoTrue on managed deployments:
 *   - Access tokens are locally-verified HS256 JWTs (jose) carrying the
 *     AuthUser shape in claims — validateToken never leaves the process
 *     (GoTrue required a network round-trip per request).
 *   - Refresh tokens rotate with family-wide replay revocation
 *     (10s reuse grace, 30-day absolute lifetime) in auth.refresh_tokens.
 *   - Magic links / invites / the CLI's one-time auth code are single-use
 *     hashed tokens in auth.one_time_tokens, delivered via EmailProvider
 *     (Resend HTTP) instead of GoTrue SMTP.
 *   - The OAuth dance itself lives in /api/auth/oauth/[provider] (built on
 *     nuxt-auth-utils handlers); this module owns identity, token and
 *     user-store logic and exposes completeOAuthSignIn() to that route.
 *
 * User store: auth.users (postgres/migrations/000_auth_shim.sql). Inserts
 * fire the same handle_new_user bootstrap trigger the Supabase pair relies
 * on (profile + primary workspace + owner membership).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import type { AuthProvider, AuthSession, AuthTokens, AuthUser, ProviderTokens } from './auth'
import { decryptApiKey, encryptApiKey } from '../utils/encryption'
import { getDb, getPostgresConfig } from './postgres-db/client'

const ACCESS_TOKEN_TTL_SECONDS = 3600 // GoTrue jwt_expiry parity
const REFRESH_TOKEN_TTL_DAYS = 30
const ROTATION_GRACE_SECONDS = 10 // GoTrue refresh_token_reuse_interval parity
const MAGIC_LINK_TTL_SECONDS = 3600 // GoTrue otp_expiry parity
const INVITE_TTL_SECONDS = 7 * 24 * 3600
const CLI_CODE_TTL_SECONDS = 60

const encoder = new TextEncoder()

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function randomToken(prefix: 'crt' | 'mlc' | 'inv' | 'otc'): string {
  return `${prefix}_${randomBytes(24).toString('hex')}`
}

function jwtSecret(): Uint8Array {
  return encoder.encode(getPostgresConfig().authJwtSecret)
}

interface UserRow {
  id: string
  email: string
  raw_user_meta_data: unknown
  provider: string | null
  provider_account_id: string | null
}

function toAuthUser(row: UserRow): AuthUser {
  const meta = (row.raw_user_meta_data ?? {}) as Record<string, unknown>
  return {
    id: row.id,
    email: row.email,
    avatarUrl: (meta.avatar_url as string | undefined) ?? null,
    provider: (row.provider as AuthUser['provider']) ?? 'email',
    providerAccountId: row.provider_account_id,
  }
}

async function signAccessToken(user: AuthUser): Promise<{ token: string, expiresAt: number }> {
  const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS
  const token = await new SignJWT({
    email: user.email,
    avatar_url: user.avatarUrl,
    provider: user.provider,
    provider_account_id: user.providerAccountId,
    role: 'authenticated',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer('contentrain-studio')
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(jwtSecret())

  return { token, expiresAt }
}

async function insertRefreshToken(userId: string, familyId: string): Promise<string> {
  const raw = randomToken('crt')
  await getDb()
    .insertInto('auth.refresh_tokens')
    .values({
      user_id: userId,
      token_hash: sha256(raw),
      family_id: familyId,
      expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000).toISOString(),
    })
    .execute()
  return raw
}

/** Issue a fresh access + refresh pair (new rotation family by default). */
async function issueTokens(user: AuthUser, familyId = randomUUID()): Promise<AuthTokens> {
  const { token, expiresAt } = await signAccessToken(user)
  const refreshToken = await insertRefreshToken(user.id, familyId)
  return { accessToken: token, refreshToken, expiresAt }
}

async function loadUserById(userId: string): Promise<UserRow | undefined> {
  return await getDb()
    .selectFrom('auth.users')
    .select(['id', 'email', 'raw_user_meta_data', 'provider', 'provider_account_id'])
    .where('id', '=', userId)
    .executeTakeFirst()
}

/**
 * Find-or-create a user for an external OAuth sign-in. Matching order:
 * (provider, provider_account_id), then lower(email) — a magic-link account
 * signing in with OAuth for the first time gets linked, not duplicated.
 * Inserts fire the handle_new_user bootstrap trigger.
 */
async function upsertOAuthUser(input: {
  provider: 'github' | 'google'
  providerAccountId: string
  email: string
  name: string | null
  userName: string | null
  avatarUrl: string | null
}): Promise<UserRow> {
  const db = getDb()
  const meta = JSON.stringify({
    full_name: input.name ?? undefined,
    user_name: input.userName ?? undefined,
    avatar_url: input.avatarUrl ?? undefined,
  })
  const now = new Date().toISOString()

  const byAccount = await db
    .selectFrom('auth.users')
    .select('id')
    .where('provider', '=', input.provider)
    .where('provider_account_id', '=', input.providerAccountId)
    .executeTakeFirst()

  const byEmail = byAccount
    ? undefined
    : await db
        .selectFrom('auth.users')
        .select('id')
        .where(({ eb, fn }) => eb(fn('lower', ['email']), '=', input.email.toLowerCase()))
        .executeTakeFirst()

  const existingId = byAccount?.id ?? byEmail?.id

  if (existingId) {
    await db
      .updateTable('auth.users')
      .set({
        email: input.email,
        provider: input.provider,
        provider_account_id: input.providerAccountId,
        raw_user_meta_data: meta,
        email_verified_at: now,
        last_sign_in_at: now,
        updated_at: now,
      })
      .where('id', '=', existingId)
      .execute()
    return (await loadUserById(existingId))!
  }

  const inserted = await db
    .insertInto('auth.users')
    .values({
      email: input.email,
      provider: input.provider,
      provider_account_id: input.providerAccountId,
      raw_user_meta_data: meta,
      email_verified_at: now,
      last_sign_in_at: now,
    })
    .returning('id')
    .executeTakeFirst()

  return (await loadUserById(inserted!.id))!
}

/** Find-or-create by email (magic link / invite). Inserts fire the bootstrap trigger. */
async function upsertEmailUser(email: string): Promise<UserRow> {
  const db = getDb()
  const now = new Date().toISOString()

  const existing = await db
    .selectFrom('auth.users')
    .select('id')
    .where(({ eb, fn }) => eb(fn('lower', ['email']), '=', email.toLowerCase()))
    .executeTakeFirst()

  if (existing) {
    await db
      .updateTable('auth.users')
      .set({ email_verified_at: now, last_sign_in_at: now, updated_at: now })
      .where('id', '=', existing.id)
      .execute()
    return (await loadUserById(existing.id))!
  }

  const inserted = await db
    .insertInto('auth.users')
    .values({ email, provider: 'email', email_verified_at: now, last_sign_in_at: now })
    .returning('id')
    .executeTakeFirst()

  return (await loadUserById(inserted!.id))!
}

async function createOneTimeToken(input: {
  type: 'magic_link' | 'invite' | 'cli_code'
  email: string
  userId?: string | null
  ttlSeconds: number
  payload?: Record<string, unknown>
}): Promise<string> {
  const prefix = input.type === 'magic_link' ? 'mlc' : input.type === 'invite' ? 'inv' : 'otc'
  const raw = randomToken(prefix)

  await getDb()
    .insertInto('auth.one_time_tokens')
    .values({
      email: input.email,
      user_id: input.userId ?? null,
      token_hash: sha256(raw),
      token_type: input.type,
      payload: JSON.stringify(input.payload ?? {}),
      expires_at: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
    })
    .execute()

  return raw
}

interface ConsumedToken {
  email: string
  user_id: string | null
  token_type: string
  payload: Record<string, unknown>
}

/** Atomically consume a one-time token: single-use, unexpired. */
async function consumeOneTimeToken(raw: string): Promise<ConsumedToken | null> {
  const rows = await getDb()
    .updateTable('auth.one_time_tokens')
    .set({ consumed_at: new Date().toISOString() })
    .where('token_hash', '=', sha256(raw))
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', new Date().toISOString())
    .returning(['email', 'user_id', 'token_type', 'payload'])
    .execute()

  const row = rows[0]
  if (!row) return null
  return { ...row, payload: (row.payload ?? {}) as Record<string, unknown> }
}

/** Session for a consumed token's subject (creating the user for email flows). */
async function sessionForConsumedToken(consumed: ConsumedToken): Promise<AuthSession> {
  const row = consumed.user_id
    ? await loadUserById(consumed.user_id)
    : await upsertEmailUser(consumed.email)

  if (!row)
    throw createError({ statusCode: 401, message: 'Invalid or expired code' })

  const user = toAuthUser(row)
  const tokens = await issueTokens(user)

  let providerTokens: ProviderTokens | null = null
  const packed = consumed.payload.provider_tokens as { access?: string, refresh?: string | null, expires_at?: number | null, refresh_expires_at?: number | null } | undefined
  if (packed?.access) {
    const secret = useRuntimeConfig().sessionSecret as string
    try {
      providerTokens = {
        accessToken: decryptApiKey(packed.access, secret),
        refreshToken: packed.refresh ? decryptApiKey(packed.refresh, secret) : null,
        expiresAt: packed.expires_at ?? null,
        refreshTokenExpiresAt: packed.refresh_expires_at ?? null,
      }
    }
    catch {
      providerTokens = null
    }
  }

  return { user, tokens, providerTokens }
}

// ─── Route-facing helpers (managed pair only) ───

/**
 * Complete an external OAuth sign-in (called by /api/auth/oauth/[provider]
 * after the provider exchange): find-or-link the user, stamp sign-in, and
 * issue Studio tokens.
 */
export async function completeOAuthSignIn(input: {
  provider: 'github' | 'google'
  providerAccountId: string
  email: string
  name: string | null
  userName: string | null
  avatarUrl: string | null
}): Promise<AuthSession> {
  const row = await upsertOAuthUser(input)
  const user = toAuthUser(row)
  const tokens = await issueTokens(user)
  return { user, tokens }
}

/** Mint the CLI's short-lived one-time auth code (provider tokens ride encrypted). */
export async function createCliAuthCode(user: AuthUser, providerTokens: ProviderTokens | null): Promise<string> {
  let packed: Record<string, unknown> | undefined
  if (providerTokens?.accessToken) {
    const secret = useRuntimeConfig().sessionSecret as string
    packed = {
      provider_tokens: {
        access: encryptApiKey(providerTokens.accessToken, secret),
        refresh: providerTokens.refreshToken ? encryptApiKey(providerTokens.refreshToken, secret) : null,
        expires_at: providerTokens.expiresAt,
        refresh_expires_at: providerTokens.refreshTokenExpiresAt,
      },
    }
  }

  return createOneTimeToken({
    type: 'cli_code',
    email: user.email ?? '',
    userId: user.id,
    ttlSeconds: CLI_CODE_TTL_SECONDS,
    payload: packed,
  })
}

/**
 * Session for the directory-review account (POST /api/auth/review-login).
 * The route owns ALL gating (env opt-in, single allowed address,
 * timing-safe password check, rate limit) — this just materializes the
 * user through the normal email bootstrap chain and issues Studio tokens.
 */
export async function createReviewSession(email: string): Promise<AuthSession> {
  const row = await upsertEmailUser(email)
  const user = toAuthUser(row)
  const tokens = await issueTokens(user)
  return { user, tokens }
}

/** Consume a magic-link token (GET /api/auth/magic/verify). */
export async function consumeMagicLinkToken(raw: string): Promise<AuthSession | null> {
  if (!raw.startsWith('mlc_') && !raw.startsWith('inv_')) return null
  const consumed = await consumeOneTimeToken(raw)
  if (!consumed) return null
  return sessionForConsumedToken(consumed)
}

export function createManagedAuthProvider(): AuthProvider {
  return {
    async validateToken(accessToken) {
      try {
        const { payload } = await jwtVerify(accessToken, jwtSecret(), { issuer: 'contentrain-studio' })
        if (typeof payload.sub !== 'string') return null
        return {
          id: payload.sub,
          email: (payload.email as string | undefined) ?? null,
          avatarUrl: (payload.avatar_url as string | undefined) ?? null,
          provider: (payload.provider as AuthUser['provider']) ?? null,
          providerAccountId: (payload.provider_account_id as string | undefined) ?? null,
        }
      }
      catch {
        return null
      }
    },

    async refreshSession(refreshToken) {
      const db = getDb()
      const now = new Date()

      const stored = await db
        .selectFrom('auth.refresh_tokens')
        .select(['id', 'user_id', 'family_id', 'expires_at', 'rotated_at', 'revoked_at'])
        .where('token_hash', '=', sha256(refreshToken))
        .executeTakeFirst()

      if (!stored || stored.revoked_at || Date.parse(stored.expires_at) < now.getTime())
        return null

      if (stored.rotated_at) {
        // Reuse of a rotated token: tolerate concurrent/retried refreshes for
        // ROTATION_GRACE_SECONDS by re-issuing an access token on the family's
        // current tail; outside the window it's replay — revoke the family.
        const withinGrace = now.getTime() - Date.parse(stored.rotated_at) <= ROTATION_GRACE_SECONDS * 1000
        if (!withinGrace) {
          await db
            .updateTable('auth.refresh_tokens')
            .set({ revoked_at: now.toISOString() })
            .where('family_id', '=', stored.family_id)
            .where('revoked_at', 'is', null)
            .execute()
          return null
        }
      }

      const row = await loadUserById(stored.user_id)
      if (!row) return null
      const user = toAuthUser(row)

      // Rotate: mark this token, keep the family.
      await db
        .updateTable('auth.refresh_tokens')
        .set({ rotated_at: now.toISOString() })
        .where('id', '=', stored.id)
        .where('rotated_at', 'is', null)
        .execute()

      const { token, expiresAt } = await signAccessToken(user)
      const nextRefresh = await insertRefreshToken(user.id, stored.family_id)
      return { accessToken: token, refreshToken: nextRefresh, expiresAt }
    },

    async refreshProviderToken(provider, refreshToken) {
      // Same contract as the Supabase impl: direct call against GitHub's
      // token endpoint using the login OAuth App credentials.
      if (provider !== 'github') return null

      const config = useRuntimeConfig()
      const clientId = (config.oauth as { github?: { clientId?: string } } | undefined)?.github?.clientId
      const clientSecret = (config.oauth as { github?: { clientSecret?: string } } | undefined)?.github?.clientSecret
      if (!clientId || !clientSecret) return null

      try {
        const response = await $fetch<{
          access_token?: string
          refresh_token?: string
          expires_in?: number
          refresh_token_expires_in?: number
          error?: string
        }>('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { Accept: 'application/json' },
          body: {
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
          },
        })

        if (response.error || !response.access_token) return null

        const nowSeconds = Math.floor(Date.now() / 1000)
        return {
          accessToken: response.access_token,
          refreshToken: response.refresh_token ?? null,
          expiresAt: response.expires_in ? nowSeconds + response.expires_in : null,
          refreshTokenExpiresAt: response.refresh_token_expires_in ? nowSeconds + response.refresh_token_expires_in : null,
        }
      }
      catch {
        return null
      }
    },

    async getOAuthRedirectUrl(provider, redirectTo) {
      // Entry URL for /api/auth/oauth/[provider]. Carries ONLY flow context
      // (redirect target / CLI callback). It must NOT carry a `state` param:
      // nuxt-auth-utils' handleState() treats a present query.state as "this
      // is the callback leg" and reads its cookie instead of setting one, so
      // a state here breaks its CSRF cookie and every login fails with
      // "state mismatch". CSRF state is wholly owned by the module.
      // A localhost 98xx callback target marks the CLI flow (validated
      // upstream in login.post.ts).
      const siteUrl = (useRuntimeConfig().public.siteUrl as string).replace(/\/+$/, '')

      const isCliTarget = /^http:\/\/(?:127\.0\.0\.1|localhost):98\d{2}\/callback$/.test(redirectTo)
      const params = new URLSearchParams()
      if (isCliTarget) params.set('cli_redirect', redirectTo)
      else params.set('redirect', redirectTo)

      return { url: `${siteUrl}/api/auth/oauth/${provider}?${params.toString()}` }
    },

    async exchangeCode(code) {
      const consumed = await consumeOneTimeToken(code)
      if (!consumed)
        throw createError({ statusCode: 401, message: 'Invalid or expired code' })
      return sessionForConsumedToken(consumed)
    },

    async exchangeTokens(accessToken, refreshToken) {
      const user = await this.validateToken(accessToken)
      if (!user)
        throw createError({ statusCode: 401, message: 'Invalid access token' })

      let expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS
      try {
        const { payload } = await jwtVerify(accessToken, jwtSecret())
        if (typeof payload.exp === 'number') expiresAt = payload.exp
      }
      catch { /* validated above */ }

      return {
        user,
        tokens: { accessToken, refreshToken: refreshToken ?? null, expiresAt },
        providerTokens: null,
      }
    },

    async sendMagicLink(email, redirectTo) {
      const email_ = email.trim()
      const token = await createOneTimeToken({
        type: 'magic_link',
        email: email_,
        ttlSeconds: MAGIC_LINK_TTL_SECONDS,
      })

      const siteUrl = (useRuntimeConfig().public.siteUrl as string).replace(/\/+$/, '')
      const url = `${siteUrl}/api/auth/magic/verify?token=${token}&redirect=${encodeURIComponent(redirectTo || '/')}`

      const emailProvider = useEmailProvider()
      if (!emailProvider)
        throw createError({ statusCode: 500, message: 'Email provider is not configured (NUXT_RESEND_API_KEY)' })

      // Copy lives in the email-templates content model (auth-magic-link).
      const tpl = emailTemplate('auth-magic-link', { url })
      await emailProvider.sendEmail({ to: email_, subject: tpl.subject, html: tpl.body })
    },

    async inviteUserByEmail(email, options) {
      const row = await upsertEmailUser(email.trim())
      const token = await createOneTimeToken({
        type: 'invite',
        email: row.email,
        userId: row.id,
        ttlSeconds: INVITE_TTL_SECONDS,
      })

      const siteUrl = (useRuntimeConfig().public.siteUrl as string).replace(/\/+$/, '')
      const url = `${siteUrl}/api/auth/magic/verify?token=${token}&redirect=${encodeURIComponent(options?.redirectTo || '/')}`

      const emailProvider = useEmailProvider()
      if (!emailProvider)
        throw createError({ statusCode: 500, message: 'Email provider is not configured (NUXT_RESEND_API_KEY)' })

      // Copy lives in the email-templates content model (auth-invite).
      const tpl = emailTemplate('auth-invite', { url })
      await emailProvider.sendEmail({ to: row.email, subject: tpl.subject, html: tpl.body })

      return { userId: row.id }
    },

    async getUserById(userId) {
      const row = await loadUserById(userId)
      return row ? toAuthUser(row) : null
    },

    async getUserByEmail(email) {
      const row = await getDb()
        .selectFrom('auth.users')
        .select(['id', 'email', 'raw_user_meta_data', 'provider', 'provider_account_id'])
        .where(({ eb, fn }) => eb(fn('lower', ['email']), '=', email.toLowerCase()))
        .executeTakeFirst()

      return row ? toAuthUser(row) : null
    },

    async deleteUser(userId) {
      // Cascades: profiles → workspaces → … plus refresh/one-time tokens.
      await getDb().deleteFrom('auth.users').where('id', '=', userId).execute()
    },

    async revokeSession(refreshToken) {
      const stored = await getDb()
        .selectFrom('auth.refresh_tokens')
        .select('family_id')
        .where('token_hash', '=', sha256(refreshToken))
        .executeTakeFirst()

      if (!stored) return

      await getDb()
        .updateTable('auth.refresh_tokens')
        .set({ revoked_at: new Date().toISOString() })
        .where('family_id', '=', stored.family_id)
        .where('revoked_at', 'is', null)
        .execute()
    },
  }
}
