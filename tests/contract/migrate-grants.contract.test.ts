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
    await sql`DELETE FROM public.migrate_grants WHERE order_id LIKE ${`${orderId}%`}`.execute(getDb())
    await sql`DELETE FROM public.migrate_s2s_jti WHERE jti LIKE ${`${orderId}%`}`.execute(getDb())
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

  it('finds a grant by its order, and nothing for an order without one', async () => {
    await claim(owner.userId)
    expect(await methods.getMigrateGrantByOrderId(orderId)).toMatchObject({ order_id: orderId, user_id: owner.userId })
    expect(await methods.getMigrateGrantByOrderId(`${orderId}-none`)).toBeNull()
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

  it('writes a repository only onto a grant that has none', async () => {
    const { grant } = await claim(owner.userId)
    expect(grant.repo_owner).toBeNull()
    const first = await methods.setMigrateGrantRepo(grant.id as string, { owner: 'acme', name: 'blog' })
    expect(first).toMatchObject({ repo_owner: 'acme', repo_name: 'blog' })
    const second = await methods.setMigrateGrantRepo(grant.id as string, { owner: 'other', name: 'site' })
    expect(second).toMatchObject({ repo_owner: 'acme', repo_name: 'blog' })
  })

  it('marks a grant revoked once: the first reason stays, the grant is never un-revoked', async () => {
    const { grant } = await claim(owner.userId)
    expect(grant.revoked_at).toBeNull()
    const first = await methods.markMigrateGrantRevoked(grant.id as string, 'refund_before_delivery')
    expect(first).toMatchObject({ revoked_reason: 'refund_before_delivery' })
    expect(first!.revoked_at).not.toBeNull()
    const again = await methods.markMigrateGrantRevoked(grant.id as string, 'ops')
    expect(again).toMatchObject({ revoked_reason: 'refund_before_delivery' })
    expect(String(again!.revoked_at)).toBe(String(first!.revoked_at))
    expect(await methods.markMigrateGrantRevoked(`00000000-0000-0000-0000-000000000000`, 'ops')).toBeNull()
  })

  it('keeps the signed origin: taken once, never replaced, found by workspace and repo', async () => {
    const order = `${orderId}-origin`
    const claimSite = (origin?: string) => methods.claimMigrateGrant({
      orderId: order,
      claimJti: 'jti-origin',
      userId: owner.userId,
      plan: 'pro',
      trialDays: 60,
      repoOwner: 'Acme',
      repoName: 'Site',
      email: 'owner@example.com',
      origin,
    })
    const first = await claimSite()
    expect(first.grant.origin).toBeNull()
    // A grant recorded before claims carried an origin takes it from the next claim for the order…
    expect((await claimSite('https://old.example')).grant.origin).toBe('https://old.example')
    // …and a later claim cannot move it.
    expect((await claimSite('https://other.example')).grant.origin).toBe('https://old.example')

    // Only a grant bound to the workspace counts.
    expect(await methods.getMigrateGrantOrigin(owner.workspaceId, 'acme/site')).toBeNull()
    await methods.bindMigrateGrantWorkspace(first.grant.id as string, owner.workspaceId)
    expect(await methods.getMigrateGrantOrigin(owner.workspaceId, 'ACME/site')).toBe('https://old.example')
    expect(await methods.getMigrateGrantOrigin(other.workspaceId, 'acme/site')).toBeNull()
    expect(await methods.getMigrateGrantOrigin(owner.workspaceId, 'acme/blog')).toBeNull()
    expect(await methods.getMigrateGrantOrigin(owner.workspaceId, 'acme')).toBeNull()
  })

  describe('bundle grants (migration 044)', () => {
    const bundle = (suffix: string) => methods.claimMigrateGrant({
      orderId: `${orderId}-b-${suffix}`,
      claimJti: `jti-b-${suffix}`,
      userId: owner.userId,
      plan: 'pro',
      email: 'owner@example.com',
      kind: 'bundle',
    })

    it('has no trial and no repository until delivery, and is found by id', async () => {
      const { grant, created } = await bundle('shape')
      expect(created).toBe(true)
      expect(grant).toMatchObject({ kind: 'bundle', trial_days: null, repo_owner: null, repo_name: null })
      expect(await methods.getMigrateGrantById(grant.id as string)).toMatchObject({ id: grant.id, kind: 'bundle' })
      expect(await methods.getMigrateGrantById('00000000-0000-0000-0000-000000000000')).toBeNull()
    })

    it('a trial grant still needs its trial days and repository', async () => {
      await expect(methods.claimMigrateGrant({
        orderId: `${orderId}-b-trial`, claimJti: 'jti-b-trial', userId: owner.userId, plan: 'pro', email: 'owner@example.com',
      })).rejects.toThrow()
    })

    it('remembers the checkout it opened and the product the subscription must move to', async () => {
      const { grant } = await bundle('checkout')
      await methods.saveMigrateGrantCheckout(grant.id as string, {
        checkoutId: 'co_1',
        checkoutUrl: 'https://sandbox.polar.sh/checkout/c_1',
        checkoutExpiresAt: '2030-01-01T00:00:00.000Z',
        amountCents: 64100,
        targetProductId: 'prod_pro_y',
      })
      expect(await methods.getMigrateGrantById(grant.id as string)).toMatchObject({
        checkout_id: 'co_1', checkout_url: 'https://sandbox.polar.sh/checkout/c_1', amount_cents: 64100, bundle_target_product_id: 'prod_pro_y', bundle_applied_at: null,
      })
    })

    it('lists a redeemed bundle until its move is recorded, oldest first, and only once recorded does it leave', async () => {
      const mine = (await bundle('pending')).grant.id as string
      const notRedeemed = (await bundle('unpaid')).grant.id as string
      for (const id of [mine, notRedeemed]) {
        await methods.saveMigrateGrantCheckout(id, { checkoutId: `co_${id}`, checkoutUrl: 'https://sandbox.polar.sh/checkout/c', checkoutExpiresAt: '2030-01-01T00:00:00.000Z', amountCents: 100, targetProductId: 'prod_y' })
      }
      await methods.markMigrateGrantRedeemed(mine, 'sub_pending')

      const ids = async () => (await methods.listPendingMigrateBundles(500)).map(row => row.id)
      expect(await ids()).toContain(mine)
      expect(await ids()).not.toContain(notRedeemed)

      await methods.markMigrateBundleApplied(mine)
      expect(await ids()).not.toContain(mine)
      const applied = String((await methods.getMigrateGrantById(mine))!.bundle_applied_at)
      await methods.markMigrateBundleApplied(mine)
      expect(String((await methods.getMigrateGrantById(mine))!.bundle_applied_at)).toBe(applied)
    })
  })

  describe('comments export held on the grant (migration 040)', () => {
    const payload = { format: 'contentrain-comments@1', comments: [{ id: 1 }] }
    const future = () => new Date(Date.now() + 3600_000).toISOString()
    const grantFor = async (suffix: string, repoName = `Site-${suffix}`) => {
      const { grant } = await methods.claimMigrateGrant({
        orderId: `${orderId}-ce-${suffix}`,
        claimJti: `jti-ce-${suffix}`,
        userId: owner.userId,
        plan: 'pro',
        trialDays: 60,
        repoOwner: 'Acme',
        repoName,
        email: 'owner@example.com',
      })
      await methods.bindMigrateGrantWorkspace(grant.id as string, owner.workspaceId)
      return { id: grant.id as string, repo: `acme/${repoName.toLowerCase()}` }
    }

    it('holds a ready export, finds it by workspace and repo only, and shows the payload only on request', async () => {
      const g = await grantFor('ready')
      await methods.saveMigrateCommentsExport(g.id, { status: 'ready', payload, comments: 1, expiresAt: future() })

      const view = await methods.getMigrateCommentsExport(owner.workspaceId, g.repo)
      expect(view).toMatchObject({ grantId: g.id, status: 'ready', comments: 1, importedAt: null })
      expect(view).not.toHaveProperty('payload')
      expect(await methods.getMigrateCommentsExport(owner.workspaceId, g.repo, { withPayload: true })).toMatchObject({ payload })
      expect(await methods.getMigrateCommentsExport(other.workspaceId, g.repo)).toBeNull()
      expect(await methods.getMigrateCommentsExport(owner.workspaceId, 'acme/nothing')).toBeNull()
      expect(await methods.getMigrateCommentsExportState(g.id)).toMatchObject({ status: 'ready' })
    })

    it('marking it imported clears the payload at once and keeps the count; it cannot be marked twice or overwritten', async () => {
      const g = await grantFor('imported')
      await methods.saveMigrateCommentsExport(g.id, { status: 'ready', payload, comments: 1, expiresAt: future() })
      await methods.markMigrateCommentsExportImported(g.id)

      const done = await methods.getMigrateCommentsExport(owner.workspaceId, g.repo, { withPayload: true })
      expect(done).toMatchObject({ status: 'imported', comments: 1 })
      expect(done?.payload ?? null).toBeNull()
      expect(done?.importedAt).not.toBeNull()
      const at = done?.importedAt

      await methods.markMigrateCommentsExportImported(g.id)
      expect((await methods.getMigrateCommentsExportState(g.id))?.importedAt).toBe(at)

      // A later claim for the order never brings an imported export back.
      await methods.saveMigrateCommentsExport(g.id, { status: 'ready', payload, comments: 9, expiresAt: future() })
      expect(await methods.getMigrateCommentsExportState(g.id)).toMatchObject({ status: 'imported', comments: 1 })
    })

    it('an unavailable export is recorded without a payload and can still become ready', async () => {
      const g = await grantFor('unavailable')
      await methods.saveMigrateCommentsExport(g.id, { status: 'unavailable', payload: null, comments: 4, expiresAt: future() })
      expect(await methods.getMigrateCommentsExportState(g.id)).toMatchObject({ status: 'unavailable', comments: 4 })
      await methods.markMigrateCommentsExportImported(g.id)
      expect(await methods.getMigrateCommentsExportState(g.id)).toMatchObject({ status: 'unavailable' })

      await methods.saveMigrateCommentsExport(g.id, { status: 'ready', payload, comments: 1, expiresAt: future() })
      expect(await methods.getMigrateCommentsExportState(g.id)).toMatchObject({ status: 'ready' })
    })

    it('an export never imported is cleared when its window ends', async () => {
      const g = await grantFor('expired')
      await methods.saveMigrateCommentsExport(g.id, { status: 'ready', payload, comments: 1, expiresAt: new Date(Date.now() - 1000).toISOString() })

      const view = await methods.getMigrateCommentsExport(owner.workspaceId, g.repo, { withPayload: true })
      expect(view).toMatchObject({ status: 'expired', comments: 1 })
      expect(view?.payload ?? null).toBeNull()
      const stored = await sql<{ payload: unknown }>`SELECT payload FROM public.migrate_comment_exports WHERE grant_id = ${g.id}`.execute(getDb())
      expect(stored.rows[0]?.payload).toBeNull()
    })
  })

  it('remembers a server-to-server jti once, and drops it after its window (migration 042)', async () => {
    const jti = `${orderId}-s2s`
    const future = new Date(Date.now() + 600_000)
    expect(await methods.claimMigrateS2sJti(jti, 'account-state', future)).toBe(true)
    expect(await methods.claimMigrateS2sJti(jti, 'account-state', future)).toBe(false)

    const old = `${orderId}-s2s-old`
    expect(await methods.claimMigrateS2sJti(old, 'account-state', new Date(Date.now() - 1000))).toBe(true)
    // The next claim sweeps the lapsed record, so its jti is free again.
    expect(await methods.claimMigrateS2sJti(`${orderId}-s2s-other`, 'account-state', future)).toBe(true)
    expect(await methods.claimMigrateS2sJti(old, 'account-state', future)).toBe(true)
  })

  it('gives a jti back after our own failure, so the same request can be taken again', async () => {
    const jti = `${orderId}-s2s-release`
    const future = new Date(Date.now() + 600_000)
    expect(await methods.claimMigrateS2sJti(jti, 'account-state', future)).toBe(true)
    await methods.releaseMigrateS2sJti(jti)
    expect(await methods.claimMigrateS2sJti(jti, 'account-state', future)).toBe(true)
    expect(await methods.claimMigrateS2sJti(jti, 'account-state', future)).toBe(false)
  })

  it('finds the user behind a GitHub id through the lookup function the Supabase pair calls (migration 043)', async () => {
    const githubId = `gh-${Date.now()}`
    await sql`INSERT INTO auth.identities (provider, provider_id, user_id) VALUES ('github', ${githubId}, ${owner.userId})`.execute(getDb())
    const found = await sql<{ id: string | null }>`SELECT public.migrate_user_id_by_identity('github', ${githubId}) AS id`.execute(getDb())
    expect(found.rows[0]?.id).toBe(owner.userId)
    const none = await sql<{ id: string | null }>`SELECT public.migrate_user_id_by_identity('github', 'no-such-id') AS id`.execute(getDb())
    expect(none.rows[0]?.id).toBeNull()
  })

  it('lists the workspaces a user owns, and no one else\'s', async () => {
    const owned = await methods.listOwnedWorkspacesAdmin(owner.userId)
    expect(owned.map(w => w.id)).toContain(owner.workspaceId)
    expect(owned.map(w => w.id)).not.toContain(other.workspaceId)
    expect(owned[0]).toHaveProperty('plan')
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
