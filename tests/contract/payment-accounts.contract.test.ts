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
