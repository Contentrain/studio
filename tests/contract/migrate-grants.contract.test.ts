import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrateGrantMethods } from '../../server/providers/postgres-db/migrate-grants'
import { deleteSeededUser, getDb, seedUser, sql } from './helpers'
import type { SeededUser } from './helpers'

describe('postgres-db migrate-grants (contract)', () => {
  const methods = migrateGrantMethods()
  let owner: SeededUser
  let other: SeededUser
  const orderId = `order-${Date.now()}`

  const claim = (userId: string, jti = 'jti-1') => methods.claimMigrateGrant({
    orderId,
    claimJti: jti,
    userId,
    plan: 'pro',
    trialDays: 60,
    repoOwner: 'acme',
    repoName: 'blog',
    email: 'owner@example.com',
  })

  beforeAll(async () => {
    owner = await seedUser('grant-owner')
    other = await seedUser('grant-other')
  })

  afterAll(async () => {
    await sql`DELETE FROM public.migrate_grants WHERE order_id = ${orderId}`.execute(getDb())
    for (const user of [owner, other]) await deleteSeededUser(user.userId)
  })

  it('records one grant per order and hands the same row back on a second claim', async () => {
    const first = await claim(owner.userId)
    expect(first.created).toBe(true)
    expect(first.grant).toMatchObject({ order_id: orderId, user_id: owner.userId, plan: 'pro', trial_days: 60, bound_at: null })

    // Same order, another account and another token: nothing new is written.
    const second = await claim(other.userId, 'jti-2')
    expect(second.created).toBe(false)
    expect(second.grant.id).toBe(first.grant.id)
    expect(second.grant.user_id).toBe(owner.userId)
  })

  it('shows a grant only to its owner', async () => {
    const { grant } = await claim(owner.userId)
    expect(await methods.getMigrateGrantForUser(grant.id as string, owner.userId)).toMatchObject({ id: grant.id })
    expect(await methods.getMigrateGrantForUser(grant.id as string, other.userId)).toBeNull()
  })

  it('binds to one workspace for good, and rebinding there keeps the first bind time', async () => {
    const { grant } = await claim(owner.userId)
    const bound = await methods.bindMigrateGrantWorkspace(grant.id as string, owner.workspaceId)
    expect(bound).toMatchObject({ workspace_id: owner.workspaceId })
    const boundAt = String(bound!.bound_at)

    const again = await methods.bindMigrateGrantWorkspace(grant.id as string, owner.workspaceId)
    expect(String(again!.bound_at)).toBe(boundAt)

    expect(await methods.bindMigrateGrantWorkspace(grant.id as string, other.workspaceId)).toBeNull()
  })

  it('counts only the first redemption', async () => {
    const { grant } = await claim(owner.userId)
    await methods.markMigrateGrantRedeemed(grant.id as string, 'sub_first')
    await methods.markMigrateGrantRedeemed(grant.id as string, 'sub_second')

    const row = await methods.getMigrateGrantForUser(grant.id as string, owner.userId)
    expect(row!.redeemed_at).not.toBeNull()
    expect(row!.redeemed_subscription_id).toBe('sub_first')
  })

  it('refuses a trial longer than the contract allows', async () => {
    await expect(methods.claimMigrateGrant({
      orderId: `${orderId}-long`,
      claimJti: 'jti-long',
      userId: owner.userId,
      plan: 'starter',
      trialDays: 365,
      repoOwner: 'acme',
      repoName: 'blog',
      email: 'owner@example.com',
    })).rejects.toBeDefined()
  })
})
