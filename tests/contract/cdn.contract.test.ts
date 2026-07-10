import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cdnMethods } from '../../server/providers/postgres-db/cdn'
import { deleteSeededUser, getDb, mintAccessToken, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

describe('postgres-db cdn (contract)', () => {
  const methods = cdnMethods()
  let user: SeededUser
  let userToken: string
  let projectId: string

  beforeAll(async () => {
    user = await seedUser('cdn')
    userToken = await mintAccessToken(user.userId)
    const project = await sql<{ id: string }>`
      INSERT INTO public.projects (workspace_id, repo_full_name)
      VALUES (${user.workspaceId}, 'contentrain/cdn-fixture') RETURNING id
    `.execute(getDb())
    projectId = project.rows[0]!.id
  })

  afterAll(async () => {
    await deleteSeededUser(user.userId)
  })

  it('key lifecycle: create → validate by hash → get → list (RLS) → revoke → invalid', async () => {
    const keyHash = randomUUID()
    const created = await methods.createCDNKey({
      projectId,
      workspaceId: user.workspaceId,
      keyHash,
      keyPrefix: 'crn_cdn1',
      name: 'delivery-key',
    })
    expect(Object.keys(created).sort()).toEqual(['created_at', 'environment', 'id', 'key_prefix', 'name', 'scopes'])
    expect(created.scopes).toEqual(['delivery'])
    expect(created.environment).toBe('production')

    const valid = await methods.validateCDNKeyHash(keyHash)
    expect(valid!.project_id).toBe(projectId)
    expect(await methods.validateCDNKeyHash('missing-hash')).toBeNull()

    await methods.updateCDNKeyLastUsed(created.id as string)
    const fetched = await methods.getCDNKey(created.id as string)
    expect(fetched!.last_used_at).not.toBeNull()

    const listed = await methods.listCDNKeys(userToken, projectId, user.workspaceId)
    expect(listed.map(k => k.id)).toContain(created.id)

    expect(await methods.countActiveCDNKeys(projectId)).toBe(1)
    await methods.revokeCDNKey(created.id as string, projectId)
    expect(await methods.countActiveCDNKeys(projectId)).toBe(0)
    expect(await methods.validateCDNKeyHash(keyHash)).toBeNull()
  })

  it('createCDNKeyIfAllowed enforces the key limit atomically', async () => {
    const grant = await methods.createCDNKeyIfAllowed({
      projectId,
      workspaceId: user.workspaceId,
      keyHash: randomUUID(),
      keyPrefix: 'crn_cdn2',
      name: 'limited-key',
      limit: 1,
      scopes: ['delivery', 'forms'],
    })
    expect(grant.allowed).toBe(true)
    expect(grant.key).toBeDefined()

    const denied = await methods.createCDNKeyIfAllowed({
      projectId,
      workspaceId: user.workspaceId,
      keyHash: randomUUID(),
      keyPrefix: 'crn_cdn3',
      name: 'over-limit',
      limit: 1,
    })
    expect(denied.allowed).toBe(false)
    expect(denied.currentCount).toBe(1)
  })

  it('build lifecycle + paginated listing newest-first', async () => {
    const first = await methods.createCDNBuild({ projectId, triggerType: 'manual', commitSha: 'a'.repeat(7), branch: 'contentrain' })
    await methods.updateCDNBuild(first.id as string, { status: 'success', file_count: 12, completed_at: new Date().toISOString() })
    const second = await methods.createCDNBuild({ projectId, triggerType: 'webhook', commitSha: 'b'.repeat(7), branch: 'contentrain' })

    const builds = await methods.listCDNBuilds(projectId, { limit: 10 })
    expect(builds.map(b => b.id)).toEqual([second.id, first.id])
    expect(builds[1]!.status).toBe('success')
    expect(builds[1]!.file_count).toBe(12)

    const paged = await methods.listCDNBuilds(projectId, { limit: 1, page: 2 })
    expect(paged.map(b => b.id)).toEqual([first.id])
  })

  it('usage increments (keyed + public) accumulate and aggregate over a window', async () => {
    const key = await methods.createCDNKey({
      projectId,
      workspaceId: user.workspaceId,
      keyHash: randomUUID(),
      keyPrefix: 'crn_use',
      name: 'usage-key',
    })
    const day = '2026-03-05'

    await methods.incrementCDNUsage(projectId, key.id as string, day, 10, 1000)
    await methods.incrementCDNUsage(projectId, key.id as string, day, 5, 500)
    await methods.incrementPublicCDNUsage(projectId, day, 2, 200)

    const totals = await methods.getMonthlyProjectCDNUsage(projectId, '2026-03-01', '2026-03-31')
    expect(totals.requestCount).toBe(17)
    expect(totals.bandwidthBytes).toBe(1700)

    const outside = await methods.getMonthlyProjectCDNUsage(projectId, '2026-04-01', '2026-04-30')
    expect(outside).toEqual({ requestCount: 0, bandwidthBytes: 0 })
  })

  it('conversation key validation shares the hash pattern', async () => {
    const keyHash = randomUUID()
    const inserted = await sql<{ id: string }>`
      INSERT INTO public.conversation_api_keys (project_id, workspace_id, key_hash, key_prefix, name)
      VALUES (${projectId}, ${user.workspaceId}, ${keyHash}, 'crn_conv', 'conv-key') RETURNING id
    `.execute(getDb())

    const valid = await methods.validateConversationKeyHash(keyHash)
    expect(valid!.id).toBe(inserted.rows[0]!.id)
    expect(valid!.ai_model).toBeTruthy()

    await methods.updateConversationKeyLastUsed(inserted.rows[0]!.id)
    await sql`UPDATE public.conversation_api_keys SET revoked_at = now() WHERE id = ${inserted.rows[0]!.id}`.execute(getDb())
    expect(await methods.validateConversationKeyHash(keyHash)).toBeNull()
  })
})
