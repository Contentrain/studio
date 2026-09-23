import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { paymentAccountMethods } from '../../server/providers/postgres-db/payment-accounts'
import { createPostgresDatabaseProvider } from '../../server/providers/postgres-db'
import { deleteSeededUser, seedUser } from './helpers'
import type { SeededUser } from './helpers'

describe('postgres-db payment-accounts (contract)', () => {
  const methods = paymentAccountMethods()
  let user: SeededUser

  beforeAll(async () => {
    user = await seedUser('pay')
  })

  afterAll(async () => {
    await deleteSeededUser(user.userId)
  })

  it('upsert activates, updates in place, and archives competing providers atomically', async () => {
    expect(await methods.getActivePaymentAccount(user.workspaceId)).toBeNull()

    const polar = await methods.upsertPaymentAccount({
      workspaceId: user.workspaceId,
      provider: 'polar',
      customerId: 'cus_polar_1',
      subscriptionStatus: 'trialing',
      plan: 'starter',
      pluginMetadata: { checkoutId: 'chk_1' },
    })
    expect(polar.is_active).toBe(true)
    expect(polar.plugin_metadata).toEqual({ checkoutId: 'chk_1' })

    // same (workspace, provider, customer) → in-place update, same row id
    const renewed = await methods.upsertPaymentAccount({
      workspaceId: user.workspaceId,
      provider: 'polar',
      customerId: 'cus_polar_1',
      subscriptionStatus: 'active',
      plan: 'pro',
    })
    expect(renewed.id).toBe(polar.id)
    expect(renewed.subscription_status).toBe('active')
    expect(renewed.plan).toBe('pro')

    // switching providers archives the polar row in the same transaction
    const stripe = await methods.upsertPaymentAccount({
      workspaceId: user.workspaceId,
      provider: 'stripe',
      customerId: 'cus_stripe_1',
      subscriptionStatus: 'active',
      plan: 'pro',
    })
    expect(stripe.is_active).toBe(true)

    const active = await methods.getActivePaymentAccount(user.workspaceId)
    expect(active!.id).toBe(stripe.id)
    expect(active!.provider).toBe('stripe')

    await methods.archiveActivePaymentAccount(user.workspaceId)
    expect(await methods.getActivePaymentAccount(user.workspaceId)).toBeNull()
  })

  it('metadata key: compare-and-set with one winner, kept by an upsert built from an earlier read', async () => {
    const base = { workspaceId: user.workspaceId, provider: 'polar', customerId: 'cus_meta_1' }
    await methods.upsertPaymentAccount({ ...base, subscriptionStatus: 'trialing', pluginMetadata: { billable_meters: ['a'] } })

    // 'absent' sets once; a second 'absent' finds the key.
    expect(await methods.setPaymentAccountMetadataKey({ workspaceId: user.workspaceId, key: 'activation_email', value: 'pending', when: 'absent' })).toBe(true)
    expect(await methods.setPaymentAccountMetadataKey({ workspaceId: user.workspaceId, key: 'activation_email', value: 'pending', when: 'absent' })).toBe(false)

    // Two concurrent claims of pending → sent: exactly one wins.
    const claim = () => methods.setPaymentAccountMetadataKey({ workspaceId: user.workspaceId, key: 'activation_email', value: 'sent', when: { equals: 'pending' } })
    const wins = await Promise.all([claim(), claim(), claim()])
    expect(wins.filter(Boolean)).toHaveLength(1)

    // An upsert carrying a stale value (read before the claim) keeps the
    // stored one for a preserved key, and still replaces the rest.
    const row = await methods.upsertPaymentAccount({
      ...base,
      subscriptionStatus: 'active',
      pluginMetadata: { billable_meters: ['b'], activation_email: 'pending' },
      preserveMetadataKeys: ['activation_email'],
    })
    expect(row.subscription_status).toBe('active')
    expect(row.plugin_metadata).toEqual({ billable_meters: ['b'], activation_email: 'sent' })

    // A preserved key the row does not hold is not introduced by the upsert.
    await methods.upsertPaymentAccount({ ...base, pluginMetadata: {} })
    const cleared = await methods.upsertPaymentAccount({ ...base, pluginMetadata: { activation_email: 'pending' }, preserveMetadataKeys: ['activation_email'] })
    expect(cleared.plugin_metadata).toEqual({})

    // 'different': one winner per value, a new value claims again.
    const episode = (value: string) => methods.setPaymentAccountMetadataKey({ workspaceId: user.workspaceId, key: 'recovery_email', value, when: 'different' })
    expect((await Promise.all([episode('g1'), episode('g1')])).filter(Boolean)).toHaveLength(1)
    expect(await episode('g1')).toBe(false)
    expect(await episode('g2')).toBe(true)

    // No active row: nothing to set.
    await methods.archiveActivePaymentAccount(user.workspaceId)
    expect(await methods.setPaymentAccountMetadataKey({ workspaceId: user.workspaceId, key: 'k', value: 'v', when: 'absent' })).toBe(false)
  })

  it('usage outbox: idempotent enqueue, FIFO pending list, ingest/failure bookkeeping', async () => {
    const idempotencyKey = `evt-${randomUUID()}`

    await methods.enqueueUsageEvent({
      workspaceId: user.workspaceId,
      meterName: 'ai_messages',
      value: 3,
      idempotencyKey,
      metadata: { month: '2026-05' },
    })
    // duplicate → swallowed (23505 contract)
    await methods.enqueueUsageEvent({
      workspaceId: user.workspaceId,
      meterName: 'ai_messages',
      value: 3,
      idempotencyKey,
    })

    const pending = await methods.listPendingUsageEvents(10)
    const mine = pending.filter(e => e.workspace_id === user.workspaceId)
    expect(mine).toHaveLength(1)
    expect(Number(mine[0]!.value)).toBe(3)
    expect(mine[0]!.metadata).toEqual({ month: '2026-05' })

    // failure path: attempt_count increments atomically, stays pending
    await methods.markUsageEventIngested(mine[0]!.id as string, 'polar 503')
    await methods.markUsageEventIngested(mine[0]!.id as string, 'polar 503 again')
    const retried = (await methods.listPendingUsageEvents(10)).find(e => e.id === mine[0]!.id)!
    expect(retried.attempt_count).toBe(2)
    expect(retried.last_error).toBe('polar 503 again')

    // success path: ingested_at set, error cleared, drops from pending
    await methods.markUsageEventIngested(mine[0]!.id as string)
    expect((await methods.listPendingUsageEvents(10)).find(e => e.id === mine[0]!.id)).toBeUndefined()
  })

  it('createPostgresDatabaseProvider assembles the complete DatabaseProvider', async () => {
    const provider = createPostgresDatabaseProvider()

    // spot-check methods from every module bundle
    for (const method of [
      'getProfile',
      'upsertOAuthProviderToken',
      'cleanupAuditLogs',
      'listWorkspacesPendingTrialReminder',
      'transferWorkspaceOwnership',
      'createWorkspaceMemberIfAllowed',
      'getProjectWithMembers',
      'getWorkspaceMonthlyCDNBandwidth',
      'insertMessages',
      'createCDNKeyIfAllowed',
      'incrementMcpCloudUsageIfAllowed',
      'listMediaAssets',
      'createFormSubmissionIfAllowed',
      'deleteWebhook',
      'upsertPaymentAccount',
    ] as const) {
      expect(typeof provider[method], method).toBe('function')
    }
  })
})
