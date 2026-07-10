import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditMethods } from '../../server/providers/postgres-db/audit'
import { deleteSeededUser, getDb, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

describe('postgres-db audit (contract)', () => {
  const methods = auditMethods()
  let user: SeededUser

  function entry(action: string) {
    return {
      workspaceId: user.workspaceId,
      actorId: user.userId,
      action,
      tableName: 'form_submissions',
      recordId: randomUUID(),
      recordSnapshot: { field: 'value' },
      sourceIp: '203.0.113.7',
      userAgent: 'contract-suite',
      origin: 'app' as const,
    }
  }

  beforeAll(async () => {
    user = await seedUser('audit')
    await methods.createAuditLog(entry('delete_form_submission'))
    await methods.createAuditLog(entry('delete_form_submission'))
    await methods.createAuditLog(entry('delete_project'))
  })

  afterAll(async () => {
    await sql`DELETE FROM public.audit_logs WHERE workspace_id = ${user.workspaceId}`.execute(getDb())
    await deleteSeededUser(user.userId)
  })

  it('lists workspace logs with an exact total and the public column set', async () => {
    const { data, total } = await methods.listAuditLogs(user.workspaceId)

    expect(total).toBe(3)
    expect(data).toHaveLength(3)
    expect(Object.keys(data[0]!).sort()).toEqual(
      ['action', 'actor_id', 'created_at', 'id', 'origin', 'record_id', 'table_name', 'workspace_id'],
    )
  })

  it('filters by action and paginates with a stable total', async () => {
    const filtered = await methods.listAuditLogs(user.workspaceId, { action: 'delete_form_submission' })
    expect(filtered.total).toBe(2)

    const page = await methods.listAuditLogs(user.workspaceId, { limit: 2, page: 2 })
    expect(page.total).toBe(3)
    expect(page.data).toHaveLength(1)
  })

  it('sorts newest-first by default and oldest-first on request', async () => {
    const newest = await methods.listAuditLogs(user.workspaceId)
    const oldest = await methods.listAuditLogs(user.workspaceId, { sort: 'oldest' })

    expect(newest.data.map(r => r.id).reverse()).toEqual(oldest.data.map(r => r.id))
  })

  it('createAuditLog never throws — even against invalid input', async () => {
    await expect(
      methods.createAuditLog({
        workspaceId: 'not-a-uuid',
        action: 'broken',
        tableName: 'x',
        recordId: 'also-not-a-uuid',
      }),
    ).resolves.toBeUndefined()
  })

  it('cleanupAuditLogs purges only rows older than the retention window', async () => {
    await sql`
      INSERT INTO public.audit_logs (workspace_id, action, table_name, record_id, created_at)
      VALUES (${user.workspaceId}, 'ancient', 'projects', ${randomUUID()}, now() - interval '120 days')
    `.execute(getDb())

    const purged = await methods.cleanupAuditLogs(90)

    expect(purged).toBeGreaterThanOrEqual(1)
    const { total } = await methods.listAuditLogs(user.workspaceId, { action: 'ancient' })
    expect(total).toBe(0)
    const { total: recent } = await methods.listAuditLogs(user.workspaceId)
    expect(recent).toBe(3)
  })
})
