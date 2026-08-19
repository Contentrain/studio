import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  consumeAuthorizationCode,
  createAuthorizationCode,
  createDcrClient,
  getGrantContextByAccessToken,
  getWorkspaceGrant,
  issueAccessToken,
  issueRefreshToken,
  listWorkspaceGrants,
  revokeGrant,
  rotateRefreshToken,
  upsertGrant,
} from '../../server/utils/oauth-server/store'
import type { SeededUser } from './helpers'
import { deleteSeededUser, getDb, seedUser, sql } from './helpers'

/**
 * OAuth AS store against real Postgres (migration 016): atomic single-use
 * codes, grant-tuple uniqueness, refresh rotation family semantics,
 * revocation cascades and FK cascades.
 */
describe('oauth-server store (contract)', () => {
  let user: SeededUser
  let projectId: string
  let clientId: string

  beforeAll(async () => {
    user = await seedUser('oauth')
    const project = await sql<{ id: string }>`
      INSERT INTO public.projects (workspace_id, repo_full_name)
      VALUES (${user.workspaceId}, 'contentrain/oauth-fixture') RETURNING id
    `.execute(getDb())
    projectId = project.rows[0]!.id

    const client = await createDcrClient({
      clientName: 'Contract Client',
      clientUri: null,
      logoUri: null,
      redirectUris: ['http://localhost/callback'],
      metadata: {},
    })
    clientId = client.clientId
  })

  afterAll(async () => {
    await deleteSeededUser(user.userId)
    await sql`DELETE FROM auth.oauth_clients WHERE client_id = ${clientId}`.execute(getDb())
  })

  function grantInput(overrides: Partial<Parameters<typeof upsertGrant>[0]> = {}) {
    return {
      userId: user.userId,
      clientId,
      workspaceId: user.workspaceId,
      projectId,
      scope: 'content:read offline_access',
      ...overrides,
    }
  }

  function codeInput() {
    return {
      clientId,
      userId: user.userId,
      workspaceId: user.workspaceId,
      projectId,
      redirectUri: 'http://localhost:54321/callback',
      scope: 'content:read offline_access',
      codeChallenge: 'a'.repeat(43),
      resource: null,
    }
  }

  it('authorization codes are single-use, atomically', async () => {
    const raw = await createAuthorizationCode(codeInput())

    // Concurrent redemptions: exactly one wins.
    const results = await Promise.all(Array.from({ length: 5 }, () => consumeAuthorizationCode(raw)))
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(results.find(Boolean)).toMatchObject({
      clientId,
      userId: user.userId,
      projectId,
      codeChallenge: 'a'.repeat(43),
      codeChallengeMethod: 'S256',
    })

    // Replay after consumption stays dead.
    expect(await consumeAuthorizationCode(raw)).toBeNull()
  })

  it('expired codes do not consume', async () => {
    const raw = await createAuthorizationCode(codeInput())
    await sql`
      UPDATE auth.oauth_authorization_codes
      SET expires_at = now() - interval '1 minute'
      WHERE consumed_at IS NULL AND client_id = ${clientId}
    `.execute(getDb())
    expect(await consumeAuthorizationCode(raw)).toBeNull()
  })

  it('re-approving the same tuple updates the grant instead of duplicating', async () => {
    const first = await upsertGrant(grantInput())
    const second = await upsertGrant(grantInput({ scope: 'content:read content:write offline_access' }))
    expect(second.grantId).toBe(first.grantId)

    const grants = await listWorkspaceGrants(user.workspaceId)
    const mine = grants.filter(g => g.clientId === clientId)
    expect(mine).toHaveLength(1)
    expect(mine[0]!.scope).toBe('content:read content:write offline_access')
  })

  it('access tokens resolve to their grant and expire', async () => {
    const { grantId } = await upsertGrant(grantInput())
    const { token } = await issueAccessToken(grantId)

    const ctx = await getGrantContextByAccessToken(token)
    expect(ctx).toMatchObject({ grantId, userId: user.userId, workspaceId: user.workspaceId, projectId })

    await sql`
      UPDATE auth.oauth_access_tokens SET expires_at = now() - interval '1 second'
      WHERE grant_id = ${grantId}
    `.execute(getDb())
    expect(await getGrantContextByAccessToken(token)).toBeNull()
  })

  it('refresh rotation keeps the family; replay outside grace revokes it', async () => {
    const { grantId } = await upsertGrant(grantInput())
    const raw1 = await issueRefreshToken(grantId)

    const rotated = await rotateRefreshToken(raw1)
    expect(rotated).not.toBeNull()
    expect(rotated!.grant.grantId).toBe(grantId)
    expect(rotated!.refreshToken).toMatch(/^crn_ort_/)
    const raw2 = rotated!.refreshToken

    // Replay of raw1 within the 10s grace window re-issues (concurrent refresh tolerance).
    const withinGrace = await rotateRefreshToken(raw1)
    expect(withinGrace).not.toBeNull()

    // Push raw1's rotation outside the grace window → replay revokes the family.
    await sql`
      UPDATE auth.oauth_refresh_tokens SET rotated_at = now() - interval '30 seconds'
      WHERE grant_id = ${grantId} AND rotated_at IS NOT NULL
    `.execute(getDb())
    expect(await rotateRefreshToken(raw1)).toBeNull()
    expect(await rotateRefreshToken(raw2)).toBeNull() // family-wide revocation
  })

  it('revoking a grant kills refresh tokens and access tokens', async () => {
    const { grantId } = await upsertGrant(grantInput())
    const { token } = await issueAccessToken(grantId)
    const refresh = await issueRefreshToken(grantId)

    const revoked = await revokeGrant(grantId, user.workspaceId)
    expect(revoked).toBe(true)

    expect(await getGrantContextByAccessToken(token)).toBeNull()
    expect(await rotateRefreshToken(refresh)).toBeNull()
    expect(await getWorkspaceGrant(grantId, user.workspaceId)).toBeNull()

    // Wrong workspace or already-revoked → false, no cross-tenant revocation.
    expect(await revokeGrant(grantId, user.workspaceId)).toBe(false)
    expect(await revokeGrant(randomUUID(), user.workspaceId)).toBe(false)
  })

  it('deleting the project cascades the grant away', async () => {
    const { grantId } = await upsertGrant(grantInput())
    await sql`DELETE FROM public.projects WHERE id = ${projectId}`.execute(getDb())

    const rows = await sql<{ count: number }>`
      SELECT count(*)::int AS count FROM auth.oauth_grants WHERE id = ${grantId}
    `.execute(getDb())
    expect(rows.rows[0]!.count).toBe(0)
  })
})
