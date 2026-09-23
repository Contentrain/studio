import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { usageAlertMethods } from '../../server/providers/postgres-db/usage-alerts'
import { deleteSeededUser, getDb, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

describe('postgres-db usage-alerts (contract)', () => {
  const methods = usageAlertMethods()
  let subscribed: SeededUser
  let unsubscribed: SeededUser

  beforeAll(async () => {
    subscribed = await seedUser('usage-alert-sub')
    unsubscribed = await seedUser('usage-alert-free')
    await sql`
      INSERT INTO public.payment_accounts (workspace_id, provider, customer_id, subscription_status, is_active)
      VALUES (${subscribed.workspaceId}, 'polar', ${`cus_${subscribed.workspaceId.slice(0, 8)}`}, 'active', true)
    `.execute(getDb())
  })

  afterAll(async () => {
    for (const user of [subscribed, unsubscribed])
      await deleteSeededUser(user.userId) // payment_accounts and usage_alerts cascade via workspace
  })

  it('lists only workspaces with an active payment account, with the fields the job reads', async () => {
    const rows = await methods.listWorkspacesForUsageAlerts()
    const ids = rows.map(r => r.id)
    expect(ids).toContain(subscribed.workspaceId)
    expect(ids).not.toContain(unsubscribed.workspaceId)
    const row = rows.find(r => r.id === subscribed.workspaceId)!
    expect(Object.keys(row).sort()).toEqual(
      ['id', 'media_storage_bytes', 'name', 'overage_settings', 'owner_id', 'plan', 'slug', 'type'],
    )
  })

  it('a claim wins once per workspace, meter, period and threshold; release lets it win again', async () => {
    const key = { workspaceId: subscribed.workspaceId, meter: 'ai_messages', periodKey: '2026-09-15', threshold: 100 as const }
    expect(await methods.claimUsageAlert(key)).toBe(true)
    expect(await methods.claimUsageAlert(key)).toBe(false)
    // Another threshold or period is its own alert.
    expect(await methods.claimUsageAlert({ ...key, threshold: 80 })).toBe(true)
    // CDN delivery's hard stop is a third level (migration 034).
    expect(await methods.claimUsageAlert({ ...key, meter: 'cdn_bandwidth', threshold: 120 })).toBe(true)
    expect(await methods.claimUsageAlert({ ...key, periodKey: '2026-10-15' })).toBe(true)

    await methods.releaseUsageAlert(key)
    expect(await methods.claimUsageAlert(key)).toBe(true)
  })
})
