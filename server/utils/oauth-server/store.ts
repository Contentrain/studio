/**
 * OAuth AS persistence — managed pair only.
 *
 * Follows the managed-auth precedent: talks to the auth-schema tables
 * directly through getDb() (service path), never through DatabaseProvider —
 * the tables exist only on the postgres pair, so provider methods would just
 * force dead Supabase stubs.
 *
 * Token model is opaque-by-design: `oac_` codes, `crn_oat_` access tokens
 * and `crn_ort_` refresh tokens are random secrets whose SHA-256 hex lands
 * in the row. MCP clients treat access tokens as opaque per spec; the
 * resource route resolves hash → grant per request, which doubles as
 * instant revocation. Swapping to JWTs later only touches this module and
 * the token endpoint.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { getDb } from '../../providers/postgres-db/client'

export const AUTHORIZATION_CODE_TTL_SECONDS = 120
export const ACCESS_TOKEN_TTL_SECONDS = 3600
export const REFRESH_TOKEN_TTL_DAYS = 30
const ROTATION_GRACE_SECONDS = 10 // managed-auth refresh reuse parity
const CIMD_CACHE_TTL_SECONDS = 3600
const DCR_ORPHAN_MAX_AGE_DAYS = 30

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function randomToken(prefix: 'oac' | 'crn_oat' | 'crn_ort'): string {
  return `${prefix}_${randomBytes(32).toString('hex')}`
}

function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString()
}

export interface OAuthClientRow {
  clientId: string
  kind: 'cimd' | 'dcr'
  clientName: string | null
  clientUri: string | null
  logoUri: string | null
  redirectUris: string[]
  metadata: Record<string, unknown>
  metadataFetchedAt: string | null
}

export interface GrantContext {
  grantId: string
  userId: string
  clientId: string
  workspaceId: string
  projectId: string
  scope: string
}

interface ClientDbRow {
  client_id: string
  kind: string
  client_name: string | null
  client_uri: string | null
  logo_uri: string | null
  redirect_uris: unknown
  metadata: unknown
  metadata_fetched_at: string | null
}

function toClientRow(row: ClientDbRow): OAuthClientRow {
  const uris = Array.isArray(row.redirect_uris) ? row.redirect_uris : []
  return {
    clientId: row.client_id,
    kind: row.kind as OAuthClientRow['kind'],
    clientName: row.client_name,
    clientUri: row.client_uri,
    logoUri: row.logo_uri,
    redirectUris: uris.filter((u): u is string => typeof u === 'string'),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    metadataFetchedAt: row.metadata_fetched_at,
  }
}

const CLIENT_COLUMNS = [
  'client_id',
  'kind',
  'client_name',
  'client_uri',
  'logo_uri',
  'redirect_uris',
  'metadata',
  'metadata_fetched_at',
] as const

export async function getClient(clientId: string): Promise<OAuthClientRow | null> {
  const row = await getDb()
    .selectFrom('auth.oauth_clients')
    .select(CLIENT_COLUMNS)
    .where('client_id', '=', clientId)
    .executeTakeFirst()

  return row ? toClientRow(row) : null
}

/** CIMD row = cache of the fetched metadata document, keyed by its URL. */
export async function upsertCimdClient(input: {
  clientId: string
  clientName: string | null
  clientUri: string | null
  logoUri: string | null
  redirectUris: string[]
  raw: Record<string, unknown>
}): Promise<OAuthClientRow> {
  const now = new Date().toISOString()
  await getDb()
    .insertInto('auth.oauth_clients')
    .values({
      client_id: input.clientId,
      kind: 'cimd',
      client_name: input.clientName,
      client_uri: input.clientUri,
      logo_uri: input.logoUri,
      redirect_uris: JSON.stringify(input.redirectUris),
      metadata: JSON.stringify(input.raw),
      metadata_fetched_at: now,
      last_used_at: now,
    })
    .onConflict(oc => oc.column('client_id').doUpdateSet({
      client_name: input.clientName,
      client_uri: input.clientUri,
      logo_uri: input.logoUri,
      redirect_uris: JSON.stringify(input.redirectUris),
      metadata: JSON.stringify(input.raw),
      metadata_fetched_at: now,
      last_used_at: now,
    }))
    .execute()

  return (await getClient(input.clientId))!
}

/** DCR (RFC 7591) registration. Public clients only — no secret is minted. */
export async function createDcrClient(input: {
  clientName: string | null
  clientUri: string | null
  logoUri: string | null
  redirectUris: string[]
  metadata: Record<string, unknown>
}): Promise<OAuthClientRow> {
  const clientId = `dcr_${randomBytes(16).toString('hex')}`
  await getDb()
    .insertInto('auth.oauth_clients')
    .values({
      client_id: clientId,
      kind: 'dcr',
      client_name: input.clientName,
      client_uri: input.clientUri,
      logo_uri: input.logoUri,
      redirect_uris: JSON.stringify(input.redirectUris),
      metadata: JSON.stringify(input.metadata),
    })
    .execute()

  return (await getClient(clientId))!
}

export async function touchClient(clientId: string): Promise<void> {
  await getDb()
    .updateTable('auth.oauth_clients')
    .set({ last_used_at: new Date().toISOString() })
    .where('client_id', '=', clientId)
    .execute()
}

// ─── Authorization codes ───

export interface AuthCodeRow {
  clientId: string
  userId: string
  workspaceId: string
  projectId: string
  redirectUri: string
  scope: string
  codeChallenge: string
  codeChallengeMethod: string
  resource: string | null
}

export async function createAuthorizationCode(input: {
  clientId: string
  userId: string
  workspaceId: string
  projectId: string
  redirectUri: string
  scope: string
  codeChallenge: string
  resource: string | null
}): Promise<string> {
  const raw = randomToken('oac')
  await getDb()
    .insertInto('auth.oauth_authorization_codes')
    .values({
      code_hash: sha256(raw),
      client_id: input.clientId,
      user_id: input.userId,
      workspace_id: input.workspaceId,
      project_id: input.projectId,
      redirect_uri: input.redirectUri,
      scope: input.scope,
      code_challenge: input.codeChallenge,
      resource: input.resource,
      expires_at: isoIn(AUTHORIZATION_CODE_TTL_SECONDS),
    })
    .execute()
  return raw
}

/** Atomically consume a code: single-use, unexpired (one_time_tokens pattern). */
export async function consumeAuthorizationCode(raw: string): Promise<AuthCodeRow | null> {
  const rows = await getDb()
    .updateTable('auth.oauth_authorization_codes')
    .set({ consumed_at: new Date().toISOString() })
    .where('code_hash', '=', sha256(raw))
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', new Date().toISOString())
    .returning([
      'client_id',
      'user_id',
      'workspace_id',
      'project_id',
      'redirect_uri',
      'scope',
      'code_challenge',
      'code_challenge_method',
      'resource',
    ])
    .execute()

  const row = rows[0]
  if (!row) return null
  return {
    clientId: row.client_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    redirectUri: row.redirect_uri,
    scope: row.scope,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
    resource: row.resource,
  }
}

// ─── Grants ───

/**
 * Consent record. Re-approving the same (user, client, workspace, project)
 * refreshes the scope on the active row instead of stacking duplicates —
 * ON CONFLICT targets the partial unique index, so revoked history rows
 * never collide.
 */
export async function upsertGrant(input: {
  userId: string
  clientId: string
  workspaceId: string
  projectId: string
  scope: string
}): Promise<{ grantId: string }> {
  const result = await sql<{ id: string }>`
    INSERT INTO auth.oauth_grants (user_id, client_id, workspace_id, project_id, scope)
    VALUES (${input.userId}, ${input.clientId}, ${input.workspaceId}, ${input.projectId}, ${input.scope})
    ON CONFLICT (user_id, client_id, workspace_id, project_id) WHERE revoked_at IS NULL
    DO UPDATE SET scope = EXCLUDED.scope, last_used_at = now()
    RETURNING id
  `.execute(getDb())

  return { grantId: result.rows[0]!.id }
}

// ─── Tokens ───

export async function issueAccessToken(grantId: string): Promise<{ token: string, expiresIn: number }> {
  const raw = randomToken('crn_oat')
  await getDb()
    .insertInto('auth.oauth_access_tokens')
    .values({
      token_hash: sha256(raw),
      grant_id: grantId,
      expires_at: isoIn(ACCESS_TOKEN_TTL_SECONDS),
    })
    .execute()
  return { token: raw, expiresIn: ACCESS_TOKEN_TTL_SECONDS }
}

export async function issueRefreshToken(grantId: string, familyId: string = randomUUID()): Promise<string> {
  const raw = randomToken('crn_ort')
  await getDb()
    .insertInto('auth.oauth_refresh_tokens')
    .values({
      grant_id: grantId,
      token_hash: sha256(raw),
      family_id: familyId,
      expires_at: isoIn(REFRESH_TOKEN_TTL_DAYS * 24 * 3600),
    })
    .execute()
  return raw
}

async function loadGrant(grantId: string): Promise<GrantContext | null> {
  const row = await getDb()
    .selectFrom('auth.oauth_grants')
    .select(['id', 'user_id', 'client_id', 'workspace_id', 'project_id', 'scope', 'revoked_at'])
    .where('id', '=', grantId)
    .executeTakeFirst()

  if (!row || row.revoked_at) return null
  return {
    grantId: row.id,
    userId: row.user_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    scope: row.scope,
  }
}

/**
 * Rotate a refresh token — managed-auth family semantics: reuse of a rotated
 * token inside the grace window tolerates concurrent refreshes; outside it,
 * the whole family is revoked (replay). A revoked grant kills the family too.
 */
export async function rotateRefreshToken(raw: string): Promise<{
  grant: GrantContext
  accessToken: string
  accessTokenExpiresIn: number
  refreshToken: string
} | null> {
  const db = getDb()
  const now = new Date()

  const stored = await db
    .selectFrom('auth.oauth_refresh_tokens')
    .select(['id', 'grant_id', 'family_id', 'expires_at', 'rotated_at', 'revoked_at'])
    .where('token_hash', '=', sha256(raw))
    .executeTakeFirst()

  if (!stored || stored.revoked_at || Date.parse(stored.expires_at) < now.getTime())
    return null

  if (stored.rotated_at) {
    const withinGrace = now.getTime() - Date.parse(stored.rotated_at) <= ROTATION_GRACE_SECONDS * 1000
    if (!withinGrace) {
      await db
        .updateTable('auth.oauth_refresh_tokens')
        .set({ revoked_at: now.toISOString() })
        .where('family_id', '=', stored.family_id)
        .where('revoked_at', 'is', null)
        .execute()
      return null
    }
  }

  const grant = await loadGrant(stored.grant_id)
  if (!grant) return null

  await db
    .updateTable('auth.oauth_refresh_tokens')
    .set({ rotated_at: now.toISOString() })
    .where('id', '=', stored.id)
    .where('rotated_at', 'is', null)
    .execute()

  const { token: accessToken, expiresIn } = await issueAccessToken(grant.grantId)
  const refreshToken = await issueRefreshToken(grant.grantId, stored.family_id)
  return { grant, accessToken, accessTokenExpiresIn: expiresIn, refreshToken }
}

/**
 * Resolve an opaque access token to its grant. Null on unknown/expired
 * tokens and on revoked grants — the resource route turns null into the
 * 401 WWW-Authenticate challenge.
 */
export async function getGrantContextByAccessToken(raw: string): Promise<GrantContext | null> {
  const row = await getDb()
    .selectFrom('auth.oauth_access_tokens')
    .innerJoin('auth.oauth_grants', 'auth.oauth_grants.id', 'auth.oauth_access_tokens.grant_id')
    .select([
      'auth.oauth_grants.id as grant_id',
      'auth.oauth_grants.user_id',
      'auth.oauth_grants.client_id',
      'auth.oauth_grants.workspace_id',
      'auth.oauth_grants.project_id',
      'auth.oauth_grants.scope',
      'auth.oauth_grants.revoked_at',
    ])
    .where('auth.oauth_access_tokens.token_hash', '=', sha256(raw))
    .where('auth.oauth_access_tokens.expires_at', '>', new Date().toISOString())
    .executeTakeFirst()

  if (!row || row.revoked_at) return null

  // Best-effort activity stamp — never blocks the request path.
  getDb()
    .updateTable('auth.oauth_grants')
    .set({ last_used_at: new Date().toISOString() })
    .where('id', '=', row.grant_id)
    .execute()
    .catch(() => {})

  return {
    grantId: row.grant_id,
    userId: row.user_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    scope: row.scope,
  }
}

// ─── Management (Connected Apps panel) ───

export interface GrantListRow {
  grantId: string
  userId: string
  clientId: string
  clientName: string | null
  clientUri: string | null
  logoUri: string | null
  projectId: string
  projectRepo: string | null
  scope: string
  createdAt: string
  lastUsedAt: string | null
}

export async function listWorkspaceGrants(workspaceId: string): Promise<GrantListRow[]> {
  const rows = await getDb()
    .selectFrom('auth.oauth_grants')
    .innerJoin('auth.oauth_clients', 'auth.oauth_clients.client_id', 'auth.oauth_grants.client_id')
    .leftJoin('projects', 'projects.id', 'auth.oauth_grants.project_id')
    .select([
      'auth.oauth_grants.id as grant_id',
      'auth.oauth_grants.user_id',
      'auth.oauth_grants.client_id',
      'auth.oauth_clients.client_name',
      'auth.oauth_clients.client_uri',
      'auth.oauth_clients.logo_uri',
      'auth.oauth_grants.project_id',
      'projects.repo_full_name as project_repo',
      'auth.oauth_grants.scope',
      'auth.oauth_grants.created_at',
      'auth.oauth_grants.last_used_at',
    ])
    .where('auth.oauth_grants.workspace_id', '=', workspaceId)
    .where('auth.oauth_grants.revoked_at', 'is', null)
    .orderBy('auth.oauth_grants.created_at', 'desc')
    .execute()

  return rows.map(row => ({
    grantId: row.grant_id,
    userId: row.user_id,
    clientId: row.client_id,
    clientName: row.client_name,
    clientUri: row.client_uri,
    logoUri: row.logo_uri,
    projectId: row.project_id,
    projectRepo: (row.project_repo as string | null) ?? null,
    scope: row.scope,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }))
}

/** Revoke a grant + its refresh-token families; access tokens are deleted. */
export async function revokeGrant(grantId: string, workspaceId: string): Promise<boolean> {
  const db = getDb()
  const now = new Date().toISOString()

  const updated = await db
    .updateTable('auth.oauth_grants')
    .set({ revoked_at: now })
    .where('id', '=', grantId)
    .where('workspace_id', '=', workspaceId)
    .where('revoked_at', 'is', null)
    .returning('id')
    .execute()

  if (updated.length === 0) return false

  await db
    .updateTable('auth.oauth_refresh_tokens')
    .set({ revoked_at: now })
    .where('grant_id', '=', grantId)
    .where('revoked_at', 'is', null)
    .execute()
  await db
    .deleteFrom('auth.oauth_access_tokens')
    .where('grant_id', '=', grantId)
    .execute()

  return true
}

/** Load a single active grant scoped to a workspace (revocation authz). */
export async function getWorkspaceGrant(grantId: string, workspaceId: string): Promise<GrantContext | null> {
  const row = await getDb()
    .selectFrom('auth.oauth_grants')
    .select(['id', 'user_id', 'client_id', 'workspace_id', 'project_id', 'scope'])
    .where('id', '=', grantId)
    .where('workspace_id', '=', workspaceId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()

  if (!row) return null
  return {
    grantId: row.id,
    userId: row.user_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    scope: row.scope,
  }
}

// ─── Housekeeping ───

/**
 * Opportunistic cleanup, fired best-effort from the token endpoint:
 * spent/expired codes and tokens, plus orphaned DCR clients (Claude's DCR
 * fallback registers a new client per fresh connection — rows whose dance
 * never completed have no grants and are safe to drop after 30 days).
 */
export async function cleanupExpired(): Promise<void> {
  const db = getDb()

  await db
    .deleteFrom('auth.oauth_authorization_codes')
    .where('expires_at', '<', new Date(Date.now() - 3600 * 1000).toISOString())
    .execute()

  await db
    .deleteFrom('auth.oauth_access_tokens')
    .where('expires_at', '<', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
    .execute()

  await db
    .deleteFrom('auth.oauth_refresh_tokens')
    .where('expires_at', '<', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString())
    .execute()

  await sql`
    DELETE FROM auth.oauth_clients c
    WHERE c.kind = 'dcr'
      AND c.created_at < now() - make_interval(days => ${DCR_ORPHAN_MAX_AGE_DAYS})
      AND NOT EXISTS (SELECT 1 FROM auth.oauth_grants g WHERE g.client_id = c.client_id)
  `.execute(db)
}

/** CIMD cache freshness — resolveCimdClient refetches past this window. */
export function isCimdCacheFresh(metadataFetchedAt: string | null): boolean {
  if (!metadataFetchedAt) return false
  return Date.now() - Date.parse(metadataFetchedAt) < CIMD_CACHE_TTL_SECONDS * 1000
}
