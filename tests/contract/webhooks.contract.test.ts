import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { webhookMethods } from '../../server/providers/postgres-db/webhooks'
import { deleteSeededUser, getDb, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

describe('postgres-db webhooks (contract)', () => {
  const methods = webhookMethods()
  let user: SeededUser
  let projectId: string
  let webhookId: string

  beforeAll(async () => {
    user = await seedUser('wh')
    const project = await sql<{ id: string }>`
      INSERT INTO public.projects (workspace_id, repo_full_name)
      VALUES (${user.workspaceId}, 'contentrain/wh-fixture') RETURNING id
    `.execute(getDb())
    projectId = project.rows[0]!.id

    const webhook = await sql<{ id: string }>`
      INSERT INTO public.webhooks (project_id, workspace_id, name, url, events, secret)
      VALUES (${projectId}, ${user.workspaceId}, 'hook-a', 'https://example.com/a', ${['content.published']}, 'whsec_a')
      RETURNING id
    `.execute(getDb())
    webhookId = webhook.rows[0]!.id
  })

  afterAll(async () => {
    await deleteSeededUser(user.userId)
  })

  it('webhook CRUD: list (with secret), scoped get, update stamps updated_at, active filter', async () => {
    const list = await methods.listProjectWebhooks(projectId, user.workspaceId)
    expect(list.map(w => w.id)).toEqual([webhookId])
    expect(list[0]!.secret).toBe('whsec_a')

    const scoped = await methods.getWebhook(webhookId, { projectId, workspaceId: user.workspaceId })
    expect(scoped!.url).toBe('https://example.com/a')
    expect(await methods.getWebhook(webhookId, { projectId: randomUUID() })).toBeNull()

    const updated = await methods.updateWebhook(webhookId, projectId, user.workspaceId, { active: false, events: ['content.deleted'] })
    expect(updated.active).toBe(false)
    expect(updated.events).toEqual(['content.deleted'])

    expect(await methods.listActiveProjectWebhooks(user.workspaceId, projectId)).toEqual([])
    await methods.updateWebhook(webhookId, projectId, user.workspaceId, { active: true })
    expect((await methods.listActiveProjectWebhooks(user.workspaceId, projectId)).map(w => w.id)).toEqual([webhookId])
  })

  it('delivery lifecycle: create (jsonb payload) → list → update → pending retries window', async () => {
    const delivery = await methods.createWebhookDelivery({
      webhookId,
      event: 'content.published',
      payload: { model: 'posts', entries: ['a', 'b'] },
    })

    const { deliveries, total } = await methods.listWebhookDeliveries(webhookId)
    expect(total).toBe(1)
    expect(deliveries[0]!.status).toBe('pending')

    await methods.updateWebhookDelivery(delivery.id as string, {
      status: 'pending',
      retry_count: 1,
      next_retry_at: new Date(Date.now() - 60_000).toISOString(),
    })

    const due = await methods.listPendingWebhookRetries()
    const mine = due.find(d => d.id === delivery.id)!
    expect(mine.retry_count).toBe(1)
    expect(mine.payload).toEqual({ model: 'posts', entries: ['a', 'b'] })

    await methods.updateWebhookDelivery(delivery.id as string, { status: 'delivered', delivered_at: new Date().toISOString(), next_retry_at: null })
    expect((await methods.listPendingWebhookRetries()).find(d => d.id === delivery.id)).toBeUndefined()
  })

  it('deleteWebhook removes deliveries + webhook atomically', async () => {
    await methods.createWebhookDelivery({ webhookId, event: 'x', payload: {} })
    await methods.deleteWebhook(webhookId, projectId, user.workspaceId)

    expect(await methods.getWebhook(webhookId)).toBeNull()
    const orphans = await sql<{ count: number }>`
      SELECT count(*)::int AS count FROM public.webhook_deliveries WHERE webhook_id = ${webhookId}
    `.execute(getDb())
    expect(orphans.rows[0]!.count).toBe(0)
  })

  it('conversation key CRUD + usage aggregation by source=api', async () => {
    const created = await methods.createConversationKey({
      project_id: projectId,
      workspace_id: user.workspaceId,
      key_hash: randomUUID(),
      key_prefix: 'crn_whk',
      name: 'api-key',
      role: 'editor',
    })
    expect(created.ai_model).toBeTruthy()
    expect(created.monthly_message_limit).toBe(1000)

    const listed = await methods.listConversationKeys(projectId, user.workspaceId)
    expect(listed.map(k => k.id)).toEqual([created.id])

    const updated = await methods.updateConversationKey(created.id as string, projectId, user.workspaceId, { name: 'renamed', rate_limit_per_minute: 30 })
    expect(updated.name).toBe('renamed')
    expect(updated.rate_limit_per_minute).toBe(30)

    // getConversationKeyUsage filters agent_usage on source='api' — a value
    // agent_usage_source_check (studio|byoa) has never allowed; migration 006
    // moved API usage into api_message_usage for exactly that reason. The
    // faithful contract on both backends: rows with other sources are never
    // returned, and the query can only ever yield [].
    await sql`
      INSERT INTO public.agent_usage (workspace_id, user_id, api_key_id, month, message_count, source)
      VALUES (${user.workspaceId}, ${user.userId}, ${created.id as string}, '2026-05', 4, 'byoa')
    `.execute(getDb())
    expect(await methods.getConversationKeyUsage([created.id as string], '2026-05')).toEqual([])
    expect(await methods.getConversationKeyUsage([], '2026-05')).toEqual([])

    expect(await methods.countActiveConversationKeys(projectId, user.workspaceId)).toBe(1)
    await methods.revokeConversationKey(created.id as string, projectId, user.workspaceId)
    expect(await methods.countActiveConversationKeys(projectId, user.workspaceId)).toBe(0)
  })
})
