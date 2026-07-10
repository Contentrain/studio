import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mcpCloudMethods } from '../../server/providers/postgres-db/mcp-cloud'
import { deleteSeededUser, getDb, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

const MONTH = '2026-04'

describe('postgres-db mcp-cloud (contract)', () => {
  const methods = mcpCloudMethods()
  let user: SeededUser
  let projectId: string
  let keyId: string
  const keyHash = randomUUID()

  beforeAll(async () => {
    user = await seedUser('mcp')
    const project = await sql<{ id: string }>`
      INSERT INTO public.projects (workspace_id, repo_full_name)
      VALUES (${user.workspaceId}, 'contentrain/mcp-fixture') RETURNING id
    `.execute(getDb())
    projectId = project.rows[0]!.id
  })

  afterAll(async () => {
    await deleteSeededUser(user.userId)
  })

  it('key lifecycle: create (defaults) → lookup by hash → touch → list/count → revoke', async () => {
    const created = await methods.createMcpCloudKey({
      workspaceId: user.workspaceId,
      projectId,
      name: 'agent-key',
      keyHash,
      keyPrefix: 'mcp_live1',
      allowedTools: ['contentrain_status'],
    })
    keyId = created.id as string
    expect(created.rate_limit_per_minute).toBe(60)
    expect(created.monthly_call_limit).toBeNull()
    expect(created.allowed_tools).toEqual(['contentrain_status'])

    const byHash = await methods.getMcpCloudKeyByHash(keyHash)
    expect(byHash!.id).toBe(keyId)
    expect(await methods.getMcpCloudKeyByHash('missing')).toBeNull()

    await methods.touchMcpCloudKey(keyId)
    expect((await methods.getMcpCloudKeyByHash(keyHash))!.last_used_at).not.toBeNull()

    const listed = await methods.listMcpCloudKeys(user.workspaceId, projectId)
    expect(listed.map(k => k.id)).toEqual([keyId])
    expect(await methods.countActiveMcpCloudKeys(user.workspaceId)).toBe(1)
    expect(await methods.countActiveMcpCloudKeys(user.workspaceId, randomUUID())).toBe(0)
  })

  it('atomic monthly quota with per-key usage rows', async () => {
    const first = await methods.incrementMcpCloudUsageIfAllowed({
      workspaceId: user.workspaceId,
      month: MONTH,
      keyId,
      limit: 2,
    })
    expect(first).toEqual({ allowed: true, used: 1 })

    await methods.incrementMcpCloudUsageIfAllowed({ workspaceId: user.workspaceId, month: MONTH, keyId, limit: 2 })
    const denied = await methods.incrementMcpCloudUsageIfAllowed({ workspaceId: user.workspaceId, month: MONTH, keyId, limit: 2 })
    expect(denied.allowed).toBe(false)
    expect(denied.used).toBe(2)

    expect(await methods.getWorkspaceMonthlyMcpCloudUsage(user.workspaceId, MONTH)).toBe(2)
    expect(await methods.getWorkspaceMonthlyMcpCloudUsage(user.workspaceId, '2026-01')).toBe(0)

    const perKey = await methods.getMcpCloudKeyUsage([keyId], MONTH)
    expect(perKey).toEqual([{ mcp_key_id: keyId, call_count: 2 }])
    expect(await methods.getMcpCloudKeyUsage([], MONTH)).toEqual([])
  })

  it('revoke hides the key from listings and counts', async () => {
    await methods.revokeMcpCloudKey(keyId, user.workspaceId)

    expect(await methods.listMcpCloudKeys(user.workspaceId)).toEqual([])
    expect(await methods.countActiveMcpCloudKeys(user.workspaceId)).toBe(0)
    // hash lookup still returns the row (revocation is checked by the caller)
    expect((await methods.getMcpCloudKeyByHash(keyHash))!.revoked_at).not.toBeNull()
  })
})
