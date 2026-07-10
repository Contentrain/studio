import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { usageMethods } from '../../server/providers/postgres-db/usage'
import { deleteSeededUser, getDb, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

const MONTH = '2026-03'

describe('postgres-db usage (contract)', () => {
  const methods = usageMethods()
  let user: SeededUser
  let other: SeededUser
  let projectId: string

  beforeAll(async () => {
    user = await seedUser('usage')
    other = await seedUser('usage-other')

    const project = await sql<{ id: string }>`
      INSERT INTO public.projects (workspace_id, repo_full_name)
      VALUES (${user.workspaceId}, 'contentrain/usage-fixture')
      RETURNING id
    `.execute(getDb())
    projectId = project.rows[0]!.id
  })

  afterAll(async () => {
    await deleteSeededUser(user.userId)
    await deleteSeededUser(other.userId)
  })

  it('sums studio-source agent usage for the exact month only', async () => {
    expect(await methods.getWorkspaceMonthlyAIUsage(user.workspaceId, MONTH)).toBe(0)

    // agent_usage is UNIQUE (workspace_id, user_id, month, source) — the
    // two studio rows therefore belong to two different users of the
    // workspace, which is also the realistic aggregation case.
    const rows = [
      { userId: user.userId, month: MONTH, source: 'studio', count: 12 },
      { userId: other.userId, month: MONTH, source: 'studio', count: 8 },
      { userId: user.userId, month: MONTH, source: 'byoa', count: 100 }, // excluded: wrong source
      { userId: user.userId, month: '2026-02', source: 'studio', count: 50 }, // excluded: wrong month
    ]
    for (const row of rows) {
      await sql`
        INSERT INTO public.agent_usage (workspace_id, user_id, month, message_count, source)
        VALUES (${user.workspaceId}, ${row.userId}, ${row.month}, ${row.count}, ${row.source})
      `.execute(getDb())
    }

    expect(await methods.getWorkspaceMonthlyAIUsage(user.workspaceId, MONTH)).toBe(20)
    expect(await methods.getWorkspaceMonthlyAIUsage(other.workspaceId, MONTH)).toBe(0)
  })

  it('sums conversation-API usage across keys for the month', async () => {
    const keyId = randomUUID()
    await sql`
      INSERT INTO public.conversation_api_keys (id, project_id, workspace_id, key_hash, key_prefix, name)
      VALUES (${keyId}, ${projectId}, ${user.workspaceId}, ${randomUUID()}, 'crn_test', 'usage-key')
    `.execute(getDb())

    await sql`
      INSERT INTO public.api_message_usage (workspace_id, api_key_id, month, message_count)
      VALUES (${user.workspaceId}, ${keyId}, ${MONTH}, 7)
    `.execute(getDb())

    expect(await methods.getWorkspaceMonthlyAPIUsage(user.workspaceId, MONTH)).toBe(7)
    expect(await methods.getWorkspaceMonthlyAPIUsage(user.workspaceId, '2026-02')).toBe(0)
  })

  it('sums CDN bandwidth across the workspace\'s projects within the month window', async () => {
    const seed = [
      { start: `${MONTH}-01`, bytes: 1_000_000 }, // in window (inclusive start)
      { start: `${MONTH}-28`, bytes: 500_000 }, // in window
      { start: '2026-04-01', bytes: 900_000 }, // excluded: next-month start (exclusive)
      { start: '2026-02-28', bytes: 900_000 }, // excluded: previous month
    ]
    for (const row of seed) {
      await sql`
        INSERT INTO public.cdn_usage (project_id, period_start, bandwidth_bytes)
        VALUES (${projectId}, ${row.start}, ${row.bytes})
      `.execute(getDb())
    }

    expect(await methods.getWorkspaceMonthlyCDNBandwidth(user.workspaceId, MONTH)).toBe(1_500_000)
    expect(await methods.getWorkspaceMonthlyCDNBandwidth(other.workspaceId, MONTH)).toBe(0)
  })
})
